/**
 * v7: スタッフ専用の操作の判定（2026-10-30 StaffGate.gs）と、予約画面の電話番号を本人にだけ返す変更の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * .gs を Node の vm に読み込み、シート・キャッシュ・Telegram はスタブで置き換える（本番には触れない）。
 *   - 署名つき（Telegram）: スタッフマスターの有効なスタッフ・管理グループのメンバーだけ通す／古い署名は通さない
 *   - ホーム画面アプリ（専用リンク）: v7-operations と同じ式の鍵＋有効なスタッフだけ通す
 *   - TG_AUTH_MODE が enforce の時だけ止める（未設定・audit は記録だけで、これまでどおり動く）
 *   - 記録にはユーザー ID を残さない
 *   - booking_init の電話番号は、署名で確かめた本人にだけ返す
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const BOT_TOKEN = '000000:TEST-ONLY-NOT-A-REAL-TOKEN';
const STAFF_ID = '111';
const ADMIN_ID = '222';
const STRANGER_ID = '333';
const LINK_SECRET = 'test-field-link-secret';

const toBuf = (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => b & 0xff)));
const toSigned = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));

function makeCtx(props) {
  const store = new Map(Object.entries(props));
  const cache = new Map();
  const ctx = {
    console,
    Logger: { log: () => {} },
    Utilities: {
      computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
      newBlob: (s) => ({ getBytes: () => toSigned(Buffer.from(String(s), 'utf8')) }),
      formatDate: (d, tz, fmt) => {
        const iso = d.toISOString();
        return fmt === 'yyyyMMdd' ? iso.slice(0, 10).replace(/-/g, '') : iso.slice(11, 19);
      }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (store.has(k) ? store.get(k) : null),
        setProperty: (k, v) => store.set(k, String(v)),
        deleteProperty: (k) => store.delete(k),
        getKeys: () => Array.from(store.keys())
      })
    },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }) },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (name) => (name !== 'スタッフマスター' ? null : {
          getDataRange: () => ({
            getValues: () => [
              ['スタッフID', 'Chat ID', '氏名(JP)', '有効'],
              ['S1', STAFF_ID, 'A', true],
              ['S2', '444', 'B', false]
            ]
          })
        })
      })
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => JSON.parse(s) }) },
    // 管理グループ: ADMIN_ID だけメンバー
    isAdminGroupMember_: (uid) => String(uid) === ADMIN_ID,
    // ルーターの先にある処理（本物の代わり）
    apiBookingToday: () => ({ status: 'ok', bookings: [{ customerName: 'X' }] }),
    apiChatSend: () => ({ status: 'ok', sent: true }),
    __store: store
  };
  vm.createContext(ctx);
  ['TelegramAuth.gs', 'StaffGate.gs', 'Router.gs'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7', f), 'utf8'), ctx, { filename: f }));
  return ctx;
}

const BASE_PROPS = { BOT_TOKEN_BOOKING: BOT_TOKEN, OPERATIONS_SPREADSHEET_ID: 'ops-sheet', FIELD_LINK_SECRET: LINK_SECRET };

function initData(userId, ageSec) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000) - (ageSec || 0)), query_id: 'q1', user: JSON.stringify({ id: Number(userId) }) };
  const dcs = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams(Object.assign({}, fields, { hash })).toString();
}

function linkKey(chatId) {
  return crypto.createHmac('sha256', LINK_SECRET).update('field-link-v1:' + chatId).digest('hex').slice(0, 24);
}

const check = (ctx, ...args) => ctx.staffGateCheck_(...args);

test('Telegram: 有効なスタッフは通す・管理グループのメンバーも通す', () => {
  const ctx = makeCtx(BASE_PROPS);
  assert.equal(check(ctx, initData(STAFF_ID), '', '').via, 'tg_staff');
  assert.equal(check(ctx, initData(ADMIN_ID), '', '').via, 'tg_admin');
});

test('Telegram: スタッフでない人・無効のスタッフ・偽の署名・古い署名は通さない', () => {
  const ctx = makeCtx(BASE_PROPS);
  assert.deepEqual(JSON.parse(JSON.stringify(check(ctx, initData(STRANGER_ID), '', ''))), { allowed: false, via: '', reason: 'tg_not_staff' });
  assert.equal(check(ctx, initData('444'), '', '').reason, 'tg_not_staff');
  assert.equal(check(ctx, initData(STAFF_ID).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64)), '', '').reason, 'tg_hash_mismatch');
  assert.equal(check(ctx, initData(STAFF_ID, 8 * 86400), '', '').reason, 'tg_expired');
  assert.equal(check(ctx, '', '', '').reason, 'no_auth');
});

test('ホーム画面アプリ: 正しい鍵の有効なスタッフだけ通す', () => {
  const ctx = makeCtx(BASE_PROPS);
  assert.equal(check(ctx, '', STAFF_ID, linkKey(STAFF_ID)).via, 'link_staff');
  assert.equal(check(ctx, '', STAFF_ID, linkKey(STRANGER_ID)).reason, 'link_bad');
  assert.equal(check(ctx, '', STRANGER_ID, linkKey(STRANGER_ID)).reason, 'link_not_staff');
  assert.equal(check(ctx, '', STAFF_ID, '').reason, 'link_bad');
  const noSecret = makeCtx(Object.assign({}, BASE_PROPS, { FIELD_LINK_SECRET: '' }));
  assert.equal(check(noSecret, '', STAFF_ID, linkKey(STAFF_ID)).reason, 'link_unconfigured');
});

test('スタッフ一覧が読めない時は通さない（管理グループのメンバーは通す）', () => {
  const ctx = makeCtx(Object.assign({}, BASE_PROPS, { OPERATIONS_SPREADSHEET_ID: '' }));
  assert.equal(check(ctx, initData(STAFF_ID), '', '').reason, 'staff_list_unavailable');
  assert.equal(check(ctx, initData(ADMIN_ID), '', '').via, 'tg_admin');
  assert.equal(check(ctx, '', STAFF_ID, linkKey(STAFF_ID)).reason, 'staff_list_unavailable');
});

test('audit（未設定）: 止めずにこれまでどおり返し、判定だけ記録する（ユーザー ID は残さない）', () => {
  const ctx = makeCtx(BASE_PROPS);
  const res = ctx.doGet({ parameter: { action: 'booking_today' } });
  assert.equal(res.status, 'ok');
  const key = Array.from(ctx.__store.keys()).find((k) => k.startsWith('STAFF_GATE_AUDIT_'));
  const rec = JSON.parse(ctx.__store.get(key));
  assert.equal(rec.counts['booking_today|deny_no_auth'], 1);
  assert.ok(!JSON.stringify(rec).includes(STAFF_ID));
  const view = ctx.apiStaffGateAudit_({});
  assert.equal(view.mode, 'audit');
  assert.equal(view.configured.staffList, true);
});

test('enforce: 本人確認の無い呼び出しは止め、スタッフは通す（GET・POST とも）', () => {
  const ctx = makeCtx(Object.assign({}, BASE_PROPS, { TG_AUTH_MODE: 'enforce' }));
  assert.equal(ctx.doGet({ parameter: { action: 'booking_today' } }).error, 'AUTH_REQUIRED');
  assert.equal(ctx.doGet({ parameter: { action: 'booking_today', _tg: initData(STAFF_ID) } }).status, 'ok');
  assert.equal(ctx.doGet({ parameter: { action: 'booking_today', _fu: STAFF_ID, _fk: linkKey(STAFF_ID) } }).status, 'ok');
  const post = (body) => ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  assert.equal(post({ action: 'chat_send', chatId: '999', message: 'hi' }).error, 'AUTH_REQUIRED');
  assert.equal(post({ action: 'chat_send', chatId: '999', message: 'hi', _tgInitData: initData(STAFF_ID) }).status, 'ok');
});

test('スタッフ専用でない操作は判定しない', () => {
  const ctx = makeCtx(Object.assign({}, BASE_PROPS, { TG_AUTH_MODE: 'enforce' }));
  assert.equal(ctx.isStaffOnlyAction_('booking_init'), false);
  assert.equal(ctx.isStaffOnlyAction_('booking_create'), false);
  assert.equal(ctx.isStaffOnlyAction_('menu_prices'), false);
  assert.equal(ctx.isStaffOnlyAction_('chat_send'), true);
  assert.equal(ctx.isStaffOnlyAction_('job'), true);
});

test('booking_init: 電話番号は署名で確かめた本人にだけ返す', () => {
  const ctx = makeCtx(BASE_PROPS);
  vm.runInContext(`
    findCustomerForInit_ = function () { return { data: { '顧客ID': 'C1', 'チャットID': '555', '氏名': 'Kim', '電話番号': '012345678', 'ユーザー名': 'kim' } }; };
    getActivePlans = function () { return []; };
    getDispatchFee = function () { return null; };
    getBookingConfig = function () { return {}; };
  `, ctx);
  assert.equal(ctx.apiBookingInit({ chatId: '555', _authUserId: '555' }).customer.phone, '012345678');
  assert.equal(ctx.apiBookingInit({ chatId: '555', _authUserId: '' }).customer.phone, '');
  assert.equal(ctx.apiBookingInit({ chatId: '555', _authUserId: '777' }).customer.phone, '');
  assert.equal(ctx.apiBookingInit({ chatId: '555' }).customer.name, 'Kim');   // 名前・顧客IDはこれまでどおり（予約画面が使う）
});
