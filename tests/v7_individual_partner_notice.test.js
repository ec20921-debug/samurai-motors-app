/**
 * v7 / v7-operations: 個人提携のグループへの予約の通知と月報（2026-10-28 IndividualPartnerNotice.gs ほか）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * .gs を Node の vm に読み込み、シート・Telegram はスタブで置き換える（本番には触れない）。
 *   - グループの言語の標準 = 英語＋クメール語（店マスター「グループへの通知の言語」が空欄の時）
 *   - 紹介者ご本人の予約: 金額・地図・駐車のお願い入り／お友達の予約: 日時・車種・メニューだけ
 *   - 立ち上げの文（連携完了・はじめのご案内・チラシの説明・本人登録リンク・登録のお礼）のクメール語・営業ボードの表示と同じ文
 *   - クメール語の文がまだ無い文（本人登録リンクを開いた人への返事）は英語だけ・クメール語だけの設定でも空にしない
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
  const run = load('v7', ['KvStore.gs', 'PartnerLang.gs', 'IndividualPartner.gs', 'IndividualPartnerNotice.gs', 'SourceGroupNotify.gs', 'BookingLogic.gs', 'PartnerSelfRegister.gs']);
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

test('クメール語の文がまだ無い文（本人登録リンクを開いた人への返事）: 英語＋クメール語なら英語だけ・クメール語だけの設定でも空にしない', () => {
  const run = loadV7({ 'SHOP-KM': 'クメール語' });
  assert.equal(run('individualText_(individualGroupLangs_("SHOP-HIRO"), SELF_REG_TEXT.busy)'), '⏳ Busy, please open the link again in a minute.');
  assert.equal(run('individualText_(individualGroupLangs_("SHOP-KM"), SELF_REG_TEXT.busy)'), '⏳ Busy, please open the link again in a minute.');
});

test('連携完了（英語＋クメール語）', () => {
  const run = loadV7();
  assert.equal(run('individualConnectedText_("Hiro Sato", individualGroupLangs_("SHOP-HIRO"))'), [
    '✅ Connected!', 'Partner: Hiro Sato', 'When someone you referred books with us, you\'ll get a message here.', '',
    '✅ បានភ្ជាប់ក្រុមហើយ!', 'ដៃគូ: Hiro Sato', 'ដំណឹងអំពីការកក់ ពីភ្ញៀវដែលអ្នកបានណែនាំមក នឹងផ្ញើមកក្នុងក្រុមនេះ។'
  ].join('\n'));
});

test('はじめのご案内（英語＋クメール語・本人未登録・紹介割引なし）: 営業ボードの表示（v7-operations）と同じ文', () => {
  const run = loadV7();
  const text = run('buildIndividualGroupGreeting_("Hiro Sato", 30, 0, individualGroupLangs_("SHOP-HIRO"), false)');
  const km = text.split('\n\n').slice(4).join('\n\n');   // 英語は4かたまり（あいさつ・はじめに・紹介のしかた・締め）
  assert.equal(km, [
    'សូមស្វាគមន៍ Hiro Sato មកកាន់ SAMURAI MOTORS! យើងនឹងផ្ញើដំណឹងមកក្នុងក្រុមនេះ។',
    '',
    '[ធ្វើតែម្តងគត់]',
    '1. ចុះឈ្មោះខ្លួនអ្នក៖ សូមបើក «🔑 តំណភ្ជាប់ចុះឈ្មោះ» ដែលនឹងមកដល់បន្ទាប់ (បើមានប៊ូតុង «START» បង្ហាញ សូមចុច)។ ការកក់របស់អ្នកផ្ទាល់ នឹងបានបញ្ចុះតម្លៃ 30% ពេលកក់។',
    '',
    '[របៀបណែនាំមិត្តភក្តិ]',
    '2. សូមចែករំលែកខិត្តប័ណ្ណ ឬ URL សម្រាប់ណែនាំ ដែលនឹងមកដល់បន្ទាប់ ទៅកាន់មិត្តភក្តិរបស់អ្នក (មិនមែនតំណភ្ជាប់ចុះឈ្មោះទេ)។',
    '- ពេលមិត្តភក្តិកក់ យើងនឹងប្រាប់អ្នកនៅទីនេះ អំពីថ្ងៃ ម៉ោង សេវា និងប្រភេទរថយន្ត (មិនផ្ញើឈ្មោះ ឬរូបថតទេ)',
    '',
    'បើមានអ្វីចង់សួរ សូមកុំស្ទាក់ស្ទើរសួរក្នុងក្រុមនេះ។ សូមអរគុណ!'
  ].join('\n'));
  assert.match(text, /^Welcome to SAMURAI MOTORS, Hiro Sato!/);
  // 月次レポート・10日払いの案内は出さない（2026-10-31 Daisuke「月次レポートは一旦無し」）
  assert.doesNotMatch(text, /each month|by the 10th|ដើមខែ|ថ្ងៃទី10|កម្រៃជើងសារ/);
  // 本人登録済み・紹介割引あり（20＋10）: 登録の案内なし・割引の行あり。% を二重に付けない
  const done = run('buildIndividualGroupGreeting_("Hiro Sato", 20, 10, individualGroupLangs_("SHOP-HIRO"), true)');
  assert.match(done, /\n\[ការកក់របស់អ្នកផ្ទាល់\] អ្នកបានចុះឈ្មោះរួចហើយ។ ការកក់របស់អ្នកផ្ទាល់ នឹងបានបញ្ចុះតម្លៃ 30% ពេលកក់។\n/);
  assert.match(done, /\n- ភ្ញៀវដែលអ្នកបានណែនាំមក នឹងបានបញ្ចុះតម្លៃ 10% លើសេវាទាំងអស់\n/);
  assert.match(done, /\nសូមចែករំលែកខិត្តប័ណ្ណ ឬ URL សម្រាប់ណែនាំ ដែលនឹងមកដល់បន្ទាប់ ទៅកាន់មិត្តភក្តិរបស់អ្នក។\n/);
  assert.doesNotMatch(done, /%%|ធ្វើតែម្តងគត់/);
  // 営業ボードの表示（v7-operations）は予約Botが送る文と同じ
  const ops = load('v7-operations', ['PartnerLangOps.gs', 'IndividualPartnerOps.gs']);
  [[30, 0, false], [20, 10, true], [30, 0, true]].forEach(([r, d, sd]) => {
    assert.equal(ops('individualGroupGreetingText_("Hiro Sato", ' + r + ', ' + d + ', individualGroupLangsOps_({}), ' + sd + ')'),
      run('buildIndividualGroupGreeting_("Hiro Sato", ' + r + ', ' + d + ', individualGroupLangs_("SHOP-HIRO"), ' + sd + ')'));
  });
});

test('チラシの説明・本人登録リンク・登録のお礼（英語＋クメール語）', () => {
  const run = loadV7();
  const L = 'individualGroupLangs_("SHOP-HIRO")';
  const flyers = run('partnerFlyersText_("Hiro Sato", "PTN-011", ' + L + ')');
  assert.match(flyers, /\n\n📎 ខិត្តប័ណ្ណសម្រាប់ណែនាំ \(មាន លេខ PTN-011 និង QR របស់អ្នកផ្ទាល់\)\n/);
  assert.match(run('partnerFlyersText_("Hiro Sato", "", ' + L + ')'), /\n\n📎 ខិត្តប័ណ្ណសម្រាប់ណែនាំ \(មាន QR របស់អ្នកផ្ទាល់\)\n/);
  assert.match(flyers, /ការកក់ដែលធ្វើតាម QR ឬ URL យើងនឹងកត់ត្រាជាការណែនាំរបស់អ្នកដោយស្វ័យប្រវត្តិ។$/);
  const link = 'https://t.me/SAMURAI_MOTORS_BOOKING_BOT?start=self_x';
  assert.equal(run('selfRegGroupText_("Hiro Sato", 30, ' + JSON.stringify(link) + ', ' + L + ')').split('\n\n')[1], [
    '🔑 តំណភ្ជាប់ចុះឈ្មោះសម្រាប់ Hiro Sato',
    link,
    'អ្នកដំបូងគេដែលបើកតំណភ្ជាប់នេះ នឹងត្រូវបានចុះឈ្មោះជា Hiro Sato។ សូមកុំចុច បើអ្នកមិនមែនជា Hiro Sato។',
    'សូមបើកតំណភ្ជាប់ ហើយចុចប៊ូតុង «START» បើមានបង្ហាញ (បើមិនបង្ហាញ ក៏មិនអីទេ)។ អាចត្រូវរង់ចាំប្រហែល 1 នាទី ទើបមានសារឆ្លើយតប។',
    'បន្ទាប់ពីនោះ ការកក់របស់អ្នកផ្ទាល់ តាមប៊ូតុង «Booking» នឹងបានបញ្ចុះតម្លៃ 30%។',
    'សម្រាប់មិត្តភក្តិ សូមចែករំលែកខិត្តប័ណ្ណ ឬ URL សម្រាប់ណែនាំ មិនមែនតំណភ្ជាប់នេះទេ។'
  ].join('\n'));
  assert.equal(run('selfRegGroupDoneText_("Hiro Sato", 30, "Hirotaka Sato", ' + L + ')').split('\n\n')[1], [
    '✅ សូមអរគុណដែលបានចុះឈ្មោះ!',
    'ការចុះឈ្មោះសម្រាប់ Hiro Sato រួចរាល់ហើយ (Telegram: Hirotaka Sato)។',
    'ការកក់របស់អ្នកផ្ទាល់ តាមប៊ូតុង «Booking» នឹងបានបញ្ចុះតម្លៃ 30%។',
    'យើងរីករាយនឹងបានសហការជាមួយអ្នក!',
    '(បើមិនមែនជាអ្នកទេ សូមទាក់ទងមក SAMURAI MOTORS។)'
  ].join('\n'));
  assert.doesNotMatch(run('selfRegGroupDoneText_("Hiro Sato", 0, "Hirotaka Sato", ' + L + ')'), /«Booking»/);
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
