/**
 * ScoutBoardShopLinks.gs — 営業ボードの「🔗 提携店QR・グループ連携」タブ（2026-10-22）
 *
 * Daisuke「QR はRun Kosalがラベル印刷してチラシに貼る時にも関わる大事な作業。網羅的に把握したい」
 *          「店ごとのグループ名・招待手順・送る文の一覧を」「統一したところで提携先・QR・グループ番号を一元管理」
 *
 * - 営業ボード（ScoutBoard.gs）の1時間ごとの書き直しに相乗りする。v7 Database は読むだけ
 * - 店ごとに: 連携の状態 / 作るグループ名 / グループで送る文（/register <コード>）/ 予約QRのURL /
 *   流入（QRを読んだ人 → 予約画面 → 予約 → 施工完了 → 売上・取り分）/ 実際のグループ名・連携日時
 * - 対象: 店マスターの「QRリンク(BookingBot)」に予約Botのリンクがある店（= 専用QRを配った店）と、Bot連携シートにある店。
 *   【サンプル】行（SHOP-SAMPLE-xxx）は除く
 * - 流入はファネルログの bot_start / ソース shop:<shop_id>（v7 本番 @82・2026-10-21 14:15 以降）。
 *   予約・施工・売上は、その店のQRを読んだお客様（チャットID）の予約すべて（2回目以降も含む）
 * - 同日 v2: スマホでコピーしやすい列順（店名 → QRのURL → 連携 → 送る文）・シール枚数/最終日（ShopQrSticker.gs が店マスターに書く）・
 *   あいさつ文は右端・全行を折り返さず1行の高さに揃える。手順は「アプリでQRを出す → 印刷 → 記録 → グループ」の順
 * - 2026-10-26: Daisuke「何語で通知かも各グループ毎にわかるように」→「グループへの通知の言語」「お客様への通知の言語」の2列。
 *   車屋のグループの言語は店マスター「グループへの通知の言語」の設定（空欄＝標準 クメール語＋英語＋日本語・PartnerLangOps.gs）。
 *   あいさつ文の列も実際に送る文にした（車屋＝設定の言語の順・レジデンス等＝英語・個人提携＝英語＋クメール語が標準（2026-10-28〜・それまでは日本語）。v7 ShopGroupGreeting.gs と同じ選び方）
 */

const SCOUT_LINKS_TAB_KEY = 'links';
const SCOUT_LINKS_BOT = 'SAMURAI_MOTORS_BOOKING_BOT';
// グループに最初に送るあいさつ文（{shop} に店名）。クメール語は Panha 校閲（provisional・Run Kosal 確認待ち）
// 2026-10-24〜 連携時に予約Botが自動送信（v7/ShopGroupGreeting.gs に同じ文を複製）。文言を直すときは両方を直す
// 2026-10-26〜 店マスター「グループへの通知の言語」の順に、言語ごとに空行で区切って並べる（日本語は同日新設）
const SCOUT_LINKS_GREETING_KM =
  'នេះជាក្រុមរបស់ {shop} និង SAMURAI MOTORS។\n' +
  'សម្រាប់ភ្ញៀវដែលកក់តាម QR របស់ហាងអ្នក យើងនឹងផ្ញើសារពេលចាប់ផ្តើម និងបញ្ចប់ការលាងសម្អាត ព្រមទាំងរូបថត មុន / ក្រោយ មកក្រុមនេះ។\n' +
  'នៅដើមខែនីមួយៗ យើងនឹងផ្ញើរបាយការណ៍ប្រចាំខែ ដែលបង្ហាញចំនួនការងារ និងចំនួនទឹកប្រាក់ ផងដែរ។\n' +
  'សូមអរគុណដែលសហការជាមួយយើង ហើយសូមបន្តដើរជាមួយគ្នា!';
const SCOUT_LINKS_GREETING_EN =
  'This is the group for {shop} × SAMURAI MOTORS.\n' +
  'For customers who book through your shop\'s QR, you\'ll see start and finish updates and Before/After photos here.\n' +
  'At the start of each month, we\'ll also send a monthly report with the number of jobs and the amounts.\n' +
  'Thank you for working with us. We look forward to a great partnership!';
const SCOUT_LINKS_GREETING_JA =
  '{shop} × SAMURAI MOTORS のグループです。\n' +
  'お店の QR からご予約いただいたお客様について、作業の開始と完了、作業前後の写真をこのグループでお知らせします。\n' +
  '毎月はじめに、件数と金額をまとめた月次レポートもお送りします。\n' +
  'ご協力ありがとうございます。これからもよろしくお願いします！';
// レジデンス等の提携先（流入元の shop_id）のあいさつ文（英語のみ）。v7/SourceGroupNotify.gs buildSourceGroupGreeting_ と同じ文。直すときは両方を直す
const SCOUT_LINKS_GREETING_SOURCE_EN =
  'This is the group for {shop} × SAMURAI MOTORS.\n' +
  'When a resident books with us, you\'ll see the booking here (date, time, unit number and car), ' +
  'and on the day, start and finish updates with Before/After photos.\n' +
  'Thank you for working with us!';

