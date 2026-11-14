/**
 * v7-operations: 週次売上レポート（WeeklySalesReport.gs・2026-11-14 Daisuke 指示）
 *
 * 実行: node --test "tests/*.test.js"
 *
 *   - 土曜 20:00〜20:29 JST だけ送る・同じ日に2回送らない
 *   - 週は日曜〜土曜。先週は その前の7日
 *   - 売上・件数・サービス明細に先週比が付く。キャンセルは入れない
 *   - 今週も先週も0件なら送らない。読めない時は送って知らせる
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPS = path.join(__dirname, '..', 'v7-operations');

function makeCtx(opts) {
  opts = Object.assign({ rows: [], readThrow: false, dow: '6', hm: '20:05', today: '2026-11-14' }, opts || {});
  const sent = [];
  const store = {};
  const ranges = [];
  const ctx = {
    console,
    Logger: { log: () => {} },
    OPS_TZ: 'Asia/Phnom_Penh',
    BOT_TYPE: { INTERNAL: 'internal' },
    Utilities: { formatDate: (d, tz, fmt) => (fmt === 'u' ? opts.dow : fmt === 'HH:mm' ? opts.hm : opts.today) },
    SpreadsheetApp: { openById: () => ({ getSpreadsheetTimeZone: () => 'Asia/Phnom_Penh' }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => store[k] || null, setProperty: (k, v) => { store[k] = v; } }) },
    getConfig: () => ({ adminDailyReportThreadId: '77', adminGroupId: '-100', v7SpreadsheetId: 'v7-sheet' }),
    sendMessage: (bot, chatId, text, o) => sent.push({ bot, chatId, text, o }),
    escapeHtml_: (s) => String(s),
    isCancelledStatus_: (s) => s === 'キャンセル'
  };
  vm.createContext(ctx);
  // computeV7WeeklyKpi_ / bookingPlanLabel_ は本物（DailyReport.gs）を使う
  vm.runInContext(fs.readFileSync(path.join(OPS, 'DailyReport.gs'), 'utf8'), ctx, { filename: 'DailyReport.gs' });
  vm.runInContext(fs.readFileSync(path.join(OPS, 'WeeklySalesReport.gs'), 'utf8'), ctx, { filename: 'WeeklySalesReport.gs' });
  ctx.readV7BookingsInRange_ = (id, from, to) => {
    ranges.push([from, to]);
    if (opts.readThrow) throw new Error('v7 unavailable');
    return opts.rows.filter((r) => r['予約日'] >= from && r['予約日'] <= to);
  };
  return { ctx, sent, ranges };
}

function bk(date, plan, amt, cust, extra) {
  return Object.assign({ '予約日': date, 'プラン': plan, '料金(USD)': amt, '顧客ID': cust, '進行状態': '作業完了', '決済状態': '清算済み' }, extra || {});
}

const ROWS = [
  // 今週（11/08 日 〜 11/14 土）
  bk('2026-11-08', 'SAMURAI WASH (W)', 12, 'C1'),
  bk('2026-11-10', 'SAMURAI WASH (W)', 12, 'C2', { '決済状態': 'QR送信済み' }),
  bk('2026-11-14', '', 30, 'C3', { 'オプション': 'BODY' }),
  bk('2026-11-12', 'SAMURAI WASH (W)', 12, 'C4', { '進行状態': 'キャンセル' }),
  // 先週（11/01 〜 11/07）
  bk('2026-11-01', 'SAMURAI WASH (W)', 12, 'C1'),
  bk('2026-11-07', 'GLASS', 20, 'C5'),
  // 範囲の外
  bk('2026-10-31', 'SAMURAI WASH (W)', 12, 'C9')
];

test('土曜 20:05 JST → 送る。2週間分を読み、日曜〜土曜で分ける', () => {
  const { ctx, sent, ranges } = makeCtx({ rows: ROWS });
  ctx.maybeSendWeeklySalesReport_();
  assert.equal(sent.length, 1);
  assert.deepEqual(ranges[0], ['2026-11-01', '2026-11-14']);
  const t = sent[0].text;
  assert.match(t, /11\/08\(日\) 〜 11\/14\(土\)/);
  assert.match(t, /売上: \$54\.00/);               // 12+12+30（キャンセルは入れない）
  assert.match(t, /📈 \+\$22\.00（\+69%）（先週 \$32\.00）/);
  assert.match(t, /作業: <b>3件<\/b>　📈 \+1件/);
  assert.match(t, /キャンセル: 1件/);
  assert.equal(sent[0].o.message_thread_id, 77);
});

test('サービス明細: 売上の多い順・先週比・先週だけのサービスは 0件', () => {
  const { ctx, sent } = makeCtx({ rows: ROWS });
  ctx.sendWeeklySalesReport('2026-11-14');
  const t = sent[0].text;
  assert.ok(t.indexOf('🥇 BODY: <b>1件 / $30.00</b>') >= 0);
  assert.ok(t.indexOf('🆕 先週はなし') > t.indexOf('BODY'));
  assert.ok(t.indexOf('🥈 SAMURAI WASH (W): <b>2件 / $24.00</b>') >= 0);
  assert.ok(t.indexOf('📈 +1件・📈 +$12.00') >= 0);
  assert.ok(t.indexOf('💤 GLASS: <b>0件 / $0.00</b>') >= 0);
  assert.ok(t.indexOf('📉 −1件・📉 −$20.00') >= 0);
  assert.match(t, /清算済み: 2件　⏳ まだ: 1件（\$12\.00）/);
});

test('土曜以外・時刻の外は送らない', () => {
  let r = makeCtx({ rows: ROWS, dow: '5' }); r.ctx.maybeSendWeeklySalesReport_(); assert.equal(r.sent.length, 0);
  r = makeCtx({ rows: ROWS, hm: '19:59' }); r.ctx.maybeSendWeeklySalesReport_(); assert.equal(r.sent.length, 0);
  r = makeCtx({ rows: ROWS, hm: '20:30' }); r.ctx.maybeSendWeeklySalesReport_(); assert.equal(r.sent.length, 0);
});

test('同じ土曜に2回呼ばれても1回だけ', () => {
  const { ctx, sent } = makeCtx({ rows: ROWS });
  ctx.maybeSendWeeklySalesReport_();
  ctx.maybeSendWeeklySalesReport_();
  assert.equal(sent.length, 1);
});

test('今週も先週も0件 → 送らない／読めない時 → 送って知らせる', () => {
  let r = makeCtx({ rows: [] }); r.ctx.sendWeeklySalesReport('2026-11-14'); assert.equal(r.sent.length, 0);
  r = makeCtx({ readThrow: true }); r.ctx.sendWeeklySalesReport('2026-11-14');
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0].text, /読取失敗/);
});

test('先週が0円でも ％ を出さずに壊れない・月またぎの日付', () => {
  const { ctx, sent } = makeCtx({ rows: [bk('2026-12-01', 'SAMURAI WASH (W)', 12, 'C1')] });
  ctx.sendWeeklySalesReport('2026-12-05');
  assert.match(sent[0].text, /11\/29\(日\) 〜 12\/05\(土\)/);
  assert.match(sent[0].text, /📈 \+\$12\.00（先週 \$0\.00）/);
});
