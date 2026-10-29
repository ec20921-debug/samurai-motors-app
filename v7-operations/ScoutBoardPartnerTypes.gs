/**
 * ScoutBoardPartnerTypes.gs — 営業ボード「📘 提携の型」タブ（2026-10-29）
 *
 * Daisuke「GSS にわかりやすく型もわかりやすく把握できるようにいれといて」「このGSSにいれてほしい」（営業ボード）
 * - 提携の型（車屋・飲食店・レジデンス/商業施設・個人）の選び方と違いを1枚にした、見るだけのタブ
 * - 中身の正本は suzuki-empire-day1 docs/MOTORS_PARTNER_TYPES.md。型を足す・変える時は md を直してからここも直す
 * - 店のデータは読まない（決まった文だけ）。中身を変えた時だけ書き直す（SCOUT_TYPES_VERSION を上げる＝毎時の更新を重くしない）
 */

const SCOUT_TYPES_TAB_KEY = 'types';
const SCOUT_TYPES_VERSION = '2026-10-29b';   // b: ① の「相手」「スキル」を2列分の幅に・提携のタブを並べ直す   // 下の文を変えたら上げる
const SCOUT_TYPES_PROP = 'SCOUT_BOARD_TYPES_VERSION';

const SCOUT_TYPES_TITLE = '📘 Samurai Motors 提携の型（4種類） / Partner types';
const SCOUT_TYPES_SUB = '新しい提携が決まったら、まず ① で型を選び、その型のスキルで立ち上げる。型で「お客様がだれに払うか」「グループに何が届くか」が変わる。' +
  '/register のあとは直しにくい（あいさつ文は1回きり）。正本 = Day1 docs/MOTORS_PARTNER_TYPES.md';

const SCOUT_TYPES_CHOOSE = [
  ['相手', '型', 'スキル（Claude に「〇〇と提携が決まった」と言えば動く）'],
  ['車を売る・直す店（中古車販売・整備工場・ディーラー・タイヤ店）、ゴルフ場など「お店が窓口」', '🚗 車屋提携', 'motors-dealer-partner'],
  ['レストラン・カフェ・パブなど飲食店（お客様はお食事中に施工・お金は当社に直接）', '🍽 飲食店提携', 'motors-restaurant-partner'],
  ['マンション・コンド・ホテル・オフィスビル（住民・利用者に案内してもらう・お金は当社に直接）', '🏠 レジデンス・商業施設提携', 'motors-residence-partner'],
  ['個人の紹介者（友達・知り合いに紹介してくれる人）', '🙋 個人提携', 'motors-individual-partner']
];

const SCOUT_TYPES_NAMES = ['🚗 車屋提携', '🍽 飲食店提携', '🏠 レジデンス・商業施設', '🙋 個人提携'];
const SCOUT_TYPES_FILLS = ['#e3eef9', '#fdebd3', '#e6f4ea', '#f3e8fd'];
const SCOUT_TYPES_COMPARE = [
  ['例（第1号）', 'PLP Auto World・RTN Auto Garage・LUXE Auto', 'PJ Restaurant（2026-10-29）', 'Picasso City Garden', 'Hiro Sato さん（PTN-011）'],
  ['お客様が払う先', 'お店（定価）', '当社（ABA）', '当社（ABA）', '当社（ABA）'],
  ['相手の取り分', '紹介料率（空欄＝30%）をお店がその場で確保。当社は残り70%を施工の時にその場で受け取る',
    '紹介料 30%（毎月はじめに前月分を ABA・10日まで）', 'なし（Picasso は払わない・2026-10-25）',
    '紹介料 30%（毎月はじめに ABA）。紹介割引と合わせて30%まで'],
  ['お客様の割引', 'なし（全体キャンペーンも付かない）', 'なし', '流入元タブで決める（Picasso 住民＝いつでも20%オフ・出張料なし）', '紹介割引（標準0%）。本人の予約は30%引き'],
  ['グループの言語（標準）', 'クメール語＋英語＋日本語', '英語＋クメール語', '英語（固定）', '英語＋クメール語'],
  ['グループに届くもの', '連携完了・あいさつ文・QRからの来店・作業の開始/完了と写真・請求（ABA QR）・月次レポート',
    '連携完了・あいさつ文・予約の知らせ（日時・メニュー・車種／名前・写真なし）・月次レポート（件数・金額・紹介料）',
    '連携完了・あいさつ文（英語）・予約が入った（日時・部屋番号・車種）・作業の開始/完了と写真。月次レポートなし',
    'はじめのご案内→チラシ6枚→紹介URL→本人登録リンク→登録のお礼・予約の知らせ・月次レポート'],
  ['QR', 'start=shop_<shop_id>（1店1つ）', 'start=shop_<shop_id>（1店1つ）', 'start=<流入元コード>（掲示物ごとに分ける）', 'start=shop_<shop_id>（QRの下に番号 PTN-xxx）'],
  ['店マスターでの見分け', '提携種別＝空欄（流入元タブに無い）', '提携種別＝飲食店', '流入元タブの shop_id にその店', '提携種別＝個人提携'],
  ['営業ボードのタブ（相手の種類）', '🚗 車屋提携（ゴルフ場・ホテル等は 🏢 商業施設提携）', '🍽 飲食店提携', '🏠 レジデンス提携（ホテル・商業ビルは 🏢）', '🙋 個人提携'],
  ['配る物', '定価メニュー表（QRシール枠）＋QRシール（営業アプリで印刷）', '飲食店チラシ（英語＋日本語／英語＋クメール語）', '専用チラシ・サイネージ・住民グループ投稿', '紹介チラシ6枚（番号入り・名前なし）']
];