// 「何語で届くか」（2026-10-26 時点の v7 の文面に合わせる。文面の言語を変えたらここも直す）
//   グループ: 車屋＝店マスター「グループへの通知の言語」の設定（連携完了・QRからの来店・あいさつ文・作業の開始/完了と写真・請求・月次レポート）
//             レジデンス等＝英語で固定（SourceGroupNotify）／個人提携＝空欄は日本語・この列で英語にも（IndividualPartner / IndividualPartnerOps・2026-10-27〜）
//   お客様: 車屋・個人提携の QR から来たお客様＝クメール語＋英語。レジデンス等（流入元タブの言語 en-ja）＝
//           あいさつ・予約確定・予約画面は英語＋日本語、作業の知らせ・リマインドなどはクメール語＋英語
const SCOUT_LINKS_LANG_FIXED = {
  source:     { group: '英語（固定）',        customer: '英語＋日本語（あいさつ・予約確定・予約画面）／ほかはクメール語＋英語' },
  individual: { group: '英語＋クメール語（標準）', customer: 'クメール語＋英語' },   // group は店マスターの設定で表示（scoutLinksRows_）
  restaurant: { group: '英語＋クメール語（標準）', customer: 'クメール語＋英語' },   // 2026-10-29 飲食店（同上）
  unknown:    { group: '（判定できず: 流入元タブを読めません）', customer: '（判定できず）' }
};
const SCOUT_LINKS_SHOP_CUSTOMER_LANG = 'クメール語＋英語';

/** 車屋のグループの言語の表示（店マスターの設定・空欄は「（標準）」・読めない値はそのことも出す） */
function scoutLinksShopLangLabel_(shop) {
  const raw = String(shop[PARTNER_GROUP_LANG_COL] || '').trim();
  const label = partnerLangsLabel_(shopGroupLangsOps_(shop));
  if (!raw) return label + '（標準）';
  if (!parsePartnerLangs_(raw)) return label + '（「' + raw + '」を読めないので標準）';
  const unknown = partnerLangsUnknownWords_(raw);
  return unknown.length ? label + '（⚠️ 読めない語: ' + unknown.join('・') + '）' : label;
}

function scoutBoardWriteShopLinks_(board, d) {
  const sh = scoutBoardSheet_(board, SCOUT_LINKS_TAB_KEY);
  const items = scoutLinksRows_();
  const rows = items.map(function(o) { return o.cells; });
  // 提携の種類ごとのタブ（2026-10-27）。失敗しても全体のタブには影響させない
  try { scoutLinksWriteKindTabs_(board, items); } catch (e) { Logger.log('⚠️ 営業ボード 提携の種類ごとのタブ: ' + e); }

  const steps = [
    ['🔗 提携店QR・グループ連携（1時間ごとに自動更新・見るだけ） / Partner shop QR & group link'],
    ['QRシールの作り方（お店がOKした時・スマホで） / How to make the QR sticker'],
    ['① 営業アプリのお店の画面 →「🔗 このお店のQRを出す」→「📋 URLをコピー」（この表の「予約QRのURL」をコピーしてもよい） / In the app: issue QR → copy URL'],
    ['② ラベル印刷アプリに貼り付けてシールを印刷 → 自分のスマホで1回読んで確認（「QRを読んだ人」が増える） / Paste into the label app → print → scan once to check'],
    ['③ アプリで「🏷 QRシールを渡した」に枚数を記録（この表の「シール枚数」に出る） / Record the sticker count in the app'],
    ['お店の Telegram グループの作り方 / How to set up the shop group'],
    ['④ Telegram で「新しいグループ」→ お店の人（オーナー）と 予約Bot @' + SCOUT_LINKS_BOT + ' を追加。グループ名は「作るグループ名」をコピペ / New group → add the owner and the bot'],
    ['⑤「グループで送る文」（/register 6桁）を送る → Bot が「✅ Connected!」と「あいさつ文」（右端の列と同じ）を自動で送ったら完了。あいさつ文は手で貼らない / Send the /register line — the bot replies and posts the greeting automatically'],
    ['⚠️ コード（6桁）はその店のグループでだけ使う。社外に出さない（他の人が使うとお店の写真が別のグループに届く） / Never share the codes outside'],
    ['🌐 車屋のグループへの通知の言語は、v7 Database「店マスター」の「' + PARTNER_GROUP_LANG_COL + '」列で店ごとに変えられる（プルダウン・並べた順に出す・空欄＝クメール語＋英語＋日本語・最大5分で反映。あいさつ文は連携の1回だけなので ⑤ の前に決める）。レジデンス等は英語で固定・個人提携は空欄＝英語＋クメール語（同じ列で日本語にも） / Group language per shop: 店マスター'],
    ['📑 相手の種類ごとの一覧は「🚗 車屋提携」「🍽 飲食店提携」「🏠 レジデンス提携」「🏢 商業施設提携」「🙋 個人提携」タブ（2026-10-29〜。分類は店マスター「' + BOARD_CATEGORY_COL + '」・空欄は自動） / Per-type tabs']
  ];
  sh.getRange(1, 1, steps.length, 1).setValues(steps);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.getRange(2, 1).setFontWeight('bold');
  sh.getRange(6, 1).setFontWeight('bold');
  sh.getRange(steps.length - 2, 1).setFontColor('#b3261e');   // ⚠️ コードの行（2026-10-27 に種類ごとのタブの行を足したので末尾から3行目）

  const r0 = steps.length + 2;
  // スマホで開いた時に「店名 → QRのURL → 連携 → 送る文」が横スクロールなしで見える順（2026-10-22）。
  // あいさつ文（長い・全店同じ形）は右端へ。1行の高さを揃えるため折り返さない
  const headers = ['No', '店名 (Shop)', '予約QRのURL (QR link)', '連携 (Linked)', 'グループで送る文 (Send in group)',
    'グループへの通知の言語 (Group language)', 'お客様への通知の言語 (Customer language)',
    '作るグループ名 (Group name)', 'シール枚数 (Stickers)', 'シール最終日 (Last sticker)',
    'QRを読んだ人 (Scanned)', '予約画面を開いた人 (Opened)', '予約 (Bookings)',
    '施工完了 (Done)', '売上 USD（お店の車も含む）(Sales)', '店の取り分 USD (Shop share)', 'SAMURAI USD', '取り分の率 (Rate %)',
    '実際のグループ名 (Actual group)', '連携日時 (Linked at)', 'あいさつ文 (Greeting)', 'shop_id'];
  const n = scoutBoardTable_(sh, r0, headers, rows,
    [36, 160, 260, 90, 140, 240, 260, 230, 80, 100, 80, 90, 70, 70, 80, 90, 80, 70, 200, 130, 360, 220], []);
  if (rows.length) {
    sh.getRange(r0 + 1, 1, rows.length, headers.length).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    sh.setRowHeightsForced(r0 + 1, rows.length, 24);
  }
  sh.setFrozenRows(r0);
  sh.setFrozenColumns(2);
  if (rows.length) sh.getRange(r0, 1, n, headers.length).createFilter();
}

