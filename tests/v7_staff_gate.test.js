/**
 * v7: スタッフ専用の操作の判定（2026-10-30 StaffGate.gs）と、予約画面の電話番号を本人にだけ返す変更の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * .gs を Node の vm に読み込み、シート・キャッシュ・Telegram はスタブで置き換える（本番には触れない）。
 *   - 署名つき（Telegram）: スタッフマスターの有効なスタッフ・管理グループのメンバーだけ通す／24時間より古い署名は通さない
 *   - ホーム画面アプリ（専用リンク）: v7-operations FieldLink.gs と同じ鍵＋有効なスタッフだけ通す
 *   - TG_AUTH_MODE が enforce の時（または STAFF_GATE_ENFORCE_ACTIONS に入れた操作）だけ止める。設定が読めない時は止める側
 *   - 記録にはユーザー ID を残さない（末尾4桁だけ）・匿名の拒否は間引いて記録する
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
const STAFF_ID = '1110111';
const ADMIN_ID = '2220222';
const STRANGER_ID = '3330333';
const LINK_SECRET = 'test-field-link-secret';

const toBuf = (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : Buffer.from(v.map((b) => b & 0xff)));
const toSigned = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));

function gasGlobals(store, cache, opts) {
  return {
    console,
    Logger: { log: () => {} },
    Utilities: {
      computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', toBuf(key)).update(toBuf(value)).digest()),
      newBlob: (s) => ({ getBytes: () => toSigned(Buffer.from(String(s), 'utf8')) }),
      formatDate: (d, tz, fmt) => {
        const iso = d.toISOString();
        return fmt === 'yyyyMMdd' ? iso.slice(0, 10).replace(/-/g, '') : iso.slice(11, 19);
      },
      getUuid: () => crypto.randomUUID()
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => { if (opts.propsThrow) throw new Error('quota'); return store.has(k) ? store.get(k) : null; },
        setProperty: (k, v) => store.set(k, String(v)),
        deleteProperty: (k) => store.delete(k),
        getKeys: () => Array.from(store.keys())
      })
    },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) }
  };
}

function makeCtx(props) {
  const store = new Map(Object.entries(props));
  const cache = new Map();
  const opts = { propsThrow: false, sheetThrow: false };
  const calls = [];
  const ctx = Object.assign(gasGlobals(store, cache, opts), {
    SpreadsheetApp: {
      openById: () => {
        if (opts.sheetThrow) throw new Error('sheet unavailable');
        return {
          getSheetByName: (name) => (name !== 'スタッフマスター' ? null : {
            getDataRange: () => ({
              getValues: () => [
                ['スタッフID', 'Chat ID', '氏名(JP)', '有効'],
                ['S1', STAFF_ID, 'A', true],
                ['S2', '4440444', 'B', false]
              ]
            })
          })
        };
      }
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType: () => JSON.parse(s) }) },
    // 管理グループ: ADMIN_ID だけメンバー
    isAdminGroupMember_: (uid) => String(uid) === ADMIN_ID,
    // ルーターの先にある処理（本物の代わり）。受け取った中身を記録する
    apiBookingToday: () => ({ status: 'ok', bookings: [{ customerName: 'X' }] }),
    apiChatSend: (body) => { calls.push(body); return { status: 'ok', sent: true }; }
  });
  vm.createContext(ctx);
  ['TelegramAuth.gs', 'StaffGate.gs', 'Router.gs'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7', f), 'utf8'), ctx, { filename: f }));
  return { ctx, store, cache, opts, calls };
}

const BASE_PROPS = { BOT_TOKEN_BOOKING: BOT_TOKEN, OPERATIONS_SPREADSHEET_ID: 'ops-sheet', FIELD_LINK_SECRET: LINK_SECRET };

function initData(userId, ageSec) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000) - (ageSec || 0)), query_id: 'q1', user: JSON.stringify({ id: Number(userId) }) };
  const dcs = Object.keys(fields).sort().map((k) => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams(Object.assign({}, fields, { hash })).toString();
}

// 鍵は v7-operations の本物（FieldLink.gs）で作る＝式がずれたらテストが落ちる
function linkKey(chatId) {
  const store = new Map([['FIELD_LINK_SECRET', LINK_SECRET]]);
  const ops = gasGlobals(store, new Map(), {});
  vm.createContext(ops);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7-operations', 'FieldLink.gs'), 'utf8'), ops, { filename: 'FieldLink.gs' });
  return ops.fieldLinkKey_(chatId);
}

const check = (t, ...args) => JSON.parse(JSON.stringify(t.ctx.staffGateCheck_(...args)));
const auditKey = (t) => Array.from(t.store.keys()).find((k) => k.startsWith('STAFF_GATE_AUDIT_'));

test('Telegram: 有効なスタッフは通す・管理グループのメンバーも通す', () => {
  const t = makeCtx(BASE_PROPS);
  assert.equal(check(t, initData(STAFF_ID), '', '').via, 'tg_staff');
  assert.equal(check(t, initData(ADMIN_ID), '', '').via, 'tg_admin');
  assert.equal(check(t, initData(STAFF_ID, -100), '', '').via, 'tg_staff');   // 端末の時計が少し進んでいても通す
});

test('Telegram: スタッフでない人・無効のスタッフ・偽の署名・24時間より古い署名は通さない', () => {
  const t = makeCtx(BASE_PROPS);
  assert.equal(check(t, initData(STRANGER_ID), '', '').reason, 'tg_not_staff');
  assert.equal(check(t, initData('4440444'), '', '').reason, 'tg_not_staff');
  assert.equal(check(t, initData(STAFF_ID).replace(/hash=[0-9a-f]+/, 'hash=' + '0'.repeat(64)), '', '').reason, 'tg_hash_mismatch');
  assert.equal(check(t, initData(STAFF_ID, 25 * 3600), '', '').reason, 'tg_expired');
  assert.equal(check(t, '', '', '').reason, 'no_auth');
});

test('ホーム画面アプリ: v7-operations と同じ鍵で、有効なスタッフだけ通す', () => {
  const t = makeCtx(BASE_PROPS);
  assert.equal(t.ctx.staffGateLinkKey_(LINK_SECRET, STAFF_ID), linkKey(STAFF_ID));
  assert.equal(check(t, '', STAFF_ID, linkKey(STAFF_ID)).via, 'link_staff');
  assert.equal(check(t, '', STAFF_ID, linkKey(STRANGER_ID)).reason, 'link_bad');
  assert.equal(check(t, '', STRANGER_ID, linkKey(STRANGER_ID)).reason, 'link_not_staff');
  assert.equal(check(t, '', STAFF_ID, '').reason, 'link_bad');
  assert.equal(check(t, '', 'constructor', linkKey('constructor')).reason, 'link_not_staff');   // 名前の衝突で通らない
  const noSecret = makeCtx(Object.assign({}, BASE_PROPS, { FIELD_LINK_SECRET: '' }));
  assert.equal(check(noSecret, '', STAFF_ID, linkKey(STAFF_ID)).reason, 'link_unconfigured');
});

test('スタッフ一覧: 読めない時は通さない（管理グループは通す）・一度読めていれば6時間はその一覧を使う', () => {
  const none = makeCtx(Object.assign({}, BASE_PROPS, { OPERATIONS_SPREADSHEET_ID: '' }));
  assert.equal(check(none, initData(STAFF_ID), '', '').reason, 'staff_list_unavailable');
  assert.equal(check(none, initData(ADMIN_ID), '', '').via, 'tg_admin');
  assert.equal(check(none, '', STAFF_ID, linkKey(STAFF_ID)).reason, 'staff_list_unavailable');

  const t = makeCtx(BASE_PROPS);
  assert.equal(check(t, initData(STAFF_ID), '', '').via, 'tg_staff');
  t.cache.delete('staff_gate_ids');   // 10分のキャッシュが切れた
  t.opts.sheetThrow = true;           // シートが一時的に読めない
  assert.equal(check(t, initData(STAFF_ID), '', '').via, 'tg_staff');
});

test('モード: 未設定は記録だけ・enforce で止める・設定が読めない時は止める側・操作ごとの先行 enforce', () => {
  assert.equal(makeCtx(BASE_PROPS).ctx.staffGateEnforced_('booking_today'), false);
  assert.equal(makeCtx(Object.assign({}, BASE_PROPS, { TG_AUTH_MODE: ' Enforce ' })).ctx.staffGateEnforced_('booking_today'), true);
  const broken = makeCtx(BASE_PROPS);
  broken.opts.propsThrow = true;
  assert.equal(broken.ctx.staffGateEnforced_('booking_today'), true);
  const early = makeCtx(Object.assign({}, BASE_PROPS, { STAFF_GATE_ENFORCE_ACTIONS: 'chat_send, chat_history' }));
  assert.equal(early.ctx.staffGateEnforced_('chat_send'), true);
  assert.equal(early.ctx.staffGateEnforced_('booking_today'), false);
});

test('audit（未設定）: 止めずにこれまでどおり返し、判定だけ記録する（ID は末尾4桁だけ・匿名は間引く）', () => {
  const t = makeCtx(BASE_PROPS);
  assert.equal(t.ctx.doGet({ parameter: { action: 'booking_today' } }).status, 'ok');
  assert.equal(t.ctx.doGet({ parameter: { action: 'booking_today' } }).status, 'ok');
  assert.equal(t.ctx.doGet({ parameter: { action: 'booking_today', _tg: initData(STRANGER_ID) } }).status, 'ok');
  const rec = JSON.parse(t.store.get(auditKey(t)));
  assert.equal(rec.counts['booking_today|deny_no_auth|none'], 1);          // 2回目は間引かれる
  assert.equal(rec.counts['booking_today|deny_tg_not_staff|tg'], 1);
  assert.ok(!JSON.stringify(rec).includes(STRANGER_ID));
  assert.equal(rec.fails[rec.fails.length - 1].u4, STRANGER_ID.slice(-4));
  const sum = t.ctx.staffGateAuditSummary_(1);
  assert.equal(sum.mode, 'audit');
  assert.equal(sum.staffSheetReadable, true);
  assert.equal(sum.activeStaffCount, 1);
  assert.equal(t.ctx.doGet({ parameter: { action: 'staff_gate_audit' } }).status, 'error');   // ウェブには出さない
});

test('enforce: 本人確認の無い呼び出しは止め、スタッフは通す（GET・POST とも）', () => {
  const t = makeCtx(Object.assign({}, BASE_PROPS, { TG_AUTH_MODE: 'enforce' }));
  assert.equal(t.ctx.doGet({ parameter: { action: 'booking_today' } }).error, 'AUTH_REQUIRED');
  assert.equal(t.ctx.doGet({ parameter: { action: 'booking_today', _tg: initData(STAFF_ID) } }).status, 'ok');
  assert.equal(t.ctx.doGet({ parameter: { action: 'booking_today', _fu: STAFF_ID, _fk: linkKey(STAFF_ID) } }).status, 'ok');
  const post = (body) => t.ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  const denied = post({ action: 'chat_send', chatId: '999', message: 'hi', client_id: 'c-1' });
  assert.equal(denied.error, 'AUTH_REQUIRED');
  assert.equal(denied.retryable, false);
  assert.equal(denied.client_id, 'c-1');
  assert.equal(t.calls.length, 0);
  assert.equal(post({ action: 'chat_send', chatId: '999', message: 'hi', _fu: STAFF_ID, _fk: linkKey(STAFF_ID) }).status, 'ok');
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0]._fu, undefined);   // 鍵は下流に渡さない
  assert.equal(t.calls[0]._fk, undefined);
});

test('送り主: _authUserId は署名で確かめた本人だけ・_staffUserId は StaffGate が通したスタッフ（署名／専用リンク）。画面が送った値は使わない（2026-10-31）', () => {
  const t = makeCtx(BASE_PROPS);
  const post = (body) => t.ctx.doPost({ postData: { contents: JSON.stringify(body) } });
  post({ action: 'chat_send', chatId: '999', message: 'tg', _tg: initData(STAFF_ID) });
  post({ action: 'chat_send', chatId: '999', message: 'link', _fu: STAFF_ID, _fk: linkKey(STAFF_ID) });
  post({ action: 'chat_send', chatId: '999', message: 'none', _authUserId: STAFF_ID, _staffUserId: STAFF_ID });
  post({ action: 'chat_send', chatId: '999', message: 'badlink', _fu: STAFF_ID, _fk: linkKey(STRANGER_ID) });
  post({ action: 'chat_send', chatId: '999', message: 'stranger', _tg: initData(STRANGER_ID) });   // 署名は本物だがスタッフではない
  assert.deepEqual(t.calls.map((c) => c._authUserId), [STAFF_ID, '', '', '', STRANGER_ID]);
  assert.deepEqual(t.calls.map((c) => c._staffUserId), [STAFF_ID, STAFF_ID, '', '', '']);
});

test('スタッフ専用でない操作は判定しない', () => {
  const { ctx } = makeCtx(Object.assign({}, BASE_PROPS, { TG_AUTH_MODE: 'enforce' }));
  ['booking_init', 'booking_create', 'booking_register_customer', 'booking_slots', 'menu_prices', 'ping', 'constructor']
    .forEach((a) => assert.equal(ctx.isStaffOnlyAction_(a), false, a));
  ['chat_send', 'chat_history', 'job', 'job_start', 'job_end', 'booking_today'].forEach((a) => assert.equal(ctx.isStaffOnlyAction_(a), true, a));
});

test('booking_init: 電話番号は署名で確かめた本人にだけ返す（24時間以内）', () => {
  const { ctx } = makeCtx(BASE_PROPS);
  vm.runInContext(`
    findCustomerForInit_ = function () { return { data: { '顧客ID': 'C1', 'チャットID': '555', '氏名': 'Kim', '電話番号': '012345678', 'ユーザー名': 'kim' } }; };
    getActivePlans = function () { return []; };
    getDispatchFee = function () { return null; };
    getBookingConfig = function () { return {}; };
  `, ctx);
  assert.equal(ctx.apiBookingInit({ chatId: '555', _authUserId: '555', _authAgeSec: '60' }).customer.phone, '012345678');
  assert.equal(ctx.apiBookingInit({ chatId: '555', _authUserId: '555', _authAgeSec: String(25 * 3600) }).customer.phone, '');
  assert.equal(ctx.apiBookingInit({ chatId: '555', _authUserId: '', _authAgeSec: '' }).customer.phone, '');
  assert.equal(ctx.apiBookingInit({ chatId: '555', _authUserId: '777', _authAgeSec: '60' }).customer.phone, '');
  assert.equal(ctx.apiBookingInit({ chatId: '555' }).customer.name, 'Kim');   // 名前・顧客IDはこれまでどおり（予約画面が使う）
});
