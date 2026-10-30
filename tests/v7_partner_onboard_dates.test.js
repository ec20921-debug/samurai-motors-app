/**
 * v7: 個人提携の毎時の安全網（PartnerSelfRegister.gs sendPendingIndividualOnboarding_）が、
 *     「状態」タブで日付に化けたあいさつ文の日時を読んでも、既存のグループにチラシを送り直さないことの確認（2026-10-31）
 *
 * 実行: node --test "tests/*.test.js"
 *
 * 不具合（2026-10-31 01:53 JST・本番 @105）: 状態タブへの引っ越しで、シートが shop_greeting_sent_ の「2026-10-26 15:25:36」を
 *   日付に変え、読むと「Mon Oct 26 2026 …」になった。文字の並びで比べる「2026-10-27 11:00 より前のグループには送らない」が効かず、
 *   Hiro さん（PTN-011・あいさつ文 10/26）のグループに、チラシ v1.0・6枚と紹介URLが自動で送り直された。
 *   - 日付に化けた値でも、元の文字の形で読む（KvStore.gs）→ 既存のグループには送らない
 *   - 新しいグループ（あいさつ文が 7 日以内）には、今までどおり送る（文字でも、化けた日付でも）
 *   - 日時として読めない値（「Mon Oct …」の文字など）なら送らない（安全側）
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

// 時計は不具合の時刻に固定（2026-10-31 01:53 JST = プノンペン 10/30 23:53）。実際の日付が進むと 7 日の枠だけで弾かれて、
// 「2026-10-27 11:00 より前は送らない」が壊れても気づけなくなるため
const NOW = Date.UTC(2026, 9, 30, 16, 53, 0);
class FixedDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}

// シートが「yyyy-MM-dd H:mm:ss」を日付に変えた時の Date（スプレッドシートのタイムゾーン Asia/Tokyo）
function sheetDate(text) {
  const m = String(text).match(/^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +m[6]));
}

function formatDate(d, tz, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach((p) => { parts[p.type] = p.value; });
  return String(fmt || 'yyyy-MM-dd HH:mm:ss').replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
}

/** 「状態」タブに rows（[キー, 値]）を置き、毎時の安全網を1回まわす。チラシ・本人登録リンクを送ろうとした shop_id を返す */
function runSafetyNet(stateRows, partners) {
  const rows = [['キー(key)', '値(value)', '更新日時(updated_at)']].concat(stateRows.map((r) => [r[0], r[1], '']));
  const ss = {
    getSpreadsheetTimeZone: () => 'Asia/Tokyo',
    getSheetByName: (n) => (n === '状態' ? sheet : null)
  };
  const sheet = {
    getParent: () => ss,
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    getRange: () => ({ setNumberFormat: () => ({}), setValues: () => ({}) })
  };
  const cache = new Map();
  const log = [];
  const ctx = {
    console,
    Date: FixedDate,
    Logger: { log: (m) => log.push(String(m)) },
    Utilities: { formatDate },
    getSpreadsheet: () => ss,
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, getProperties: () => ({}) }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) || null, getAll: () => ({}), put: () => {}, putAll: () => {} }) },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} }) }
  };
  vm.createContext(ctx);
  ['KvStore.gs', 'ShopGroupGreeting.gs', 'PartnerSelfRegister.gs'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7', f), 'utf8'), ctx, { filename: f }));
  const flyers = [], links = [];
  ctx.__partners = partners;
  ctx.__flyers = flyers;
  ctx.__links = links;
  vm.runInContext(`
    function readShopLinks_() {
      return __partners.map(function(p) { return { obj: { '状態': '連携済', 'shop_id': p.shopId, 'グループchat_id': '-100' } }; });
    }
    function individualPartnerState_() { return true; }
    function individualPartnerInfo_(shopId) {
      var p = __partners.filter(function(x) { return x.shopId === shopId; })[0];
      return { name: shopId, selfChat: p.selfChat || '', kind: 'individual' };
    }
    function sendIndividualFlyersOnce_(shopId) { __flyers.push(shopId); return 'sent'; }
    function sendSelfRegLinkOnce_(shopId) { __links.push(shopId); return 'sent'; }
  `, ctx);
  vm.runInContext('sendPendingIndividualOnboarding_()', ctx);
  const greet = (shopId) => vm.runInContext(`kvGet_('shop_greeting_sent_' + ${JSON.stringify(shopId)})`, ctx);
  return { flyers: flyers.slice(), links: links.slice(), greet, log };
}

const hoursAgo = (h) => formatDate(new Date(NOW - h * 60 * 60 * 1000), 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss');

test('Hiro さんの不具合の再現: あいさつ文の日時（10/26・11時の線より前）が日付に化けていても、チラシ・リンクを送り直さない', () => {
  const r = runSafetyNet([['shop_greeting_sent_SHOP-HIRO', sheetDate('2026-10-26 15:25:36')]],
    [{ shopId: 'SHOP-HIRO', selfChat: '1000000001' }]);
  assert.equal(r.greet('SHOP-HIRO'), '2026-10-26 15:25:36');   // 元の文字の形で読めている（KvStore の修正）
  assert.deepEqual(r.flyers, []);                              // → 「11時より前」で止まる（7 日の枠の内側でも）
  assert.deepEqual(r.links, []);
});

test('新しいグループ（あいさつ文が 7 日以内）には今までどおり送る。文字でも、日付に化けていても同じ', () => {
  const recent = hoursAgo(2);
  const r = runSafetyNet([
    ['shop_greeting_sent_SHOP-NEW1', recent],
    ['shop_greeting_sent_SHOP-NEW2', sheetDate(recent)]
  ], [{ shopId: 'SHOP-NEW1' }, { shopId: 'SHOP-NEW2' }]);
  assert.deepEqual(r.flyers, ['SHOP-NEW1', 'SHOP-NEW2']);
  assert.deepEqual(r.links, ['SHOP-NEW1', 'SHOP-NEW2']);
});

test('あいさつ文から 7 日を過ぎたグループ・日時として読めない値のグループには送らない（安全側）', () => {
  const r = runSafetyNet([
    ['shop_greeting_sent_SHOP-OLD', hoursAgo(8 * 24)],
    ['shop_greeting_sent_SHOP-BAD', 'Mon Oct 26 2026 15:25:36 GMT+0900 (Japan Standard Time)']
  ], [{ shopId: 'SHOP-OLD' }, { shopId: 'SHOP-BAD' }]);
  assert.deepEqual(r.flyers, []);
  assert.deepEqual(r.links, []);
  assert.ok(r.log.some((m) => m.indexOf('あいさつ文の日時が読めない') >= 0 && m.indexOf('SHOP-BAD') >= 0));   // 黙って止めない
});