/** 表の行を作る（v7 Database の 店マスター・Bot連携・ファネルログ・予約 を読むだけ） */
function scoutLinksRows_() {
  const ss = getSalesLogSs_();
  const shopRows = readSheetObjects_(getShopSheet_());
  const shopById = {};
  shopRows.forEach(function(r) { const id = String(r.obj['shop_id'] || '').trim(); if (id) shopById[id] = r.obj; });

  // Bot連携: 同じ shop_id は 連携済 → 待機中 → その他 の順に1行（v7 ShopRouting.findShopLinkByShopId_ と同じ）
  const linkSheet = ss.getSheetByName(SHOP_PROV_LINK_SHEET);
  const rank = { '連携済': 3, '待機中': 2 };
  const linkById = {};
  (linkSheet ? readSheetObjects_(linkSheet) : []).forEach(function(r) {
    const id = String(r.obj['shop_id'] || '').trim();
    if (!id) return;
    const rk = rank[String(r.obj['状態'])] || 1;
    if (!linkById[id] || rk > linkById[id].rk) linkById[id] = { rk: rk, obj: r.obj };
  });

  // 対象の店（店マスターの QR リンクの順 → Bot連携だけにある店）
  const ids = [];
  const isSample = function(id, name) { return id.indexOf('SHOP-SAMPLE') === 0 || String(name || '').indexOf('【サンプル】') === 0; };
  shopRows.forEach(function(r) {
    const id = String(r.obj['shop_id'] || '').trim();
    if (id && !isSample(id, r.obj['店名']) && /t\.me\/[^?\s]+\?start=shop_/.test(String(r.obj['QRリンク(BookingBot)'] || ''))) ids.push(id);
  });
  Object.keys(linkById).forEach(function(id) {
    if (ids.indexOf(id) < 0 && !isSample(id, (linkById[id].obj || {})['店名'])) ids.push(id);
  });

  // レジデンス等の提携先（流入元タブの shop_id）。読めない時は null（言語は「判定できず」・あいさつ文は車屋の文のまま）
  const srcShopIds = (typeof sourcePartnerShopIds_ === 'function') ? sourcePartnerShopIds_() : null;
  const funnel = scoutLinksFunnel_(ss);
  const bookings = scoutLinksBookings_(ss);
  const fieldJobs = scoutLinksFieldJobs_(ss);   // 現場アプリで店を選んだ作業（予約なし・在庫車やボイス依頼など）

  return ids.map(function(id, i) {
    const shop = shopById[id] || {};
    const link = linkById[id] ? linkById[id].obj : null;
    const name = String(shop['店名'] || (link && link['店名']) || id);
    const st = link ? String(link['状態'] || '') : '';
    const linked = st === '連携済';
    const code = (link && st === '待機中') ? String(link['ワンタイムコード'] || '') : '';
    const qr = 'https://t.me/' + SCOUT_LINKS_BOT + '?start=shop_' + id;

    // 流入: その店のQRを読んだお客様（重複なし）→ 予約画面・予約・施工・売上
    const chats = funnel.scans[id] || {};
    const chatIds = Object.keys(chats);
    let opened = 0, booked = 0, done = 0, sales = 0;
    chatIds.forEach(function(c) {
      if (funnel.opened[c]) opened++;
      (bookings[c] || []).forEach(function(b) {
        if (b.status === 'キャンセル') return;
        // 別の提携先の紹介の予約は数えない（最初の紹介者で固定・2026-10-27: 紹介元のあるお客様が別の店のQRを読んでも紹介元は変わらない）
        if (b.ref && b.ref !== id) return;
        booked++;
        if (b.status === '作業完了') { done++; sales += b.amount; }
      });
    });
    // 店の在庫車など（店が当社に払う）: 店の取り分は無いので SAMURAI 側にだけ足す。
    // その店のQRを読んだお客様の作業は、上の予約（手動ジョブの売上計上行）で数えているので足さない
    let fieldSales = 0;
    (fieldJobs[id] || []).forEach(function(j) {
      if (j.chat && chats.hasOwnProperty(j.chat)) return;
      booked++; done++; fieldSales += j.amount;
    });
    const rate = (typeof shopCommissionTerms_ === 'function' && shopById[id]) ? shopCommissionTerms_(shop).rate : 30;
    const shopShare = Math.round(sales * rate) / 100;   // お客さんの予約の分だけ
    const totalSales = Math.round((sales + fieldSales) * 100) / 100;
    // 提携の種類（v7 ShopGroupGreeting.buildShopGroupGreeting_ と同じ順: レジデンス等 → 飲食店 → 個人提携 → 車屋）
    const kindVal = String(shop[INDIVIDUAL_PARTNER_KIND_COL] || '').trim();
    const kind = (srcShopIds && srcShopIds[id]) ? 'source'
      : kindVal === RESTAURANT_PARTNER_KIND ? 'restaurant'
      : kindVal === INDIVIDUAL_PARTNER_KIND ? 'individual'
      : srcShopIds ? 'shop' : 'unknown';
    const fill = function() { return name; };   // 店名に $& 等が入っても特殊展開しない

    const cells = [
      i + 1,
      name,
      qr,
      linked ? '✅ 連携済' : (code ? '⏳ 未連携' : '— コード未発行'),
      linked ? '（連携済み・送らなくてよい）' : (code ? '/register ' + code : '（コード未発行: アプリのお店の画面で「🔗 このお店のQRを出す」を押す）'),
      kind === 'shop' ? scoutLinksShopLangLabel_(shop)
        : (kind === 'individual' || kind === 'restaurant') ? partnerLangsLabel_(individualGroupLangsOps_(shop)) + (String(shop['グループへの通知の言語'] || '').trim() ? '' : '（空欄＝英語＋クメール語）')
        : SCOUT_LINKS_LANG_FIXED[kind].group,
      kind === 'shop' ? SCOUT_LINKS_SHOP_CUSTOMER_LANG : SCOUT_LINKS_LANG_FIXED[kind].customer,
      name + ' × SAMURAI MOTORS',
      Number(shop['QRシール枚数']) || 0,
      formatSalesLogDateCell_(shop['QRシール最終日']).substring(0, 10),
      chatIds.length, opened, booked, done,
      totalSales, shopShare, Math.round((sales - shopShare + fieldSales) * 100) / 100, rate,
      linked ? String(link['グループ名'] || '') : '',
      linked ? String(link['紐付け日時'] || '') : '',
      // レジデンス等は英語の専用文（SourceGroupNotify.gs）、個人提携は専用文（IndividualPartnerOps.gs・英語＋クメール語が標準・2026-10-28〜）
      kind === 'source'
        ? SCOUT_LINKS_GREETING_SOURCE_EN.replace(/\{shop\}/g, fill)
        : kind === 'restaurant'
        ? restaurantGroupGreetingText_(name, rate, individualGroupLangsOps_(shop))
        : kind === 'individual'
        ? individualGroupGreetingText_(name, rate, individualEffectiveDiscountOps_(shop, rate), individualGroupLangsOps_(shop),
            !!String(shop['本人chat_id'] || '').trim())
        : langLinesOps_(shopGroupLangsOps_(shop), { km: SCOUT_LINKS_GREETING_KM, en: SCOUT_LINKS_GREETING_EN, ja: SCOUT_LINKS_GREETING_JA })
          .map(function(t) { return t.replace(/\{shop\}/g, fill); }).join('\n\n'),
      id
    ];
    // 種類ごとのタブ用（scoutLinksWriteKindTabs_）。cat = 営業ボードの分類（相手の種類）・pay = お金の流れ（2026-10-29）
    return { cells: cells, kind: kind, cat: scoutLinksCategory_(kind, shop), pay: SCOUT_LINKS_PAY_LABEL[kind] || '', shop: shop, link: link, id: id, name: name, linked: linked, code: code, qr: qr, rate: rate,
             scanned: chatIds.length, opened: opened, booked: booked, done: done, sales: totalSales, share: shopShare };
  });
}

