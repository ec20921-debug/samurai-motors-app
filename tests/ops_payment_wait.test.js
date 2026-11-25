/**
 * v7-operations: 日報の「💵 入金待ち」欄（2026-11-25 Daisuke 要望）
 *
 * 実行: node --test "tests/*.test.js"
 *
 * PaymentWaitSection.gs を Node の vm に読み込み、シートはスタブで置き換える（本番には触れない）。
 *   - 作業完了・清算済みでない・金額 > 0 の行だけを、会社ごとに「何台・何ドル（いつの作業）」で出す
 *   - キャンセル・清算済み・0$（無料施工）は数えない
 *   - 「入金待ちメモ」タブのメモは、その会社に入金待ちがある時だけ出す
 *   - 入金待ちがゼロなら「なし」の1行、読めない時は読取失敗を1行
 *   - 日報の中では本日の売上のすぐ下に出る
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPS = path.join(__dirname, '..', 'v7-operations');

const HDR = ['予約ID', '予約日', '料金(USD)', '進行状態', '決済状態', '請求額(USD)', '管理者メモ'];

function bk(id, day, amt, prog, pay, memo) {
  return [id, day, amt, prog, pay, amt, memo];
}

function makeCtx(bookRows, memoRows, opts) {
  opts = opts || {};
  const sheets = {
    '予約': [HDR].concat(bookRows),
    '入金待ちメモ': memoRows ? [['客名', 'メモ', '更新日']].concat(memoRows) : null
  };
  const sheetStub = (data) => ({
    getLastRow: () => data.length,
    getLastColumn: () => data[0].length,
    getRange: (r, c, nr, nc) => ({ getValues: () => data.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc)) })
  });
  const ctx = {
    console,
    Logger: { log: () => {} },
    OPS_TZ: 'Asia/Phnom_Penh',
    Utilities: { formatDate: (d) => d.toISOString().substring(0, 10) },
    getConfig: () => ({ v7SpreadsheetId: 'v7-sheet' }),
    SpreadsheetApp: {
      openById: () => {
        if (opts.throws) throw new Error('v7 unavailable');
        return {
          getSpreadsheetTimeZone: () => 'Asia/Phnom_Penh',
          getSheetByName: (n) => (sheets[n] ? sheetStub(sheets[n]) : null)
        };
      }
    },
    escapeHtml_: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    isCancelledStatus_: (s) => s === 'キャンセル',
    isCompletedStatus_: (s) => s === '作業完了'
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(OPS, 'PaymentWaitSection.gs'), 'utf8'), ctx, { filename: 'PaymentWaitSection.gs' });
  return ctx;
}

const LUXE = '客名:LUXE Auto｜手動ジョブ売上｜店払い:LUXE Auto（お店と決めた金額）';

// 2026-11-25 時点の本番と同じ形（LUXE Auto 5台 110$ が入金待ち）
const ROWS = [
  bk('BK-20261117-002', '2026/11/17', 10, '作業完了', '清算済み', LUXE),
  bk('BK-20261118-001', '2026/11/18', 25, '作業完了', 'QR送信済み', LUXE),
  bk('BK-20261118-002', '2026/11/18', 20, '作業完了', 'QR送信済み', LUXE),
  bk('BK-20261119-001', '2026/11/19', 20, '作業完了', 'QR送信済み', LUXE),
  bk('BK-20261119-003', '2026/11/19', 20, '作業完了', 'QR送信済み', LUXE),
  bk('BK-20261121-001', '2026/11/21', 25, '作業完了', 'QR送信済み', LUXE),
  bk('BK-20261026-002', '2026/10/27', 12, 'キャンセル', '未清算', ''),
  bk('BK-20261025-001', '2026/10/25', 0, '作業完了', '要確認', '客名:CRSP｜無料施工'),
  bk('BK-20261120-002', '2026/11/20', 20, '作業完了', '清算済み', '客名:ហាក់ ហេង 168｜手動ジョブ売上')
];

test('会社ごとに何台・何ドル（いつの作業）。清算済み・キャンセル・0$ は数えない', () => {
  const text = makeCtx(ROWS, null).buildPaymentWaitSection_();
  assert.equal(text, '💵 <b>入金待ち</b>（合計 5台・110$）\n　LUXE Auto：5台・<b>110$</b>（11/18〜11/21 の作業）');
});

test('入金待ちメモがあれば、その会社の行の下に出る（入金待ちのない会社のメモは出さない）', () => {
  const memos = [
    ['LUXE Auto', '11/21 に請求書を手渡し。水祭りが終わったら払うと言われた', new Date('2026-11-25T00:00:00Z')],
    ['ហាក់ ហេង 168', '古いメモ', '2026-11-01']
  ];
  const text = makeCtx(ROWS, memos).buildPaymentWaitSection_();
  assert.match(text, /LUXE Auto：5台・<b>110\$<\/b>（11\/18〜11\/21 の作業）\n　　↳ 11\/21 に請求書を手渡し。水祭りが終わったら払うと言われた（11\/25）$/);
  assert.doesNotMatch(text, /古いメモ/);
});

test('複数の会社は金額の大きい順。客名の無い Bot 予約は「個人のお客様」にまとめる。端数は小数2桁', () => {
  const rows = ROWS.concat([
    bk('BK-20261124-001', '2026/11/24', 10.5, '作業完了', '未清算', ''),
    bk('BK-20261124-002', '2026/11/24', 300, '作業完了', '要確認', '客名:Picasso Staff｜BODY')
  ]);
  const text = makeCtx(rows, null).buildPaymentWaitSection_();
  assert.match(text, /^💵 <b>入金待ち<\/b>（合計 7台・420\.50\$）\n　Picasso Staff：1台・<b>300\$<\/b>（11\/24 の作業）\n　LUXE Auto：5台[^\n]*\n　個人のお客様（Bot 予約）：1台・<b>10\.50\$<\/b>（11\/24 の作業）$/);
});

test('入金待ちがゼロなら「なし」の1行', () => {
  const rows = ROWS.map((r) => r.slice()).map((r) => { r[4] = '清算済み'; return r; });
  assert.equal(makeCtx(rows, null).buildPaymentWaitSection_(), '💵 <b>入金待ち</b>: なし');
});

test('予約シートが読めない時は読取失敗を1行（日報は止めない）', () => {
  assert.match(makeCtx(ROWS, null, { throws: true }).buildPaymentWaitSection_(), /入金待ち<\/b>\n　（予約シートの読取失敗: Error: v7 unavailable）/);
});

test('日報の中では本日の売上のすぐ下に出る', () => {
  const sent = [];
  const ctx = makeCtx(ROWS, null);
  Object.assign(ctx, {
    BOT_TYPE: { INTERNAL: 'internal' },
    getConfig: () => ({ adminDailyReportThreadId: '77', adminGroupId: '-100', v7SpreadsheetId: 'v7-sheet' }),
    sendMessage: (bot, chatId, text) => sent.push(text),
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {} }) },
    readSystemChangesForDate_: () => [],
    buildSystemChangesSection_: () => '',
    buildOsoujiSection_: () => '',
    buildNihongoSection_: () => ''
  });
  vm.runInContext(fs.readFileSync(path.join(OPS, 'DailyReport.gs'), 'utf8'), ctx, { filename: 'DailyReport.gs' });
  ctx.Utilities = { formatDate: () => '2026-11-25' };
  ctx.readV7BookingsForDate_ = () => [{ 'プラン': '', 'オプション': 'BODY', '料金(USD)': 25, '進行状態': '作業完了', '決済状態': 'QR送信済み' }];
  ctx.buildManualJobUncountedSection_ = () => '';
  ctx.buildSalesLogSection_ = () => '🤝 <b>車屋営業状況</b>（stub）';
  ctx.dailyReportActivity_ = () => ({ bookings: 1, visits: 0, changes: 0 });
  ctx.sendDailyReport();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /決済状況[\s\S]*\n\n💵 <b>入金待ち<\/b>（合計 5台・110\$）[\s\S]*\n\n🤝 <b>車屋営業状況/);
});
