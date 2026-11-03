/**
 * v7: 提携店グループの作業通知に注文番号（🆔 BK-…）を出す・管理通知の文面（2026-11-03 Daisuke）
 *
 * 実行: node --test "tests/*.test.js"
 *
 *   - 完了通知に「🆔 番号」が見出しの直後に出る。番号が無い時は行を出さない
 *   - 予約なしの作業は売上の番号ができてから店へ完了通知を送る（作業終了で 売上の記録 → 完了通知 → 請求 の順）
 *   - 現場で店を選んだ作業では「🏪 提携店の作業」の管理通知を出さず、「QR は送っていません」とも書かない
 *   - 請求の結果の管理通知にも番号が出る
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, 'v7', f), 'utf8');

const sent = [];
const ctx = {
  console, Logger: { log: () => {} }, BOT_TYPE: { BOOKING: 'b' },
  getConfig: () => ({ adminGroupId: 'admin' }),
  sendMessage: (bot, chat, text) => { sent.push(text); return { ok: true }; },
};
vm.createContext(ctx);
['PartnerLang.gs', 'ShopInvoice.gs'].forEach((f) => vm.runInContext(read(f), ctx, { filename: f }));
const job = (p) => vm.runInContext('shopGroupJobText_(["km","en"], ' + JSON.stringify(p) + ')', ctx);

test('完了通知: 🆔 は見出しの直後・車より前（2026-11-03 の LUXE Auto と同じ内容）', () => {
  const lines = job({ phase: 'end', who: 'shop', id: 'BK-20261103-002', car: 'kia Ray', duration: 201 }).split('\n');
  assert.equal(lines[1], 'Job finished (your shop)');
  assert.equal(lines[2], '🆔 BK-20261103-002');
  assert.equal(lines[3], '🚗 kia Ray');
});

test('番号が無い時は 🆔 の行を出さない', () => {
  assert.doesNotMatch(job({ phase: 'start', who: 'shop', id: '', car: 'kia Ray' }), /🆔/);
  assert.doesNotMatch(job({ phase: 'start', who: 'shop', car: 'kia Ray' }), /🆔/);
});

test('作業終了の順番: 売上の記録 → 店への完了通知 → 請求', () => {
  const src = read('JobManager.gs');
  const iSale = src.indexOf('manualSaleId = recordManualJobSaleIfNeeded_(');
  const iFinish = src.indexOf("id: jobRefId, car: body.carModel");
  const iInvoice = src.indexOf('sendShopInvoiceForJob_(body, opts, {');
  assert.ok(iSale > 0 && iFinish > iSale && iInvoice > iFinish, [iSale, iFinish, iInvoice].join(','));
});

test('管理通知に矛盾する文を残さない・現場で店を選んだ作業では 🏪 を出さない', () => {
  const src = read('JobManager.gs');
  assert.doesNotMatch(src, /お客様へ当社の決済QRは送っていません/);
  assert.doesNotMatch(src, /🏪 提携店の作業/);
  assert.match(src, /shopRef && !shopFromField && \(bookingId/);
  // 店を選んだ作業が「どのお店か選ばれていません」の警告へ落ちない
  assert.match(src, /else if \(ptEndShop && !shopFromField\)/);
});

test('請求の結果の管理通知に番号が出る（番号が無くても送れる）', () => {
  sent.length = 0;
  ctx.getShopNameById_ = () => 'LUXE Auto';
  vm.runInContext('notifyShopInvoiceAdmin_("sent", "S1", 25, {}, "BK-20261103-002"); notifyShopInvoiceAdmin_("sent", "S1", 25, {}, "")', ctx);
  assert.equal(sent[0], '🧾 お店のグループへ請求を送りました: LUXE Auto $25（BK-20261103-002・ABA QR 付き）');
  assert.equal(sent[1], '🧾 お店のグループへ請求を送りました: LUXE Auto $25（ABA QR 付き）');
});
