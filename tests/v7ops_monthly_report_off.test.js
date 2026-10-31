/**
 * v7-operations: 提携先のグループへの月次レポートを止める（2026-10-31 ShopProvisioningManager.gs PARTNER_MONTHLY_REPORT_TO_GROUPS）
 *
 * 実行: node --test "tests/*.test.js"
 *   Daisuke「月次レポートは一旦無しにしよう。すべての提携で。まだいろいろ変わるかもしれないから」
 *   - false（標準）: 車屋・個人提携・飲食店のどのグループにも送らない。紹介料の記帳・パートナー精算・管理グループへのまとめは続ける
 *   - true に戻せば従来どおりグループへ送る
 * シート・Telegram はスタブ（本番には触れない）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function run(toGroups) {
  const log = { groupSends: [], adminSends: [], synced: 0, settled: [] };
  const ctx = { console, Logger: { log: () => {} } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7-operations', 'ShopProvisioningManager.gs'), 'utf8'), ctx, { filename: 'ShopProvisioningManager.gs' });
  ctx.__log = log;
  vm.runInContext(`
    PARTNER_MONTHLY_REPORT_TO_GROUPS = ${toGroups ? 'true' : 'false'};
    Utilities = { formatDate: function() { return '2026-10'; } };
    BOT_TYPE = { INTERNAL: 'internal' };
    PARTNER_LANG_SHOP_DEFAULT = ['km', 'en'];
    INDIVIDUAL_PARTNER_KIND_COL = '提携の種類';
    COMMISSION_DEFAULT_RATE = 30;
    individualPartnersById_ = function() { return { 'SHOP-HIRO': { kind: 'individual' }, 'SHOP-PJ': { kind: 'restaurant' } }; };
    syncIndividualPartnerCommissions_ = function() { __log.synced++; };
    buildPartnerSettlement = function(ym) { __log.settled.push(ym); };
    ensureShopLinkSheet_ = function() { return { getDataRange: function() { return { getValues: function() { return [
      ['shop_id', '店名', 'グループchat_id', '状態'],
      ['SHOP-LUXE', 'LUXE Auto', '-100', '連携済'],
      ['SHOP-HIRO', 'Hiro Sato', '-200', '連携済'],
      ['SHOP-PJ', 'PJ Restaurant', '-300', '連携済'],
      ['SHOP-PICASSO', 'Picasso', '-400', '連携済']
    ]; } }; } }; };
    sourcePartnerShopIds_ = function() { return { 'SHOP-PICASSO': true }; };
    aggregateCommissionsByShop_ = function() { return { 'SHOP-LUXE': { count: 6, sales: 141, commission: 42.3, ourShare: 98.7, outstanding: 0, owedToShop: 0, rates: { 30: true } } }; };
    getShopSheet_ = function() { return null; };
    readSheetObjects_ = function() { return []; };
    shopCommissionTerms_ = function() { return { rate: 30 }; };
    shopGroupLangsOps_ = function() { return ['km', 'en']; };
    individualGroupLangsOps_ = function() { return ['en', 'km']; };
    individualOwedUpTo_ = function() { return { 'SHOP-HIRO': 3.15 }; };
    getShopProvProps_ = function() { return { bookingBotToken: 'x' }; };
    buildIndividualMonthlyReport_ = function() { return 'indiv report'; };
    buildShopMonthlyReportText_ = function() { return 'shop report'; };
    sendViaBookingBot_ = function(token, chatId, text) { __log.groupSends.push(chatId); return true; };
    getConfig = function() { return { adminGroupId: 'admin', adminPartnerThreadId: '' }; };
    sendMessage = function(bot, chatId, text) { __log.adminSends.push(text); };
    sendShopMonthlyReports();
  `, ctx);
  return log;
}

test('標準（停止中）: どの提携先のグループにも送らない・記帳と精算と管理グループへのまとめは続ける', () => {
  assert.equal(vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'v7-operations', 'ShopProvisioningManager.gs'), 'utf8') + ';PARTNER_MONTHLY_REPORT_TO_GROUPS',
    { Logger: { log: () => {} } }), false);
  const log = run(false);
  assert.deepEqual(log.groupSends, []);
  assert.equal(log.synced, 1);
  assert.deepEqual(log.settled, ['2026-10']);
  assert.equal(log.adminSends.length, 1);
  const admin = log.adminSends[0];
  assert.match(admin, /グループへのレポートは停止中/);
  assert.match(admin, /⏸ LUXE Auto: 6台/);
  assert.match(admin, /⏸ 🙋 Hiro Sato（個人提携）/);
  assert.match(admin, /⏸ 🍽 PJ Restaurant（飲食店）/);
  assert.doesNotMatch(admin, /✅|❌/);
});

test('true に戻せば従来どおり送る（レジデンス等は送らない）', () => {
  const log = run(true);
  assert.deepEqual(log.groupSends.sort(), ['-100', '-200', '-300']);
  assert.match(log.adminSends[0], /送信結果/);
  assert.match(log.adminSends[0], /✅ LUXE Auto/);
});
