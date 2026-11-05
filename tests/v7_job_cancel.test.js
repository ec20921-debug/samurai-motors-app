/**
 * v7: 現場アプリの「この作業を取り消す（アプリのテスト・押し間違い）」のサーバー側（2026-11-05 JobCancel.gs）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * v7 の実ファイル（.gs）を Node の vm に読み込み、シート・Telegram はスタブで置き換える（本番には触れない）。
 *   - 作業記録の行を「中断」にし、v2記録(JSON) に取り消しを残す。管理グループに1回だけ知らせる
 *   - 開始が届いていない（行が無い）時は ok・何も書かない
 *   - 予約つき・作業終了が届いた行は受け付けない（retryable=false＝端末で要確認）
 *   - 2回目は duplicate（通知もしない）／管理通知が失敗しても取り消しは ok
 *   - 受け口（Router.gs）とスタッフ限定（StaffGate.gs）に job_cancel がある
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');
const JOB_CID = '9f3b8383-7a10-4147-86df-459636f90362';
const CANCEL_CID = '0b8d2c51-1111-4222-8333-944455556666';

function startJson(extra) {
  return JSON.stringify({ start: Object.assign({ checks: {}, no_damage: true, photo_slots: [], damage: [],
    shop_id: 'SHOP-20260929-164743-b8040692', residence_id: '', residence_who: '', mode: 'shop', who: 'shop', agreed_price: 19.4 }, extra || {}) });
}

function loadV7(rows, opts) {
  opts = opts || {};
  const sent = [], updates = [];
  let lockOk = opts.lockOk !== false;
  const ctx = {
    console, sent, updates,
    Logger: { log: () => {} },
    SHEET_NAMES: { JOBS: '作業記録' },
    BOT_TYPE: { BOOKING: 'booking' },
    LockService: { getScriptLock: () => ({ tryLock: () => lockOk, releaseLock: () => {} }) },
    SpreadsheetApp: { flush: () => {} },
    Utilities: { formatDate: (d, tz, f) => 'PP(' + d.toISOString().slice(0, 16) + ')' },
    getConfig: () => ({ adminGroupId: '-100admin' }),
    sendMessage: (bot, chatId, text, o) => {
      if (opts.sendThrows) throw new Error('telegram down');
      sent.push({ bot, chatId, text, o }); return { ok: true };
    },
    findRow: (sheet, col, val) => {
      const i = rows.findIndex((r) => String(r[col]) === String(val));
      return i < 0 ? null : { rowIndex: i + 2, data: Object.assign({}, rows[i]) };
    },
    updateRow: (sheet, rowIndex, obj) => { updates.push({ rowIndex, obj }); Object.assign(rows[rowIndex - 2], obj); },
    sheetSafeText_: (v) => String(v),
    getShopNameById_: (id) => (id === 'SHOP-20260929-164743-b8040692' ? 'LUXE Auto' : ''),
    fieldResidenceById_: (id, who) => (id === 'SRC-PICASSO' ? { id, name: 'Picasso', who } : null),
    staffByChatId_: (id) => (id === '111' ? { staffId: 'ST-001', nameJp: 'Run Kosal', nameEn: 'Run Kosal' } : null)
  };
  vm.createContext(ctx);
  ['JobIdempotency.gs', 'JobCancel.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(V7, f), 'utf8'), ctx, { filename: f }));
  return ctx;
}

function jobRow(extra) {
  return Object.assign({ 'ジョブID': 'JOB-20261105-002', '予約ID': '', '作業状態': '作業中', '開始時刻': new Date('2026-11-05T04:21:42Z'),
    '車種': 'なた', 'client_id': JOB_CID, '完了イベントID': '', 'v2記録(JSON)': startJson() }, extra || {});
}
const body = (extra) => Object.assign({ action: 'job_cancel', client_id: CANCEL_CID, job_client_id: JOB_CID, request_id: CANCEL_CID,
  app_version: 'field-test', _authUserId: '', _staffUserId: '' }, extra || {});

test('作業中の行 → 「中断」にして、取り消しを v2記録(JSON) に残す（開始の記録も残す）', () => {
  const rows = [jobRow()];
  const ctx = loadV7(rows);
  const res = ctx.apiJobCancelV2(body({ _staffUserId: '111' }));
  assert.equal(res.status, 'ok');
  assert.equal(res.client_id, CANCEL_CID, '端末が送信済みにできるよう client_id を返す');
  assert.equal(res.jobId, 'JOB-20261105-002');
  assert.equal(rows[0]['作業状態'], '中断');
  const j = JSON.parse(rows[0]['v2記録(JSON)']);
  assert.equal(j.start.shop_id, 'SHOP-20260929-164743-b8040692', '開始の記録は消さない');
  assert.equal(j.cancel.client_id, CANCEL_CID);
  assert.equal(j.cancel.by, '111');
  assert.equal(j.cancel.reason, 'test_or_mistake');
  assert.equal(ctx.updates.length, 1);
});

test('管理グループ（一般）に1回だけ知らせる: ジョブID・お店・車・取り消した人・手で消す案内', () => {
  const rows = [jobRow()];
  const ctx = loadV7(rows);
  ctx.apiJobCancelV2(body({ _staffUserId: '111' }));
  assert.equal(ctx.sent.length, 1);
  const m = ctx.sent[0];
  assert.equal(m.chatId, '-100admin');
  assert.equal(m.o.message_thread_id, undefined, '予約なしの開始は一般に届いているので一般へ');
  assert.ok(m.text.startsWith('🗑 作業の取り消し（アプリのテスト・押し間違い）'));
  assert.ok(m.text.includes('🆔 JOB-20261105-002'));
  assert.ok(m.text.includes('🏪 提携店: LUXE Auto'));
  assert.ok(m.text.includes('🚗 なた'));
  assert.ok(m.text.includes('👤 取り消した人: Run Kosal'));
  assert.ok(m.text.includes('作業記録は「中断」にしました（売上・請求は出ません）'));
  assert.ok(m.text.includes('このグループと「LUXE Auto」のグループに届いた「▶️ 作業開始」は自動では消えません'));
});

test('送り主が確かめられない時は「スタッフ不明」・お店なしの作業は「このグループ」だけ案内', () => {
  const rows = [jobRow({ 'v2記録(JSON)': startJson({ shop_id: '', mode: '' }) })];
  const ctx = loadV7(rows);
  ctx.apiJobCancelV2(body());
  const t = ctx.sent[0].text;
  assert.ok(t.includes('👤 取り消した人: （スタッフ不明）'));
  assert.ok(!t.includes('🏪'));
  assert.ok(t.includes('📌 このグループに届いた「▶️ 作業開始」'));
});

test('建物（レジデンス等）・新しいお店の作業も、届いた先を案内する', () => {
  let rows = [jobRow({ 'v2記録(JSON)': startJson({ shop_id: '', mode: '', residence_id: 'SRC-PICASSO', residence_who: 'resident' }) })];
  let ctx = loadV7(rows);
  ctx.apiJobCancelV2(body());
  assert.ok(ctx.sent[0].text.includes('🏢 Picasso'));
  assert.ok(ctx.sent[0].text.includes('このグループと「Picasso」のグループに'));
  rows = [jobRow({ 'v2記録(JSON)': startJson({ shop_id: '', new_shop_name: 'ABC Car' }) })];
  ctx = loadV7(rows);
  ctx.apiJobCancelV2(body());
  assert.ok(ctx.sent[0].text.includes('🏪 新しいお店: ABC Car'));
  assert.ok(ctx.sent[0].text.includes('📌 このグループに届いた'), '新しいお店はグループが無い＝開始は届いていない');
});

test('開始が届いていない（行が無い）→ ok・何も書かない・知らせない', () => {
  const rows = [jobRow({ client_id: 'aaaaaaaa-0000-4000-8000-000000000000' })];
  const ctx = loadV7(rows);
  const res = ctx.apiJobCancelV2(body());
  assert.equal(res.status, 'ok');
  assert.equal(res.result, 'not_started');
  assert.equal(res.client_id, CANCEL_CID);
  assert.equal(ctx.updates.length, 0);
  assert.equal(ctx.sent.length, 0);
});

test('2回目（もう「中断」）→ duplicate・書かない・知らせない', () => {
  const rows = [jobRow({ '作業状態': '中断' })];
  const ctx = loadV7(rows);
  const res = ctx.apiJobCancelV2(body());
  assert.equal(res.status, 'duplicate');
  assert.equal(res.ok, true);
  assert.equal(ctx.updates.length, 0);
  assert.equal(ctx.sent.length, 0);
});

test('作業終了が届いた行・完了の行は取り消さない（ALREADY_ENDED・retryable=false）', () => {
  for (const extra of [{ '完了イベントID': 'eeeeeeee-0000-4000-8000-000000000000' }, { '作業状態': '完了' }]) {
    const rows = [jobRow(extra)];
    const ctx = loadV7(rows);
    const res = ctx.apiJobCancelV2(body());
    assert.equal(res.status, 'error');
    assert.equal(res.error, 'ALREADY_ENDED');
    assert.equal(res.retryable, false);
    assert.equal(res.client_id, CANCEL_CID);
    assert.equal(ctx.updates.length, 0);
    assert.equal(ctx.sent.length, 0);
  }
});

test('予約つきの作業は受け付けない（HAS_BOOKING・retryable=false）', () => {
  for (const bk of ['BK-20261105-001', "'BK-20261105-001"]) {
    const rows = [jobRow({ '予約ID': bk })];
    const ctx = loadV7(rows);
    const res = ctx.apiJobCancelV2(body());
    assert.equal(res.error, 'HAS_BOOKING');
    assert.equal(res.retryable, false);
    assert.equal(rows[0]['作業状態'], '作業中');
  }
});

test('不正なID・同じID・ロックが取れない', () => {
  const rows = [jobRow()];
  let ctx = loadV7(rows);
  assert.equal(ctx.apiJobCancelV2(body({ client_id: 'x' })).error, 'INVALID_CLIENT_ID');
  assert.equal(ctx.apiJobCancelV2(body({ job_client_id: 'bad id!' })).error, 'INVALID_JOB_CLIENT_ID');
  assert.equal(ctx.apiJobCancelV2(body({ job_client_id: CANCEL_CID })).error, 'INVALID_JOB_CLIENT_ID', '取り消し自身のIDを作業IDにしない');
  ctx = loadV7(rows, { lockOk: false });
  const res = ctx.apiJobCancelV2(body());
  assert.equal(res.error, 'BUSY');
  assert.equal(res.retryable, true);
  assert.equal(rows[0]['作業状態'], '作業中');
});

test('管理通知が失敗しても、取り消しは ok（行は「中断」のまま）', () => {
  const rows = [jobRow()];
  const ctx = loadV7(rows, { sendThrows: true });
  const res = ctx.apiJobCancelV2(body());
  assert.equal(res.status, 'ok');
  assert.equal(rows[0]['作業状態'], '中断');
});

test('受け口とスタッフ限定に job_cancel がある', () => {
  const router = fs.readFileSync(path.join(V7, 'Router.gs'), 'utf8');
  assert.match(router, /case 'job_cancel':\s*\n\s*result = apiJobCancelV2\(body\);/);
  const ctx = vm.createContext({ console, Logger: { log: () => {} } });
  vm.runInContext(fs.readFileSync(path.join(V7, 'StaffGate.gs'), 'utf8'), ctx, { filename: 'StaffGate.gs' });
  assert.equal(ctx.isStaffOnlyAction_('job_cancel'), true);
  assert.equal(ctx.isStaffOnlyAction_('job_start'), true);
});

test('「中断」は売上の自動計上・日報・提携店の集計に入らない（どれも 作業状態=完了 だけを見る）', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(src('v7/ManualSales.gs'), /!== '完了'\) return; \/\/ 作業中・中断は対象外/);
  assert.match(src('v7-operations/DailyReport.gs'), /if \(String\(r\[jIdx\['作業状態'\]\] \|\| ''\) !== '完了'\) return;/);
  assert.match(src('v7-operations/ScoutBoardShopLinks.gs'), /String\(stCol\[k\] \|\| ''\) !== '完了'\) return;/);
});
