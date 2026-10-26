/**
 * ShopGroupGreeting.gs — 店舗グループ連携時のあいさつ文 自動送信（2026-10-24）
 *
 * 【目的】/register で店舗グループを連携した直後に、お店向けのあいさつ文（クメール語＋英語）を
 *   予約Botから自動で送る。これまでは日本側が営業ボード「あいさつ文」列を手でコピペしていた。
 *   Daisuke「連携した時に、あいさつ文も Bot が自動で送るようにしてほしい。こんかいのも」
 *
 * 【送る経路】
 *   1. 即時: ShopRouting.gs handleShopGroupMessage_ の連携完了直後に sendShopGroupGreetingOnce_()
 *   2. 安全網: send24HoursFeedback（毎時）に相乗りした sendPendingShopGreetings()。
 *      連携から SHOP_GREETING_CATCHUP_DAYS 日以内で未送信の店にだけ送る（即時送信の失敗・この機能より前に連携した店の救済）
 *
 * 【送信済みの印】Script Properties `shop_greeting_sent_<shop_id>`（失うと二重送信になるため Cache ではなく永続側）
 *
 * 【文言】v7-operations/ScoutBoardShopLinks.gs の SCOUT_LINKS_GREETING_KM / _EN / _JA と同じ文（営業ボードと同じ形: 言語ごとに空行で区切る）。
 *   2026-10-26〜 店マスター「グループへの通知の言語」の順に並べる（標準 クメール語 → 英語 → 日本語・PartnerLang.gs）。
 *   別 GAS プロジェクトで共有できないため複製している。文言を直すときは両方を直すこと。
 *   クメール語は Panha 校閲（provisional・Run Kosal 確認待ち）
 */

var SHOP_GREETING_KM =
  'នេះជាក្រុមរបស់ {shop} និង SAMURAI MOTORS។\n' +
  'សម្រាប់ភ្ញៀវដែលកក់តាម QR របស់ហាងអ្នក យើងនឹងផ្ញើសារពេលចាប់ផ្តើម និងបញ្ចប់ការលាងសម្អាត ព្រមទាំងរូបថត មុន / ក្រោយ មកក្រុមនេះ។\n' +
  'នៅដើមខែនីមួយៗ យើងនឹងផ្ញើរបាយការណ៍ប្រចាំខែ ដែលបង្ហាញចំនួនការងារ និងចំនួនទឹកប្រាក់ ផងដែរ។\n' +
  'សូមអរគុណដែលសហការជាមួយយើង ហើយសូមបន្តដើរជាមួយគ្នា!';
var SHOP_GREETING_EN =
  'This is the group for {shop} × SAMURAI MOTORS.\n' +
  'For customers who book through your shop\'s QR, you\'ll see start and finish updates and Before/After photos here.\n' +
  'At the start of each month, we\'ll also send a monthly report with the number of jobs and the amounts.\n' +
  'Thank you for working with us. We look forward to a great partnership!';

// 2026-10-26 新設（日本語）
var SHOP_GREETING_JA =
  '{shop} × SAMURAI MOTORS のグループです。\n' +
  'お店の QR からご予約いただいたお客様について、作業の開始と完了、作業前後の写真をこのグループでお知らせします。\n' +
  '毎月はじめに、件数と金額をまとめた月次レポートもお送りします。\n' +
  'ご協力ありがとうございます。これからもよろしくお願いします！';

var SHOP_GREETING_PROP_PREFIX = 'shop_greeting_sent_';
// 安全網で拾う範囲（これより前に連携した店には送らない。City Golf 等の既存グループに今さら送らないため）
var SHOP_GREETING_CATCHUP_DAYS = 7;

/**
 * あいさつ文の本文（店マスター「グループへの通知の言語」の順に、言語ごとに空行で区切る）。流入元（レジデンス等）の提携先は専用の英語文（SourceGroupNotify.gs・2026-10-26）、
 * 個人提携は日本語＋英語の専用文（IndividualPartner.gs・2026-10-26）
 */
