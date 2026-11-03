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
      if (id === PICASSO) return { obj: { shop_id: PICASSO, '店名': 'Picasso City Garden', '状態': opts.unlinked ? '待機中' : '連携済', 'グループchat_id': '-1000000000' } };
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
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.fieldResidences_())), [{ id: PICASSO, name: 'Picasso City Garden', pct: 0 }]);
});

test('レジデンス一覧: 割引率は流入元タブの決まりで返す（常時・期間内は率、期間外は0）', () => {
  const { ctx } = load();
  // 実物の sourcePctFor_ / sourceInPeriod_ / sourceToday_ を読み込む（シートには触らない）
  const src = fs.readFileSync(path.join(V7, 'SourceCampaign.gs'), 'utf8');
  const pick = (name) => { const a = src.indexOf('function ' + name + '('); return src.slice(a, src.indexOf(String.fromCharCode(10) + '}', a) + 2); };
  vm.runInContext(pick('sourceInPeriod_') + pick('sourcePctFor_') + 'function sourceToday_() { return "2026-11-03"; }', ctx);
  const c = { itemPct: { HEADLIGHT_MAGIC: 50 }, servicePct: 20, start: '2026-10-26', end: '2026-11-01' };
  assert.equal(ctx.fieldResidencePct_(Object.assign({ serviceAlways: true }, c)), 20);
  assert.equal(ctx.fieldResidencePct_(Object.assign({ serviceAlways: false }, c)), 0);
  assert.equal(ctx.fieldResidencePct_({ servicePct: 20, start: '2026-11-01', end: '2026-11-30' }), 20);
  assert.equal(ctx.fieldResidencePct_({ servicePct: 0, serviceAlways: true }), 0);
});

test('レジデンス一覧: 流入元の行で率が違う時は最も高い率。率の計算が失敗しても一覧からは消さない', () => {
  const base = { label: 'Picasso City Garden', placeName: 'Picasso City Garden', active: true, shopId: PICASSO };
  const { ctx } = load({ cfgs: { a: Object.assign({ code: 'a', pct: 0 }, base), b: Object.assign({ code: 'b', pct: 20 }, base) } });
  ctx.sourceToday_ = () => '2026-11-03';
  ctx.sourcePctFor_ = (c) => c.pct;
  assert.equal(ctx.fieldResidences_()[0].pct, 20);
  ctx.sourcePctFor_ = () => { throw new Error('boom'); };
  const r = ctx.fieldResidences_();
  assert.equal(r.length, 1);
  assert.equal(r[0].pct, 0);
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
  assert.ok(sent.every((m) => m.chatId === '-1000000000'));
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

test('施工内容（2026-11-01）: 通知に 🧽 の行（英語のメニュー名・重複なし）。無ければ行を出さない', () => {
  const { ctx, sent } = load();
  const staff = ctx.sourceGroupWalkinRec_(ctx.fieldResidenceById_(PICASSO, 'staff'), '');
  ctx.notifySourceGroupJob_('start', { rec: staff, carModel: 'STAREX', blobs: [1, 2, 3, 4], opts: {}, services: 'BODY' });
  ctx.notifySourceGroupJob_('end', { rec: staff, carModel: 'STAREX', duration: 90, blobs: [1], opts: {}, services: 'WASH,HEADLIGHT_MAGIC,WASH' });
  assert.equal(sent[0].text, '▶️ Job started — Picasso City Garden staff\n🚗 STAREX\n🧽 BODY\n📷 Before photos ↓');
  assert.equal(sent[1].text, '✅ Job finished — Picasso City Garden staff\n🚗 STAREX\n🧽 WASH + HEADLIGHT MAGIC\n⏱ 90 min\n📷 After photos ↓');
  assert.equal(ctx.sourceGroupServicesEn_(''), '');
  assert.equal(ctx.sourceGroupServicesEn_(undefined), '');
  assert.equal(ctx.sourceGroupServicesEn_('GLASS_3, BODY'), 'GLASS 3 + BODY');
});