// ====== 営業ボードの分類（相手の種類・2026-10-29） ======
// Daisuke「車屋提携のタブの中にシティゴルフが入ってるけど、これは商業施設提携の方に入れてほしい」「ピカソはレジデンスだけど、商業施設ではないよね？」
//   → タブは「相手の種類」で分ける（それまでは「お金の流れ」で分けていた）。お金の仕組み（提携種別・流入元タブ）は変えない。
//   分類 = 店マスター「営業ボードの分類」（プルダウン）。空欄は自動: 飲食店の型→飲食店／業種の言葉（ゴルフ・ホテル等→商業施設、コンド等→レジデンス、
//   飲食・レストラン等→飲食店）／流入元の提携先→レジデンス／ほか→車屋。個人提携はいつも「🙋 個人提携」（専用の列があるため）
const BOARD_CATEGORY_COL = '営業ボードの分類';
const BOARD_CATEGORY_OPTIONS = ['車屋', '飲食店', 'レジデンス', '商業施設'];
const SCOUT_LINKS_PAY_LABEL = {
  shop:       'お店に払う（店集金・当社は残りを施工時に）',
  unknown:    'お店に払う（店集金・当社は残りを施工時に）',
  restaurant: '当社に払う（紹介料は月初に ABA）',
  individual: '当社に払う（紹介料は月初に ABA）',
  source:     '当社に払う（特典は流入元タブ）'
};

