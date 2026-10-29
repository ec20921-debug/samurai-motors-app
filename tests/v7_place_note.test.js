/**
 * v7: 予約画面の「場所のメモ」（2026-10-29）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * v7 の実ファイル（.gs）を Node の vm に読み込み、シートはスタブで置き換える（本番には触れない）。
 *   - bookingPlaceNote_: 出張だけ・改行や制御文字は空白・先頭の = + - @ を外す・200字まで
 *   - apiBookingToday: 現場アプリへ 住所 と 場所補足 を address / placeNote で渡す（列が無い古いシートでも落ちない）
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');

function load(files, extra) {
  const ctx = Object.assign({ console, Logger: { log: () => {} } }, extra || {});
  vm.createContext(ctx);
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(V7, f), 'utf8'), ctx, { filename: f }));
  return ctx;
}

test('場所のメモ: 出張だけ使う（店舗・流入元の固定場所は空）', () => {
  const ctx = load(['SourceCampaign.gs', 'BookingLogic.gs']);
  assert.equal(ctx.bookingPlaceNote_('Vattanac Tower B2', false, '出張'), 'Vattanac Tower B2');
  assert.equal(ctx.bookingPlaceNote_('Vattanac Tower B2', false, '店舗'), '');
  assert.equal(ctx.bookingPlaceNote_('Vattanac Tower B2', true, '出張'), '');
  assert.equal(ctx.bookingPlaceNote_('', false, '出張'), '');
  assert.equal(ctx.bookingPlaceNote_(undefined, false, '出張'), '');
});

test('場所のメモ: 改行・制御文字は空白、先頭の = + - @ は外す、200字まで', () => {
  const ctx = load(['SourceCampaign.gs', 'BookingLogic.gs']);
  assert.equal(ctx.bookingPlaceNote_('Gate 2\nB2 parking\t\tnear lift', false, '出張'), 'Gate 2 B2 parking near lift');
  assert.equal(ctx.bookingPlaceNote_('=IMPORTXML("http://x")', false, '出張'), 'IMPORTXML("http://x")');
  assert.equal(ctx.bookingPlaceNote_('  +@-B1', false, '出張'), 'B1');
  assert.equal(ctx.bookingPlaceNote_('ជាន់ B2 ក្បែរជណ្ដើរយន្ត', false, '出張'), 'ជាន់ B2 ក្បែរជណ្ដើរយន្ត');
  assert.equal(ctx.bookingPlaceNote_('x'.repeat(300), false, '出張').length, 200);
});

function bookingsSheet(headers, rows) {
  const map = {}; headers.forEach((h, i) => { map[h] = i + 1; });
  return {
    map,
    sheet: { getLastRow: () => rows.length + 1, getLastColumn: () => headers.length,
      getRange: () => ({ getValues: () => rows.map((r) => headers.map((h) => (h in r ? r[h] : ''))) }) }
  };
}
function loadJobs(headers, rows) {
  const { map, sheet } = bookingsSheet(headers, rows);
  const pad = (n) => String(n).padStart(2, '0');
  return load(['JobManager.gs'], {
    SHEET_NAMES: { BOOKINGS: '予約', JOBS: '作業記録' },
    getSheet: () => sheet,
    getHeaderMap: () => map,
    getSpreadsheet: () => ({ getSpreadsheetTimeZone: () => 'Asia/Phnom_Penh' }),
    Utilities: { formatDate: (d) => { const p = new Date(d.getTime() + 7 * 3600e3);
      return p.getUTCFullYear() + '-' + pad(p.getUTCMonth() + 1) + '-' + pad(p.getUTCDate()); } },
    findCustomerRow: () => ({ data: { '氏名': 'Test Customer' } }),
    calcEndTime: () => '11:30'
  });
}
const todayPP = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const BASE = ['予約ID', 'チャットID', '車種タイプ', '車種名', 'プラン', 'オプション', '予約日', '予約時刻', '所要時間(分)', '料金(USD)', '進行状態', 'マップリンク', 'サービスタイプ'];
const ROW = { '予約ID': 'BK-1', 'チャットID': '123', '車種タイプ': 'セダン', 'プラン': '清 KIYOME (A)', '予約日': '', '予約時刻': '10:00',
  '所要時間(分)': 90, '料金(USD)': 25, '進行状態': '予約確定', 'マップリンク': 'https://www.google.com/maps?q=11.55,104.92', 'サービスタイプ': '出張' };

test('予約一覧: 住所 と 場所補足 を現場アプリへ渡す', () => {
  const ctx = loadJobs(BASE.concat(['住所', '場所補足']),
    [Object.assign({}, ROW, { '予約日': todayPP(), '住所': 'Street 271', '場所補足': 'Vattanac Tower B2' })]);
  const res = ctx.apiBookingToday();
  assert.equal(res.status, 'ok');
  assert.equal(res.bookings.length, 1);
  assert.equal(res.bookings[0].placeNote, 'Vattanac Tower B2');
  assert.equal(res.bookings[0].address, 'Street 271');
  assert.equal(res.bookings[0].location, 'https://www.google.com/maps?q=11.55,104.92', '場所は今までどおり地図リンクを優先');
});

test('予約一覧: 住所・場所補足の列が無い古いシートでも空で返す', () => {
  const ctx = loadJobs(BASE, [Object.assign({}, ROW, { '予約日': todayPP() })]);
  const res = ctx.apiBookingToday();
  assert.equal(res.status, 'ok');
  assert.equal(res.bookings[0].placeNote, '');
  assert.equal(res.bookings[0].address, '');
});
