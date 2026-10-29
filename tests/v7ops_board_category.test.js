/**
 * v7-operations: 営業ボードのタブを「相手の種類」で分ける（2026-10-29 ScoutBoardShopLinks.gs scoutLinksCategory_）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *   Daisuke「車屋提携のタブの中にシティゴルフが入ってるけど、これは商業施設提携の方に」「ピカソはレジデンスだけど、商業施設ではないよね？」
 *   - 分類 = 店マスター「営業ボードの分類」（車屋・飲食店・レジデンス・商業施設）。空欄は自動（飲食店の型 → 業種の言葉 → 流入元＝レジデンス → 車屋）
 *   - 個人提携はいつも 🙋（専用の列）。各タブは店名の右に「お金の流れ」
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadOps() {
  const ctx = { console, Logger: { log: () => {} } };
  vm.createContext(ctx);
  ['PartnerLangOps.gs', 'IndividualPartnerOps.gs', 'ScoutBoardShopLinks.gs'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7-operations', f), 'utf8'), ctx, { filename: f }));
  return (code) => vm.runInContext(code, ctx);
}

test('分類: 空欄は自動（City Golf＝ゴルフ場→商業施設・Picasso＝流入元→レジデンス・飲食店の型→飲食店・ほか→車屋）', () => {
  const run = loadOps();
  const cat = (kind, shop) => run('scoutLinksCategory_(' + JSON.stringify(kind) + ', ' + JSON.stringify(shop) + ')');
  assert.equal(cat('shop', { '店名': 'City Golf', '業種': 'ゴルフ場' }), '商業施設');
  assert.equal(cat('source', { '店名': 'Picasso' }), 'レジデンス');
  assert.equal(cat('source', { '店名': 'Hotel X', '業種': 'ホテル' }), '商業施設');
  assert.equal(cat('restaurant', { '店名': 'PJ Restaurant' }), '飲食店');
  assert.equal(cat('shop', { '店名': 'PLP Auto World', '業種': '中古車販売' }), '車屋');
  assert.equal(cat('shop', { '店名': 'Cafe Y', '業種': 'カフェ' }), '飲食店');
  assert.equal(cat('individual', { '店名': 'Hiro Sato', '営業ボードの分類': '商業施設' }), '個人');
});

test('分類: 店マスター「営業ボードの分類」があればそれを使う（読めない値は自動）', () => {
  const run = loadOps();
  const cat = (kind, shop) => run('scoutLinksCategory_(' + JSON.stringify(kind) + ', ' + JSON.stringify(shop) + ')');
  assert.equal(cat('shop', { '店名': 'City Golf', '業種': '', '営業ボードの分類': '商業施設' }), '商業施設');
  assert.equal(cat('source', { '店名': 'Mall Z', '営業ボードの分類': '商業施設' }), '商業施設');
  assert.equal(cat('shop', { '店名': 'A', '営業ボードの分類': 'ゴルフ' }), '車屋');
});

test('タブへの振り分け: 1店は1つのタブだけ・各タブは店名の右に「お金の流れ」', () => {
  const run = loadOps();
  run('var __tabs = {}; scoutLinksWriteKindTab_ = function(board, key, notes, headers, rows) { __tabs[key] = { headers: headers, rows: rows }; };' +
      'scoutLinksFlyerSends_ = function() { return {}; }; formatSalesLogDateCell_ = function(v) { return String(v || ""); };' +
      'parsePercentCell_ = function(v) { return (v === "" || v == null) ? null : Number(v); }; COMMISSION_DEFAULT_RATE = 30;');
  const mk = (id, name, kind, shop) => ({ id, name, kind, shop: Object.assign({ '店名': name }, shop || {}),
    cells: [0, name, 'qr-' + id, '✅'], link: {}, linked: true, rate: 30, qr: 'qr-' + id });
  const items = [
    mk('S1', 'PLP Auto World', 'shop', { '業種': '中古車販売' }),
    mk('S2', 'City Golf', 'shop', { '業種': 'ゴルフ場' }),
    mk('S3', 'Picasso', 'source'),
    mk('S4', 'PJ Restaurant', 'restaurant'),
    mk('S5', 'Hiro Sato', 'individual')
  ].map((o) => { o.cat = run('scoutLinksCategory_(' + JSON.stringify(o.kind) + ', ' + JSON.stringify(o.shop) + ')');
    o.pay = run('SCOUT_LINKS_PAY_LABEL[' + JSON.stringify(o.kind) + ']'); return o; });
  run('scoutLinksWriteKindTabs_({}, ' + JSON.stringify(items) + ')');
  const tabs = JSON.parse(run('JSON.stringify(__tabs)'));
  const names = (k) => tabs[k].rows.map((r) => r[1]);
  assert.deepEqual(names('pShop'), ['PLP Auto World']);
  assert.deepEqual(names('pFacility'), ['City Golf']);
  assert.deepEqual(names('pResidence'), ['Picasso']);
  assert.deepEqual(names('pRestaurant'), ['PJ Restaurant']);
  assert.equal(tabs.pIndiv.rows.length, 1);
  assert.equal(tabs.pFacility.headers[2], 'お金の流れ (Payment)');
  assert.equal(tabs.pFacility.rows[0][2], 'お店に払う（店集金・当社は残りを施工時に）');
  assert.equal(tabs.pResidence.rows[0][2], '当社に払う（特典は流入元タブ）');
  assert.equal(tabs.pRestaurant.rows[0][2], '当社に払う（紹介料は月初に ABA）');
  assert.equal(tabs.pShop.rows[0][3], 'qr-S1');   // 元の列は1つ右へずれる
});
