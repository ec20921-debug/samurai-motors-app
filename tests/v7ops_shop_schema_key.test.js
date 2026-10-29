/**
 * v7-operations: 店マスターの列そろえ（SalesLogManager.gs getShopSheet_）の「合図の文字列」の確認
 *
 * 実行: node --test "tests/*.test.js"
 *   列そろえは 6時間に1回（runAtMostEvery_）。合図の文字列が変わると次の呼び出しですぐそろえる。
 *   2026-10-29: 「営業ボードの分類」「提携種別」が合図に入っておらず、新しい列とプルダウンが最大6時間遅れた
 *   → そろえる列の名前はすべて合図に入っていること（列を足したら合図にも足す）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function load() {
  const ctx = { console, Logger: { log: () => {} } };
  vm.createContext(ctx);
  ['SalesLogManager.gs', 'CommissionManager.gs', 'PartnerLangOps.gs', 'IndividualPartnerOps.gs', 'ScoutBoardShopLinks.gs'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7-operations', f), 'utf8'), ctx, { filename: f }));
  // 店マスターはある・列そろえで頼まれた列の名前を記録する（シートには触らない）
  vm.runInContext(
    'var __asked = [], __key = null, __fn = null;' +
    'getSalesLogSs_ = function() { return { getSheetByName: function() { return {}; } }; };' +
    'runAtMostEvery_ = function(key, ttl, fn) { __key = key; __fn = fn; };' +
    'ensureColumnsAtEnd_ = function(sheet, headers) { headers.forEach(function(h) { __asked.push(h); }); return true; };' +
    'ensureColumnAfter_ = function(sheet, after, h) { __asked.push(h); return true; };' +
    'getSheetHeaders_ = function() { return []; };', ctx);
  return (code) => vm.runInContext(code, ctx);
}

test('合図の文字列: 列そろえで足す列の名前がすべて入る（営業ボードの分類・提携種別を含む）', () => {
  const run = load();
  run('getShopSheet_()');
  const key = run('__key');
  assert.ok(key, '列そろえが runAtMostEvery_ を通る');
  run('__fn()');
  const asked = JSON.parse(run('JSON.stringify(__asked)'));
  assert.ok(asked.includes('営業ボードの分類'));
  assert.ok(asked.includes('提携種別'));
  const parts = key.split('|');
  asked.forEach((h) => assert.ok(parts.includes(h), '合図に「' + h + '」が無い（列を足したら合図にも足す）'));
});
