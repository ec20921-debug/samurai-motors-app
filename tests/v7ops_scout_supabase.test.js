/**
 * v7-operations: SAMURAI SCOUT の読み取り用の写し（ScoutSupabase.gs・2026-11-07）
 *
 * 実行: node --test "tests/*.test.js"
 *
 *   - 設定（Script Properties 3つ）が無ければ何もしない（Supabase を呼ばない）
 *   - 書き込みが ok なら、その店の詳細の写しを消すだけ（重い作り直しはしない）。ok でなければ何もしない。応答はそのまま返す
 *   - GAS で一覧・詳細を作った時はそれを写す（訪問の緯度経度は写さない）。空の一覧は写さない
 *   - 通行証は1人6時間に6回まで。外したスタッフの通行証は定期の処理で消す
 *   - 新しい鍵（sb_…）は apikey だけ、旧 JWT の鍵は Authorization にも入れる
 *   - 通行証: スタッフでなければ出さない。Supabase にはハッシュだけを送り、元の文字は応答だけに入れる
 *   - Supabase が落ちていても例外を外に出さない
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'v7-operations', 'ScoutSupabase.gs'), 'utf8');

function makeCtx(opts) {
  opts = Object.assign({ props: {}, status: 201, throwFetch: false, staff: true, tokenRows: [] }, opts || {});
  const fetches = [];
  const cache = {};
  const ctx = {
    console,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in opts.props ? opts.props[k] : null) }) },
    UrlFetchApp: {
      fetch: (url, o) => {
        if (opts.throwFetch) throw new Error('network down');
        fetches.push({ url, method: o.method, headers: o.headers, body: o.payload ? JSON.parse(o.payload) : undefined });
        if (o.method === 'get') return { getResponseCode: () => 200, getContentText: () => JSON.stringify(opts.tokenRows) };
        return { getResponseCode: () => opts.status, getContentText: () => '' };
      }
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' }
    },
    salesLogShopsData_: () => [{ shopId: 'S1', shopName: 'A' }],
    salesLogShopDetail: (chatId, id) => ({ ok: true, shop: { shopId: id }, visits: [], hearings: [], notes: [], qr: null }),
    findStaffByChatId: (id) => (opts.staff === true || (Array.isArray(opts.staff) && opts.staff.includes(id)) ? { chatId: id } : null),
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    runAtMostEvery_: (k, t, fn) => fn()
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, fetches };
}

const ON = { SUPABASE_URL: 'https://abcd.supabase.co/', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', SUPABASE_SECRET_KEY: 'sb_secret_y' };

test('設定が無ければ Supabase を呼ばず、応答はそのまま', () => {
  const { ctx, fetches } = makeCtx();
  const res = { ok: true, shopId: 'S1' };
  assert.equal(ctx.scoutSbAfterWrite_(res, '1', 'S1'), res);
  assert.equal(fetches.length, 0);
  assert.equal(ctx.scoutSbIssueToken('1').error, 'SCOUT_SB_OFF');
});

test('URL が supabase.co でなければ設定なし扱い', () => {
  const { ctx } = makeCtx({ props: Object.assign({}, ON, { SUPABASE_URL: 'https://evil.example.com' }) });
  assert.equal(ctx.scoutSbConfig_(), null);
});

test('書き込みが ok なら、その店の詳細の写しを消すだけ（新しい鍵は apikey だけ）', () => {
  const { ctx, fetches } = makeCtx({ props: ON });
  const res = { ok: true, visitId: 'V1', shopId: 'S9' };
  assert.equal(ctx.scoutSbAfterWrite_(res, ''), res);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].method, 'delete');
  assert.equal(fetches[0].url, 'https://abcd.supabase.co/rest/v1/scout_cache?key=eq.detail%3AS9');
  assert.equal(fetches[0].headers.apikey, 'sb_secret_y');
  assert.equal(fetches[0].headers.Authorization, undefined);
});

test('お店の番号がおかしければ消しに行かない', () => {
  const { ctx, fetches } = makeCtx({ props: ON });
  ctx.scoutSbAfterWrite_({ ok: true, shopId: 'S1&key=neq.x' }, '');
  assert.equal(fetches.length, 0);
});

test('GAS で一覧を作った時はそれを写す（空なら写さない）', () => {
  const { ctx, fetches } = makeCtx({ props: ON });
  const res = { ok: true, shops: [{ shopId: 'S1' }] };
  assert.equal(ctx.scoutSbAfterList_(res), res);
  assert.equal(fetches[0].url, 'https://abcd.supabase.co/rest/v1/scout_cache?on_conflict=key');
  assert.equal(fetches[0].body[0].key, 'shops');
  assert.match(fetches[0].headers.Prefer, /merge-duplicates/);
  ctx.scoutSbAfterList_({ ok: true, shops: [] });
  assert.equal(fetches.length, 1);
});

test('詳細の写しには訪問の緯度経度を入れない（あり/なしだけ）', () => {
  const { ctx, fetches } = makeCtx({ props: ON });
  ctx.scoutSbAfterDetail_('S1', { ok: true, shop: { shopId: 'S1' }, visits: [{ visitId: 'a', lat: 11.55, lng: 104.9 }, { visitId: 'b', lat: '', lng: '' }], hearings: [], notes: [], qr: null });
  const v = fetches[0].body[0].data.visits;
  assert.equal(fetches[0].body[0].key, 'detail:S1');
  assert.deepEqual([v[0].lat, v[0].lng, v[1].lat], [0, 0, null]);
  assert.ok(!JSON.stringify(fetches[0].body).includes('104.9'));
});

test('旧 JWT の鍵は Authorization にも入れる', () => {
  const { ctx, fetches } = makeCtx({ props: Object.assign({}, ON, { SUPABASE_SECRET_KEY: 'eyJhbGciOi.x.y' }) });
  ctx.scoutSbSync();
  assert.equal(fetches[0].headers.Authorization, 'Bearer eyJhbGciOi.x.y');
});

test('書き込みが失敗なら写さない', () => {
  const { ctx, fetches } = makeCtx({ props: ON });
  ctx.scoutSbAfterWrite_({ ok: false, error: 'X' }, 'S1');
  assert.equal(fetches.length, 0);
});

test('通行証: ハッシュだけを送り、元の文字は応答にだけ入れる', () => {
  const { ctx, fetches } = makeCtx({ props: ON });
  const r = ctx.scoutSbIssueToken('777');
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://abcd.supabase.co');
  assert.equal(r.key, 'sb_publishable_x');
  assert.ok(r.token.length >= 32);
  const sent = fetches[0].body[0];
  assert.equal(sent.chat_id, '777');
  assert.equal(sent.token_hash, crypto.createHash('sha256').update(r.token).digest('hex'));
  assert.ok(!JSON.stringify(fetches).includes(r.token));
  assert.ok(r.exp > Date.now() + 6 * 864e5 && r.exp < Date.now() + 8 * 864e5);
});

test('通行証: スタッフでなければ出さない', () => {
  const { ctx, fetches } = makeCtx({ props: ON, staff: false });
  assert.equal(ctx.scoutSbIssueToken('1').error, 'STAFF_NOT_FOUND');
  assert.equal(fetches.length, 0);
});

test('Supabase が落ちていても例外を出さない', () => {
  const { ctx } = makeCtx({ props: ON, throwFetch: true });
  const res = { ok: true, shopId: 'S1' };
  assert.equal(ctx.scoutSbAfterWrite_(res, 'S1'), res);
  assert.equal(ctx.scoutSbIssueToken('1').error, 'SCOUT_SB_UNAVAILABLE');
  assert.doesNotThrow(() => ctx.scoutSbSync());
});

test('定期の写し: 一覧を送り、期限切れと外したスタッフの通行証を消す', () => {
  const { ctx, fetches } = makeCtx({ props: ON, staff: ['1'], tokenRows: [{ chat_id: '1' }, { chat_id: '2' }, { chat_id: '2' }] });
  ctx.scoutSbSync();
  assert.equal(fetches[0].body[0].key, 'shops');
  assert.equal(fetches[1].method, 'delete');
  assert.match(fetches[1].url, /scout_tokens\?expires_at=lt\./);
  assert.equal(fetches[2].method, 'get');
  const dels = fetches.slice(3);
  assert.deepEqual(dels.map((f) => f.url), ['https://abcd.supabase.co/rest/v1/scout_tokens?chat_id=eq.2']);
});

test('通行証は1人6時間に6回まで', () => {
  const { ctx } = makeCtx({ props: ON });
  for (let i = 0; i < 6; i++) assert.equal(ctx.scoutSbIssueToken('9').ok, true);
  assert.equal(ctx.scoutSbIssueToken('9').error, 'SCOUT_SB_RATE');
  assert.equal(ctx.scoutSbIssueToken('8').ok, true);
});
