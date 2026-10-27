/**
 * IndividualPartner.gs — 個人提携（紹介者が個人の提携先）（2026-10-26・第1号 Hiro Sato さん）
 *
 * 【目的】Daisuke「お店、車屋提携、個人提携みたいな感じがこれからも増えていく」。
 *   個人の紹介者は、車屋（店集金・ShopRouting.gs）ともレジデンス等の流入元（SourceGroupNotify.gs）とも扱いが違う:
 *   - 紹介されたお客様は当社に直接払う（当社の決済QR・支払いのご案内は通常どおり）→ getValidShopRef_ が '' を返す
 *   - 紹介者のグループには「予約が入った」だけを送る（日本語が標準・2026-10-27〜。店マスター「グループへの通知の言語」で英語にも）。作業の開始・完了と写真・請求は送らない
 *   - 紹介料は、月初に v7-operations/IndividualPartnerOps.gs が完了・清算済みの予約から台帳へ記帳し、
 *     月次レポート（グループの言語）をグループへ送る → 紹介料は ABA で支払う
 *   - 紹介者本人の利用: 2026-10-26 は紹介料の対象 → 2026-10-27 Daisuke「本人の予約は予約の時に30%引き・紹介料なし。
 *     紹介した友達の予約は、あとでまとめて30%バック」に変更（店マスター「本人chat_id」に登録した時。未登録の間は
 *     従来どおり紹介料・ReferralAttribution.gs ⑦）。全体キャンペーンは提携店と同じく対象外（紹介料と重なるため）
 *   決定ログ: Vault/01_Personal/Decisions/2026-10-26-motors-individual-partner-type.md
 *
 * 【設定】v7 Database「店マスター」の「提携種別」列が「個人提携」の行。紹介料率は「紹介料率(%)」（空欄=30）。
 *   紹介されたお客様への割引は「紹介割引率(%)」（空欄=0・合計30%まで・配分の設定 2026-10-27 ReferralAttribution.gs）。
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
var REFERRAL_DISCOUNT_COL = '紹介割引率(%)';   // 店マスター（個人提携だけ使う・ReferralAttribution.gs）
var PARTNER_SELF_CHAT_COL = '本人chat_id';   // 店マスター: 紹介者ご本人の Telegram chat_id（本人の予約は予約の時に割引・紹介料なし・ReferralAttribution.gs）
var BOOKING_REFERRAL_RATE_COL = '紹介料率(%)';   // 予約タブ: 予約した時の紹介料率の写し（v7-operations/IndividualPartnerOps.gs が記帳に使う）
var PARTNER_KIND_CACHE_KEY = 'shop_partner_kinds_v1';   // 2026-10-27 に discount を足した。古い中身（discount 無し）は割引0として読む（鍵は変えない＝最後に読めた内容を空にしない）
var PARTNER_KIND_CACHE_SEC = 300;
var PARTNER_KIND_LKG_KEY = 'shop_partner_kinds_lkg_v1';
var PARTNER_KIND_LKG_SEC = 6 * 60 * 60;
var __partnerKindMemo_ = null;
var __partnerKindFresh_ = false;   // この実行で読み直し済み（無い shop_id のたびにシートを読み直さない）
var __partnerKindReadFailed_ = false;   // この実行の読み直しが失敗し、最後に読めた内容で動いている

// お客様向けの一言（歓迎文。英語は下の individualWelcomeReferralLine_）。
// クメール語は Panha 校閲（2026-10-26・provisional・Run Kosal 確認待ち: ប្រាប់…អំពី の自然さ／សេវា＝選んだメニュー／ប្រភេទរថយន្ត／否定の括弧）
var INDIVIDUAL_WELCOME_KM = '📅 ពេលអ្នកកក់ យើងនឹងប្រាប់ {name} អំពីថ្ងៃ ម៉ោង សេវា និងប្រភេទរថយន្ត ផងដែរ (មិនផ្ញើឈ្មោះ ស្លាកលេខ ឬរូបថតទេ)។';
// 紹介割引の一言（{pct} に数字・英語は individualWelcomeReferralLine_）。空なら英語だけ（2026-10-27）
// クメール語は Panha 校閲（2026-10-27・provisional 44/50・Run Kosal 確認待ち: ភ្ញៀវដែលគេណែនាំមក の自然さ／សេវាទាំងអស់ と គ្រប់សេវា／数字は半角）
var INDIVIDUAL_DISCOUNT_KM = '🎁 បញ្ចុះតម្លៃ {pct}% លើសេវាទាំងអស់ សម្រាប់ភ្ញៀវដែលគេណែនាំមក';

// ====== 判定 ======

/**
 * 店マスター → { shop_id: { name, rate, discount, selfChat } | 0 }（個人提携だけ中身あり。全店の shop_id を持つ）。5分キャッシュ。
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
      var di = head.indexOf(REFERRAL_DISCOUNT_COL);   // 無い時は割引 0（従来どおり）
      var si = head.indexOf(PARTNER_SELF_CHAT_COL);   // 無い時は本人割引なし（従来どおり）
      if (ci < 0) throw new Error('店マスターに shop_id 列がありません');
      // 列が無い・見出しが違う時に「全員が車屋」と決めつけない（決済QR・写真の向きが逆になる）→ 分からない扱い
      if (ki < 0) throw new Error('店マスターに「' + PARTNER_KIND_COL + '」列がありません');
      sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(ci, ni, ki, ri, di, si) + 1).getValues().forEach(function(r) {
        var id = String(r[ci] || '').trim();
        if (!id) return;
        var indiv = String(r[ki] || '').trim() === INDIVIDUAL_PARTNER_KIND;
        map[id] = indiv ? {
          name: (ni >= 0 ? String(r[ni] || '').trim() : '') || id,
          rate: (ri >= 0 && typeof fieldParseRate_ === 'function') ? fieldParseRate_(r[ri]) : 30,
          discount: (di >= 0 && typeof referralParseDiscount_ === 'function') ? referralParseDiscount_(r[di]) : 0,
          selfChat: si >= 0 ? String(r[si] || '').trim() : ''
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

/** 個人提携の { name, rate, discount }（discount は店マスターの値そのまま。実際に使う割引は effectiveReferralDiscount_）。個人提携でない・分からない時は null */
function individualPartnerInfo_(shopId) {
  if (!isIndividualPartnerShop_(shopId)) return null;
  return readPartnerKinds_()[String(shopId).trim()] || null;
}

