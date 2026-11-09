/**
 * v7: Supabase の受付（TgRelay.gs）と、キュー処理の1本化（QueueManager.gs）・1分ごとの受け取りの切り替え（BotPoller.gs）（2026-11-09）
 *
 * 実行: node --test "tests/*.test.js"
 *
 *   - tg_relay: 合言葉が合う時だけキューに積む。合わない・設定が無い・形が壊れている・Bot の種類が違うものは積まない。処理済みは積まない
 *   - tg_drain: 合言葉が合う時だけキューを処理する
 *   - 受付で受けている Bot は getUpdates を呼ばない。1分ごとの Bot はこれまでどおり
 *   - 見張り: 配達の失敗が2回続いたら webhook を外して（未配達は残す）1分ごとに戻し、管理グループに知らせる。1回だけなら戻さない
 *   - 見張り: 受付の health が2回続けて失敗したら戻す。設定が消されたらすぐ戻す
 *   - 有効化: health が通らなければ webhook を登録しない。通れば合言葉つきで登録して relay にする
 *   - キュー処理: 別の処理がロックを持っている時は見送る
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const URL_ = 'https://abcdefgh.supabase.co/functions/v1/tg-relay';
const KEY = 'k'.repeat(32);
const SECRET = 'S'.repeat(40);
const GOOD_PROPS = { TG_RELAY_URL: URL_, TG_RELAY_KEY: KEY, TG_WEBHOOK_SECRET: SECRET };

function makeCtx(opts) {
  opts = opts || {};
  const props = new Map(Object.entries(opts.props || {}));
  const cache = new Map();
  const state = {
    log: [], tg: [], sent: [], handled: [], userLockFree: true, pingOk: true, pingDb: true,
    webhook: opts.webhook || { url: '', pending_update_count: 0 }
  };
  const ctx = {
    console, Date, JSON, Math,
    Logger: { log: (m) => state.log.push(String(m)) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, String(v)),
        deleteProperty: (k) => props.delete(k),
        getProperties: () => Object.fromEntries(props)
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, String(v)),
        remove: (k) => cache.delete(k),
        removeAll: (ks) => ks.forEach((k) => cache.delete(k))
      })
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
      getUserLock: () => ({ tryLock: () => state.userLockFree, releaseLock: () => {} })
    },
    UrlFetchApp: {
      fetch: (url, opt) => {
        state.pingCalls = (state.pingCalls || 0) + 1;
        assert.equal(url, URL_);
        assert.equal(opt.headers['x-relay-key'], KEY);
        return {
          getResponseCode: () => (state.pingOk ? 200 : 503),
          getContentText: () => JSON.stringify(state.pingOk ? { ok: true, db: state.pingDb } : { ok: false })
        };
      }
    },
    callTelegramApi: (bot, method, payload) => {
      state.tg.push({ bot, method, payload });
      if (method === 'setWebhook') state.webhook = { url: payload.url, pending_update_count: 0 };
      if (method === 'deleteWebhook') state.webhook = { url: '', pending_update_count: state.webhook.pending_update_count };
      if (method === 'getUpdates') return { ok: true, result: [] };
      return { ok: true, result: true };
    },
    getWebhookInfo: (bot) => { state.tg.push({ bot, method: 'getWebhookInfo' }); return { ok: true, result: state.webhook }; },
    sendMessage: (bot, chatId, text) => state.sent.push({ bot, chatId, text }),
    getConfig: () => ({ adminGroupId: '-100ADMIN' }),
    handleBookingBotUpdate: (u) => state.handled.push(['booking', u.update_id]),
    handleFieldBotUpdate: (u) => state.handled.push(['field', u.update_id])
  };
  ctx.getUpdates = (bot, offset, o) => ctx.callTelegramApi(bot, 'getUpdates', Object.assign({ offset }, o));
  vm.createContext(ctx);
  ['Config.gs', 'QueueManager.gs', 'BotPoller.gs', 'TgRelay.gs'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7', f), 'utf8'), ctx, { filename: f }));
  ctx.getConfig = () => ({ adminGroupId: '-100ADMIN' });   // Config.gs の本物（必須キーを読む）を置き換える
  const run = (code) => vm.runInContext(code, ctx);
  const queueKeys = () => Array.from(props.keys()).filter((k) => k.indexOf('queue_') === 0);
  return { ctx, run, props, cache, state, queueKeys };
}

const plain = (v) => JSON.parse(JSON.stringify(v));
const relayBody = (over) => JSON.stringify(Object.assign({ relayKey: KEY, botType: 'booking', update: { update_id: 1001, message: { text: 'hi' } } }, over || {}));

// ====== tg_relay / tg_drain ======

test('tg_relay: 合言葉が合う時だけ積む。設定が無い・合言葉違い・Bot違い・形が壊れたものは積まない', () => {
  const none = makeCtx();
  assert.equal(plain(none.run(`apiTgRelay_(${relayBody()})`)).message, 'FORBIDDEN');   // 設定が無い＝仕組みごと止まっている
  assert.equal(none.queueKeys().length, 0);

  const t = makeCtx({ props: GOOD_PROPS });
  assert.equal(plain(t.run(`apiTgRelay_(${relayBody({ relayKey: 'x'.repeat(32) })})`)).message, 'FORBIDDEN');
  assert.equal(plain(t.run(`apiTgRelay_(${relayBody({ relayKey: '' })})`)).message, 'FORBIDDEN');
  assert.equal(plain(t.run(`apiTgRelay_(${relayBody({ botType: 'internal' })})`)).message, 'BAD_BOT');
  assert.equal(plain(t.run(`apiTgRelay_(${relayBody({ update: { update_id: 'abc' } })})`)).message, 'BAD_UPDATE');
  assert.equal(plain(t.run(`apiTgRelay_(${relayBody({ update: { update_id: 1.5 } })})`)).message, 'BAD_UPDATE');
  assert.equal(t.queueKeys().length, 0);

  assert.deepEqual(plain(t.run(`apiTgRelay_(${relayBody()})`)), { ok: true });
  assert.equal(t.queueKeys().length, 1);
  const payload = JSON.parse(t.props.get(t.queueKeys()[0]));
  assert.equal(payload.botType, 'booking');
  assert.equal(payload.update.update_id, 1001);
});

test('tg_relay: 処理済みの update は積まない（Telegram の送り直しで二重に返事しない）', () => {
  const t = makeCtx({ props: Object.assign({ processed_ids_v1: JSON.stringify(['1001']) }, GOOD_PROPS) });
  assert.deepEqual(plain(t.run(`apiTgRelay_(${relayBody()})`)), { ok: true, duplicate: true });
  assert.equal(t.queueKeys().length, 0);
});

test('tg_drain: 合言葉が合う時だけ、その場でキューを処理する（同じ update を2回積んでも返事は1回）', () => {
  const t = makeCtx({ props: GOOD_PROPS });
  t.run(`apiTgRelay_(${relayBody()})`);
  t.run(`apiTgRelay_(${relayBody({ botType: 'field', update: { update_id: 2002 } })})`);
  assert.equal(plain(t.run(`apiTgDrain_({ relayKey: 'nope' })`)).message, 'FORBIDDEN');
  assert.deepEqual(t.state.handled, []);
  assert.deepEqual(plain(t.run(`apiTgDrain_({ relayKey: '${KEY}' })`)), { ok: true, ran: true });
  assert.deepEqual(t.state.handled.map((h) => h.join(':')).sort(), ['booking:1001', 'field:2002']);
  assert.equal(t.queueKeys().length, 0);
  // Telegram が同じものを送り直した（処理済みの一覧に入っているので積まない）
  t.run(`apiTgRelay_(${relayBody()})`);
  t.run(`apiTgDrain_({ relayKey: '${KEY}' })`);
  assert.equal(t.state.handled.length, 2);
});

test('キュー処理: 別の処理がロックを持っている時は見送り、キューは残す（次の1分ごとで拾う）', () => {
  const t = makeCtx({ props: GOOD_PROPS });
  t.run(`apiTgRelay_(${relayBody()})`);
  t.state.userLockFree = false;
  assert.deepEqual(plain(t.run(`apiTgDrain_({ relayKey: '${KEY}' })`)), { ok: true, ran: false });
  t.run(`processTelegramQueue()`);
  assert.deepEqual(t.state.handled, []);
  assert.equal(t.queueKeys().length, 1);
  t.state.userLockFree = true;
  t.run(`processTelegramQueue()`);
  assert.deepEqual(plain(t.state.handled), [['booking', 1001]]);
});

// ====== 1分ごとの受け取りとの切り替え ======

test('受付で受けている Bot は getUpdates を呼ばない。もう片方の Bot はこれまでどおり1分ごと', () => {
  const t = makeCtx({ props: Object.assign({ tg_relay_state_v1: JSON.stringify({ booking: 'relay' }) }, GOOD_PROPS),
    webhook: { url: URL_ + '?bot=booking', pending_update_count: 0 } });
  t.run(`pollTelegramUpdates()`);
  const polled = t.state.tg.filter((c) => c.method === 'getUpdates').map((c) => c.bot);
  assert.deepEqual(polled, ['field']);
});

test('設定が揃っていなければ、状態が relay でも1分ごとで動く（設定を消す＝非常口）', () => {
  const t = makeCtx({ props: { tg_relay_state_v1: JSON.stringify({ booking: 'relay' }) } });
  assert.equal(t.run(`tgRelayIsOn_('booking')`), false);
  t.run(`pollTelegramUpdates()`);
  assert.equal(JSON.parse(t.props.get('tg_relay_state_v1')).booking, 'poll');      // 見張りが poll に戻す
  assert.ok(t.state.tg.some((c) => c.method === 'deleteWebhook' && c.bot === 'booking' && c.payload.drop_pending_updates === false));
  assert.deepEqual(t.state.tg.filter((c) => c.method === 'getUpdates').map((c) => c.bot), ['booking', 'field']);
});

// ====== 見張り ======

function relayOn(webhook) {
  const t = makeCtx({ props: Object.assign({ tg_relay_state_v1: JSON.stringify({ booking: 'relay' }) }, GOOD_PROPS), webhook });
  return t;
}
const nextWatch = (t) => { t.cache.delete('tg_relay_watch_at'); t.run(`tgRelayWatch_()`); };

test('見張り: 配達の失敗が1回だけなら戻さない。2回続いたら webhook を外し（未配達は残す）1分ごとに戻して管理グループに知らせる', () => {
  const failing = { url: URL_ + '?bot=booking', pending_update_count: 3,
    last_error_date: Math.floor(Date.now() / 1000) - 60, last_error_message: 'Wrong response from the webhook: 502 Bad Gateway' };
  const t = relayOn(failing);
  t.run(`tgRelayWatch_()`);
  assert.equal(JSON.parse(t.props.get('tg_relay_state_v1')).booking, 'relay');
  assert.equal(t.state.sent.length, 0);

  nextWatch(t);
  assert.equal(JSON.parse(t.props.get('tg_relay_state_v1')).booking, 'poll');
  const del = t.state.tg.find((c) => c.method === 'deleteWebhook');
  assert.equal(del.payload.drop_pending_updates, false);
  assert.equal(t.state.sent.length, 1);
  assert.equal(t.state.sent[0].chatId, '-100ADMIN');
  assert.match(t.state.sent[0].text, /1分ごとの受け取りに戻しました/);
  assert.match(t.state.sent[0].text, /tgRelayEnableBooking/);
  assert.doesNotMatch(t.state.sent[0].text, new RegExp(KEY + '|' + SECRET));   // 合言葉は出さない
});

test('見張り: 失敗→回復なら数え直す。古い失敗（10分より前）や未配達ゼロは怪しくない', () => {
  const t = relayOn({ url: URL_ + '?bot=booking', pending_update_count: 2, last_error_date: Math.floor(Date.now() / 1000) - 30 });
  t.run(`tgRelayWatch_()`);                                                          // 1回目
  t.state.webhook = { url: URL_ + '?bot=booking', pending_update_count: 0, last_error_date: Math.floor(Date.now() / 1000) - 30 };
  nextWatch(t);                                                                      // 回復（数え直し）
  t.state.webhook = { url: URL_ + '?bot=booking', pending_update_count: 2, last_error_date: Math.floor(Date.now() / 1000) - 3600 };
  nextWatch(t);                                                                      // 古い失敗
  assert.equal(JSON.parse(t.props.get('tg_relay_state_v1')).booking, 'relay');
  assert.equal(t.state.sent.length, 0);
});

test('見張り: 登録先がずれていたら（2回続けて）戻す', () => {
  const t = relayOn({ url: 'https://example.com/other', pending_update_count: 0 });
  t.run(`tgRelayWatch_()`);
  nextWatch(t);
  assert.equal(JSON.parse(t.props.get('tg_relay_state_v1')).booking, 'poll');
});

test('見張り: 受付の health は1時間に1回。2回続けて失敗したら戻す（予約ゼロの週でも Supabase を毎日使う）', () => {
  const t = relayOn({ url: URL_ + '?bot=booking', pending_update_count: 0 });
  t.run(`tgRelayWatch_()`);
  t.run(`tgRelayWatch_()`);
  assert.equal(t.state.pingCalls, 1);                                                // 間引き
  t.state.pingOk = false;
  t.cache.delete('tg_relay_ping_at'); t.run(`tgRelayWatch_()`);
  assert.equal(JSON.parse(t.props.get('tg_relay_state_v1')).booking, 'relay');
  t.cache.delete('tg_relay_ping_at'); t.run(`tgRelayWatch_()`);
  assert.equal(JSON.parse(t.props.get('tg_relay_state_v1')).booking, 'poll');
  assert.match(t.state.sent[0].text, /health/);
});

test('見張り: どの Bot も1分ごとなら Telegram にも受付にも問い合わせない', () => {
  const t = makeCtx({ props: GOOD_PROPS });
  t.run(`tgRelayWatch_()`);
  assert.equal(t.state.tg.length, 0);
  assert.equal(t.state.pingCalls || 0, 0);
});

// ====== 有効化・無効化 ======

test('有効化: health が通らなければ webhook を登録しない', () => {
  const t = makeCtx({ props: GOOD_PROPS });
  t.state.pingOk = false;
  assert.throws(() => t.run(`tgRelayEnableBooking()`), /health/);
  assert.equal(t.state.tg.filter((c) => c.method === 'setWebhook').length, 0);
  assert.equal(t.props.get('tg_relay_state_v1'), undefined);
});

test('有効化: 合言葉つきで登録し（未配達は捨てない）relay にする。無効化で webhook を外して poll に戻す', () => {
  const t = makeCtx({ props: GOOD_PROPS });
  t.run(`tgRelayEnableBooking()`);
  const set = t.state.tg.find((c) => c.method === 'setWebhook');
  assert.equal(set.bot, 'booking');
  assert.equal(set.payload.url, URL_ + '?bot=booking');
  assert.equal(set.payload.secret_token, SECRET);
  assert.equal(set.payload.drop_pending_updates, false);
  assert.equal(JSON.parse(t.props.get('tg_relay_state_v1')).booking, 'relay');
  assert.ok(!t.state.log.join('\n').includes(KEY) && !t.state.log.join('\n').includes(SECRET));   // ログに合言葉を出さない

  t.run(`tgRelayDisableBooking()`);
  assert.equal(JSON.parse(t.props.get('tg_relay_state_v1')).booking, 'poll');
  assert.equal(t.state.tg.filter((c) => c.method === 'deleteWebhook').pop().payload.drop_pending_updates, false);
});

test('設定の形が違えば止まる（URL が supabase.co でない・合言葉が短い・Telegram に使えない文字）', () => {
  [
    { TG_RELAY_URL: 'https://evil.example.com/functions/v1/tg-relay' },
    { TG_RELAY_KEY: 'short' },
    { TG_WEBHOOK_SECRET: 'has space '.repeat(4) }
  ].forEach((bad) => {
    const t = makeCtx({ props: Object.assign({}, GOOD_PROPS, bad) });
    assert.equal(t.run(`tgRelayConfig_()`), null);
  });
});
