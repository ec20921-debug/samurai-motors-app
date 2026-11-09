/**
 * Supabase Edge Function tg-relay（supabase/functions/tg-relay/relay.js）の確認（2026-11-09）
 *
 * 実行: node --test "tests/*.test.js"
 *   - Telegram の合言葉が合わなければ 401（GAS を呼ばない）。Bot の種類が違えば 400
 *   - GAS が積めた時だけ 200。積めなかった・GAS に届かない時は 502（Telegram が送り直す＝消えない）
 *   - 積めたら tg_drain と、表への1行（Bot の種類と update_id だけ・中身は書かない）を後ろで頼む
 *   - 壊れた update は 200 で捨てる（送り直させても直らない）
 *   - GET（GAS の見回り）は合言葉が合う時だけ表に1行書いて { ok, db }
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MOD = pathToFileURL(path.join(__dirname, '..', 'supabase', 'functions', 'tg-relay', 'relay.js')).href;
const ENV = {
  GAS_EXEC_URL: 'https://script.google.com/macros/s/AKfyc_TEST-123/exec',
  GAS_RELAY_KEY: 'g'.repeat(32),
  TG_WEBHOOK_SECRET: 'T'.repeat(40),
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_TEST'
};
const FN = 'https://abcdefgh.supabase.co/functions/v1/tg-relay';

async function setup(gasReply) {
  const { createHandler } = await import(MOD);
  const calls = []; const later = []; const logs = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    if (url === ENV.GAS_EXEC_URL) {
      const r = typeof gasReply === 'function' ? gasReply(JSON.parse(init.body)) : gasReply;
      if (r instanceof Error) throw r;
      return new Response(JSON.stringify(r), { status: 200 });
    }
    return new Response('', { status: 201 });
  };
  const handle = createHandler({ env: (k) => ENV[k], fetch, waitUntil: (p) => later.push(p), log: (m) => logs.push(m) });
  return { handle, calls, later, logs };
}

const tgReq = (body, opts) => new Request(FN + '?bot=' + ((opts && opts.bot) || 'booking'), {
  method: 'POST',
  headers: { 'x-telegram-bot-api-secret-token': (opts && 'secret' in opts) ? opts.secret : ENV.TG_WEBHOOK_SECRET, 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});
const UPDATE = { update_id: 555, message: { chat: { id: 42 }, text: 'ជំរាបសួរ' } };

test('合言葉が違う・無い → 401。GAS を呼ばない', async () => {
  const t = await setup({ ok: true });
  assert.equal((await t.handle(tgReq(UPDATE, { secret: 'T'.repeat(39) + 'x' }))).status, 401);
  assert.equal((await t.handle(tgReq(UPDATE, { secret: '' }))).status, 401);
  assert.equal(t.calls.length, 0);
});

test('Bot の種類が違う → 400', async () => {
  const t = await setup({ ok: true });
  assert.equal((await t.handle(tgReq(UPDATE, { bot: 'internal' }))).status, 400);
  assert.equal(t.calls.length, 0);
});

test('GAS が積めたら 200。続けて tg_drain と表への1行（中身は書かない）を後ろで頼む', async () => {
  const t = await setup((b) => ({ ok: true, action: b.action }));
  const res = await t.handle(tgReq(UPDATE));
  assert.equal(res.status, 200);
  const first = t.calls[0];
  assert.equal(first.url, ENV.GAS_EXEC_URL);
  assert.equal(first.init.redirect, 'follow');
  assert.deepEqual(first.body, { relayKey: ENV.GAS_RELAY_KEY, action: 'tg_relay', botType: 'booking', update: UPDATE });
  await Promise.all(t.later);
  assert.equal(t.calls[1].body.action, 'tg_drain');
  const hb = t.calls.find((c) => c.url.indexOf('/rest/v1/relay_heartbeat') > 0);
  assert.deepEqual(Object.keys(hb.body[0]).sort(), ['last_seen_at', 'last_update_id', 'source']);
  assert.equal(hb.body[0].source, 'booking');
  assert.equal(hb.body[0].last_update_id, 555);
  assert.ok(!JSON.stringify(hb.body).includes('ជំរាបសួរ'));
  assert.ok(!t.logs.join('\n').includes('ជំរាបសួរ'));
});

test('GAS が断った・届かない → 502（Telegram が送り直す）。後ろの処理は頼まない', async () => {
  for (const reply of [{ ok: false, message: 'FORBIDDEN' }, new Error('timeout')]) {
    const t = await setup(reply);
    assert.equal((await t.handle(tgReq(UPDATE))).status, 502);
    assert.equal(t.later.length, 0);
  }
});

test('壊れた update は 200 で捨てる（GAS を呼ばない）', async () => {
  const t = await setup({ ok: true });
  assert.equal((await t.handle(tgReq('{not json'))).status, 200);
  assert.equal((await t.handle(tgReq({ update_id: 'x' }))).status, 200);
  assert.equal(t.calls.length, 0);
});

test('GET（GAS の見回り）: 合言葉が合う時だけ表に1行書いて { ok, db }', async () => {
  const t = await setup({ ok: true });
  const bad = await t.handle(new Request(FN, { headers: { 'x-relay-key': 'nope' } }));
  assert.equal(bad.status, 404);
  const good = await t.handle(new Request(FN, { headers: { 'x-relay-key': ENV.GAS_RELAY_KEY } }));
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { ok: true, db: true });
  assert.equal(t.calls[0].body[0].source, 'gas');
});

test('設定が揃っていなければ受けない（503）', async () => {
  const { createHandler } = await import(MOD);
  const handle = createHandler({ env: () => '', fetch: async () => { throw new Error('no'); }, waitUntil: () => {}, log: () => {} });
  assert.equal((await handle(tgReq(UPDATE))).status, 503);
});
