/**
 * v7-operations: 日本側の入口の「今日」（PortalToday.gs・2026-11-22）
 *
 * 実行: node --test "tests/*.test.js"
 *
 * PortalToday.gs だけを Node の vm に読み込み、Supabase への問い合わせ・シート・日報の欄はスタブ（本番には触れない）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPS = path.join(__dirname, '..', 'v7-operations');
const TOKEN = 'eyJ' + 'a'.repeat(120) + '.' + 'b'.repeat(200) + '.' + 'c'.repeat(43);
const APIKEY = 'eyJ' + 'k'.repeat(100);

function makeCtx(opts) {
  opts = Object.assign({ role: 'admin', status: 200 }, opts || {});
  const cacheStore = {}; const fetches = [];
  const ctx = {
    console, Logger: { log: () => {} }, OPS_TZ: 'Asia/Phnom_Penh',
    Utilities: {
      formatDate: (d, tz, f) => (f === 'H:mm' ? '18:30' : '2026-11-22'),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => Array.from(require('node:crypto').createHash('sha256').update(text, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b))
    },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cacheStore ? cacheStore[k] : null), put: (k, v) => { cacheStore[k] = v; } }) },
    UrlFetchApp: { fetch: (url, o) => {
      fetches.push({ url, headers: o.headers });
      if (opts.throws) throw new Error('network');
      return { getResponseCode: () => opts.status, getContentText: () => JSON.stringify(opts.status === 200 ? opts.role : { message: 'JWT expired' }) };
    } },
    getSheetTz_: () => 'Asia/Phnom_Penh',
    formatTimeCell_: (c) => String(c || ''),
    getAllRows: () => [
      { '日付': '2026-11-21', '氏名(JP)': 'ロン', '出勤時刻': '7:50', '退勤時刻': '18:00' },
      { '日付': '2026-11-22', '氏名(JP)': 'ロン', '出勤時刻': '7:55', '退勤時刻': '18:03' },
      { '日付': '2026-11-22', '氏名(JP)': 'ナビン', '出勤時刻': '7:02', '退勤時刻': '' }
    ],
    buildSalesSection_: () => '💰 <b>本日の売上</b>\n　合計: <b>$42.00</b>\n　ジョブ: 3件（完了 3 / キャンセル 0）',
    buildOsoujiSection_: () => '🧹 <b>そうじ</b>（Navin）11/11 か所・42分・6:45〜7:27',
    buildNihongoSection_: () => '📚 <b>日本語</b>（ナビン）\n　きのう：22分・48問\n　今日（ここまで）：まだ'
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(OPS, 'PortalToday.gs'), 'utf8'), ctx, { filename: 'PortalToday.gs' });
  return { ctx, fetches, cacheStore };
}
const plain = (o) => JSON.parse(JSON.stringify(o));
const titles = (r) => plain(r).cards.map((c) => c.title);

test('全部・経営 → 売上も出る／メンバー → 売上は出ない', () => {
  for (const role of ['admin', 'exec']) {
    const r = makeCtx({ role }).ctx.portalToday_({ token: TOKEN, apikey: APIKEY });
    assert.equal(r.ok, true);
    assert.deepEqual(titles(r), ['売上', '出勤', 'そうじ', '日本語']);
    assert.deepEqual(plain(r).cards[0].lines, ['合計: $42.00', 'ジョブ: 3件（完了 3 / キャンセル 0）']);
  }
  const m = makeCtx({ role: 'member' }).ctx.portalToday_({ token: TOKEN, apikey: APIKEY });
  assert.deepEqual(titles(m), ['出勤', 'そうじ', '日本語']);
  assert.ok(!JSON.stringify(plain(m)).includes('42.00'));
});

test('出勤は今日の分だけ・タグは外す', () => {
  const r = plain(makeCtx().ctx.portalToday_({ token: TOKEN, apikey: APIKEY }));
  assert.deepEqual(r.cards[1].lines, ['ロン　7:55〜18:03', 'ナビン　7:02〜']);
  assert.deepEqual(r.cards[2].lines, ['（Navin）11/11 か所・42分・6:45〜7:27']);
  assert.ok(!JSON.stringify(r).includes('<b>'));
});

test('現場スタッフ・通行証が無効・形がおかしい → 何も出さない', () => {
  assert.deepEqual(plain(makeCtx({ role: 'staff' }).ctx.portalToday_({ token: TOKEN, apikey: APIKEY })), { ok: false, error: 'FORBIDDEN' });
  assert.deepEqual(plain(makeCtx({ status: 401 }).ctx.portalToday_({ token: TOKEN, apikey: APIKEY })), { ok: false, error: 'FORBIDDEN' });
  assert.deepEqual(plain(makeCtx({ role: 'owner' }).ctx.portalToday_({ token: TOKEN, apikey: APIKEY })), { ok: false, error: 'FORBIDDEN' });
  const bad = makeCtx();
  assert.equal(bad.ctx.portalToday_({ token: 'short', apikey: APIKEY }).error, 'FORBIDDEN');
  assert.equal(bad.ctx.portalToday_({ token: TOKEN + ' x', apikey: APIKEY }).error, 'FORBIDDEN');
  assert.equal(bad.ctx.portalToday_({}).error, 'FORBIDDEN');
  assert.equal(bad.fetches.length, 0, '形がおかしい時は問い合わせもしない');
});

test('問い合わせ先は決まった宛先だけ・役割と数字はキャッシュ・通行証は保存しない', () => {
  const { ctx, fetches, cacheStore } = makeCtx();
  ctx.portalToday_({ token: TOKEN, apikey: APIKEY, url: 'https://evil.example' });
  ctx.portalToday_({ token: TOKEN, apikey: APIKEY });
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, 'https://vavtrzewmldmpwmtogef.supabase.co/rest/v1/rpc/my_role');
  assert.equal(fetches[0].headers.Authorization, 'Bearer ' + TOKEN);
  assert.ok(!JSON.stringify(cacheStore).includes(TOKEN) && !Object.keys(cacheStore).join().includes(TOKEN.slice(0, 30)));
});

test('通信の失敗はキャッシュしない（次にもう一度確かめる）・欄が読めなくても全体は返す', () => {
  const a = makeCtx({ throws: true });
  assert.equal(a.ctx.portalToday_({ token: TOKEN, apikey: APIKEY }).error, 'FORBIDDEN');
  assert.equal(Object.keys(a.cacheStore).length, 0);
  const b = makeCtx();
  b.ctx.buildSalesSection_ = () => { throw new Error('sheet down'); };
  const r = plain(b.ctx.portalToday_({ token: TOKEN, apikey: APIKEY }));
  assert.deepEqual(r.cards[0].lines, ['読めませんでした']);
  assert.equal(r.cards.length, 4);
});
