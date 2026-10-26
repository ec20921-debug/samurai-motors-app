/**
 * IndividualPartner.gs — 個人提携（紹介者が個人の提携先）（2026-10-26・第1号 Hiro Sato さん）
 *
 * 【目的】Daisuke「お店、車屋提携、個人提携みたいな感じがこれからも増えていく」。
 *   個人の紹介者は、車屋（店集金・ShopRouting.gs）ともレジデンス等の流入元（SourceGroupNotify.gs）とも扱いが違う:
 *   - 紹介されたお客様は当社に直接払う（当社の決済QR・支払いのご案内は通常どおり）→ getValidShopRef_ が '' を返す
 *   - 紹介者のグループには「予約が入った」だけを日本語＋英語で送る。作業の開始・完了と写真・請求は送らない
 *   - 紹介料は、月初に v7-operations/IndividualPartnerOps.gs が完了・清算済みの予約から台帳へ記帳し、
 *     月次レポート（日本語＋英語）をグループへ送る → 紹介料は ABA で支払う
 *   - 紹介者本人の利用も紹介料の対象（Daisuke 2026-10-26）。全体キャンペーンは提携店と同じく対象外（紹介料と重なるため）
 *   決定ログ: Vault/01_Personal/Decisions/2026-10-26-motors-individual-partner-type.md
 *
 * 【設定】v7 Database「店マスター」の「提携種別」列が「個人提携」の行。紹介料率は「紹介料率(%)」（空欄=30）。
 *   店QR（t.me/<予約Bot>?start=shop_<shop_id>）・Bot連携（/register）・グループ名は車屋と同じ仕組みを使う
 *
 * 【読めない時】店マスターを読めず個人提携か分からない時（individualPartnerState_ = null）は、
 *   決済は店扱い（当社QRを送らない＝取り消せない二重請求を避ける側）、写真・あいさつ文・請求は送らない側に倒す。
 *   最後に読めた内容（6時間）があればそれを使う
 *
 * 【呼び出し元】ShopRouting.gs（getValidShopRef_・/register・/start shop_・店グループへの同報・現場アプリの店の選択肢）/
 *   BookingLogic.gs（予約の記録・予約の通知）/ BookingBot.gs（歓迎文）/ ShopGroupGreeting.gs / ShopInvoice.gs
 */

var INDIVIDUAL_PARTNER_KIND = '個人提携';   // v7-operations/IndividualPartnerOps.gs と同じ値（別 GAS プロジェクトのため複製）
var PARTNER_KIND_COL = '提携種別';
var PARTNER_KIND_CACHE_KEY = 'shop_partner_kinds_v1';
var PARTNER_KIND_CACHE_SEC = 300;
var PARTNER_KIND_LKG_KEY = 'shop_partner_kinds_lkg_v1';
var PARTNER_KIND_LKG_SEC = 6 * 60 * 60;
var __partnerKindMemo_ = null;
var __partnerKindFresh_ = false;   // この実行で読み直し済み（無い shop_id のたびにシートを読み直さない）
var __partnerKindReadFailed_ = false;   // この実行の読み直しが失敗し、最後に読めた内容で動いている

// お客様向けの一言（歓迎文。英語は下の individualWelcomeReferralLine_）。
// クメール語は Panha 校閲（2026-10-26・provisional・Run Kosal 確認待ち: ប្រាប់…អំពី の自然さ／សេវា＝選んだメニュー／ប្រភេទរថយន្ត／否定の括弧）
var INDIVIDUAL_WELCOME_KM = '📅 ពេលអ្នកកក់ យើងនឹងប្រាប់ {name} អំពីថ្ងៃ ម៉ោង សេវា និងប្រភេទរថយន្ត ផងដែរ (មិនផ្ញើឈ្មោះ ស្លាកលេខ ឬរូបថតទេ)។';

// ====== 判定 ======

/**
 * 店マスター → { shop_id: { name, rate } | 0 }（個人提携だけ中身あり。全店の shop_id を持つ）。5分キャッシュ。
 * 読めない時は最後に読めた内容（6時間）、それも無ければ null
 * @param {boolean} [fresh] - キャッシュを使わず読み直す
 */
