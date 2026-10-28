/**
 * v7 / v7-operations: 個人提携のグループへの予約の通知と月報（2026-10-28 IndividualPartnerNotice.gs ほか）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * .gs を Node の vm に読み込み、シート・Telegram はスタブで置き換える（本番には触れない）。
 *   - グループの言語の標準 = 英語＋クメール語（店マスター「グループへの通知の言語」が空欄の時）
 *   - 紹介者ご本人の予約: 金額・地図・駐車のお願い入り／お友達の予約: 日時・車種・メニューだけ
 *   - クメール語の文が無い文（はじめのご案内など）は英語だけ・クメール語だけの設定でも空にしない
 *   - 月報: 見出しは「 / 」で1行・文は言語ごとに1行
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function load(dir, files) {
  const ctx = { console, Logger: { log: () => {} } };
  vm.createContext(ctx);
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'), ctx, { filename: f }));
  return (code) => vm.runInContext(code, ctx);
}

function loadV7(langByShop) {
  const run = load('v7', ['PartnerLang.gs', 'IndividualPartner.gs', 'IndividualPartnerNotice.gs', 'SourceGroupNotify.gs', 'BookingLogic.gs']);
  run('__partnerLangMemo_ = ' + JSON.stringify(langByShop || {}) + ';');
  return run;
}

const SHOP = 'SHOP-HIRO';
const BASE = {
  bookingId: 'BK-20261028-001',
  plan: { name: 'SAMURAI WASH', planFull: 'SAMURAI WASH (W)' },
  options: [{ opt: { kind: 'HEADLIGHT', nameEn: 'Standard', code: 'HEADLIGHT' }, amount: 15 }],
  vehicleType: 'SUV以上', carModel: '',
  date: '2026-10-30', startTime: '15:00', endTime: '16:25'
};
const SELF = Object.assign({}, BASE, {
  self: true, name: 'Hiro Sato', selfPct: 30,
  serviceSubtotal: 30, discountAmount: 9, dispatchFee: 0, amount: 21,
  mapsUrl: 'https://www.google.com/maps?q=11.583616,104.897299', inStore: false
});

function notice(run, fn, info, shop) {
  return run(fn + '(individualGroupLangs_(' + JSON.stringify(shop || SHOP) + '), ' + JSON.stringify(info) + ')');
}

test('グループの言語: 空欄は英語＋クメール語・設定すれば日本語やクメール語も', () => {
  const run = loadV7({ 'SHOP-JA': '日本語', 'SHOP-KM': 'クメール語', 'SHOP-JAEN': '日本語＋英語' });
  assert.deepEqual(Array.from(run('individualGroupLangs_("SHOP-HIRO")')), ['en', 'km']);
  assert.deepEqual(Array.from(run('individualGroupLangs_("SHOP-JA")')), ['ja']);
  assert.deepEqual(Array.from(run('individualGroupLangs_("SHOP-KM")')), ['km']);
  assert.deepEqual(Array.from(run('individualGroupLangs_("SHOP-JAEN")')), ['ja', 'en']);
});

test('紹介者ご本人の予約（英語＋クメール語）: 金額・地図・駐車のお願い入り', () => {
  const run = loadV7();
  assert.equal(notice(run, 'individualSelfBookingNotice_', SELF), [
    '✅ Booking confirmed / ការកក់ទទួលបានជោគជ័យ',
    'Thank you, Hiro Sato! / សូមអរគុណ Hiro Sato!',
    '━━━━━━━━━━━━━━━━',
    '📋 BK-20261028-001',
    '📅 Fri 30 Oct 2026 · 15:00–16:25',
    '🚗 SUV',
    '🧽 SAMURAI WASH + SAMURAI HEADLIGHT (Standard)',
    '💵 30.00$ → 21.00$ (Partner discount -30% / បញ្ចុះតម្លៃ 30% សម្រាប់ដៃគូ)',
    '📍 https://www.google.com/maps?q=11.583616,104.897299',
    '━━━━━━━━━━━━━━━━',
    '📝 Condo / building parking:',
    'Once your parking spot is decided, please send us your plate number and the floor you parked on, here in this group.',
    'បើអ្នកចតនៅអគារ សូមផ្ញើស្លាកលេខ និងជាន់ដែលអ្នកចត មកក្នុងក្រុមនេះ ពេលដឹងកន្លែងចតហើយ។'
  ].join('\n'));
});

test('紹介者ご本人の予約: 出張料がある時は出張料と合計・店舗作業は地図と駐車のお願いなし', () => {
  const run = loadV7();
  const withFee = notice(run, 'individualSelfBookingNotice_', Object.assign({}, SELF, { dispatchFee: 2, amount: 23 }));
  assert.match(withFee, /\n💵 30\.00\$ → 21\.00\$ \(Partner discount/);
  assert.match(withFee, /\n🚚 Delivery fee \/ ថ្លៃដឹកជញ្ជូន: 2\.00\$\n💵 Total \/ សរុប: 23\.00\$\n/);
  const noFee = notice(run, 'individualSelfBookingNotice_', SELF);
  assert.doesNotMatch(noFee, /Delivery fee|Total/);   // 出張料 0 の時は行ごと出さない（「出張料なし」と書かない）
  const inStore = notice(run, 'individualSelfBookingNotice_', Object.assign({}, SELF, { inStore: true }));
  assert.match(inStore, /🏪 In-store service \/ សេវានៅហាង$/);
  assert.doesNotMatch(inStore, /📍|parking|អគារ/);
  // 本人割引でない割引（流入元の特典など）は割引の名前を出さない
  const otherDisc = notice(run, 'individualSelfBookingNotice_', Object.assign({}, SELF, { selfPct: 0 }));
  assert.match(otherDisc, /\n💵 30\.00\$ → 21\.00\$\n/);
});

test('紹介されたお友達の予約（英語＋クメール語）: 名前・場所・金額は載せない', () => {
  const run = loadV7();
  const text = notice(run, 'individualReferralBookingNotice_', BASE);
  assert.equal(text, [
    '📅 New booking from your referral / មានការកក់ថ្មី ពីភ្ញៀវដែលអ្នកបានណែនាំមក',
    '🗓 Fri 30 Oct 2026 · 15:00–16:25',
    '🚗 SUV',
    '🧽 SAMURAI WASH + SAMURAI HEADLIGHT (Standard)'
  ].join('\n'));
});

test('日本語の設定: 日付は 10/30(金)・見出しは日本語', () => {
  const run = loadV7({ 'SHOP-JA': '日本語' });
  assert.equal(notice(run, 'individualReferralBookingNotice_', BASE, 'SHOP-JA').split('\n').slice(0, 2).join('\n'),
    '📅 ご予約が入りました（ご紹介）\n🗓 10/30(金) · 15:00–16:25');
  assert.match(notice(run, 'individualSelfBookingNotice_', SELF, 'SHOP-JA'), /^✅ ご予約を承りました\nHiro Sato さん、ありがとうございます！\n/);
});

test('クメール語の文がまだ無い文: 英語＋クメール語なら英語だけ・クメール語だけの設定でも空にしない', () => {
  const run = loadV7({ 'SHOP-KM': 'クメール語' });
  const connected = run('individualConnectedText_("Hiro Sato", individualGroupLangs_("SHOP-HIRO"))');
  assert.match(connected, /^✅ Connected!/);
  assert.doesNotMatch(connected, /連携完了/);
  assert.match(run('individualConnectedText_("Hiro Sato", individualGroupLangs_("SHOP-KM"))'), /^✅ Connected!/);
});

test('月報（英語＋クメール語）: 見出しは1行・文は言語ごと', () => {
  const run = load('v7-operations', ['PartnerLangOps.gs', 'IndividualPartnerOps.gs']);
  const report = (a, owedAll) => run('buildIndividualMonthlyReport_("Hiro Sato", "2026-10", ' + JSON.stringify(a) + ', "30%", ' + owedAll +
    ', individualGroupLangsOps_({}))');
  assert.equal(report({ count: 3, sales: 63, commission: 18.9, owedToShop: 18.9 }, 23.9), [
    '📊 SAMURAI MOTORS — Monthly Report / របាយការណ៍ប្រចាំខែ (2026-10)',
    '',
    'Hiro Sato',
    'Referred jobs / ចំនួនការងារដែលអ្នកបានណែនាំមក: 3',
    'Total sales / តម្លៃសេវាសរុប: 63.00$',
    'Your commission (30%) / កម្រៃជើងសារ របស់អ្នក (30%): 18.90$',
    '',
    '💵 We will pay your commission of 23.90$ by ABA by the 10th.',
    '💵 យើងនឹងបង់កម្រៃជើងសារចំនួន 23.90$ ជូនអ្នក ត្រឹមថ្ងៃទី10 (តាម ABA)។',
    '(Includes 5.00$ from earlier months.)',
    '(រួមទាំង 5.00$ ពីខែមុនៗ)',
    '',
    'Thank you! / សូមអរគុណ!'
  ].join('\n'));
  assert.match(report({ count: 2, sales: 40, commission: 12, owedToShop: 0 }, 0),
    /\n✅ Your commission has been paid\.\n✅ យើងបានបង់កម្រៃជើងសារជូនអ្នកហើយ។\n/);
  assert.match(report({ count: 0, sales: 0, commission: 0, owedToShop: 0 }, 0),
    /\nNo referred jobs last month — thank you for your support!\nខែមុនមិនមានការងារដែលអ្នកបានណែនាំមកទេ។ សូមអរគុណដែលគាំទ្រយើងជានិច្ច!\n/);
  assert.deepEqual(Array.from(run('individualGroupLangsOps_({ "グループへの通知の言語": "日本語" })')), ['ja']);
});
