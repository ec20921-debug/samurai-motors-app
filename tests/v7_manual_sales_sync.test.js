/**
 * v7: 手動ジョブ売上の毎時安全網シンク（ManualSales.gs syncMissingManualJobSales）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * v7 の実ファイル（.gs）を Node の vm に読み込み、シート・Telegram はスタブで置き換える（本番には触れない）。
 *   - 現場アプリ「お店の仕事」の店の車（v2記録(JSON) の end.price_mode = 'agreed'）は、
 *     毎時シンクで作り直しても実時間の job_end と同じ「お店と決めた金額」で記録・通知する（2026-10-30）
 *   - 古いアプリの行（price_mode なし）は今までどおり「定価・お店の率」
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');
const FILES = ['FieldShopMode.gs', 'FieldPayment.gs', 'ManualSales.gs'];

const JOB_HEADERS = ['ジョブID', '予約ID', '作業状態', '開始時刻', '完了時刻', '車種', '料金(USD)', '支払区分', 'v2記録(JSON)', '提携店ID', '売上予約ID'];
const BOOKING_HEADERS = ['予約ID', '管理者メモ'];
const headerMap = (headers) => headers.reduce((m, h, i) => { m[h] = i + 1; return m; }, {});

// 2次元配列をシートのように読む（getRange(行, 列, 行数, 列数).getValues() だけ）
function fakeSheet(rows) {
  return {
    rows,
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
      getValue: () => (rows[r - 1] || [])[c - 1],
    }),
  };
}

function fmt(date, tz, pattern) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
}

function loadV7(jobRows) {
  const sent = [], appended = [], updated = [];
  const jobs = fakeSheet([JOB_HEADERS].concat(jobRows));
  const bookings = fakeSheet([BOOKING_HEADERS]);
  const ctx = {
    console, sent, appended,
    Logger: { log: () => {} },
    SHEET_NAMES: { JOBS: '作業記録', BOOKINGS: '予約' },
    BOT_TYPE: { BOOKING: 'booking' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { formatDate: fmt, parseDate: (s) => new Date(s + 'T00:00:00+07:00') },
  };
  vm.createContext(ctx);
  FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(V7, f), 'utf8'), ctx, { filename: f }));
  Object.assign(ctx, {
    getSpreadsheet: () => ({ getSpreadsheetTimeZone: () => 'Asia/Phnom_Penh' }),
    getSheet: (name) => (name === '作業記録' ? jobs : bookings),
    getHeaderMap: (name) => headerMap(name === '作業記録' ? JOB_HEADERS : BOOKING_HEADERS),
    readRow: (name, rowIndex) => {
      const hs = name === '作業記録' ? JOB_HEADERS : BOOKING_HEADERS;
      const row = (name === '作業記録' ? jobs : bookings).rows[rowIndex - 1] || [];
      return hs.reduce((o, h, i) => { o[h] = row[i]; return o; }, {});
    },
    // 作業記録への書き戻し（売上予約ID）を記録し、シートにも反映する
    updateRow: (name, rowIndex, upd) => {
      updated.push(Object.assign({ sheet: name, row: rowIndex }, upd));
      const hm = headerMap(name === '作業記録' ? JOB_HEADERS : BOOKING_HEADERS);
      const rows = (name === '作業記録' ? jobs : bookings).rows;
      Object.keys(upd).forEach((k) => { if (hm[k]) rows[rowIndex - 1][hm[k] - 1] = upd[k]; });
    },
    ensureJobsAmountColumn_: () => {},
    getShopNameById_: () => 'City Golf',
    getConfig: () => ({ adminGroupId: '-100' }),
    sendMessage: (bot, chatId, text) => { sent.push(text); },
    generateDateSeqId: () => 'BK-TEST-' + (appended.length + 1),
    appendRow: (name, row) => { appended.push(row); bookings.rows.push([row['予約ID'], row['管理者メモ']]); },
  });
  return { ctx, sent, appended, updated, run: (code) => vm.runInContext(code, ctx) };
}

// 作業記録の1行（完了時刻は今の少し前＝7日以内）。v2End は v2記録(JSON) の end。saleBookingId は「売上予約ID」（既に結ばれた行）
function jobRow(jobId, amount, v2End, saleBookingId) {
  const end = new Date(Date.now() - 60 * 60 * 1000);
  const start = new Date(end.getTime() - 10 * 60 * 1000);
  return [jobId, '', '完了', start, end, 'テスト', amount, 'shop', JSON.stringify({ start: {}, end: v2End }), 'SHOP-X', saleBookingId || ''];
}

test('毎時シンク: お店と決めた金額（price_mode=agreed）は実時間と同じ表示で作り直す', () => {
  const { ctx, sent, appended } = loadV7([
    jobRow('JOB-1', 10, { payment_type: 'shop', list_price: 20, shop_rate: 30, mode: 'shop', price_mode: 'agreed', agreed_price: 10, guide_price: 14 }),
  ]);
  assert.equal(ctx.syncMissingManualJobSales(), 1);
  const memo = appended[0]['管理者メモ'];
  assert.ok(memo.includes('店払い:City Golf（お店と決めた金額）'), memo);
  assert.ok(!memo.includes('定価$20'), '定価×率ではないので定価を書かない: ' + memo);
  assert.ok(sent[0].includes('・お店と決めた金額）'), sent[0]);
  assert.ok(!sent[0].includes('定価 $20'), sent[0]);
});

test('毎時シンク: 古いアプリの行（price_mode なし）は今までどおり定価・お店の率', () => {
  const { ctx, sent, appended } = loadV7([
    jobRow('JOB-2', 8.4, { payment_type: 'shop', list_price: 12, shop_rate: 30 }),
  ]);
  assert.equal(ctx.syncMissingManualJobSales(), 1);
  assert.ok(appended[0]['管理者メモ'].includes('店払い:City Golf（定価$12・お店30%）'), appended[0]['管理者メモ']);
  assert.ok(sent[0].includes('定価 $12・お店 30%'), sent[0]);
});

test('毎時シンク: 計上済み（重複キーあり）なら作り直さない', () => {
  const { ctx, appended } = loadV7([
    jobRow('JOB-3', 10, { payment_type: 'shop', list_price: 20, shop_rate: 30, price_mode: 'agreed' }),
  ]);
  assert.equal(ctx.syncMissingManualJobSales(), 1);
  assert.equal(ctx.syncMissingManualJobSales(), 0);
  assert.equal(appended.length, 1);
});

test('毎時シンク: 作った売上行の番号を作業記録「売上予約ID」に書き戻す（作業↔売上を番号で結ぶ・2026-10-31）', () => {
  const { ctx, appended, updated } = loadV7([
    jobRow('JOB-4', 10, { payment_type: 'shop', list_price: 20, shop_rate: 30, price_mode: 'agreed' }),
  ]);
  assert.equal(ctx.syncMissingManualJobSales(), 1);
  assert.equal(appended[0]['予約ID'], 'BK-TEST-1');
  assert.deepEqual(JSON.parse(JSON.stringify(updated)), [{ sheet: '作業記録', row: 2, '売上予約ID': 'BK-TEST-1' }]);
  // 2回目: 番号が入った行は管理者メモを見ずに計上済みと判断する
  assert.equal(ctx.syncMissingManualJobSales(), 0);
  assert.equal(updated.length, 1);
});

test('毎時シンク: 「売上予約ID」が入っていて、その予約が残っている行（既に結ばれた作業）は対象外', () => {
  const t = loadV7([
    jobRow('JOB-5', 10, { payment_type: 'shop', list_price: 20, shop_rate: 30 }, 'BK-20261031-001'),
  ]);
  t.ctx.getSheet('予約').rows.push(['BK-20261031-001', '客名:｜手動ジョブ売上｜MS:x']);
  assert.equal(t.ctx.syncMissingManualJobSales(), 0);
  assert.equal(t.appended.length, 0);
  assert.equal(t.updated.length, 0);
});

test('毎時シンク: 「売上予約ID」の行き先（売上行）を手で消していたら、従来どおり作り直して番号を書き直す', () => {
  const { ctx, appended, updated } = loadV7([
    jobRow('JOB-6', 10, { payment_type: 'shop', list_price: 20, shop_rate: 30, price_mode: 'agreed' }, 'BK-GONE'),
  ]);
  assert.equal(ctx.syncMissingManualJobSales(), 1);
  assert.equal(appended.length, 1);
  assert.equal(updated[0]['売上予約ID'], 'BK-TEST-1');
});

test('毎時シンク: 計上済み（重複キーあり）で番号が未記入の行には、見つかった売上行の番号を結ぶ（後から直る）', () => {
  const t = loadV7([
    jobRow('JOB-7', 10, { payment_type: 'shop', list_price: 20, shop_rate: 30, price_mode: 'agreed' }),
  ]);
  // 先に売上行だけある（導入前に計上された・または書き戻しが失敗した）状態を作る
  assert.equal(t.ctx.syncMissingManualJobSales(), 1);
  const memo = t.appended[0]['管理者メモ'];
  t.updated.length = 0;
  t.ctx.getSheet('作業記録').rows[1][JOB_HEADERS.indexOf('売上予約ID')] = '';   // 番号を消す
  assert.equal(t.ctx.syncMissingManualJobSales(), 0);          // 作り直さない
  assert.equal(t.appended.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(t.updated)), [{ sheet: '作業記録', row: 2, '売上予約ID': 'BK-TEST-1' }]);
  assert.ok(memo.includes('MS:'), memo);
});

test('書き戻しの単体: 行番号や予約IDが無い・列が無い・行のジョブIDが違う・例外 は false', () => {
  const { ctx, updated } = loadV7([
    jobRow('JOB-8', 10, { payment_type: 'shop' }),
  ]);
  assert.equal(ctx.manualSaleLinkJob_(0, 'BK-X'), false);
  assert.equal(ctx.manualSaleLinkJob_(2, ''), false);
  assert.equal(ctx.manualSaleLinkJob_(2, 'BK-X', 'JOB-OTHER'), false);   // 一括読みの後に行がずれた
  assert.equal(updated.length, 0);
  assert.equal(ctx.manualSaleLinkJob_(2, 'BK-X', 'JOB-8'), true);
  assert.equal(updated.length, 1);
  const hm = ctx.getHeaderMap;
  ctx.getHeaderMap = (name) => { const m = hm(name); delete m['売上予約ID']; return m; };   // 列が足せなかった
  assert.equal(ctx.manualSaleLinkJob_(2, 'BK-Y'), false);
  ctx.getHeaderMap = hm;
  ctx.updateRow = () => { throw new Error('sheet busy'); };
  assert.equal(ctx.manualSaleLinkJob_(2, 'BK-Z'), false);
});
