/**
 * v7-operations: 名簿にいない人が勤務Bot に START を押した時の返事（AttendanceManager.gs replyUnregisteredStart_・2026-11-20）
 *
 * 実行: node --test "tests/*.test.js"
 *
 *   - 本人へ：自分の番号つきの案内を1通（素の文字・クメール語の文に番号が入る）
 *   - 管理グループの勤怠トピックへ：名前・ユーザー名・番号を1通
 *   - 同じ人が続けて押しても、10分の間は返さない
 *   - 名簿にいる人にはこれまでどおりメニューを送る（この返事は出さない）
 *   - グループの中の /start には反応しない
 *   - 名前の改行や長い文字は切る
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPS = path.join(__dirname, '..', 'v7-operations');

function makeCtx(opts) {
  opts = opts || {};
  const sent = [], logs = [], cache = {}, menus = [];
  const ctx = {
    console,
    Logger: { log: (s) => logs.push(String(s)) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    BOT_TYPE: { INTERNAL: 'internal' },
    getConfig: () => ({ adminGroupId: opts.noAdmin ? '' : '-100123', attendanceTopicId: opts.noTopic ? '' : '77', internalMiniappUrl: 'https://example.invalid/' }),
    findStaffByChatId: (id) => (String(id) === '111' ? { staffId: 'STAFF-001' } : null),
    sendMessage: (bot, chatId, text, options) => { sent.push({ bot, chatId: String(chatId), text, options: options || {} }); return { ok: true }; }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(OPS, 'AttendanceManager.gs'), 'utf8'), ctx, { filename: 'AttendanceManager.gs' });
  ctx.sendInternalMenu_ = (id) => { menus.push(String(id)); };
  return { ctx, sent, logs, menus };
}

const msgOf = (id, from, type, text) => ({ text: text || '/start', chat: { id: id, type: type || 'private' }, from: from || {} });

test('名簿にいない人：本人に番号つきの案内、管理グループの勤怠トピックに名前と番号', () => {
  const { ctx, sent, menus } = makeCtx();
  assert.equal(ctx.handleInternalMenuCommand_(msgOf(999, { first_name: 'Sok', last_name: 'Dara', username: 'sokdara' })), true);
  assert.equal(menus.length, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].chatId, '999');
  assert.match(sent[0].text, /999/);
  assert.match(sent[0].text, /Your number: 999/);
  assert.ok(!/\{id\}|__KM_/.test(sent[0].text), '差し込み口や仮の文字が残っていない');
  assert.match(sent[0].text, /[ក-៿]/, 'クメール語の文が入っている');
  assert.equal(sent[0].options.parse_mode, undefined);
  assert.equal(sent[1].chatId, '-100123');
  assert.equal(sent[1].options.message_thread_id, 77);
  assert.equal(sent[1].options.parse_mode, undefined);
  assert.match(sent[1].text, /名前：Sok Dara/);
  assert.match(sent[1].text, /ユーザー名：@sokdara/);
  assert.match(sent[1].text, /番号（Chat ID）：999/);
});

test('同じ人が続けて押しても、2回目は返さない（別の人には返す）', () => {
  const { ctx, sent } = makeCtx();
  ctx.handleInternalMenuCommand_(msgOf(999, { first_name: 'A' }));
  ctx.handleInternalMenuCommand_(msgOf(999, { first_name: 'A' }, 'private', '/menu'));
  assert.equal(sent.length, 2);
  ctx.handleInternalMenuCommand_(msgOf(888, { first_name: 'B' }));
  assert.equal(sent.length, 4);
});

test('名簿にいる人にはメニューだけ・グループの中の /start には反応しない', () => {
  const { ctx, sent, menus } = makeCtx();
  assert.equal(ctx.handleInternalMenuCommand_(msgOf(111, { first_name: 'Ron' })), true);
  assert.deepEqual(menus, ['111']);
  assert.equal(ctx.handleInternalMenuCommand_(msgOf(-100555, { first_name: 'X' }, 'supergroup')), true);
  assert.equal(sent.length, 0);
  assert.equal(ctx.handleInternalMenuCommand_(msgOf(999, {}, 'private', 'hello')), false);
});

test('名前の改行と長い文字は切る・名前もユーザー名も無ければ（なし）・管理グループが未設定なら本人だけ', () => {
  const a = makeCtx();
  a.ctx.handleInternalMenuCommand_(msgOf(999, { first_name: 'x\n' + 'y'.repeat(200) }));
  const line = a.sent[1].text.split('\n')[1];
  assert.ok(line.length <= 3 + 60, line.length);
  assert.ok(!/y\n/.test(a.sent[1].text.split('名前：')[1].split('ユーザー名')[0].slice(0, -1)));
  const b = makeCtx();
  b.ctx.handleInternalMenuCommand_(msgOf(999, {}));
  assert.match(b.sent[1].text, /名前：（なし）/);
  assert.match(b.sent[1].text, /ユーザー名：（なし）/);
  const c = makeCtx({ noAdmin: true });
  c.ctx.handleInternalMenuCommand_(msgOf(999, { first_name: 'A' }));
  assert.equal(c.sent.length, 1);
  const d = makeCtx({ noTopic: true });
  d.ctx.handleInternalMenuCommand_(msgOf(999, { first_name: 'A' }));
  assert.equal(d.sent[1].options.message_thread_id, undefined);
});
