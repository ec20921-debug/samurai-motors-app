/**
 * v7: 現場アプリ「お店の仕事」のサーバー側（2026-10-28 FieldShopMode.gs ほか）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * v7 の実ファイル（.gs）を Node の vm に読み込み、シート・Telegram はスタブで置き換える（本番には触れない）。
 *   - 管理グループの支払い行: お店と決めた金額（price_mode=agreed）・目安から大きく離れた時の注意
 *   - 作業前からあった傷・へこみの文章（SHOP_DAMAGE_NOTE=on の時だけ・お店の仕事モードだけ）
 *   - 現場アプリのお店一覧の linked（送る側と同じ行で決める・Bot連携が空なら付けない）
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');
const FILES = ['PartnerLang.gs', 'FieldShopMode.gs', 'FieldPayment.gs', 'ShopRouting.gs'];

function loadV7() {
  const props = {}, cache = {}, sent = [];
  const ctx = {
    console, sent,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = v; }, deleteProperty: (k) => { delete props[k]; } }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
  };
  vm.createContext(ctx);
  FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(V7, f), 'utf8'), ctx, { filename: f }));
  const run = (code) => vm.runInContext(code, ctx);
  run('fieldShopRateById_ = function () { return 30; };');
  return { ctx, props, cache, sent, run };
}

const agreed = (amount, guide) => ({ amount, v2: { price_mode: 'agreed', guide_price: guide, list_price: amount, shop_rate: 30 } });

test('支払い行: お店と決めた金額（目安なし・目安あり・差）', () => {
  const { ctx } = loadV7();
  let line = ctx.fieldPayAdminLine_('shop', 'LUXE Auto', agreed(20, 0), 'PTN-A01');
  assert.ok(line.includes('（お店と決めた金額 $20・目安なし）'));
  assert.ok(!line.includes('⚠️'), '目安なし（BODY）は現場アプリが毎回確認しているので注意を出さない');
  line = ctx.fieldPayAdminLine_('shop', 'LUXE Auto', agreed(10, 8.4), 'PTN-A01');
  assert.ok(line.includes('目安 $8.4・差 +$1.6') && !line.includes('⚠️'));
  assert.ok(ctx.fieldPayAdminLine_('shop', '', agreed(8.4, 8.4), 'X').includes('目安どおり'));
  assert.ok(ctx.fieldPayAdminLine_('shop', '', agreed(5, 8.4), 'X').includes('差 −$3.4'));
});

test('支払い行: 目安の 0.5倍未満・1.5倍超は注意（打ち間違いの歯止め）', () => {
  const { ctx } = loadV7();
  assert.ok(ctx.fieldPayAdminLine_('shop', '', agreed(200, 24.5), 'X').includes('⚠️ 目安から大きく離れています'));
  assert.ok(ctx.fieldPayAdminLine_('shop', '', agreed(10, 24.5), 'X').includes('⚠️ 目安から大きく離れています'));
  assert.ok(!ctx.fieldPayAdminLine_('shop', '', agreed(36, 24.5), 'X').includes('⚠️'));
  assert.ok(!ctx.fieldPayAdminLine_('shop', '', agreed(13, 24.5), 'X').includes('⚠️'));
  assert.ok(!ctx.fieldPayAdminLine_('shop', '', agreed(13, 24.5), 'X').includes('現場で金額を変えています'));
});

test('支払い行: 古いアプリ（price_mode なし）と紹介のお客さんは今までどおり', () => {
  const { ctx } = loadV7();
  const old = ctx.fieldPayAdminLine_('shop', 'LUXE Auto', { amount: 20, v2: { list_price: 12, shop_rate: 30 } }, 'PTN-A01');
  assert.ok(old.includes('（定価 $12・お店 30%）') && old.includes('現場で金額を変えています'));
  const ref = ctx.fieldPayAdminLine_('shopref', 'ANTON Auto', { amount: 8.4, v2: { price_mode: 'agreed', list_price: 12, shop_rate: 30 } }, 'PTN-C03');
  assert.ok(ref.includes('（定価 $12・お店 30%）') && !ref.includes('⚠️') && !ref.includes('お店と決めた金額'));
});

const DMG = [{ x: 1, y: 2, memo: '  right rear door:\n small dent ', photo: 'D1' }, { x: 3, y: 4, memo: '', photo: 'D2' }, { x: 0, y: 0, memo: '', photo: '' }];

test('傷の文章: 見出し（言語の順）・1か所ずつ・締め', () => {
  const { ctx } = loadV7();
  const lines = ctx.shopDamageText_(['km', 'en', 'ja'], DMG).split('\n');
  assert.ok(lines[0].startsWith('⚠️ ស្នាមកោស') && lines[0].includes('(2 កន្លែង)'), '写真もひとことも無い傷は数えない');
  assert.ok(lines[1].includes('(2)') && lines[2].includes('（2か所）'));
  assert.equal(lines[3], '① right rear door: small dent');
  assert.equal(lines[4], '② 📷');
  assert.equal(lines[5], '');
  assert.ok(lines[6].startsWith('រូបថតដូចខាងលើ'));
  assert.equal(lines[8], '写真は上のとおりです。作業の前から、この状態でした。');
  assert.equal(ctx.shopDamageText_(['ja'], []), '');
  assert.equal(ctx.shopDamageText_(['ja'], null), '');
});

test('傷の文章: ひとことは文字単位で80まで（絵文字を半分に切らない）・多い時は件数を正しく', () => {
  const { ctx } = loadV7();
  const memo = 'a'.repeat(79) + '🚗🚗';
  const item = ctx.shopDamageText_(['en'], [{ memo }]).split('\n')[1];
  assert.equal(item, '① ' + 'a'.repeat(79) + '🚗');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(item)));
  const many = ctx.shopDamageText_(['ja'], Array.from({ length: 32 }, (_, i) => ({ memo: 'd' + i, photo: 'D' + (i + 1) }))).split('\n');
  assert.ok(many[0].includes('（32か所）'));
  assert.ok(many.includes('⑩ d9') && many.includes('(11) d10') && many.includes('(30) d29') && many.includes('…'));
  assert.ok(!many.includes('(31) d30'));
});

test('傷の文章を送る: SHOP_DAMAGE_NOTE=on・お店の仕事モードの時だけ／失敗しても止めない', () => {
  const { ctx, props, sent, run } = loadV7();
  run('notifyShopGroupByShopId_ = function (id, text) { sent.push({ id: id, text: text }); return id; }; shopGroupLangs_ = function () { return ["ja"]; };');
  const body = { v2: { mode: 'shop', damage: DMG } };
  assert.equal(ctx.notifyShopDamage_('PTN-A01', body), '');
  assert.equal(sent.length, 0, '既定は送らない（Run Kosal のクメール語の確認待ち）');
  props.SHOP_DAMAGE_NOTE = ' ON ';
  assert.equal(ctx.notifyShopDamage_('PTN-A01', body), 'PTN-A01');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.startsWith('⚠️ 作業前からあった傷・へこみ（2か所）'));
  assert.equal(ctx.notifyShopDamage_('PTN-A01', { v2: { damage: DMG } }), '', '予約の流れ（mode なし）には送らない');
  assert.equal(ctx.notifyShopDamage_('', body), '');
  assert.equal(ctx.notifyShopDamage_('PTN-A01', { v2: { mode: 'shop' } }), '', '傷なしは送らない');
  assert.equal(sent.length, 1);
  run('notifyShopGroupByShopId_ = function () { throw new Error("boom"); };');
  assert.equal(ctx.notifyShopDamage_('PTN-A01', body), '');
});

test('エディタで実行する切り替え: enableShopDamageNote で送る・disableShopDamageNote で止める', () => {
  const { ctx, props } = loadV7();
  assert.equal(ctx.shopDamageNoteOn_(), false);
  ctx.enableShopDamageNote();
  assert.equal(props.SHOP_DAMAGE_NOTE, 'on');
  assert.equal(ctx.shopDamageNoteOn_(), true);
  ctx.disableShopDamageNote();
  assert.ok(!('SHOP_DAMAGE_NOTE' in props));
  assert.equal(ctx.shopDamageNoteOn_(), false);
});

function stubShops(run, links) {
  run('readShopLinks_ = function () { return ' + JSON.stringify(links.map((o) => ({ obj: o }))) + '; };' +
    `getSpreadsheet = function () { return { getSheetByName: function () { return {
      getLastRow: function () { return 3; }, getLastColumn: function () { return 4; },
      getRange: function (r) { return { getValues: function () { return r === 1 ? [['shop_id', '店名', 'QRリンク(BookingBot)', '紹介料率(%)']]
        : [['PTN-A01', 'LUXE Auto', 'https://t.me/x?start=shop_A01', 25], ['PTN-D04', 'DARA Car Care', 'https://t.me/x?start=shop_D04', '']]; } }; } }; } }; };
    fieldParseRate_ = function (v) { return v === '' ? 30 : Number(v); };`);
}

test('お店一覧: linked は送る側と同じ行（連携済 かつ グループchat_id）で決める', () => {
  const { ctx, cache, run } = loadV7();
  stubShops(run, [
    { shop_id: 'PTN-A01', 店名: 'LUXE Auto', 状態: '連携済', グループchat_id: '-100' },
    { shop_id: 'PTN-B02', 店名: 'CRSP Garage', 状態: '待機中', グループchat_id: '' },
    { shop_id: 'PTN-C03', 店名: 'ANTON Auto', 状態: '停止', グループchat_id: '-300' },
    { shop_id: 'PTN-E05', 店名: 'EAST Motor', 状態: '連携済', グループchat_id: '' },
    { shop_id: 'PTN-E05', 店名: 'EAST Motor', 状態: '連携済', グループchat_id: '-500' },
  ]);
  const by = {};
  ctx.apiFieldPartnerShops().shops.forEach((s) => { by[s.id] = s; });
  assert.equal(by['PTN-A01'].linked, true);
  assert.equal(by['PTN-A01'].rate, 25);
  assert.equal(by['PTN-D04'].linked, false, '店マスターだけ（グループなし）');
  assert.equal(by['PTN-B02'].linked, false, '待機中');
  assert.equal(by['PTN-E05'].linked, false, '送る側が選ぶ行（先頭の連携済）が chat_id 空なら送れない＝ linked にしない');
  assert.ok(!by['PTN-C03'], '停止は出さない');
  assert.ok(cache['field_partner_shops_v3']);
  ctx.invalidateShopLinkCache_();
  assert.ok(!cache['field_partner_shops_v3'], 'グループを連携したら一覧も作り直す');
});

test('お店一覧: Bot連携が空・読めない時は linked を付けない（現場アプリは全部出す）', () => {
  const { ctx, run } = loadV7();
  stubShops(run, []);
  const shops = JSON.parse(JSON.stringify(ctx.apiFieldPartnerShops().shops));
  assert.equal(shops.length, 2);
  assert.ok(shops.every((s) => !('linked' in s)));
});
