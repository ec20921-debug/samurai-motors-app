/**
 * v7 / v7-operations: 飲食店の提携の型（2026-10-29 RestaurantPartner.gs・第1号 PJ Restaurant）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * .gs を Node の vm に読み込み、シート・Telegram はスタブで置き換える（本番には触れない）。
 *   - 店マスター「提携種別」=「飲食店」は個人提携と同じ扱い（紹介元・お客様は当社払い）で、kind = 'restaurant'
 *   - あいさつ文・連携完了・予約の知らせの見出しは飲食店向け（英語＋クメール語が標準）。営業ボードの表示（v7-operations）と同じ文
 *   - 本人登録リンク・紹介チラシは Bot から送らない。本人割引の対象にもしない
 *   - 紹介料の記帳・月報は個人提携と同じ一覧に入る（v7-operations individualPartnersById_）
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function load(dir, files, extra) {
  const ctx = Object.assign({ console, Logger: { log: () => {} } }, extra || {});
  vm.createContext(ctx);
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'), ctx, { filename: f }));
  return (code) => vm.runInContext(code, ctx);
}

// 店マスターのスタブ（readPartnerKinds_ が読む列だけ）
const MASTER = [
  ['shop_id', '店名', '提携種別', '紹介料率(%)', '紹介割引率(%)', '本人chat_id'],
  ['SHOP-PJ', 'PJ Restaurant', '飲食店', 30, '', '777'],
  ['SHOP-HIRO', 'Hiro Sato', '個人提携', 30, '', '888'],
  ['SHOP-CAR', 'PLP Auto World', '', '', '', '']
];

function fakeSheet(rows) {
  return {
    getLastRow: () => rows.length,
    getLastColumn: () => rows[0].length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => rows.slice(r - 1, r - 1 + (nr || 1)).map((row) => row.slice(c - 1, c - 1 + (nc || 1)))
    })
  };
}

function loadV7(master, opts) {
  opts = opts || {};
  const cache = {};
  const sent = [];
  const props = {};
  const run = load('v7', ['PartnerLang.gs', 'IndividualPartner.gs', 'IndividualPartnerNotice.gs', 'SourceGroupNotify.gs',
    'BookingLogic.gs', 'RestaurantPartner.gs', 'ShopGroupGreeting.gs', 'PartnerSelfRegister.gs'], {
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    getSpreadsheet: () => {
      if (opts.sheetBroken && opts.sheetBroken()) throw new Error('読めない');
      return { getSheetByName: (n) => (n === '店マスター' ? fakeSheet(master || MASTER) : null) };
    },
    getConfig: () => ({ adminGroupId: 'ADMIN' }),
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { formatDate: () => '2026-10-29 12:00:00' },
    sendMessage: (bot, chat, text) => { sent.push({ chat: chat, text: text }); return { ok: true }; },
    findShopLinkByShopId_: (id) => ({ obj: { '状態': '連携済', 'グループchat_id': '-100' + id } }),
    fieldParseRate_: (v) => (v === '' || v === null || v === undefined ? 30 : Number(v)),
    referralParseDiscount_: (v) => Number(v) || 0,
    validPartnerShopId_: () => true,
    BOT_TYPE: { BOOKING: 'booking' }
  });
  run('__partnerLangMemo_ = {};');
  run('isSourcePartnerShop_ = function() { return false; }; sourcePartnerState_ = function() { return false; };');   // 流入元タブ（SourceCampaign.gs）は読まない＝レジデンス等ではない
  return { run, sent };
}

const L = 'individualGroupLangs_("SHOP-PJ")';

test('店マスター「提携種別」=飲食店: 個人提携と同じ扱いで kind=restaurant・車屋は対象外', () => {
  const { run } = loadV7();
  assert.equal(run('individualPartnerState_("SHOP-PJ")'), true);
  assert.equal(run('isRestaurantPartnerShop_("SHOP-PJ")'), true);
  assert.equal(run('individualPartnerInfo_("SHOP-PJ").kind'), 'restaurant');
  assert.equal(run('individualPartnerInfo_("SHOP-PJ").rate'), 30);
  assert.equal(run('isRestaurantPartnerShop_("SHOP-HIRO")'), false);
  assert.equal(run('individualPartnerInfo_("SHOP-HIRO").kind'), 'individual');
  assert.equal(run('individualPartnerState_("SHOP-CAR")'), false);
  assert.equal(run('isRestaurantPartnerShop_("SHOP-CAR")'), false);
});

test('2026-10-29 より前のキャッシュ（kind 無し）は個人提携として読む', () => {
  const { run } = loadV7();
  run('__partnerKindMemo_ = { "SHOP-OLD": { name: "Old", rate: 30, discount: 0, selfChat: "" } };');
  assert.equal(run('individualPartnerState_("SHOP-OLD")'), true);
  assert.equal(run('isRestaurantPartnerShop_("SHOP-OLD")'), false);
});

test('飲食店は本人割引の対象にしない（本人chat_id が入っていても）・個人提携は今までどおり', () => {
  const { run } = loadV7();
  assert.equal(run('individualPartnerSelfFor_("777")'), null);
  assert.equal(run('individualPartnerSelfFor_("888").shopId'), 'SHOP-HIRO');
});

test('あいさつ文（英語＋クメール語・紹介料30%）: 営業ボードの表示（v7-operations）と同じ文', () => {
  const { run } = loadV7();
  const text = run('buildShopGroupGreeting_("PJ Restaurant", "SHOP-PJ")');
  assert.equal(text, [
    'Welcome to SAMURAI MOTORS, PJ Restaurant! We\'ll send updates in this group.',
    '',
    '[How it works]',
    '- Your guests book with the QR on our flyer and pay SAMURAI MOTORS directly.',
    '- When a guest books, we\'ll let you know here (date, time, menu and car — no names or photos).',
    '- At the start of each month, we\'ll send last month\'s jobs, amounts and your commission (30%), and pay it by ABA by the 10th.',
    '',
    'Feel free to ask anything in this group. Thank you!',
    '',
    'សូមស្វាគមន៍ PJ Restaurant មកកាន់ SAMURAI MOTORS! យើងនឹងផ្ញើដំណឹងមកក្នុងក្រុមនេះ។',
    '',
    '[របៀបដំណើរការ]',
    '- ភ្ញៀវហាងអ្នកកក់តាម QR លើខិត្តប័ណ្ណរបស់យើង។ ភ្ញៀវបង់ប្រាក់ឱ្យ SAMURAI MOTORS ដោយផ្ទាល់។',
    '- ពេលភ្ញៀវកក់ យើងនឹងប្រាប់អ្នកនៅទីនេះ អំពីថ្ងៃ ម៉ោង សេវា និងប្រភេទរថយន្ត (មិនផ្ញើឈ្មោះ ឬរូបថតទេ)',
    '- នៅដើមខែនីមួយៗ យើងនឹងផ្ញើចំនួនការងារ ចំនួនទឹកប្រាក់ និងកម្រៃជើងសារ (30%) របស់ខែមុន ហើយបង់កម្រៃជើងសារនោះជូនអ្នក ត្រឹមថ្ងៃទី10 (តាម ABA)',
    '',
    'បើមានអ្វីចង់សួរ សូមកុំស្ទាក់ស្ទើរសួរក្នុងក្រុមនេះ។ សូមអរគុណ!'
  ].join('\n'));
  assert.doesNotMatch(text, /Registration link|friends|ចុះឈ្មោះ|មិត្តភក្តិ/);

  const ops = load('v7-operations', ['PartnerLangOps.gs', 'IndividualPartnerOps.gs']);
  [[30, ['en', 'km']], [0, ['en', 'km']], [20, ['ja']]].forEach(([r, langs]) => {
    const l = JSON.stringify(langs);
    assert.equal(ops('restaurantGroupGreetingText_("PJ Restaurant", ' + r + ', ' + l + ')'),
      run('buildRestaurantGroupGreeting_("PJ Restaurant", ' + r + ', ' + l + ')'));
  });
});

test('あいさつ文: 紹介料率0の時は紹介料の行を出さない', () => {
  const { run } = loadV7();
  const text = run('buildRestaurantGroupGreeting_("PJ Restaurant", 0, ["en", "km"])');
  assert.match(text, /- At the start of each month, we'll send last month's jobs and amounts\.\n/);
  assert.match(text, /- នៅដើមខែនីមួយៗ យើងនឹងផ្ញើចំនួនការងារ និងចំនួនទឹកប្រាក់ របស់ខែមុន\n/);
  assert.doesNotMatch(text, /commission|កម្រៃជើងសារ/);
});

test('連携完了（英語＋クメール語）', () => {
  const { run } = loadV7();
  assert.equal(run('restaurantConnectedText_("PJ Restaurant", ' + L + ')'), [
    '✅ Connected!', 'Partner: PJ Restaurant', 'When a guest books through your QR, you\'ll get a message here.',
    '',
    '✅ បានភ្ជាប់ក្រុមហើយ!', 'ដៃគូ: PJ Restaurant', 'ដំណឹងអំពីការកក់តាម QR របស់ហាងអ្នក នឹងផ្ញើមកក្នុងក្រុមនេះ។'
  ].join('\n'));
});

test('予約の知らせ: 飲食店は「New booking via your QR」・個人提携は今までどおり', () => {
  const { run, sent } = loadV7();
  const info = JSON.stringify({ bookingId: 'BK-1', plan: { name: 'SAMURAI WASH' }, options: [], vehicleType: 'セダン', carModel: '',
    date: '2026-10-30', startTime: '15:00', endTime: '15:45' });
  assert.equal(run('notifyIndividualPartnerBooking_("SHOP-PJ", ' + info + ')'), true);
  assert.equal(run('notifyIndividualPartnerBooking_("SHOP-HIRO", ' + info + ')'), true);
  assert.equal(sent[0].text.split('\n')[0], '📅 New booking via your QR / មានការកក់ថ្មី តាម QR របស់ហាងអ្នក');
  assert.equal(sent[1].text.split('\n')[0], '📅 New booking from your referral / មានការកក់ថ្មី ពីភ្ញៀវដែលអ្នកបានណែនាំមក');
  assert.equal(sent[0].text.split('\n').slice(1).join('\n'), sent[1].text.split('\n').slice(1).join('\n'));
});

test('本人登録リンク・紹介チラシは飲食店に送らない（手で実行しても止まる）', () => {
  const { run, sent } = loadV7();
  assert.equal(run('sendSelfRegLinkOnce_("SHOP-PJ", "-100")'), true);
  assert.equal(run('sendIndividualFlyersOnce_("SHOP-PJ", "-100")'), true);
  run('partnerGroupChatId_ = function() { return "-100"; };');
  assert.equal(run('sendSelfRegLinkNow("SHOP-PJ")'), false);
  assert.equal(run('resendPartnerFlyersNow("SHOP-PJ")'), false);
  assert.equal(sent.length, 0);
});

test('管理グループの新規予約の1行: 飲食店は 🍽・個人提携は 🙋', () => {
  const { run } = loadV7();
  assert.equal(run('individualAdminLine_("PJ Restaurant", 30, "restaurant")'),
    '🍽 紹介: PJ Restaurant（飲食店・紹介料 30%・お支払いは当社へ・紹介料は月初に自動集計）\n');
  assert.equal(run('individualAdminLine_("Hiro Sato", 30)'),
    '🙋 紹介: Hiro Sato（個人提携・紹介料 30%・お支払いは当社へ・紹介料は月初に自動集計）\n');
});

test('v7-operations: 紹介料の記帳・月報の一覧に飲食店も入る（kind 付き）・車屋は入らない', () => {
  const rows = MASTER.slice(1).map((r) => ({ obj: { 'shop_id': r[0], '店名': r[1], '提携種別': r[2], '紹介料率(%)': r[3] } }));
  const ops = load('v7-operations', ['PartnerLangOps.gs', 'IndividualPartnerOps.gs'], {
    getShopSheet_: () => ({}),
    getSheetHeaders_: () => MASTER[0],
    readSheetObjects_: () => rows,
    shopCommissionTerms_: (o) => ({ rate: o['紹介料率(%)'] === '' ? 30 : Number(o['紹介料率(%)']) })
  });
  const got = JSON.parse(ops('JSON.stringify(individualPartnersById_())'));
  assert.deepEqual(Object.keys(got).sort(), ['SHOP-HIRO', 'SHOP-PJ']);
  assert.equal(got['SHOP-PJ'].kind, 'restaurant');
  assert.equal(got['SHOP-PJ'].terms.rate, 30);
  assert.equal(got['SHOP-HIRO'].kind, 'individual');
});

test('提携種別の打ち間違い: 車屋（店集金）のまま扱い、管理グループに1回だけ知らせる', () => {
  const master = MASTER.concat([['SHOP-TYPO', 'Cafe X', '飲食', '', '', '']]);
  const { run, sent } = loadV7(master);
  assert.equal(run('individualPartnerState_("SHOP-TYPO")'), false);
  assert.equal(run('individualPartnerState_("SHOP-PJ")'), true);
  run('readPartnerKinds_(true)');
  const warn = sent.filter((m) => m.chat === 'ADMIN');
  assert.equal(warn.length, 1);
  assert.match(warn[0].text, /Cafe X「飲食」/);
  assert.match(warn[0].text, /車屋（お客様は店に払う）として扱っています/);
});

test('連携の直後のあいさつ文（1回きり）: 飲食店の文を1通だけ・チラシと本人登録リンクは送らない', () => {
  const { run, sent } = loadV7();
  assert.equal(run('sendShopGroupGreetingOnce_("SHOP-PJ", "-100PJ", "PJ Restaurant")'), true);
  assert.equal(run('sendShopGroupGreetingOnce_("SHOP-PJ", "-100PJ", "PJ Restaurant")'), true);   // 2回目は送らない
  const toGroup = sent.filter((m) => m.chat === '-100PJ');
  assert.equal(toGroup.length, 1);
  assert.match(toGroup[0].text, /^Welcome to SAMURAI MOTORS, PJ Restaurant!/);
  assert.match(toGroup[0].text, /\[How it works\]/);
});

test('あいさつ文: 送る直前に店マスターを読み直せない時は送らない（古い種別の文を1回きりで送らない）', () => {
  let broken = false;
  const { run, sent } = loadV7(null, { sheetBroken: () => broken });
  assert.equal(run('individualPartnerState_("SHOP-PJ")'), true);   // 先に読めた内容がある
  broken = true;
  assert.equal(run('sendShopGroupGreetingOnce_("SHOP-PJ", "-100PJ", "PJ Restaurant")'), false);
  assert.equal(sent.filter((m) => m.chat === '-100PJ').length, 0);
});