/** 相手の種類（車屋・飲食店・レジデンス・商業施設・個人） */
function scoutLinksCategory_(kind, shop) {
  if (kind === 'individual') return '個人';
  const set = String((shop || {})[BOARD_CATEGORY_COL] || '').trim();
  if (BOARD_CATEGORY_OPTIONS.indexOf(set) >= 0) return set;
  if (kind === 'restaurant') return '飲食店';
  const biz = String((shop || {})['業種'] || '');
  if (/ゴルフ|ホテル|モール|商業|オフィス|golf|hotel|mall/i.test(biz)) return '商業施設';
  if (/コンド|レジデンス|マンション|アパート|condo|residence/i.test(biz)) return 'レジデンス';
  if (/飲食|レストラン|カフェ|パブ|バー|restaurant|cafe/i.test(biz)) return '飲食店';
  return kind === 'source' ? 'レジデンス' : '車屋';
}

/**
 * 店マスターに「営業ボードの分類」列（末尾）とプルダウンを用意する（getShopSheet_ の列そろえから）。表示の分け方だけで、お金の仕組みには効かない
 * @return {boolean} 常に true（プルダウンが付けられなくても列そろえは止めない）
 */
function ensureBoardCategoryColumn_(sheet) {
  if (!ensureColumnsAtEnd_(sheet, [BOARD_CATEGORY_COL])) return true;
  try {
    const col = getSheetHeaders_(sheet).map(function(h) { return String(h).trim(); }).indexOf(BOARD_CATEGORY_COL) + 1;
    if (col > 0 && sheet.getMaxRows() > 1) {
      const range = sheet.getRange(2, col, sheet.getMaxRows() - 1, 1);
      const rule = range.getDataValidation();
      if (!rule || String(rule.getCriteriaValues()[0]) !== String(BOARD_CATEGORY_OPTIONS)) {
        range.setDataValidation(SpreadsheetApp.newDataValidation()
          .requireValueInList(BOARD_CATEGORY_OPTIONS, true).setAllowInvalid(true)
          .setHelpText('営業ボードのどのタブに出すか（相手の種類）。空欄＝自動（業種・提携の型から）。お金の流れは「提携種別」と流入元タブで決まり、ここでは変わらない').build());
      }
    }
  } catch (err) {
    Logger.log('⚠️ 営業ボードの分類のプルダウン設定失敗（列はある）: ' + err);
  }
  return true;
}

// ====== 提携の種類ごとのタブ（2026-10-27） ======
// Daisuke「提携という軸で1つで管理できたら」「タブで個人提携、車屋提携、商業施設提携みたいにわける」「SCOUT は見やすくていいね」
//   → 入力は v7 Database「店マスター」だけ（ここは見るだけ・1時間ごとに作り直す）。全体の「🔗 提携店QR・グループ連携」タブもそのまま残す
//   - 🙋 個人提携: 番号・本人登録（v7 PartnerSelfRegister.gs が店マスターに書く）・チラシ・配分（紹介料・紹介割引・本人の割引）・紹介の数字
//   - 🚗 車屋提携 / 🏢 商業施設提携（レジデンス等＝流入元の提携先）: 全体タブと同じ列でその種類だけ

