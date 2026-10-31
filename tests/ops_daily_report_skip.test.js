/**
 * v7-operations: 日報は毎日送る。ただし「その日の更新が何もない」時は送らない（2026-10-31 Daisuke 指示）
 *
 * 実行: node --test "tests/*.test.js"
 *
 * DailyReport.gs だけを Node の vm に読み込み、シート・設定・送信はスタブで置き換える（本番には触れない）。
 *   - 予約0・訪問0・未計上なし → sendMessage を呼ばない
 *   - 予約が1件でも／訪問が1件でも／未計上があれば → 送る
 *   - 予約や営業ログが読めない時 → 送る（不具合を日報で見えるようにする）
 *   - 在庫セクションは組み立てに入らない（2026-10-31 停止）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPS = path.join(__dirname, '..', 'v7-operations');

function makeCtx(opts) {
  opts = Object.assign({ bookings: [], visits: [], changes: [], uncounted: '', bookingsThrow: false, visitsThrow: false }, opts || {});
  const sent = [];
  const ctx = {
    console,
    Logger: { log: () => {} },
    OPS_TZ: 'Asia/Phnom_Penh',
    BOT_TYPE: { INTERNAL: 'internal' },
    Utilities: { formatDate: (d, tz, fmt) => (fmt.indexOf('(E)') >= 0 ? '2026-11-01 (Sun)' : '2026-11-01') },
    getConfig: () => ({ adminDailyReportThreadId: '77', adminGroupId: '-100', v7SpreadsheetId: 'v7-sheet' }),
    sendMessage: (bot, chatId, text, o) => sent.push({ bot, chatId, text, o }),
    // 営業ログ（SalesLogManager.gs のヘルパー）
    getSalesLogSheet_: () => ({}),
    readSheetObjects_: () => { if (opts.visitsThrow) throw new Error('log unavailable'); return opts.visits.map((v) => ({ obj: v })); },
    visitRowToApi_: (o) => o,
    // 他のセクションは中身を見ないので固定の文字列に
    buildManualJobUncountedSection_: () => opts.uncounted,
    buildInventorySection_: () => { throw new Error('在庫セクションは呼ばれないはず'); },
    // 本日のシステム変更（SystemChangeLog.gs）
    readSystemChangesForDate_: () => opts.changes,
    buildSystemChangesSection_: () => (opts.changes.length ? '🛠 <b>本日のシステム変更</b>（' + opts.changes.length + '件）\n　' + opts.changes.map((c) => c.emoji + ' ' + c.text).join('\n　') : ''),
    escapeHtml_: (s) => String(s),
    isCancelledStatus_: (s) => s === 'キャンセル',
    isCompletedStatus_: (s) => s === '作業完了',
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(OPS, 'DailyReport.gs'), 'utf8'), ctx, { filename: 'DailyReport.gs' });
  // 予約（v7）の読取はファイル側の定義（SpreadsheetApp を使う）を、読み込んだ後に差し替える
  ctx.readV7BookingsForDate_ = () => { if (opts.bookingsThrow) throw new Error('v7 unavailable'); return opts.bookings; };
  ctx.buildManualJobUncountedSection_ = () => opts.uncounted; // 同じファイル内の定義を差し替える
  ctx.buildSalesLogSection_ = () => '🤝 <b>車屋営業状況</b>（stub）'; // 同上
  return { ctx, sent };
}

const BK = { 'プラン': 'SAMURAI WASH (W)', '料金(USD)': 12, '進行状態': '作業完了', '決済状態': '清算済み' };
const VISIT = { visitId: 'V-1', datetime: '2026-11-01 10:00', shopId: 'SHOP-1' };

test('更新なし（予約0・訪問0・未計上なし）→ 日報を送らない', () => {
  const { ctx, sent } = makeCtx();
  ctx.sendDailyReport();
  assert.equal(sent.length, 0);
});

test('予約が1件でもあれば送る（曜日は見ない・日曜でも）', () => {
  const { ctx, sent } = makeCtx({ bookings: [BK] });
  ctx.sendDailyReport();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /日報 2026-11-01 \(Sun\)/);
  assert.match(sent[0].text, /合計: <b>\$12\.00<\/b>/);
  assert.doesNotMatch(sent[0].text, /在庫/);
  assert.equal(sent[0].o.message_thread_id, 77);
});

test('車屋の訪問が1件でもあれば送る（予約0でも）。前日の訪問は数えない', () => {
  const past = Object.assign({}, VISIT, { datetime: '2026-10-31 15:00' });
  assert.equal(makeCtx({ visits: [past] }).ctx.dailyReportActivity_('2026-11-01').visits, 0);
  const { ctx, sent } = makeCtx({ visits: [past, VISIT] });
  ctx.sendDailyReport();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /本日分の予約なし/);
});

test('未計上の手動ジョブがあれば送る（予約0・訪問0でも）', () => {
  const { ctx, sent } = makeCtx({ uncounted: '⚠️ <b>手動ジョブ未計上</b> 1件' });
  ctx.sendDailyReport();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /手動ジョブ未計上/);
});

test('システム変更だけの日も送る（休みの日でも変更は伝える）。欄は最後に出る', () => {
  const { ctx, sent } = makeCtx({ changes: [{ emoji: '🧾', text: '作業記録に名前が入るようになりました' }] });
  ctx.sendDailyReport();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /本日の売上[\s\S]*車屋営業状況[\s\S]*本日のシステム変更<\/b>（1件）\n　🧾 作業記録に名前が入るようになりました$/);
});

test('日報全体が 4000 字を超える時だけ、システム変更の欄を続きのメッセージで送る（省略はしない）', () => {
  const changes = [];
  for (let i = 0; i < 60; i++) changes.push({ emoji: '🔧', text: '長い説明の変更 ' + i + ' '.padEnd(60, 'あ') });
  const { ctx, sent } = makeCtx({ bookings: [BK], changes });
  ctx.sendDailyReport();
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /本日の売上/);
  assert.doesNotMatch(sent[0].text, /本日のシステム変更/);
  assert.match(sent[1].text, /^🛠 <b>本日のシステム変更<\/b>（60件）/);
  assert.match(sent[1].text, /変更 59/);
  assert.equal(sent[1].o.message_thread_id, 77);
  assert.ok(sent[0].text.length <= 4000);
});

test('予約や営業ログが読めない時は送る（不具合を隠さない）', () => {
  let r = makeCtx({ bookingsThrow: true });
  r.ctx.sendDailyReport();
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].text, /読取失敗/);
  r = makeCtx({ visitsThrow: true });
  r.ctx.sendDailyReport();
  assert.equal(r.sent.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(r.ctx.dailyReportActivity_('2026-11-01'))), { bookings: 0, visits: -1, changes: 0 });
});
