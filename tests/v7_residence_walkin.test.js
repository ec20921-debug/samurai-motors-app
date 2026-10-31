/**
 * v7: 予約なしの作業で選んだレジデンス等（Picasso）のグループへ Before/After を送る（2026-10-31）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * SourceGroupNotify.gs を Node の vm に読み込み、流入元タブ・Bot連携・Telegram はスタブ（本番には触れない）。
 *   - fieldResidences_: 有効な流入元の shop_id のうち、グループ連携済みのものを1つずつ
 *   - fieldResidenceById_: 選べるレジデンスでない id は null
 *   - notifySourceGroupJob_(p.rec): 本文に金額を載せない・予約の印を消さない・同じ送信の再実行で送り直さない
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');
const PICASSO = 'SHOP-20260928-075455-d5ac9359';

function load(opts) {
  opts = opts || {};
  const sent = [], albums = [], deleted = [], marks = {};
  const cfg = (code, o) => Object.assign({ code, label: 'Picasso City Garden', placeName: 'Picasso City Garden', active: true, shopId: PICASSO, lang: 'en-ja' }, o || {});
  const ctx = {
    console, Logger: { log: () => {} },
    BOT_TYPE: { BOOKING: 'booking' },
    getConfig: () => ({ adminGroupId: '-100admin' }),
    readSourceConfigs_: () => opts.cfgs || {
      picasso_tg: cfg('picasso_tg'), picasso_flyer: cfg('picasso_flyer'),
      old_promo: cfg('old_promo', { shopId: 'SHOP-OLD', active: false, label: 'Old' }),
      nogroup: cfg('nogroup', { shopId: 'SHOP-NOGROUP', label: 'No Group Condo', placeName: '' })
    },
    sourceConfigsReadable_: () => opts.unreadable ? false : true,
    findShopLinkByShopId_: (id) => {
      if (id === PICASSO) return { obj: { shop_id: PICASSO, '店名': 'Picasso City Garden', '状態': opts.unlinked ? '待機中' : '連携済', 'グループchat_id': '-5147145489' } };
      if (id === 'SHOP-NOGROUP') return { obj: { shop_id: id, '状態': '待機中', 'グループchat_id': '' } };
      return null;
    },
    sendMessage: (bot, chatId, text) => { sent.push({ chatId, text }); return { ok: true }; },
    sendPhotoAlbum: (bot, chatId, blobs) => { albums.push({ chatId, n: blobs.length }); return { ok: true }; },
    jobCustSent_: (o, key) => !!marks[key],
    jobMarkCustSent_: (o, key) => { marks[key] = true; },
    kvGet_: () => null,
    kvDelete_: (k) => { deleted.push(k); }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(V7, 'SourceGroupNotify.gs'), 'utf8'), ctx, { filename: 'SourceGroupNotify.gs' });
  return { ctx, sent, albums, deleted };
}

test('レジデンス一覧: 連携済みの Picasso だけを1つ（流入元が何行あっても）', () => {
  const { ctx } = load();
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.fieldResidences_())), [{ id: PICASSO, name: 'Picasso City Garden' }]);
});

test('レジデンス一覧: グループ未連携・流入元タブが読めない時は空', () => {
  assert.equal(load({ unlinked: true }).ctx.fieldResidences_().length, 0);
  assert.equal(load({ unreadable: true }).ctx.fieldResidences_().length, 0);
});

test('レジデンスの確認: 一覧にない id（車屋・未連携・空）は null', () => {
  const { ctx } = load();
  assert.equal(ctx.fieldResidenceById_(PICASSO).name, 'Picasso City Garden');
  assert.equal(ctx.fieldResidenceById_('SHOP-20260929-164743-b8040692'), null);
  assert.equal(ctx.fieldResidenceById_('SHOP-NOGROUP'), null);
  assert.equal(ctx.fieldResidenceById_(''), null);
  assert.equal(ctx.fieldResidenceById_(undefined), null);
});

test('部屋番号: 改行・向きを変える記号は空白・20字まで', () => {
  const { ctx } = load();
  const res = { id: PICASSO, name: 'Picasso City Garden' };
  assert.equal(ctx.sourceGroupWalkinRec_(res, ' 12A\n\u202eB ').unitNo, '12A B');
  assert.equal(ctx.sourceGroupWalkinRec_(res, 'x'.repeat(40)).unitNo.length, 20);
  assert.equal(ctx.sourceGroupWalkinRec_(res, '').unitNo, '');
});

test('予約なしの作業: 開始・完了の本文に金額が出ない・写真が付く・予約の印は消さない', () => {
  const { ctx, sent, albums, deleted } = load();
  const rec = ctx.sourceGroupWalkinRec_({ id: PICASSO, name: 'Picasso City Garden' }, '');
  const opts = {};
  assert.equal(ctx.notifySourceGroupJob_('start', { rec, carModel: 'Lexus RX', blobs: [1, 2, 3], opts }), PICASSO);
  assert.equal(ctx.notifySourceGroupJob_('end', { rec, carModel: 'Lexus RX', duration: 95, blobs: [1, 2], opts }), PICASSO);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((m) => m.chatId === '-5147145489'));
  assert.match(sent[0].text, /^▶️ Job started — Picasso City Garden\n/);
  assert.match(sent[1].text, /^✅ Job finished — Picasso City Garden\n/);
  assert.ok(!/resident/.test(sent[0].text), 'スタッフの車もあるので resident と書かない');
  assert.match(sent[0].text, /🚪 Unit: -/);
  assert.match(sent[1].text, /⏱ 95 min/);
  assert.ok(sent.every((m) => !/\$|USD|💵/.test(m.text)), '金額を載せない');
  assert.deepEqual(albums.map((a) => a.n), [3, 2]);
  assert.equal(deleted.length, 0);
});

test('予約なしの作業: 同じ送信の再実行では送り直さない', () => {
  const { ctx, sent } = load();
  const rec = ctx.sourceGroupWalkinRec_({ id: PICASSO, name: 'Picasso City Garden' }, '0501');
  const opts = {};
  ctx.notifySourceGroupJob_('start', { rec, blobs: [], opts });
  assert.equal(ctx.notifySourceGroupJob_('start', { rec, blobs: [], opts }), PICASSO);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /🚪 Unit: 0501/);
});

test('予約の作業（今までどおり）: 印が無い予約は送らない・印がある予約は完了で印を消す', () => {
  const { ctx, sent, deleted } = load();
  assert.equal(ctx.notifySourceGroupJob_('start', { bookingId: 'BK-1', blobs: [], opts: {} }), '');
  assert.equal(sent.length, 0);
  ctx.kvGet_ = () => JSON.stringify({ shopId: PICASSO, label: 'Picasso City Garden', unitNo: '2F' });
  assert.equal(ctx.notifySourceGroupJob_('end', { bookingId: 'BK-2', blobs: [], opts: {} }), PICASSO);
  assert.match(sent[0].text, /Picasso City Garden resident/);
  assert.deepEqual(deleted, ['srcgrp_BK-2']);
});

test('住人／スタッフ（2026-10-31）: スタッフは部屋番号の行なし・見出しに staff。住人は resident と部屋番号', () => {
  const { ctx, sent } = load();
  const staff = ctx.fieldResidenceById_(PICASSO, 'staff');
  const resident = ctx.fieldResidenceById_(PICASSO, 'resident');
  assert.equal(staff.who, 'staff');
  assert.equal(ctx.fieldResidenceById_(PICASSO, 'owner').who, '', '知らない値は空');
  ctx.notifySourceGroupJob_('start', { rec: ctx.sourceGroupWalkinRec_(staff, '0501'), carModel: 'Lexus RX', blobs: [], opts: {} });
  ctx.notifySourceGroupJob_('end', { rec: ctx.sourceGroupWalkinRec_(resident, '0501'), carModel: 'Prius', blobs: [], opts: {} });   // スタブの送信済みの印は店ごとなので終了で確かめる
  assert.equal(sent[0].text, '▶️ Job started — Picasso City Garden staff\n🚗 Lexus RX');
  assert.equal(sent[1].text, '✅ Job finished — Picasso City Garden resident\n🚪 Unit: 0501\n🚗 Prius');
});