function buildShopGroupGreeting_(shopName, shopId) {
  if (shopId && typeof isSourcePartnerShop_ === 'function' && isSourcePartnerShop_(shopId)) {
    return buildSourceGroupGreeting_(shopName);
  }
  // 個人提携は日本語＋英語の専用文（IndividualPartner.gs・2026-10-26）
  var indiv = (shopId && typeof individualPartnerInfo_ === 'function') ? individualPartnerInfo_(shopId) : null;
  if (indiv) return buildIndividualGroupGreeting_(String(shopName || '').trim() || indiv.name, indiv.rate);
  var name = String(shopName || '').trim() || 'your shop';
  // 置換は関数で渡す（店名に $& 等が入っても特殊展開しない）
  var fill = function() { return name; };
  var texts = { km: SHOP_GREETING_KM, en: SHOP_GREETING_EN, ja: SHOP_GREETING_JA };
  return langLines_(shopGroupLangs_(shopId), texts).map(function(t) { return t.replace(/\{shop\}/g, fill); }).join('\n\n');
}

/**
 * 未送信なら1回だけあいさつ文を送り、送信済みの印を付ける。
 * @return {boolean} 今回送った、または送信済みだった場合 true
 */
function sendShopGroupGreetingOnce_(shopId, groupChatId, shopName) {
  if (!shopId || !groupChatId) return false;
  var props = PropertiesService.getScriptProperties();
  var key = SHOP_GREETING_PROP_PREFIX + shopId;
  if (props.getProperty(key)) return true;
  // 流入元タブが読めず、レジデンス等の提携先か判定できない時は送らない（車屋用の文を一度送ると戻せない。毎時の安全網が再試行）
  if (typeof sourcePartnerState_ === 'function' && sourcePartnerState_(shopId) === null) {
    Logger.log('⚠️ あいさつ文 保留（流入元タブを読めない）: ' + shopId);
    return false;
  }
  // 店マスターが読めず個人提携か判定できない時も送らない（IndividualPartner.gs・2026-10-26）
  if (typeof individualPartnerState_ === 'function' && individualPartnerState_(shopId) === null) {
    Logger.log('⚠️ あいさつ文 保留（店マスターを読めない）: ' + shopId);
    return false;
  }

  // 即時送信と毎時の安全網が重なっても二重に送らないよう「確認→送信→印」をロックで囲む。取れなければ次回の安全網に任せる
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    Logger.log('⚠️ あいさつ文 lock 取得失敗（次回の安全網で再試行）: ' + shopId);
    return false;
  }
  try {
    if (props.getProperty(key)) return true;
    var res = sendMessage(BOT_TYPE.BOOKING, groupChatId, buildShopGroupGreeting_(shopName, shopId));
    if (!(res && res.ok)) {
      Logger.log('⚠️ あいさつ文 送信失敗: ' + shopId + ' ' + JSON.stringify(res));
      return false;
    }
    props.setProperty(key, Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss'));
    Logger.log('👋 あいさつ文 送信: ' + shopId + ' → ' + groupChatId);
    return true;
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

/**
 * 安全網（毎時・send24HoursFeedback 相乗り）: 最近連携した店で、あいさつ文が未送信のものに送る
 * @return {number} 今回送った件数
 */
function sendPendingShopGreetings() {
  var rows = readShopLinks_();
  var props = PropertiesService.getScriptProperties();
  var since = new Date().getTime() - SHOP_GREETING_CATCHUP_DAYS * 24 * 60 * 60 * 1000;
  var sent = 0;
  rows.forEach(function(r) {
    var o = r.obj;
    if (String(o['状態'] || '') !== '連携済') return;
    var shopId = String(o['shop_id'] || '');
    var groupChatId = String(o['グループchat_id'] || '');
    if (!shopId || !groupChatId) return;
    if (props.getProperty(SHOP_GREETING_PROP_PREFIX + shopId)) return;
    var linkedAt = parseShopLinkedAt_(o['紐付け日時']);
    if (!linkedAt || linkedAt.getTime() < since) return;
    if (sendShopGroupGreetingOnce_(shopId, groupChatId, o['店名'])) sent++;
  });
  if (sent > 0) Logger.log('👋 sendPendingShopGreetings: ' + sent + '件送信');
  return sent;
}

/**
 * 紐付け日時（シートの Date / キャッシュ経由の ISO 文字列 / 'yyyy-MM-dd HH:mm:ss'（プノンペン時刻））を Date に
 */
function parseShopLinkedAt_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var s = String(v).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    // プノンペン（UTC+7）の壁時計として解釈
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5], +(m[6] || 0)));
  }
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