const SCOUT_TYPES_COMMON = [
  '書くのは v7 Database「店マスター」だけ（大元）。グループのつながりは「Bot連携」（6桁コード・/register）。見るのはこの営業ボード（1時間ごとに作り直す）',
  '/register の前に確かめる3つ（あいさつ文は1回きり・取り消せない）: ①型が正しいか（レジデンスは流入元タブの shop_id を先に）②店名がお客様に見せてよい表記か（ラテン字・日本語の注記なし）③グループの言語（店マスター「グループへの通知の言語」・最大5分で効く）',
  '型（お金の流れ）と営業ボードのタブ（相手の種類）は別。タブは店マスター「営業ボードの分類」（空欄は業種と型から自動）。例: City Golf は型＝車屋（店集金）でタブは 🏢 商業施設、Picasso はタブ 🏠 レジデンス。各タブの「お金の流れ」列で型が分かる',
  '6桁の連携コードは秘密（そのグループでだけ使う）。チラシ・対外の文に書かない',
  'クメール語は必ず Panha の校閲を通す。対外の文は日本語の意訳を付けて Daisuke に見せる',
  '配る前に「開通テスト」: 初めて使う別の Telegram で QR → START → 返事を待って Booking',
  '対外への送付・印刷は Daisuke 本人'
];

