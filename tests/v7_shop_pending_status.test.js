/**
 * v7: 提携店が払う仕事は、作業終了の時点で「清算済み」ではなく「要確認」（入金待ち）にする（2026-11-05 Daisuke）
 *
 * 実行: node --test "tests/*.test.js"
 *
 * v7 の実ファイル（.gs）を Node の vm に読み込み、シート・Telegram はスタブで置き換える（本番には触れない）。
 *   - 手動ジョブの売上行（ManualSales.gs）: 店の車・紹介客は 要確認・入金確認日時は空。ABA は今までどおり 清算済み
 *   - 予約客（FieldPayment.gs markBookingPaidOnSite_）: 要確認（入金確認日時は作業終了の時刻）。同じ作業の再送では書き直さない
 *   - お客様あての決済QR（PaymentManager.gs）: 要確認になった提携店の仕事にも送らない・再送でも状態を「未清算」に戻さない
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');
// vm の中で作った Date は外の Date と別物なので instanceof では見ない
const isDate = (v) => Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());

function fmt(date, tz, pattern) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  return pattern.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
}

function load(files, extra) {
  const sent = [], appended = [], updated = [];
  const ctx = {
    console, sent, appended, updated,
    Logger: { log: () => {} },
    SHEET_NAMES: { JOBS: '作業記録', BOOKINGS: '予約' },
    BOT_TYPE: { BOOKING: 'booking' },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { formatDate: fmt, parseDate: (s) => new Date(s + 'T00:00:00+07:00') },
  };
  vm.createContext(ctx);
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(V7, f), 'utf8'), ctx, { filename: f }));
  Object.assign(ctx, {
    getSpreadsheet: () => ({ getSpreadsheetTimeZone: () => 'Asia/Phnom_Penh' }),
    getShopNameById_: () => 'LUXE Auto',
    getConfig: () => ({ adminGroupId: '-100' }),
    sendMessage: (bot, chatId, text) => { sent.push(text); },
    generateDateSeqId: () => 'BK-TEST-' + (appended.length + 1),
    appendRow: (name, row) => { appended.push(row); },
    updateRow: (name, rowIndex, upd) => { updated.push(Object.assign({ sheet: name, row: rowIndex }, upd)); },
    // 重複キーの検索（売上行がまだ無い）
    getSheet: () => ({ getLastRow: () => 1 }),
    getHeaderMap: () => ({ '予約ID': 1, '管理者メモ': 2 }),
  }, extra || {});
  return ctx;
}

const manualBody = (paymentType, extra) => Object.assign({
  bookingId: '', amount: 25, name: '', carModel: 'KIA Ray', plate: '', duration: 120,
  startTime: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
  endTime: new Date(Date.now() - 3600 * 1000).toISOString(),
  paymentType,
  v2: { payment_type: paymentType, mode: 'shop', price_mode: 'agreed', agreed_price: 25 },
}, extra || {});

test('手動ジョブ: 店の車（shop）は「要確認」・入金確認日時は空・管理通知は入金待ち', () => {
  const ctx = load(['FieldShopMode.gs', 'FieldPayment.gs', 'ManualSales.gs']);
  const id = ctx.recordManualJobSaleIfNeeded_(manualBody('shop'), 'job_end', { shopId: 'SHOP-LUXE', jobId: 'JOB-1' });
  assert.equal(id, 'BK-TEST-1');
  const row = ctx.appended[0];
  assert.equal(row['決済状態'], '要確認');
  assert.equal(row['入金確認日時'], '');
  assert.equal(row['料金(USD)'], 25);       // 売上の額は今までどおり
  assert.equal(row['請求額(USD)'], 25);
  assert.ok(row['管理者メモ'].includes('｜店払い:LUXE Auto'), row['管理者メモ']);
  assert.ok(ctx.sent[0].includes('入金待ち＝要確認'), ctx.sent[0]);
  assert.ok(!ctx.sent[0].includes('清算済み'), ctx.sent[0]);
});

test('手動ジョブ: 紹介のお客さん（shopref）も「要確認」', () => {
  const ctx = load(['FieldShopMode.gs', 'FieldPayment.gs', 'ManualSales.gs']);
  ctx.recordManualJobSaleIfNeeded_(manualBody('shopref', { v2: { payment_type: 'shopref', list_price: 20, shop_rate: 30 } , amount: 14 }), 'job_end', { shopId: 'SHOP-X', jobId: 'JOB-2' });
  assert.equal(ctx.appended[0]['決済状態'], '要確認');
  assert.equal(ctx.appended[0]['入金確認日時'], '');
  assert.ok(ctx.appended[0]['管理者メモ'].includes('｜紹介:'), ctx.appended[0]['管理者メモ']);
});

test('手動ジョブ: ABA（その場で確かめて受け取った）は今までどおり「清算済み」・入金確認日時あり', () => {
  const ctx = load(['FieldShopMode.gs', 'FieldPayment.gs', 'ManualSales.gs']);
  ctx.recordManualJobSaleIfNeeded_(manualBody('aba', { v2: { payment_type: 'aba' } }), 'job_end', { jobId: 'JOB-3' });
  const row = ctx.appended[0];
  assert.equal(row['決済状態'], '清算済み');
  assert.ok(isDate(row['入金確認日時']), String(row['入金確認日時']));
  assert.ok(ctx.sent[0].includes('（清算済み）'), ctx.sent[0]);
});

const bookingRow = (status, memo) => ({ rowIndex: 7, data: { '決済状態': status || '未清算', '管理者メモ': memo || '', '料金(USD)': 30 } });

test('予約客: 現場が「店から受け取る」（shop・shopref）なら「要確認」・入金確認日時は作業終了の時刻（感想のお願いの起点）', () => {
  ['shop', 'shopref'].forEach((pt) => {
    const ctx = load(['FieldShopMode.gs', 'FieldPayment.gs']);
    const ok = ctx.markBookingPaidOnSite_(bookingRow(), { amount: 25, v2: { payment_type: pt } }, pt, 'LUXE Auto', 'SHOP-LUXE');
    assert.equal(ok, true);
    const upd = ctx.updated[0];
    assert.equal(upd['決済状態'], '要確認', pt);
    assert.ok(isDate(upd['入金確認日時']), pt);   // CustomerNotifier の感想のお願いが24時間後に出るように
    assert.equal(upd['料金(USD)'], 25);
    assert.ok(upd['管理者メモ'].startsWith('現場で受領: '), upd['管理者メモ']);
    assert.ok(ctx.fieldMemoShopPays_(upd['管理者メモ']), upd['管理者メモ']);
  });
});

test('予約客: ABA・無料は今までどおり「清算済み」', () => {
  ['aba', 'free'].forEach((pt) => {
    const ctx = load(['FieldShopMode.gs', 'FieldPayment.gs']);
    assert.equal(ctx.markBookingPaidOnSite_(bookingRow(), { amount: pt === 'free' ? 0 : 25 }, pt, '', ''), true);
    assert.equal(ctx.updated[0]['決済状態'], '清算済み', pt);
    assert.ok(isDate(ctx.updated[0]['入金確認日時']), pt);
  });
});

test('予約客: 同じ作業の再送では書き直さない（要確認・清算済みのどちらでも）', () => {
  const ctx = load(['FieldShopMode.gs', 'FieldPayment.gs']);
  assert.equal(ctx.markBookingPaidOnSite_(bookingRow('要確認', '現場で受領: 店の車・店から QR・LUXE Auto $25'), { amount: 25 }, 'shop', 'LUXE Auto', ''), true);
  assert.equal(ctx.markBookingPaidOnSite_(bookingRow('清算済み', '現場で受領: ABA QR $25'), { amount: 25 }, 'aba', '', ''), true);
  assert.equal(ctx.updated.length, 0);
});

test('お客様のスクショで「要確認」になった予約（現場で受領 なし）は、現場の記録で上書きする', () => {
  const ctx = load(['FieldShopMode.gs', 'FieldPayment.gs']);
  assert.equal(ctx.markBookingPaidOnSite_(bookingRow('要確認', ''), { amount: 25 }, 'aba', '', ''), true);
  assert.equal(ctx.updated[0]['決済状態'], '清算済み');
});

test('管理者メモの判定: 提携店が払う仕事だけを拾う', () => {
  const ctx = load(['FieldShopMode.gs', 'FieldPayment.gs']);
  assert.equal(ctx.fieldMemoShopPays_('客名:LUXE Auto｜手動ジョブ売上｜店払い:LUXE Auto（お店と決めた金額）｜MS:x'), true);
  assert.equal(ctx.fieldMemoShopPays_('客名:A｜手動ジョブ売上｜紹介:City Golf（定価$20・お店30%）'), true);
  assert.equal(ctx.fieldMemoShopPays_('現場で受領: 紹介客・店から QR・City Golf $14'), true);
  assert.equal(ctx.fieldMemoShopPays_('メモ｜現場で受領: 店の車・店から QR $25'), true);
  assert.equal(ctx.fieldMemoShopPays_('現場で受領: ABA QR $25'), false);
  assert.equal(ctx.fieldMemoShopPays_('客名:A｜手動ジョブ売上｜No.2P-3297｜MS:x'), false);
  assert.equal(ctx.fieldMemoShopPays_(''), false);
  assert.equal(ctx.fieldMemoShopPays_(undefined), false);
});

function loadPayment(bkData) {
  const failures = [];
  const ctx = load(['FieldShopMode.gs', 'FieldPayment.gs', 'PaymentManager.gs'], {
    findRow: () => ({ rowIndex: 9, data: bkData }),
    notifyAdminQRFailure_: (id, reason) => { failures.push(reason); },
  });
  return { ctx, failures };
}

test('決済QR: 提携店の仕事（予約客・現場で受領: 店の車）は、状態が手で未清算に戻されていても送らない', () => {
  const { ctx, failures } = loadPayment({ '予約ID': 'BK-1', '決済状態': '未清算', '管理者メモ': '現場で受領: 店の車・店から QR・LUXE Auto $25', 'チャットID': '123' });
  const res = ctx.sendPaymentQR_locked_('BK-1', {}, []);
  assert.deepEqual(JSON.parse(JSON.stringify(res)), { ok: false, reason: 'SHOP_PAYS' });
  assert.equal(failures.length, 0);
});

test('決済QR: 手動ジョブの売上行（｜店払い:）にも送らない（状態が未清算でも）', () => {
  const { ctx } = loadPayment({ '予約ID': 'BK-2', '決済状態': '未清算', '管理者メモ': '客名:LUXE Auto｜手動ジョブ売上｜店払い:LUXE Auto（お店と決めた金額）', 'チャットID': '' });
  assert.equal(ctx.sendPaymentQR_locked_('BK-2', {}, []).reason, 'SHOP_PAYS');
});

test('決済QR の再送: 提携店が払う仕事は、状態を「未清算」に戻さずに止める', () => {
  const { ctx } = loadPayment({ '予約ID': 'BK-3', '決済状態': '要確認', '管理者メモ': '客名:LUXE Auto｜手動ジョブ売上｜店払い:LUXE Auto', 'チャットID': '' });
  const res = ctx.retryPaymentQR('BK-3');
  assert.equal(res.reason, 'SHOP_PAYS');
  assert.equal(ctx.updated.length, 0);   // 決済状態・QR送信日時を書き換えていない
});

test('決済QR: 要確認の予約には、管理者メモの目印が無くても送らない（手でメモを消した時の守り）', () => {
  const { ctx, failures } = loadPayment({ '予約ID': 'BK-4', '決済状態': '要確認', '管理者メモ': '', 'チャットID': '123' });
  assert.equal(ctx.sendPaymentQR_locked_('BK-4', {}, []).reason, 'NEEDS_CHECK');
  assert.equal(failures.length, 0);
});