const SCOUT_LINKS_INDIV_HEADERS = ['No', '名前 (Partner)', '番号 (No.)', '紹介URL (Referral link)', '連携 (Linked)',
  'グループで送る文 (Send in group)', '本人登録 (Self registered)', '本人登録リンクの送付 (Self link sent)', 'チラシ (Flyers)',
  'チラシを送った日 (Flyers sent)', '紹介料 % (Commission)', '紹介割引 % (Friend discount)', '本人の割引 % (Own discount)', 'グループへの通知の言語 (Group language)',
  'QRを読んだ人 (Scanned)', '予約画面を開いた人 (Opened)', '予約 (Bookings)', '施工完了 (Done)', '売上 USD (Sales)',
  '紹介料 USD・見込み (Commission est.)', '作るグループ名 (Group name)', '実際のグループ名 (Actual group)', '連携日時 (Linked at)', 'shop_id'];

/** チラシの URL のフォルダ名から版（v7 PartnerSelfRegister.gs partnerFlyerVersion_ と同じ読み方） */
function scoutLinksFlyerVersion_(urls) {
  const seen = [];
  urls.forEach(function(u) {
    const m = String(u).match(/\/partners\/[^\/]+\/(v\d+(?:\.\d+)*)\//);
    const v = m ? m[1] : '不明';
    if (seen.indexOf(v) < 0) seen.push(v);
  });
  return seen.join('・');
}

/** v7 Database「紹介チラシ送付履歴」（v7 PartnerSelfRegister.gs が書く・手で送った分は Claude が書き足す）→ shop_id → 最後の1回 */
function scoutLinksFlyerSends_() {
  const out = {};
  const sh = getSalesLogSs_().getSheetByName('紹介チラシ送付履歴');
  if (!sh || sh.getLastRow() < 2) return out;
  readSheetObjects_(sh).forEach(function(r) {
    const id = String(r.obj['shop_id'] || '').trim();
    if (!id) return;
    const at = formatSalesLogDateCell_(r.obj['送った日時']);
    if (!out[id] || at > out[id].at) {
      out[id] = { at: at, ver: String(r.obj['チラシの版'] || ''), n: Number(r.obj['枚数']) || 0, how: String(r.obj['送り方'] || '') };
    }
  });
  return out;
}

/** 個人提携の1行 */
function scoutLinksIndivCells_(o, n, sends) {
  const s = o.shop || {};
  const selfChat = String(s['本人chat_id'] || '').trim();
  const selfName = String(s['本人の名前（Telegram）'] || '').trim();
  const selfAt = formatSalesLogDateCell_(s['本人登録日時']).substring(0, 16);
  // 店マスター「本人登録リンク」には予約Botが「送付済み 日時」だけを書く。リンク本体（先に開いた人が本人になる）は表示しない
  const selfLinkRaw = String(s['本人登録リンク'] || '').trim();
  const selfLink = selfLinkRaw.indexOf('start=self_') >= 0 ? '送付済み（リンク本体は表示しない）' : selfLinkRaw;
  // v7 PartnerSelfRegister.gs parsePartnerFlyerUrls_ と同じ読み方（送るのは最大10枚）
  const flyerUrls = String(s['紹介チラシURL'] || '').split(/[\s,、，]+/).filter(function(u) { return /^https:\/\/\S+$/.test(u); }).slice(0, 10);
  const sent = (sends || {})[o.id];
  const disc = individualEffectiveDiscountOps_(s, o.rate);
  const selfPct = Math.min(30, (Number(o.rate) >= 0 ? Number(o.rate) : 30) + disc);
  return [
    n, o.name, String(s['パートナーID'] || ''), o.qr,
    o.linked ? '✅ 連携済' : (o.code ? '⏳ 未連携' : '— コード未発行'),
    o.linked ? '（連携済み・送らなくてよい）' : (o.code ? '/register ' + o.code : '（コード未発行）'),
    selfChat ? '✅ ' + (selfName || selfChat) + (selfAt ? '・' + selfAt : '') : (selfLink ? '⏳ 未登録（リンク送付済み）' : '— 未登録'),
    selfLink,
    flyerUrls.length ? scoutLinksFlyerVersion_(flyerUrls) + '・' + flyerUrls.length + '枚' : '— 未登録',
    sent ? sent.at.substring(0, 16) + '・' + sent.ver + '・' + sent.n + '枚（' + sent.how + '）' : '— まだ',
    o.rate, disc, selfPct,
    partnerLangsLabel_(individualGroupLangsOps_(s)),
    o.scanned, o.opened, o.booked, o.done, o.sales, o.share,
    o.name + ' × SAMURAI MOTORS',
    o.linked ? String(o.link['グループ名'] || '') : '',
    o.linked ? String(o.link['紐付け日時'] || '') : '',
    o.id
  ];
}

function scoutLinksWriteKindTabs_(board, items) {
  const indiv = items.filter(function(o) { return o.kind === 'individual'; });
  let sends = {};
  try { sends = scoutLinksFlyerSends_(); } catch (e) { Logger.log('⚠️ 営業ボード 紹介チラシ送付履歴: ' + e); }
  try {
  scoutLinksWriteKindTab_(board, 'pIndiv', [
    '🙋 個人提携（1時間ごとに自動更新・見るだけ） / Individual partners',
    '入力は v7 Database「店マスター」（紹介料率・紹介割引率・グループへの通知の言語・紹介チラシURL）。本人登録は、グループに届く「🔑 本人登録リンク」から本人が押すと自動で入る',
    '本人の割引 = 紹介料率＋紹介割引（30%まで）。本人の予約は予約の時にこの割引・紹介料なし。紹介した友達の予約は翌月に紹介料',
    '取り消し（違う人が登録された）: 店マスター「本人chat_id」を消すだけ → そのリンクはすぐ使えなくなり（外した人はリンクで戻れない）、1時間以内に新しいリンクがグループに届く',
    'チラシ: 版ごとのフォルダ（PNG）。どの版をいつ送ったかの全件は v7 Database「紹介チラシ送付履歴」、版の中身は「紹介チラシの版」'
  ], SCOUT_LINKS_INDIV_HEADERS, indiv.map(function(o, i) { return scoutLinksIndivCells_(o, i + 1, sends); }),
  [36, 140, 80, 260, 90, 140, 220, 200, 90, 260, 70, 80, 80, 140, 70, 80, 60, 60, 70, 90, 200, 200, 130, 220]);
  } catch (e) { Logger.log('⚠️ 営業ボード 🙋 個人提携タブ: ' + e); }

  // 相手の種類ごとのタブ（2026-10-29）: 全体タブと同じ列＋店名の右に「お金の流れ」
  const renumber = function(list) { return list.map(function(o, i) { const c = o.cells.slice(); c[0] = i + 1; c.splice(2, 0, o.pay); return c; }); };
  const byCat = function(cat) { return items.filter(function(o) { return o.cat === cat; }); };
  const headers = ['No', '店名 (Shop)', '予約QRのURL (QR link)', '連携 (Linked)', 'グループで送る文 (Send in group)',
    'グループへの通知の言語 (Group language)', 'お客様への通知の言語 (Customer language)',
    '作るグループ名 (Group name)', 'シール枚数 (Stickers)', 'シール最終日 (Last sticker)',
    'QRを読んだ人 (Scanned)', '予約画面を開いた人 (Opened)', '予約 (Bookings)',
    '施工完了 (Done)', '売上 USD（お店の車も含む）(Sales)', '店の取り分 USD (Shop share)', 'SAMURAI USD', '取り分の率 (Rate %)',
    '実際のグループ名 (Actual group)', '連携日時 (Linked at)', 'あいさつ文 (Greeting)', 'shop_id'];
  headers.splice(2, 0, 'お金の流れ (Payment)');
  const widths = [36, 160, 230, 260, 90, 140, 240, 260, 230, 80, 100, 80, 90, 70, 70, 80, 90, 80, 70, 200, 130, 360, 220];
  const catNote = '分類は店マスター「' + BOARD_CATEGORY_COL + '」（プルダウン・空欄＝業種と提携の型から自動）。お金の流れは店ごとに「お金の流れ」列（提携種別・流入元タブで決まる）';
  try {
  scoutLinksWriteKindTab_(board, 'pShop', [
    '🚗 車屋提携（中古車販売・整備・ディーラー等・1時間ごとに自動更新・見るだけ） / Car dealer partners',
    'ふつうはお客様が店に定価を払い、店が紹介料ぶんを取る（店集金）。QRシール・グループの作り方は「🔗 提携店QR・グループ連携」タブ',
    catNote
  ], headers, renumber(byCat('車屋')), widths);
  } catch (e) { Logger.log('⚠️ 営業ボード 🚗 車屋提携タブ: ' + e); }
  try {
  scoutLinksWriteKindTab_(board, 'pFacility', [
    '🏢 商業施設提携（ゴルフ場・ホテル・商業ビル等・1時間ごとに自動更新・見るだけ） / Commercial facility partners',
    'お金の流れは施設ごとに違う（店集金 or 当社集金）→「お金の流れ」列を見る',
    catNote
  ], headers, renumber(byCat('商業施設')), widths);
  } catch (e) { Logger.log('⚠️ 営業ボード 🏢 商業施設提携タブ: ' + e); }
  try {
  scoutLinksWriteKindTab_(board, 'pResidence', [
    '🏠 レジデンス提携（マンション・コンド等・1時間ごとに自動更新・見るだけ） / Residence partners',
    'ふつうはお客様（住民）が当社に払う。特典・期間・言語は v7 Database「流入元」タブ、グループは店マスターの shop_id と Bot連携',
    catNote
  ], headers, renumber(byCat('レジデンス')), widths);
  } catch (e) { Logger.log('⚠️ 営業ボード 🏠 レジデンス提携タブ: ' + e); }
  try {
  scoutLinksWriteKindTab_(board, 'pRestaurant', [
    '🍽 飲食店提携（1時間ごとに自動更新・見るだけ） / Restaurant partners',
    'お客様は当社に直接払う。お店には紹介料（店マスター「紹介料率(%)」・空欄＝30%）を毎月はじめに ABA で。グループには予約の知らせと月次レポートだけ（写真なし）',
    '入力は v7 Database「店マスター」（提携種別=飲食店・紹介料率・グループへの通知の言語＝空欄なら英語＋クメール語）。チラシは Day1 tools/motors_restaurant_flyer（Bot からは送らない）',
    '「店の取り分 USD」の列＝紹介料の見込み（売上 × 紹介料率）',
    catNote
  ], headers, renumber(byCat('飲食店')), widths);
  } catch (e) { Logger.log('⚠️ 営業ボード 🍽 飲食店提携タブ: ' + e); }
}

/** 種類ごとのタブを1つ書く（見出しの説明＋表） */
function scoutLinksWriteKindTab_(board, key, notes, headers, rows, widths) {
  const sh = scoutBoardSheet_(board, key);
  sh.getRange(1, 1, notes.length, 1).setValues(notes.map(function(t) { return [t]; }));
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  const r0 = notes.length + 2;
  const n = scoutBoardTable_(sh, r0, headers, rows, widths, []);
  if (rows.length) {
    sh.getRange(r0 + 1, 1, rows.length, headers.length).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    sh.setRowHeightsForced(r0 + 1, rows.length, 24);
    sh.getRange(r0, 1, n, headers.length).createFilter();
  }
  sh.setFrozenRows(r0);
  sh.setFrozenColumns(2);
}

/** ファネルログ: 店QRの読み取り（bot_start / shop:<id>）と予約画面を開いたお客様 */
function scoutLinksFunnel_(ss) {
  const out = { scans: {}, opened: {} };
  const sh = ss.getSheetByName('ファネルログ');
  if (!sh || sh.getLastRow() < 2) return out;
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(String);
  const ci = head.indexOf('チャットID'), ei = head.indexOf('イベント'), si = head.indexOf('ソース');
  if (ci < 0 || ei < 0 || si < 0) return out;
  values.forEach(function(r) {
    const chat = String(r[ci] || '').trim(), ev = String(r[ei] || ''), src = String(r[si] || '');
    if (!chat) return;
    if (ev === 'bot_start' && src.indexOf('shop:') === 0) {
      const id = src.substring(5);
      (out.scans[id] = out.scans[id] || {})[chat] = true;
    } else if (ev === 'miniapp_opened') {
      out.opened[chat] = true;
    }
  });
  return out;
}

/**
 * 作業記録タブ: 現場アプリで提携店を選んだ「予約なし」の完了作業 → shop_id → [{amount, chat}]（2026-10-22）
 * 予約つきの作業は 予約タブ側（QRを読んだお客様の予約）で数えるので、二重に数えないよう除く
 * v2記録(JSON) は1セルが大きいので、使う列だけ読む
 */
function scoutLinksFieldJobs_(ss) {
  const out = {};
  const sh = ss.getSheetByName('作業記録');
  if (!sh || sh.getLastRow() < 2) return out;
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const n = sh.getLastRow() - 1;
  const col = function(name) {
    const i = head.indexOf(name);
    return i < 0 ? null : sh.getRange(2, i + 1, n, 1).getValues().map(function(r) { return r[0]; });
  };
  const shopCol = col('提携店ID'), stCol = col('作業状態');
  if (!shopCol || !stCol) return out;
  const bkCol = col('予約ID'), amtCol = col('料金(USD)'), payCol = col('支払区分'), chatCol = col('顧客チャットID');
  shopCol.forEach(function(v, k) {
    const id = String(v || '').trim();
    if (!id || (bkCol && String(bkCol[k] || '').trim()) || String(stCol[k] || '') !== '完了') return;
    if (payCol && String(payCol[k] || '') === 'free') return;   // 無料デモは売上に入れない
    (out[id] = out[id] || []).push({
      amount: amtCol ? (Number(amtCol[k]) || 0) : 0,
      chat: chatCol ? String(chatCol[k] || '').trim() : ''
    });
  });
  return out;
}

/** 予約タブ: チャットID → [{status, amount}] */
function scoutLinksBookings_(ss) {
  const out = {};
  const sh = ss.getSheetByName('予約');
  if (!sh || sh.getLastRow() < 2) return out;
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(String);
  const ci = head.indexOf('チャットID'), li = head.indexOf('進行状態'), ki = head.indexOf('料金(USD)');
  const ri = head.indexOf('紹介元shop_id');   // 2026-10-26〜 予約した時の紹介元（空 = 紹介なし・この列より前の予約）
  if (ci < 0 || li < 0) return out;
  values.forEach(function(r) {
    const chat = String(r[ci] || '').trim();
    if (!chat) return;
    (out[chat] = out[chat] || []).push({
      status: String(r[li] || ''), amount: ki >= 0 ? (Number(r[ki]) || 0) : 0,
      ref: ri >= 0 ? String(r[ri] || '').trim() : ''
    });
  });
  return out;
}
