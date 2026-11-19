/**
 * v7-operations: 専用リンクを勤務Bot から本人の Telegram へ送る（FieldLink.gs fieldLinkSendMarked・2026-11-19）
 *
 * 実行: node --test "tests/*.test.js"
 *
 *   - 「アプリと鍵」で FIELD の行に「送る」と書いた人にだけ送る（ほかのアプリの行・印のない行には送らない）
 *   - 送り先は本人の Chat ID・リンクは ?u=<chatId>&k=<鍵>・プレビューは切る
 *   - 送れたら「送る」を日付に、出した人を「勤務Bot（本人の Telegram へ）」に書き換える（2回目は送らない）
 *   - 名簿にいない・Chat ID が数字でない・送信失敗のときは、印を残して数だけ返す
 *   - 実行ログにリンク（鍵）を出さない
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const OPS = path.join(__dirname, '..', 'v7-operations');
const HEAD = ['スタッフID', '名前', 'アプリ', '状態', '入れた端末', '鍵・リンク・ログインを出した日', '出した人', '止めた日', 'メモ', '最終更新'];

function makeCtx(rows, opts) {
  opts = opts || {};
  const grid = [HEAD.slice()].concat(rows.map((r) => r.slice()));
  const sentMsgs = [], logs = [], cleared = { n: 0 };
  const sheet = {
    getDataRange: () => ({ getValues: () => grid.map((r) => r.slice()) }),
    getRange: (r, c) => ({ setValue: (v) => { grid[r - 1][c - 1] = v; } })
  };
  const staff = [
    { staffId: 'STAFF-008', chatId: '8989198556', nameJp: 'ティヌン', nameEn: 'Chey Kungsamrach', role: 'field' },
    { staffId: 'STAFF-005', chatId: 'JP-TEAM', nameJp: '日本メンバー', nameEn: 'Japan Team', role: 'admin' }
  ];
  const ctx = {
    console,
    Logger: { log: (s) => logs.push(String(s)) },
    Utilities: {
      formatDate: () => '2026-11-19',
      computeHmacSha256Signature: (v, k) => Array.from(crypto.createHmac('sha256', k).update(v).digest()).map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => 'uuid'
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'FIELD_LINK_SECRET' ? 'test-secret' : null), setProperty: () => {} }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    BOT_TYPE: { INTERNAL: 'internal' },
    getSheet: (name) => { assert.equal(name, 'アプリと鍵'); return sheet; },
    findStaffById: (id) => staff.find((s) => s.staffId === id) || null,
    findStaffByChatId: () => null,
    getActiveStaff: () => staff,
    clearStaffMasterCache: () => { cleared.n++; },
    verifyTelegramInitData_: () => ({ ok: false }),
    sendMessage: (bot, chatId, text, options) => { sentMsgs.push({ bot, chatId, text, options }); return { ok: !opts.sendFail }; }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(OPS, 'FieldLink.gs'), 'utf8'), ctx, { filename: 'FieldLink.gs' });
  return { ctx, grid, sentMsgs, logs, cleared };
}

const plain = (o) => JSON.parse(JSON.stringify(o));

test('「送る」と書いた FIELD の行の本人にだけ送り、行を書き換える', () => {
  const { ctx, grid, sentMsgs, logs } = makeCtx([
    ['STAFF-008', 'ティヌン', 'Telegram', 'ログイン済み', '', '送る', '', '', '', ''],
    ['STAFF-008', 'ティヌン', 'FIELD（現場アプリ）', '未', '', '送る', '', '', '', '2026-11-18'],
    ['STAFF-006', 'ナビン', 'FIELD（現場アプリ）', '未', '', '', '', '', '', '']
  ]);
  assert.deepEqual(plain(ctx.fieldLinkSendMarked()), { sent: 1, skipped: 0 });
  assert.equal(sentMsgs.length, 1);
  assert.equal(sentMsgs[0].bot, 'internal');
  assert.equal(sentMsgs[0].chatId, '8989198556');
  assert.match(sentMsgs[0].text, /field\/\?u=8989198556&k=[0-9a-f]{24}\n/);
  assert.equal(sentMsgs[0].options.link_preview_options.is_disabled, true);
  assert.equal(grid[2][5], '2026-11-19');
  assert.equal(grid[2][6], '勤務Bot（本人の Telegram へ）');
  assert.equal(grid[2][9], '2026-11-19');
  assert.equal(grid[1][5], '送る');           // FIELD 以外の行はさわらない
  assert.ok(!logs.some((l) => /[?&]k=/.test(l)), '実行ログに鍵を出さない');
  assert.equal(ctx.fieldLinkSendMarked().sent, 0);   // 2回目は送らない
  assert.equal(sentMsgs.length, 1);
});

test('名簿にいない・Chat ID が数字でない人には送らず、印を残す', () => {
  const { ctx, grid, sentMsgs } = makeCtx([
    ['STAFF-099', 'だれか', 'FIELD（現場アプリ）', '未', '', '送る', '', '', '', ''],
    ['STAFF-005', '日本メンバー', 'FIELD（現場アプリ）', '未', '', '送る', '', '', '', '']
  ]);
  assert.deepEqual(plain(ctx.fieldLinkSendMarked()), { sent: 0, skipped: 2 });
  assert.equal(sentMsgs.length, 0);
  assert.equal(grid[1][5], '送る');
  assert.equal(grid[2][5], '送る');
});

test('送信に失敗したら印を残す', () => {
  const { ctx, grid } = makeCtx([['STAFF-008', 'ティヌン', 'FIELD（現場アプリ）', '未', '', '送る', '', '', '', '']], { sendFail: true });
  assert.deepEqual(plain(ctx.fieldLinkSendMarked()), { sent: 0, skipped: 1 });
  assert.equal(grid[1][5], '送る');
  assert.equal(grid[1][6], '');
});

test('同じ人の FIELD の行が2つあっても送るのは1通・名簿の控えは読み直す', () => {
  const { ctx, sentMsgs, cleared } = makeCtx([
    ['STAFF-008', 'ティヌン', 'FIELD（現場アプリ）', '未', '', '送る', '', '', '', ''],
    ['STAFF-008', 'ティヌン', 'FIELD（現場アプリ）', '未', '', '送る', '', '', '', '']
  ]);
  assert.equal(ctx.fieldLinkSendMarked().sent, 1);
  assert.equal(sentMsgs.length, 1);
  assert.equal(cleared.n, 1);
});
