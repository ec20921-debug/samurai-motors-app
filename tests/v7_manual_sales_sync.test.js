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

const JOB_HEADERS = ['ジョブID', '予約ID', '作業状態', '開始時刻', '完了時刻', '車種', '料金(USD)', '支払区分', 'v2記録(JSON)', '提携店ID'];
const BOOKING_HEADERS = ['予約ID', '管理者メモ'];

// 2次元配列をシートのように読む（getRange(行, 列, 行数, 列数).getValues() だけ）
function fakeSheet(rows) {
  return {
    rows,
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => rows.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)),
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
  const sent = [], appended = [];
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
    getHeaderMap: () => ({ '予約ID': 1, '管理者メモ': 2 }),
    ensureJobsAmountColumn_: () => {},
    getShopNameById_: () => 'City Golf',
    getConfig: () => ({ adminGroupId: '-100' }),
    sendMessage: (bot, chatId, text) => { sent.push(text); },
    generateDateSeqId: () => 'BK-TEST-' + (appended.length + 1),
    appendRow: (name, row) => { appended.push(row); bookings.rows.push([row['予約ID'], row['管理者メモ']]); },
  });
  return { ctx, sent, appended, run: (code) => vm.runInContext(code, ctx) };
}

// 作業記録の1行（完了時刻は今の少し前＝7日以内）。v2End は v2記録(JSON) の end
function jobRow(jobId, amount, v2End) {
  const end = new Date(Date.now() - 60 * 60 * 1000);
  const start = new Date(end.getTime() - 10 * 60 * 1000);
  return [jobId, '', '完了', start, end, 'テスト', amount, 'shop', JSON.stringify({ start: {}, end: v2End }), 'SHOP-X'];
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