function readPartnerKinds_(fresh) {
  if (__partnerKindMemo_ && !fresh) return __partnerKindMemo_;
  var cache = CacheService.getScriptCache();
  if (!fresh) {
    try {
      var hit = cache.get(PARTNER_KIND_CACHE_KEY);
      if (hit) return (__partnerKindMemo_ = JSON.parse(hit));
    } catch (ignore) {}
  }
  __partnerKindFresh_ = true;
  try {
    var sh = getSpreadsheet().getSheetByName('店マスター');
    if (!sh) throw new Error('店マスター タブがありません');
    var map = {};
    if (sh.getLastRow() >= 2) {
      var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function(h) { return String(h).trim(); });
      var ci = head.indexOf('shop_id'), ni = head.indexOf('店名'), ki = head.indexOf(PARTNER_KIND_COL), ri = head.indexOf('紹介料率(%)');
      if (ci < 0) throw new Error('店マスターに shop_id 列がありません');
      // 列が無い・見出しが違う時に「全員が車屋」と決めつけない（決済QR・写真の向きが逆になる）→ 分からない扱い
      if (ki < 0) throw new Error('店マスターに「' + PARTNER_KIND_COL + '」列がありません');
      sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(ci, ni, ki, ri) + 1).getValues().forEach(function(r) {
        var id = String(r[ci] || '').trim();
        if (!id) return;
        var indiv = String(r[ki] || '').trim() === INDIVIDUAL_PARTNER_KIND;
        map[id] = indiv ? {
          name: (ni >= 0 ? String(r[ni] || '').trim() : '') || id,
          rate: (ri >= 0 && typeof fieldParseRate_ === 'function') ? fieldParseRate_(r[ri]) : 30
        } : 0;
      });
    }
    var json = JSON.stringify(map);
    try {
      cache.put(PARTNER_KIND_CACHE_KEY, json, PARTNER_KIND_CACHE_SEC);
      cache.put(PARTNER_KIND_LKG_KEY, json, PARTNER_KIND_LKG_SEC);
    } catch (ignore) {}
    __partnerKindReadFailed_ = false;
    return (__partnerKindMemo_ = map);
  } catch (err) {
    Logger.log('⚠️ 提携種別の読み取り失敗: ' + err);
    __partnerKindReadFailed_ = true;
    try {
      var lkg = cache.get(PARTNER_KIND_LKG_KEY);
      if (lkg) return (__partnerKindMemo_ = JSON.parse(lkg));
    } catch (ignore) {}
    return null;
  }
}

/**
 * 個人提携か: true / false / null（店マスターを読めず分からない）
 * キャッシュに無い shop_id（キャッシュの後に登録された店）は1回だけ読み直す。
 * 読み直しに失敗して最後に読めた内容にも無い時は null（登録直後の店を「車屋」と決めつけない）
 */
function individualPartnerState_(shopId) {
  var id = String(shopId || '').trim();
  if (!id) return false;
  var has = function(m) { return Object.prototype.hasOwnProperty.call(m, id); };
  var map = readPartnerKinds_();
  if (map && !has(map) && !__partnerKindFresh_) map = readPartnerKinds_(true);
  if (!map) return null;
  if (!has(map)) return __partnerKindReadFailed_ ? null : false;
  return !!map[id];
}

/** 個人提携と確かに分かる時だけ true（読めない時は false） */
function isIndividualPartnerShop_(shopId) {
  return individualPartnerState_(shopId) === true;
}

/** 個人提携の { name, rate }。個人提携でない・分からない時は null */
function individualPartnerInfo_(shopId) {
  if (!isIndividualPartnerShop_(shopId)) return null;
  return readPartnerKinds_()[String(shopId).trim()] || null;
}

/** そのお客様の紹介元が個人提携なら shop_id、そうでなければ ''（手動ジョブの売上行に紹介元を残す・ManualSales.gs） */
function individualReferralFor_(chatId) {
  try {
    var ref = (chatId && typeof getReferralPartnerRef_ === 'function') ? getReferralPartnerRef_(chatId) : '';
    return (ref && isIndividualPartnerShop_(ref)) ? ref : '';
  } catch (err) {
    Logger.log('⚠️ individualReferralFor_: ' + err);
    return '';
  }
}

// ====== 管理グループへの知らせ（1時間・6時間に1回） ======

function warnOncePer_(key, sec, text) {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get(key)) return;
    cache.put(key, '1', sec);
    sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId, text);
  } catch (err) {
    Logger.log('⚠️ warnOncePer_(' + key + '): ' + err);
  }
}

/** 店マスターが読めず個人提携か分からないため止めた（決済QR・提携先グループへの写真など） */
function warnPartnerKindUnknown_(what) {
  warnOncePer_('warn_partner_kind_unknown', 60 * 60,
    '⚠️ 店マスターの「' + PARTNER_KIND_COL + '」が読めず、個人提携か判定できません（' + what + '）。\n' +
    '安全のため、提携店QRのお客様への当社の決済QRと、提携先グループへの写真・あいさつ文を止めています。\n' +
    '店マスターを直したあと、止めた決済QRは retryPaymentQR("<予約ID>") で送れます（1時間に1回だけ知らせます）');
}

/** 予約タブに「紹介元shop_id」列が無い（紹介元が予約に残らず、個人提携の紹介料が集計されない） */
function warnIfReferralColumnMissing_() {
  try {
    if (getHeaderMap(SHEET_NAMES.BOOKINGS)['紹介元shop_id']) return;
  } catch (err) {
    Logger.log('⚠️ warnIfReferralColumnMissing_: ' + err);
    return;
  }
  warnOncePer_('warn_referral_col_missing', 6 * 60 * 60,
    '⚠️ 予約タブに「紹介元shop_id」列がありません。提携先の紹介元が予約に記録されず、個人提携の紹介料が集計されません。\n' +
    '予約タブの末尾に「紹介元shop_id」列を追加してください（6時間に1回だけ知らせます）');
}

