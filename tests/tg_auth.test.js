/**
 * tg-auth.js: GAS への通信に本人証明を付ける部品（2026-10-30 改修）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 *   - 本人証明（Telegram の署名・専用リンクの鍵）を付けるのは当社の2つの GAS だけ（?gas= の細工で他所に送らない）
 *   - Telegram の署名がある時は署名だけ、無い時は専用リンクの `_fu` / `_fk` を付ける（送る時に付ける）
 *   - URL の ?u=&k= は同じタブの sessionStorage に持ち、旧アプリ等に移っても使える
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'tg-auth.js'), 'utf8');
const field = fs.readFileSync(path.join(ROOT, 'field', 'index.html'), 'utf8');
const V7 = field.match(/var GAS_URL = '([^']+)'/)[1];
const OPS = field.match(/var OPS_URL = '([^']+)'/)[1];

function page({ initData = '', search = '', session = {} } = {}) {
  const sent = [];
  const store = new Map(Object.entries(session));
  const win = {
    Telegram: { WebApp: { initData } },
    fetch: (input, init) => { sent.push({ input, init }); return Promise.resolve({}); }
  };
  const ctx = {
    window: win,
    location: { search },
    URLSearchParams,
    JSON,
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }
  };
  ctx.Telegram = win.Telegram;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { fetch: win.fetch, sent, win, store };
}

test('当社の GAS かどうか: v7・v7-operations だけ。よく似た他人の GAS は対象外', () => {
  const p = page();
  assert.equal(p.win.SM_GAS_ALLOWED(V7), true);
  assert.equal(p.win.SM_GAS_ALLOWED(OPS + '?action=whoami'), true);
  assert.equal(p.win.SM_GAS_ALLOWED('https://script.google.com/macros/s/ATTACKER/exec'), false);
  assert.equal(p.win.SM_GAS_ALLOWED(V7 + 'x'), false);
});

test('Telegram の署名は当社の GAS にだけ付ける', () => {
  const p = page({ initData: 'user=1&hash=abc' });
  p.fetch(V7 + '?action=booking_today');
  p.fetch('https://script.google.com/macros/s/ATTACKER/exec?action=x');
  p.fetch(OPS, { method: 'POST', body: JSON.stringify({ action: 'whoami' }) });
  assert.match(p.sent[0].input, /_tg=user%3D1%26hash%3Dabc/);
  assert.equal(p.sent[1].input.indexOf('_tg='), -1);
  assert.equal(JSON.parse(p.sent[2].init.body)._tgInitData, 'user=1&hash=abc');
});

test('Telegram の外: URL の ?u=&k= を覚えて、当社の GAS に送る時だけ _fu/_fk を付ける', () => {
  const p = page({ search: '?u=111&k=key111' });
  p.fetch(V7 + '?action=booking_today');
  p.fetch(V7, { method: 'POST', body: JSON.stringify({ action: 'job_start', client_id: 'c1' }) });
  p.fetch('https://script.google.com/macros/s/ATTACKER/exec');
  assert.match(p.sent[0].input, /&_fu=111&_fk=key111$/);
  const body = JSON.parse(p.sent[1].init.body);
  assert.equal(body._fu, '111');
  assert.equal(body._fk, 'key111');
  assert.equal(p.sent[2].input, 'https://script.google.com/macros/s/ATTACKER/exec');
});

test('同じタブで別ページ（旧アプリ）に移っても、覚えた鍵を使う', () => {
  const p = page({ session: { sm_field_link: JSON.stringify({ u: '222', k: 'key222' }) } });
  p.fetch(V7 + '?action=chat_history');
  assert.match(p.sent[0].input, /_fu=222&_fk=key222/);
});

test('本人証明が何も無い時は、元のリクエストのまま送る', () => {
  const p = page();
  p.fetch(V7 + '?action=booking_slots');
  assert.equal(p.sent[0].input, V7 + '?action=booking_slots');
});