/**
 * 店マスター「本人chat_id」がこの chat_id の個人提携 → { shopId, name, rate, discount }。無い・分からない時は null。
 * 停止中・店マスターから消えた紹介者は対象外（validPartnerShopId_）
 */
function individualPartnerSelfFor_(chatId) {
  var id = String(chatId || '').trim();
  if (!id) return null;
  var map = readPartnerKinds_();
  if (!map) return null;
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    var p = map[keys[i]];
    if (!p || String(p.selfChat || '') !== id) continue;
    if (typeof validPartnerShopId_ === 'function' && !validPartnerShopId_(keys[i])) continue;   // 停止中の紹介者は対象外（ほかの行も見る）
    return { shopId: keys[i], name: p.name, rate: p.rate, discount: p.discount || 0 };
  }
  return null;
}

/**
 * そのお客様の紹介元が個人提携なら shop_id、そうでなければ ''（手動ジョブの売上行に紹介元を残す・ManualSales.gs）。
 * 紹介者ご本人（本人割引の対象）は '' ＝本人の利用に紹介料は付けない（2026-10-27 Daisuke）
 */
function individualReferralFor_(chatId) {
  try {
    // 手動ジョブの紐付けた chat_id は現場の記録（画面の申告ではない）ので、同じ値を確かめ済みとして渡す
    if (typeof selfPartnerDiscount_ === 'function' && selfPartnerDiscount_(chatId, chatId)) return '';
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

/**
 * 予約タブに「紹介元shop_id」列が無い（紹介元が予約に残らず、個人提携の紹介料が集計されない）。
 * 個人提携の予約では「紹介料率(%)」列（予約した時の率の写し・2026-10-27）も確かめる（無いと月初の記帳は店マスターのその時の率になる）
 * @param {boolean} [withRate] - 「紹介料率(%)」列も確かめる
 */
function warnIfReferralColumnMissing_(withRate) {
  var h;
  try {
    h = getHeaderMap(SHEET_NAMES.BOOKINGS);
  } catch (err) {
    Logger.log('⚠️ warnIfReferralColumnMissing_: ' + err);
    return;
  }
  if (!h['紹介元shop_id']) {
    warnOncePer_('warn_referral_col_missing', 6 * 60 * 60,
      '⚠️ 予約タブに「紹介元shop_id」列がありません。提携先の紹介元が予約に記録されず、個人提携の紹介料が集計されません。\n' +
      '予約タブの末尾に「紹介元shop_id」列を追加してください（6時間に1回だけ知らせます）');
  }
  if (withRate && !h[BOOKING_REFERRAL_RATE_COL]) {
    warnOncePer_('warn_referral_rate_col_missing', 6 * 60 * 60,
      '⚠️ 予約タブに「' + BOOKING_REFERRAL_RATE_COL + '」列がありません。予約した時の紹介料率が残らず、月初の記帳は店マスターのその時の率になります' +
      '（配分を月の途中で変えると、変える前の予約にも新しい率が付きます）。\n' +
      '予約タブの末尾に「' + BOOKING_REFERRAL_RATE_COL + '」列を追加してください（6時間に1回だけ知らせます）');
  }
}

// ====== 紹介者のグループの言語（2026-10-27） ======

// Daisuke 2026-10-27「基本的にはまず日本人向けの定型になると思うので、日本語でいいか。言語を変えてと言われたときに変えればいい」
//   → 個人提携のグループは日本語が標準。店マスター「グループへの通知の言語」に書けばその言語（日本語・英語。クメール語の文面は無い）
var INDIVIDUAL_LANG_DEFAULT = ['ja'];

/**
 * 個人提携のグループに出す言語（並び順どおり・'ja' / 'en'）。空欄・読めない時は日本語だけ
 * @param {boolean} [fresh] - 設定を読み直す（取り消せない1回きりの送信の前）
 */
function individualGroupLangs_(shopId, fresh) {
  try {
    var map = (typeof readShopGroupLangs_ === 'function') ? readShopGroupLangs_(fresh) : {};
    var v = (shopId && map && Object.prototype.hasOwnProperty.call(map, String(shopId))) ? map[String(shopId)] : '';
    var langs = ((typeof parsePartnerLangs_ === 'function' ? parsePartnerLangs_(v) : null) || [])
      .filter(function(l) { return l === 'ja' || l === 'en'; });
    return langs.length ? langs : INDIVIDUAL_LANG_DEFAULT.slice();
  } catch (err) {
    Logger.log('⚠️ individualGroupLangs_（日本語で送る）: ' + err);
    return INDIVIDUAL_LANG_DEFAULT.slice();
  }
}

/** { ja, en } を langs の順に、空行で区切ってつなぐ */
function individualText_(langs, texts) {
  return (langs || INDIVIDUAL_LANG_DEFAULT).map(function(l) { return texts[l]; }).filter(function(t) { return t; }).join('\n\n');
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
    var tail = '🚗 ' + (car || '-') + '\n🧽 ' + (services.join(' + ') || '-');
    // 日本語が標準（店マスター「グループへの通知の言語」で英語にも・2026-10-27）
    var text = individualText_(individualGroupLangs_(shopId), {
      ja: '📅 ご予約が入りました（ご紹介）\n🗓 ' + individualDateJa_(info.date) + ' ' + info.startTime + '–' + info.endTime + '\n' + tail,
      en: '📅 New booking from your referral\n🗓 ' + sourceGroupDate_(info.date) + ' ' + info.startTime + '–' + info.endTime + '\n' + tail
    });
    var res = sendMessage(BOT_TYPE.BOOKING, chatId, text);
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
 * 紹介者のグループの「はじめのご案内」（連携直後に1回・2026-10-27 刷新）。このあとチラシ・紹介URL・本人登録リンクが続く
 * （ShopGroupGreeting.gs sendShopGroupGreetingOnce_ → PartnerSelfRegister.gs）。
 * v7-operations/IndividualPartnerOps.gs individualGroupGreetingText_（営業ボードの表示）と同じ文。直すときは両方を直す
 * @param {Array<string>} [langs] - individualGroupLangs_（省略時は日本語）
 */
function buildIndividualGroupGreeting_(name, rate, discount, langs, selfDone) {
  var n = String(name || '').trim() || 'Partner';
  var pct = (Number(rate) >= 0 ? Number(rate) : 30) + '%';
  var off = Number(discount) > 0 ? Number(discount) + '%' : '';   // 紹介割引（配分の設定・2026-10-27）
  // ご本人の予約は予約の時に（紹介料率＋紹介割引）% 引き・紹介料なし（ReferralAttribution.gs ⑦）。率が 0 なら本人の登録の案内を出さない
  var selfPct = Math.min(30, (Number(rate) >= 0 ? Number(rate) : 30) + (Number(discount) > 0 ? Number(discount) : 0));
  var selfOff = selfPct + '%';
  var showSelf = selfPct > 0 && !selfDone;   // 本人登録済み（手入力など）なら登録の案内は出さず、割引だけ伝える
  return individualText_(langs, {
    ja: n + ' さん、SAMURAI MOTORS の紹介パートナーへようこそ！\nこのグループで、ご案内とお知らせをお送りします。\n\n' +
      (selfDone && selfPct > 0 ? '【ご本人のご予約】ご本人の登録は済んでいます。ご自身のご予約は、予約の時に ' + selfOff + ' 引きです。\n\n' : '') +
      (showSelf ? '【はじめに1回だけ】\n① ご本人の登録：このあと届く「🔑 本人登録リンク」を開いてください（「START」ボタンが出たら押してください）。' +
        'ご自身のご予約が、予約の時に ' + selfOff + ' 引きになります。\n\n' : '') +
      '【ご紹介のしかた】\n' + (showSelf ? '② ' : '') +
      'お友達には、このあと届く紹介用のチラシ・URL をお渡しください' + (showSelf ? '（本人登録リンクは渡さないでください）' : '') + '。\n' +
      (off ? '・ご紹介いただいた方は、全サービス ' + off + ' 引きでご利用いただけます\n' : '') +
      '・お友達のご予約が入ると、ここでお知らせします（日時・メニュー・車種。お名前や写真はお送りしません）\n' +
      '・毎月はじめに、前月の件数・金額・紹介料（' + pct + '）をまとめてお送りし、10日までに ABA でお支払いします\n\n' +
      'ご不明な点は、このグループでお気軽にどうぞ。よろしくお願いします！',
    en: 'Welcome to SAMURAI MOTORS, ' + n + '! We\'ll send updates in this group.\n\n' +
      (selfDone && selfPct > 0 ? '[Your own bookings] You are already registered. Your own bookings get ' + selfOff + ' off when you book.\n\n' : '') +
      (showSelf ? '[One-time setup]\n1. Register yourself: open the "🔑 Registration link" coming next (tap "START" if it appears). ' +
        'Your own bookings will get ' + selfOff + ' off when you book.\n\n' : '') +
      '[How to refer]\n' + (showSelf ? '2. ' : '') +
      'Share the referral flyers / URL coming next with your friends' + (showSelf ? ' (not the registration link)' : '') + '.\n' +
      (off ? '- People you refer get ' + off + ' off all services\n' : '') +
      '- When a friend books, we\'ll let you know here (date, time, menu and car — no names or photos)\n' +
      '- At the start of each month, we\'ll send last month\'s jobs, amounts and your commission (' + pct + '), and pay it by ABA by the 10th\n\n' +
      'Feel free to ask anything in this group. Thank you!'
  });
}

/** /register の連携完了の返事（日本語が標準・2026-10-27） */
function individualConnectedText_(name, langs) {
  return individualText_(langs, {
    ja: '✅ 連携完了！\n紹介パートナー: ' + name + '\nご紹介いただいた方のご予約が、このグループに届くようになりました。',
    en: '✅ Connected!\nPartner: ' + name + '\nWhen someone you referred books with us, you\'ll get a message here.'
  });
}

/**
 * 紹介QRから来たお客様への歓迎文の一言（BookingBot.gs sendWelcomeMessage）。
 * 車屋向けの「写真はお店にも共有」は出さない（写真は送らない）。代わりに予約の内容が紹介者に伝わることを伝える。
 * 紹介割引（配分の設定・2026-10-27）があれば、その一言も出す（クメール語は INDIVIDUAL_DISCOUNT_KM が入っている時だけ）
 * @param {number} [discountPct] - 実際に使う紹介割引(%)（effectiveReferralDiscount_）
 */
function individualWelcomeReferralLine_(name, discountPct) {
  var fill = function() { return name; };   // 名前に $& 等が入っても特殊展開しない
  var pct = Number(discountPct) > 0 ? String(Number(discountPct)) : '';
  var fillPct = function() { return pct; };
  return '🤝 Referred by ' + name + ' — thank you!\n' +
    (pct ? (INDIVIDUAL_DISCOUNT_KM ? INDIVIDUAL_DISCOUNT_KM.replace(/\{pct\}/g, fillPct) + '\n' : '') +
      '🎁 Referral discount: ' + pct + '% off all services\n' : '') +
    (INDIVIDUAL_WELCOME_KM ? INDIVIDUAL_WELCOME_KM.replace(/\{name\}/g, fill) + '\n' : '') +
    '📅 When you book, we\'ll also let ' + name + ' know the date, time, menu and car type (no name, plate number or photos).\n\n';
}

/**
 * 管理グループの新規予約通知に足す1行
 * @param {number} [rate] - 紹介料率(%)（予約に写した率）
 */
function individualAdminLine_(name, rate) {
  var r = (rate !== undefined && rate !== null && rate !== '' && isFinite(Number(rate))) ? '・紹介料 ' + Number(rate) + '%' : '';
  return '🙋 紹介: ' + name + '（個人提携' + r + '・お支払いは当社へ・紹介料は月初に自動集計）\n';
}
