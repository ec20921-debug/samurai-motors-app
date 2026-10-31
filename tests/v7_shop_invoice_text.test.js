/**
 * v7: 提携店グループへの請求の本文（ShopInvoice.gs buildShopInvoiceText_・2026-10-31 クメール語＋英語だけに）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 *   - 店マスターの言語が空欄（標準＝クメール語＋英語＋日本語）でも、請求には日本語を出さない
 *   - 言語の順は店マスターの設定どおり。日本語だけの設定でも空にせず クメール語 → 英語
 *   - 見出し・手順は言語ごとに1行、金額は「👉 30$」の1行、区切り線は11本（スマホで折り返さない）
 *   - 手順のあとに「自動送信です」→「わからない時の聞き方（当社スタッフ／このグループにメッセージ・声でも可）」→ お礼で閉じる
 *   - 紹介のお客さん（shopref）は定価・店の紹介料の内訳つき・説明文の上限 1024 字に収まる
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadV7() {
  const ctx = { console, Logger: { log: () => {} } };
  vm.createContext(ctx);
  ['PartnerLang.gs', 'ShopInvoice.gs'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7', f), 'utf8'), ctx, { filename: f }));
  return (code) => vm.runInContext(code, ctx);
}

const run = loadV7();
const build = (p) => run('buildShopInvoiceText_(' + JSON.stringify(p) + ')');
const JA = /[぀-ヿ]/;   // ひらがな・カタカナ
const KM = /[ក-៿]/;

// 2026-10-29 LUXE Auto（BK-20261029-004）と同じ内容
const SHOP = { pt: 'shop', refId: 'BK-20261029-004', carModel: 'KIA morning', services: 'BODY', listPrice: 30, due: 30, langs: ['km', 'en', 'ja'] };

test('標準（3言語の設定）でも請求に日本語は出ない・クメール語と英語は出る', () => {
  const text = build(SHOP);
  assert.doesNotMatch(text, JA);
  assert.match(text, KM);
  assert.match(text, /Payment request/);
  assert.match(text, /Please scan the QR above to pay Samurai Motors\./);
  assert.match(text, /After paying, please send a screenshot of the payment to this group\./);
});

test('見た目: 見出しは言語ごとに1行・金額は1行・手順に 1️⃣ 2️⃣・最後にお礼', () => {
  const lines = build(SHOP).split('\n');
  assert.equal(lines[0], '🧾 ការស្នើសុំទូទាត់ប្រាក់');
  assert.equal(lines[1], 'Payment request');
  assert.ok(lines.includes('💰 ទឹកប្រាក់ត្រូវបង់ / Amount to pay'));
  assert.ok(lines.includes('👉 30$'));
  assert.ok(lines.some((l) => l.startsWith('1️⃣ 📱 សូមស្កេន QR ខាងលើ')));
  assert.ok(lines.some((l) => l.startsWith('2️⃣ 📸 បន្ទាប់ពីបង់រួច')));
  // 順番: 2️⃣ のあと 🤖 自動送信 → 💬 わからない時 → 🙏 お礼で閉じる（Panha 推奨・2026-10-31）
  const iAuto = lines.indexOf('🤖 សារនេះផ្ញើដោយស្វ័យប្រវត្តិ។ / This is an automatic message.');
  const iAsk = lines.indexOf('💬 បើមានសំណួរ សូមសួរបុគ្គលិករបស់យើង ឬផ្ញើសារមកក្នុងក្រុមនេះ (សារសំឡេងក៏បាន)។');
  assert.ok(iAuto > 0 && iAsk > iAuto, 'auto=' + iAuto + ' ask=' + iAsk);
  assert.equal(lines[iAsk + 1], 'If you have any questions, please ask our staff or send a message to this group (voice messages are fine).');
  assert.equal(lines[lines.length - 1], '🙏 សូមអរគុណ! / Thank you!');
  lines.filter((l) => l.startsWith('━')).forEach((l) => assert.equal([...l].length, 11));
});

test('言語の順は店マスターどおり（英語＋クメール語なら英語が先）', () => {
  const lines = build(Object.assign({}, SHOP, { langs: ['en', 'km'] })).split('\n');
  assert.equal(lines[0], '🧾 Payment request');
  assert.equal(lines[1], 'ការស្នើសុំទូទាត់ប្រាក់');
  assert.ok(lines.includes('💰 Amount to pay / ទឹកប្រាក់ត្រូវបង់'));
});

test('日本語だけの設定・言語なしでも空にせず クメール語 → 英語', () => {
  [['ja'], undefined, []].forEach((langs) => {
    const lines = build(Object.assign({}, SHOP, { langs })).split('\n');
    assert.equal(lines[0], '🧾 ការស្នើសុំទូទាត់ប្រាក់');
    assert.equal(lines[1], 'Payment request');
  });
});

test('英語だけの設定なら英語だけ（2行目の訳は出ない）', () => {
  const text = build(Object.assign({}, SHOP, { langs: ['en'] }));
  assert.doesNotMatch(text, KM);
  assert.match(text, /^🧾 Payment request\n━/);
});

test('紹介のお客さん: 内訳つき・1024 字以内・compact では内訳と名前を外す', () => {
  const ref = Object.assign({}, SHOP, { pt: 'shopref', customerName: 'Sok Dara', plate: '2P-3297', services: 'SAMURAI WASH + HEADLIGHT MAGIC', listPrice: 30, rate: 30, due: 21 });
  const text = build(ref);
  assert.match(text, /👤 Sok Dara/);
  assert.match(text, /💵 តម្លៃសេវា \/ Service price: 30\$/);
  assert.match(text, /🤝 កម្រៃជើងសារ របស់ហាង \(30%\) \/ Your commission \(30%\): 9\$/);
  assert.match(text, /👉 21\$/);
  assert.ok(text.length <= 1024, 'length=' + text.length);
  const compact = build(Object.assign({}, ref, { compact: true }));
  assert.doesNotMatch(compact, /Sok Dara|Service price|commission/);
});