// ====== 紹介者のグループへの通知（予約が入った時だけ） ======

var INDIVIDUAL_DAYS_JA_ = ['日', '月', '火', '水', '木', '金', '土'];

/** '2026-10-27' → '10/27(火)'（読めなければそのまま） */
function individualDateJa_(ymd) {
  var s = String(ymd || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var d = parseDateTimePhnomPenh(s, 12, 0);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '(' + INDIVIDUAL_DAYS_JA_[d.getUTCDay()] + ')';
}

/**
 * 予約が入った（createBooking がロックを外したあと）。グループ未連携なら何もしない（人だけのグループの間など）。
 * お客様の名前・ナンバー・場所は載せない（Daisuke 2026-10-26: Picasso と同じ方針）
 * @param {string} shopId - 個人提携の shop_id
 * @param {Object} info - { bookingId, plan, options, vehicleType, carModel, date, startTime, endTime }
 * @return {boolean} 送れたか
 */
function notifyIndividualPartnerBooking_(shopId, info) {
  try {
    if (!shopId || !info || !info.bookingId) return false;
    var link = findShopLinkByShopId_(shopId);
    var chatId = (link && String(link.obj['状態']) === '連携済') ? String(link.obj['グループchat_id'] || '') : '';
    if (!chatId) return false;
    var services = [];
    if (info.plan) services.push(info.plan.name || info.plan.planFull || 'SAMURAI WASH');
    (info.options || []).forEach(function(l) {
      if (l && l.opt) services.push(optionDisplayName_(l.opt));
    });
    var car = [info.carModel, sourceGroupVehicleEn_(info.vehicleType)].filter(Boolean).join(' / ');
    var lines = [
      '📅 ご予約が入りました（ご紹介）/ New booking from your referral',
      '🗓 ' + individualDateJa_(info.date) + ' ' + info.startTime + '–' + info.endTime + '（' + sourceGroupDate_(info.date) + '）',
      '🚗 ' + (car || '-'),
      '🧽 ' + (services.join(' + ') || '-')
    ];
    var res = sendMessage(BOT_TYPE.BOOKING, chatId, lines.join('\n'));
    if (!(res && res.ok)) {
      warnSourceGroupFailed_(link, '予約 ' + info.bookingId, res);
      return false;
    }
    return true;
  } catch (err) {
    Logger.log('⚠️ notifyIndividualPartnerBooking_: ' + err);
    return false;
  }
}

// ====== 文面 ======

/**
 * 紹介者のグループのあいさつ文（日本語＋英語・連携直後に1回）。
 * v7-operations/IndividualPartnerOps.gs individualGroupGreetingText_（営業ボードの表示）と同じ文。直すときは両方を直す
 */
function buildIndividualGroupGreeting_(name, rate) {
  var n = String(name || '').trim() || 'Partner';
  var pct = (Number(rate) >= 0 ? Number(rate) : 30) + '%';
  return n + ' さん × SAMURAI MOTORS のグループです。\n' +
    'ご紹介いただいた方（' + n + ' さんご自身のご利用も含みます）からご予約が入ると、ここでお知らせします（日時・メニュー・車種。写真はお送りしません）。\n' +
    '毎月はじめに、前月の件数・金額・紹介料（' + pct + '）をまとめてお送りし、紹介料は ABA でお支払いします。\n' +
    'いつもありがとうございます。これからもよろしくお願いします！\n\n' +
    'This is the group for ' + n + ' × SAMURAI MOTORS.\n' +
    'When someone you referred books with us (including your own bookings), we\'ll let you know here — date, time, menu and car (no photos).\n' +
    'At the start of each month, we\'ll send a summary of last month\'s jobs, amounts and your commission (' + pct + '), and pay the commission by ABA.\n' +
    'Thank you for your support!';
}

/** /register の連携完了の返事（日本語＋英語） */
function individualConnectedText_(name) {
  return '✅ Connected! / 連携完了！\n' +
    'Partner: ' + name + '\n\n' +
    'When someone you referred books with us, you\'ll get a message here.\n' +
    'ご紹介いただいた方のご予約が、このグループに届くようになりました。';
}

/**
 * 紹介QRから来たお客様への歓迎文の一言（BookingBot.gs sendWelcomeMessage）。
 * 車屋向けの「写真はお店にも共有」は出さない（写真は送らない）。代わりに予約の内容が紹介者に伝わることを伝える
 */
function individualWelcomeReferralLine_(name) {
  var fill = function() { return name; };   // 名前に $& 等が入っても特殊展開しない
  return '🤝 Referred by ' + name + ' — thank you!\n' +
    (INDIVIDUAL_WELCOME_KM ? INDIVIDUAL_WELCOME_KM.replace(/\{name\}/g, fill) + '\n' : '') +
    '📅 When you book, we\'ll also let ' + name + ' know the date, time, menu and car type (no name, plate number or photos).\n\n';
}

/** 管理グループの新規予約通知に足す1行 */
function individualAdminLine_(name) {
  return '🙋 紹介: ' + name + '（個人提携・お支払いは当社へ・紹介料は月初に自動集計）\n';
}
