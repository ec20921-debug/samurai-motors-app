/**
 * v7: 個人提携の紹介者ご本人の車 → そのグループへ作業の開始・完了と写真（2026-10-30 IndividualSelfJob.gs）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * v7 の実ファイル（PartnerLang.gs・JobIdempotency.gs・IndividualSelfJob.gs）を Node の vm に読み込み、
 * 店マスター・Bot連携・Telegram はスタブで置き換える（本番には触れない）。
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');
const FILES = ['PartnerLang.gs', 'JobIdempotency.gs', 'IndividualSelfJob.gs'];

function loadV7(opt) {
  opt = opt || {};
  const cache = {}, sent = [];
  const ctx = {
    console, sent,
    Logger: { log: () => {} },
    BOT_TYPE: { BOOKING: 'booking' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    // 店マスター「本人chat_id」: 777 = Hiro さん（PTN-011）ご本人
    individualPartnerSelfFor_: (chatId) => (String(chatId) === '777' ? { shopId: 'SHOP-HIRO', name: 'Hiro Sato', rate: 30, discount: 0 } : null),
    findShopLinkByShopId_: (id) => (id === 'SHOP-HIRO'
      ? { obj: { '状態': opt.linkState || '連携済', 'グループchat_id': '-500' } } : null),
    individualGroupLangs_: () => (opt.langs || ['en', 'km']).slice(),
    warnSourceGroupFailed_: (link, what) => { sent.push({ type: 'warn', what }); },
    sendMessage: (bot, chat, text) => {
      if (opt.textFails) return { ok: false };
      sent.push({ type: 'text', chat: String(chat), text }); return { ok: true };
    },
    sendPhotoAlbum: (bot, chat, blobs) => { sent.push({ type: 'album', chat: String(chat), n: blobs.length }); return { ok: true }; }
  };
  vm.createContext(ctx);
  FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(V7, f), 'utf8'), ctx, { filename: f }));
  return { ctx, sent, cache };
}

const BLOBS = [{ name: 'b1' }, { name: 'b2' }];

test('ご本人の車: 作業開始で見出し（英語・クメール語）・車・作業前の写真の行 ＋ 写真', () => {
  const { ctx, sent } = loadV7();
  const r = ctx.notifyIndividualSelfJob_('start', '777', { car: 'Tundra / 2AK-1699', blobs: BLOBS, opts: { cid: 'job-cid-0001' } });
  assert.equal(r, 'SHOP-HIRO');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].chat, '-500');
  const lines = sent[0].text.split('\n');
  assert.equal(lines[0], '▶️ Job started (your car)');
  assert.ok(lines[1].startsWith('ការងារចាប់ផ្តើមហើយ'));
  assert.equal(lines[2], '🚗 Tundra / 2AK-1699');
  assert.equal(lines[3], '📷 Before photos / រូបថតមុនធ្វើសេវា ↓');
  assert.deepEqual([sent[1].type, sent[1].n], ['album', 2]);
});

test('ご本人の車: 作業終了で所要時間・作業後の写真の行 ＋ 写真（日本語の設定）', () => {
  const { ctx, sent } = loadV7({ langs: ['ja'] });
  ctx.notifyIndividualSelfJob_('end', '777', { car: '', duration: 52, blobs: BLOBS, opts: { cid: 'end-cid-0001' } });
  assert.equal(sent[0].text, '✅ 作業完了（ご自身のお車）\n⏱ 52分\n📷 作業後の写真 ↓');
  assert.equal(sent[1].type, 'album');
});

test('お友達（ご本人でないお客様）の車は送らない', () => {
  const { ctx, sent } = loadV7();
  assert.equal(ctx.notifyIndividualSelfJob_('start', '555', { blobs: BLOBS, opts: {} }), '');
  assert.equal(ctx.notifyIndividualSelfJob_('end', '', { blobs: BLOBS, opts: {} }), '');
  assert.equal(sent.length, 0);
});

test('グループが連携済みでなければ送らない', () => {
  const { ctx, sent } = loadV7({ linkState: '待機中' });
  assert.equal(ctx.notifyIndividualSelfJob_('start', '777', { blobs: BLOBS, opts: {} }), '');
  assert.equal(sent.length, 0);
});

test('同じ送信の再実行では送り直さない（届いた後にだけ印）', () => {
  const { ctx, sent } = loadV7();
  const opts = { cid: 'job-cid-0001' };
  ctx.notifyIndividualSelfJob_('start', '777', { blobs: BLOBS, opts });
  ctx.notifyIndividualSelfJob_('start', '777', { blobs: BLOBS, opts });
  assert.equal(sent.filter((s) => s.type === 'text').length, 1);
  // 完了は別の印
  ctx.notifyIndividualSelfJob_('end', '777', { blobs: BLOBS, opts: { cid: 'end-cid-0001' } });
  assert.equal(sent.filter((s) => s.type === 'text').length, 2);
});

test('文が届かなかった時は印を付けず、管理グループに知らせる（次の送り直しで再送）', () => {
  const { ctx, sent, cache } = loadV7({ textFails: true });
  assert.equal(ctx.notifyIndividualSelfJob_('start', '777', { blobs: BLOBS, opts: { cid: 'job-cid-0001' } }), '');
  assert.equal(sent[0].type, 'warn');
  assert.equal(Object.keys(cache).filter((k) => k.indexOf('selfstart') >= 0).length, 0);
});

test('写真が無い時は写真の行を出さない', () => {
  const { ctx, sent } = loadV7();
  ctx.notifyIndividualSelfJob_('start', '777', { car: '', blobs: [], opts: {} });
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].text.includes('📷'));
});