/** 「📘 提携の型」タブを書く（初めての時は 🔗 タブのすぐ右に作る） */
function scoutBoardWritePartnerTypes_(board) {
  const name = SCOUT_BOARD_TABS[SCOUT_TYPES_TAB_KEY];
  const props = PropertiesService.getScriptProperties();
  if (board.getSheetByName(name) && props.getProperty(SCOUT_TYPES_PROP) === SCOUT_TYPES_VERSION) return;
  if (!board.getSheetByName(name)) {
    const links = board.getSheetByName(SCOUT_BOARD_TABS[SCOUT_LINKS_TAB_KEY]);
    if (links) board.insertSheet(name, links.getIndex()); else board.insertSheet(name);
  }
  const sh = scoutBoardSheet_(board, SCOUT_TYPES_TAB_KEY);
  const W = 5;
  sh.getRange(1, 1, sh.getMaxRows(), W).breakApart();   // 前の版の結合を外してから書く
  const pad = function(row) { const r = row.slice(); while (r.length < W) r.push(''); return r; };

  // [行の中身, 行の種類] の順に並べてから1回で書く（種類で見た目を決める）
  const lines = [];
  lines.push([pad([SCOUT_TYPES_TITLE]), 'title']);
  lines.push([pad([SCOUT_TYPES_SUB]), 'note']);
  lines.push([pad(['']), 'blank']);
  lines.push([pad(['① 型の選び方 / How to choose']), 'section']);
  SCOUT_TYPES_CHOOSE.forEach(function(r, i) { lines.push([pad([r[0], '', r[1], r[2]]), i ? 'choose' : 'head']); });
  lines.push([pad(['']), 'blank']);
  lines.push([pad(['② 4つの型の違い / Differences']), 'section']);
  lines.push([[''].concat(SCOUT_TYPES_NAMES), 'typeHead']);
  SCOUT_TYPES_COMPARE.forEach(function(r) { lines.push([r, r[0] === 'お客様が払う先' ? 'pay' : 'compare']); });
  lines.push([pad(['']), 'blank']);
  lines.push([pad(['③ どの型でも共通 / Common rules']), 'section']);
  SCOUT_TYPES_COMMON.forEach(function(t) { lines.push([pad(['・' + t]), 'note']); });

  sh.getRange(1, 1, lines.length, W).setValues(lines.map(function(l) { return l[0]; }))
    .setVerticalAlignment('top').setWrapStrategy(SpreadsheetApp.WrapStrategy.OVERFLOW);
  [200, 260, 260, 260, 260].forEach(function(w, i) { sh.setColumnWidth(i + 1, w); });

  lines.forEach(function(l, i) {
    const row = i + 1, kind = l[1];
    const all = sh.getRange(row, 1, 1, W);
    if (kind === 'title') sh.getRange(row, 1).setFontSize(16).setFontWeight('bold').setFontColor('#b98a2c');
    else if (kind === 'note') sh.getRange(row, 1).setFontColor('#555555');
    else if (kind === 'section') sh.getRange(row, 1).setFontSize(12).setFontWeight('bold');
    else if (kind === 'head') all.setFontWeight('bold').setBackground(SCOUT_BOARD_HEAD_BG).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
    if (kind === 'head' || kind === 'choose') {   // 「相手」は A:B・「スキル」は D:E の幅で読めるように
      sh.getRange(row, 1, 1, 2).merge();
      sh.getRange(row, 4, 1, 2).merge();
    }
    if (kind === 'choose') {
      all.setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
      sh.getRange(row, 3).setFontWeight('bold').setBackground(SCOUT_TYPES_FILLS[(i - 5) % SCOUT_TYPES_FILLS.length]);
    } else if (kind === 'typeHead') {
      sh.getRange(row, 1).setBackground(SCOUT_BOARD_HEAD_BG);
      SCOUT_TYPES_FILLS.forEach(function(c, j) { sh.getRange(row, j + 2).setBackground(c).setFontWeight('bold').setFontSize(11); });
    } else if (kind === 'compare' || kind === 'pay') {
      all.setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
      sh.getRange(row, 1).setFontWeight('bold').setBackground(SCOUT_BOARD_HEAD_BG);
      if (kind === 'pay') {
        for (let j = 2; j <= W; j++) {
          const v = String(l[0][j - 1]);
          sh.getRange(row, j).setFontWeight('bold').setFontColor(v.indexOf('お店') === 0 ? '#b0121f' : '#1e6b35');
        }
      }
    }
  });
  sh.setFrozenRows(1);
  try { scoutBoardOrderPartnerTabs_(board); } catch (e) { Logger.log('⚠️ 営業ボード タブの並べ直し: ' + e); }
  props.setProperty(SCOUT_TYPES_PROP, SCOUT_TYPES_VERSION);
}

/** 提携のタブを 🔗 → 📘 → 🚗 → 🏢 → 🏠 → 🍽 → 🙋 の順に左から並べる（版を上げた時だけ・後から足したタブがばらばらに並ぶため） */
function scoutBoardOrderPartnerTabs_(board) {
  let pos = 1;
  [SCOUT_LINKS_TAB_KEY, SCOUT_TYPES_TAB_KEY, 'pShop', 'pFacility', 'pResidence', 'pRestaurant', 'pIndiv'].forEach(function(k) {
    const sh = board.getSheetByName(SCOUT_BOARD_TABS[k]);
    if (!sh) return;
    board.setActiveSheet(sh);
    board.moveActiveSheet(pos++);
  });
  const first = board.getSheetByName(SCOUT_BOARD_TABS[SCOUT_LINKS_TAB_KEY]);
  if (first) board.setActiveSheet(first);
}
