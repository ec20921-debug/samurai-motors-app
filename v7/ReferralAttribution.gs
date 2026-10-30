/**
 * ReferralAttribution.gs — 紹介元（店QR の shop_ref）の決め方と、個人提携の「配分の設定」（2026-10-27）
 *
 * 【決まり】Daisuke 2026-10-27「配分の設定と、最初の紹介者で固定の2つを実装して」
 *   ① 最初の紹介者をずっと（Daisuke 2026-10-26「最初の紹介者をずっとにしないとだめ」）:
 *      有効な紹介元がすでにあるお客様は、別の提携先・紹介者の QR を読んでも紹介元を変えない（紹介料の行き先が変わらない）
 *   ② 既存客は対象外（2026-08-24 確定スキーム「既存客対象外」・2026-10-26 Daisuke 再確認）:
 *      紹介元なしの予約（キャンセル以外）があるお客様は、紹介 QR を読んでも紹介元を付けない
 *   ⑥ 紹介の期限は紹介元が付いた日から12か月（8/9 決め事④「店QR起点顧客はBot直予約でも12ヶ月30%継続」9/12 裁可・
 *      2026-10-27 Daisuke「12ヶ月で良い」）。車屋も個人提携も同じ。期限が過ぎたら紹介元は無いのと同じ
 *      （紹介料・紹介割引なし・全体キャンペーンと一斉配信は通常どおり・決済は当社）。期限の内側に入った予約は、
 *      作業が期限の後でも予約の「紹介元shop_id」で紹介料が付く。期限が過ぎたお客様は、予約があれば既存客
 *      （別の紹介者の QR を読んでも付けない）。付いた日は v7 Database「状態」タブの `shopref_at_<chatId>`（"<shop_id>|<yyyy-MM-dd>"）。
 *      付いた日のちょうど12か月後の日に切れる（2026-10-28 に付いたら 2027-10-27 まで有効）。
 *      この版より前の紐付けは日付が無いので、本番に出したあと最初の確認（毎時の処理か最初の読み取り）で一括して今日を付ける
 *   ③ 個人提携は当社集金なので、レジデンス等の流入元（Picasso 等・SourceCampaign.gs）と両立する:
 *      流入元 QR を読んでも個人提携の紹介元は外さない／個人提携の QR を読んでも流入元は外さない。
 *      車屋（店集金）は従来どおり、どちらかを読むともう一方を外す（店に払う流れと当社に払う流れがぶつかるため）
 *   以前は「最後に読んだ QR が優先」（2026-10-20）だった
 *
 *   ④ 配分の設定（個人提携だけ）: 店マスター「紹介料率(%)」（空欄=30）と「紹介割引率(%)」（空欄=0）。
 *      紹介割引は紹介されたお客様への割引（サービス料金に -X%。出張料は割り引かない）。
 *      合計は 30% まで（当社の手取り 70% を守る）。超えた時は割引のほうを減らし、管理グループに知らせる
 *      （紹介料は紹介者との約束なので変えない）。紹介料は従来どおり実際に払われた額 × 紹介料率
 *   ⑤ 割引は1回の予約に1つ: 流入元の特典が効く予約では紹介割引を使わない。全体キャンペーンは紹介のお客様には元から付かない
 *   車屋は配分の対象外（お客様が店に定価を払う仕組みのため。紹介割引率を入れても使わない）
 *   ⑦ 紹介者ご本人の予約（2026-10-27 Daisuke）: 店マスター「本人chat_id」に本人の Telegram chat_id を入れると、本人の予約は
 *      予約の時に（紹介料率＋紹介割引）% 引き（標準 30%）・その予約に紹介料は付けない（予約の「紹介元shop_id」を空にする）。
 *      紹介した友達の予約は今までどおり紹介料。本人がほかの人の紹介で来ていた（有効な紹介元が別にある）時は対象外
 *
 * 【2026-10-27 Daisuke 決定（まだ決めていなかった4点）】
 *   - 紹介の期限 = 12か月（⑥）
 *   - 紹介されたお客様が紹介者になった時: 本人の利用は最初の紹介者のまま（①のとおり）。最初の紹介者が「本人で良い」と
 *     言った時だけ、手で付け替える（「状態」タブの `shop_ref_<chatId>` の値を直せば、付いた日は自動で今日から）
 *   - 高額メニューも同じ率。メニューは組み合わせて予約でき、割引は組み合わせた合計（WASH＋GLASS＋HEADLIGHT 等）に効く
 *   - 標準の配分 = 紹介料 30%（紹介割引率は空欄=0）。紹介者が希望した時だけ、紹介料の一部をお客様の割引に回す（④）
 *
 * 【呼び出し元】ShopRouting.gs handleShopStart_（店QR）／ SourceCampaign.gs handleSourceStart_（流入元QR）／
 *   BookingLogic.gs createBooking（予約の金額・紹介元）／ Router.gs apiBookingInit（予約画面の紹介割引）／ BookingBot.gs（歓迎文）
 * 【ファネルログ】店QR を読んだ記録（shop:<id>）は判断に関係なく残す（営業ボードの「QRを読んだ人」でシールの動作確認に使うため）
 */

var REFERRAL_TOTAL_CAP_PCT = 30;   // 紹介料＋紹介割引の上限（当社の手取り 70% を守る）

// 予約画面のバナー・予約確定文の英語ラベル（クメール語は REFERRAL_DISCOUNT_KM）
var REFERRAL_DISCOUNT_LABEL_EN = 'Referral discount';
// 予約画面のバナーの添え（Panha 校閲 2026-10-27・provisional・Run Kosal 確認待ち。空なら英語だけ）
var REFERRAL_DISCOUNT_KM = 'បញ្ចុះតម្លៃសម្រាប់ភ្ញៀវដែលគេណែនាំមក';

var REFERRAL_TERM_MONTHS = 12;   // 紹介の期限（⑥）
// 紹介元が付いた日 = 「状態」タブの `shopref_at_<chatId>` に "<shop_id>|<yyyy-MM-dd>"。
//   'shop_ref_' で始めない（CampaignShopFilter.gs が shop_ref_ で始まるキーを全部読むため）。置き場は状態タブ（KvStore.gs・2026-10-31）
//   shop_id も一緒に持つ: shop_ref_ だけを手で付け替えた・片方の書き込みに失敗した時に、前の店の古い日付で新しい紹介元が
//   すぐ切れないようにする（店が一致しない日付は無いのと同じ＝今日から数える）
var SHOP_REF_AT_PREFIX = 'shopref_at_';
var SHOP_REF_AT_MIGRATED_KEY = 'shopref_dates_migrated_v1';   // 日付の無い既存の紐付けに一括で日付を付けた印

// ====== ①②⑥ 店QR を読んだ時の紹介元 ======

/**
 * 店QR を読んだ時、紹介元をどうするか。
 * @return {{action: string, keptShopId?: string, expired?: boolean}}
 *   action = 'tag'（この店QRを紹介元にする）／ 'keep'（最初の紹介者 keptShopId のまま）／ 'existing'（既存客なので付けない）
 *   expired = 前の紹介元の期限（12か月）が過ぎていた
 */
function referralDecision_(chatId, scannedShopId) {
  var prev = getShopRefForCustomer(chatId);
  var expired = !!(prev && referralExpired_(chatId));
  if (prev && !expired) {
    if (prev === scannedShopId) return { action: 'tag' };   // 同じ QR の読み直し（付いた日は変えない・setReferralTag_）
    var kept = validPartnerShopId_(prev);   // 停止中・店マスターに無い紹介元は無いのと同じ（読めない時は残す側）
    if (kept) return { action: 'keep', keptShopId: kept };
  }
  // 期限が過ぎたお客様は、紹介ありの予約も含めて予約があれば既存客（12か月使ってくれたお客様に新しい紹介料を付けない）
  if (isExistingCustomer_(chatId, expired)) return { action: 'existing', expired: expired };
  return { action: 'tag', expired: expired };
}

/** 今日（プノンペン）yyyy-MM-dd */
function referralToday_() {
  return Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd');
}

/** "<shop_id>|<yyyy-MM-dd>" を読む。形が違えば null */
function parseShopRefAt_(v) {
  var m = String(v || '').match(/^(.+)\|(\d{4}-\d{2}-\d{2})$/);
  return m ? { shopId: m[1], date: m[2] } : null;
}

/** 今の紹介元（shop_ref_）が付いた日（yyyy-MM-dd）。無い・別の店の日付なら '' */
function getShopRefTaggedAt_(chatId) {
  try {
    var ref = kvGet_('shop_ref_' + String(chatId)) || '';
    var at = parseShopRefAt_(kvGet_(SHOP_REF_AT_PREFIX + String(chatId)));
    return (ref && at && at.shopId === ref) ? at.date : '';
  } catch (err) {
    return '';
  }
}

/**
 * 'yyyy-MM-dd' から n か月後の 'yyyy-MM-dd'（日はそのまま）。**文字列で比べる専用**
 * （2/29 の12か月後は存在しない "yyyy-02-29" になるが、文字列の比較なら 2/28 まで有効・3/1 に切れる。Date に渡さないこと）
 */
function referralAddMonths_(ymd, n) {
  var m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  var total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  var y = Math.floor(total / 12), mo = total % 12 + 1;
  return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + m[3];
}

/**
 * この版より前の紐付け（付いた日が無い）に、一括で今日を付ける（1回だけ・印 SHOP_REF_AT_MIGRATED_KEY）。
 * 読まれた日ごとにばらばらの起点にならないよう、最初に1回まとめて付ける（毎時の send24HoursFeedback と referralExpired_ から呼ぶ）
 */
function ensureShopRefDatesMigrated_() {
  try {
    if (kvGet_(SHOP_REF_AT_MIGRATED_KEY)) return;
    var all = kvGetAll_('shop_ref_');                 // 状態タブ（KvStore.gs）
    var ats = kvGetAll_(SHOP_REF_AT_PREFIX);
    var today = referralToday_();
    var add = {};
    var n = 0;
    Object.keys(all).forEach(function(k) {
      if (k.indexOf('shop_ref_') !== 0 || !all[k]) return;
      var c = k.substring('shop_ref_'.length);
      var at = parseShopRefAt_(ats[SHOP_REF_AT_PREFIX + c]);
      if (at && at.shopId === all[k]) return;
      add[SHOP_REF_AT_PREFIX + c] = all[k] + '|' + today;
      n++;
    });
    add[SHOP_REF_AT_MIGRATED_KEY] = today;
    kvSetAll_(add);
    Logger.log('🗓 紹介元の付いた日を一括で付けた: ' + n + '件（' + today + '）');
  } catch (err) {
    Logger.log('⚠️ ensureShopRefDatesMigrated_: ' + err);
  }
}

/**
 * 紹介元の期限（付いた日から12か月。付いた日のちょうど12か月後の日に切れる）が過ぎたか。
 * 付いた日が無い紐付けは、一括の日付付け（初回だけ）→ それでも無ければ今日を付いた日にして false。
 * 読み書きに失敗した時は false（紹介元は今までどおり有効＝店集金の判定を変えない側）
 */
function referralExpired_(chatId) {
  if (!chatId) return false;
  try {
    var at = getShopRefTaggedAt_(chatId);
    if (!at) {
      ensureShopRefDatesMigrated_();
      at = getShopRefTaggedAt_(chatId);
    }
    if (!at) {
      var ref = kvGet_('shop_ref_' + String(chatId)) || '';
      if (!ref) return false;
      kvSet_(SHOP_REF_AT_PREFIX + String(chatId), ref + '|' + referralToday_());
      Logger.log('🗓 紹介元の付いた日が無い（または別の店の日付）→ 今日から数える: chat_id=' + chatId + ' shop=' + ref);
      return false;
    }
    return referralToday_() >= referralAddMonths_(at, REFERRAL_TERM_MONTHS);
  } catch (err) {
    Logger.log('⚠️ referralExpired_: ' + err);
    return false;
  }
}

/**
 * 店QR の紹介元を付ける（handleShopStart_ の 'tag'）。同じ紹介元の読み直しで期限内なら、付いた日は変えない
 * （読み直しで期限を延ばさない）。新しく付く・付け直す時は今日を付いた日にする（紹介元と付いた日は1回でまとめて書く）
 */
function setReferralTag_(chatId, shopId) {
  var id = String(chatId);
  var prev = kvGet_('shop_ref_' + id) || '';
  if (prev === String(shopId) && getShopRefTaggedAt_(id) && !referralExpired_(id)) return;
  var props = {};
  props['shop_ref_' + id] = String(shopId);
  props[SHOP_REF_AT_PREFIX + id] = String(shopId) + '|' + referralToday_();
  kvSetAll_(props);
}

/**
 * 紹介元なしで当社を使ったことがあるか（予約タブに このチャットID の、キャンセル以外で「紹介元shop_id」が空の行がある）。
 * countReferred = true（紹介の期限が過ぎたお客様）は、紹介ありの予約も数える。
 * 作業完了の前（予約確定・作業中）も数える: 紹介なしで予約済みのお客様に紹介元が付くと、その予約の決済の判定が
 *   今の紐付けに倒れて取り違えるため（予約の「紹介元shop_id」が空 → getValidShopRefForBooking_ が今の紐付けを見る）。
 * 「紹介元shop_id」列が無い時は、キャンセル以外の行があれば既存客。
 * 読めない時は false（従来どおり紹介元を付ける。付け間違いは予約タブの「紹介元shop_id」を手で直せる）＋管理グループに知らせる
 */
function isExistingCustomer_(chatId, countReferred) {
  var id = String(chatId || '');
  if (!id) return false;
  try {
    var sheet = getSheet(SHEET_NAMES.BOOKINGS);
    var h = getHeaderMap(SHEET_NAMES.BOOKINGS);
    var ci = h['チャットID'], si = h['進行状態'], ri = h['紹介元shop_id'];
    if (!ci || !si) throw new Error('予約タブに チャットID / 進行状態 の列がありません');
    if (sheet.getLastRow() < 2) return false;
    var n = sheet.getLastRow() - 1;
    var chats = sheet.getRange(2, ci, n, 1).getValues();
    var states = sheet.getRange(2, si, n, 1).getValues();
    var refs = ri ? sheet.getRange(2, ri, n, 1).getValues() : null;
    for (var i = 0; i < n; i++) {
      if (String(chats[i][0]) !== id) continue;
      var st = String(states[i][0] || '').trim();
      if (!st || st === 'キャンセル') continue;
      if (countReferred || !refs || !String(refs[i][0] || '').trim()) return true;
    }
    return false;
  } catch (err) {
    Logger.log('⚠️ isExistingCustomer_ 読み取り失敗（新しいお客様として扱う）: ' + err);
    if (typeof warnOncePer_ === 'function') {
      warnOncePer_('warn_existing_customer_unreadable', 60 * 60,
        '⚠️ 予約タブを読めず、紹介QRのお客様が既存客か判定できませんでした（新しいお客様として紹介元を付けています）。\n' +
        '既存客に紹介元が付いていたら、v7 Database「状態」タブの shop_ref_<chat_id> と予約タブの「紹介元shop_id」を直してください（1時間に1回だけ知らせます）\n' + err);
    }
    return false;
  }
}

// ====== ③ 流入元との両立 ======

/** 流入元 QR を読んだ時、店の紐付け（shop_ref）を外してよいか（個人提携は外さない。車屋・分からない時は従来どおり外す） */
function shouldClearShopRefOnSourceScan_(chatId) {
  var ref = getShopRefForCustomer(chatId);
  if (!ref) return false;
  return !(typeof isIndividualPartnerShop_ === 'function' && isIndividualPartnerShop_(ref));
}

/** 店QR を紹介元にした時、流入元の紐付け（src_ref）を外してよいか（個人提携は外さない。車屋・分からない時は従来どおり外す） */
function shouldClearSourceRefOnShopTag_(shopId) {
  return !(typeof isIndividualPartnerShop_ === 'function' && isIndividualPartnerShop_(shopId));
}

// ====== ④ 配分の設定（紹介割引） ======

/**
 * 店マスター「紹介割引率(%)」のセルを 0〜100 の数にする（空欄・読めない値は 0）。
 * 書き方は「紹介料率(%)」と同じ（"10"・"10%"・10 → 10、シートの%書式の数値 0.1 → 10）
 */
function referralParseDiscount_(v) {
  if (v === null || v === undefined || String(v).replace('%', '').trim() === '') return 0;
  var n = Number(String(v).replace('%', '').trim());
  if (!isFinite(n)) return 0;
  if (n > 0 && n < 1 && typeof v === 'number') n = n * 100;
  n = Math.round(n * 100) / 100;
  return (n < 0 || n > 100) ? 0 : n;
}

/**
 * 個人提携の { name, rate, discount }（individualPartnerInfo_）から、実際に使う紹介割引(%)。
 * 紹介料＋割引が 30% を超える時は、割引を (30 − 紹介料) に減らして管理グループに知らせる（6時間に1回）
 */
function effectiveReferralDiscount_(info, shopId) {
  if (!info) return 0;
  var want = Number(info.discount) || 0;
  if (want <= 0) return 0;
  var rate = Number(info.rate);
  if (!isFinite(rate) || rate < 0) rate = 30;
  var room = Math.max(0, Math.round((REFERRAL_TOTAL_CAP_PCT - rate) * 100) / 100);
  if (want <= room) return want;
  if (typeof warnOncePer_ === 'function') {
    warnOncePer_('warn_referral_split_over_' + String(shopId || info.name || ''), 6 * 60 * 60,
      '⚠️ 個人提携「' + (info.name || shopId) + '」の配分が上限を超えています（紹介料 ' + rate + '% ＋ 紹介割引 ' + want + '% ＞ ' +
      REFERRAL_TOTAL_CAP_PCT + '%）。\n紹介割引を ' + room + '% に減らして予約を受けています（紹介料はそのまま）。\n' +
      '店マスターの「紹介料率(%)」「紹介割引率(%)」を、合計 ' + REFERRAL_TOTAL_CAP_PCT + '% 以内に直してください（6時間に1回だけ知らせます）');
  }
  return room;
}

/** 個人提携の shop_id → 実際に使う紹介割引(%)。個人提携でない・分からない時は 0 */
function referralDiscountForShop_(shopId) {
  if (!shopId || typeof individualPartnerInfo_ !== 'function') return 0;
  try {
    return effectiveReferralDiscount_(individualPartnerInfo_(shopId), shopId);
  } catch (err) {
    Logger.log('⚠️ referralDiscountForShop_: ' + err);
    return 0;
  }
}

/**
 * 紹介割引を、全体キャンペーンと同じ形 { active, percent, nameEn, nameKm } にする（予約画面・予約作成・確定文で同じ扱い）。
 * referral: true と紹介者名 partnerName を足す。割引が無い時は null
 */
function referralCampaign_(pct, partnerName) {
  if (!(pct > 0)) return null;
  return {
    active: true,
    percent: pct,
    nameEn: REFERRAL_DISCOUNT_LABEL_EN,
    nameKm: REFERRAL_DISCOUNT_KM,
    referral: true,
    partnerName: String(partnerName || '')
  };
}

// ====== ⑦ 紹介者ご本人の予約（2026-10-27 Daisuke「Hiro さん本人の予約だけ予約の時に30%引き・その予約に紹介料は付けない」） ======

// 予約画面のバナー・予約確定文の英語ラベル（クメール語の添えは無し＝英語だけ。クメール語を足す時は Panha を通す）
var SELF_PARTNER_LABEL_EN = 'Partner discount';

/**
 * 紹介者ご本人の割引 { shopId, name, pct }。対象でなければ null。
 *   - 店マスター「本人chat_id」がこのお客様の chat_id の個人提携（individualPartnerSelfFor_）
 *   - ほかに有効な紹介元がある時は対象外（最初の紹介者のまま＝本人の利用はその人の紹介・2026-10-27 決定）
 *   - 率 = 紹介料率＋紹介割引（30% まで）。標準の 30＋0 なら 30%引き
 * 紹介元の QR を読んだかどうか・紹介の期限には関係しない（本人であることで決まる）
 *
 * なりすまし対策（2026-10-27 レビュー指摘）: 予約画面の chat_id は画面が申告する値なので、それだけで本人とはしない。
 *   verifiedUserId = Telegram の署名で確かめた user.id（Router.gs が _authUserId に入れる）と chat_id が一致する時だけ本人。
 *   Telegram から直接届いた /start（msg.chat.id）や手動ジョブなど、chat_id が信頼できる呼び元は同じ値を渡す
 * @param {string} chatId
 * @param {string} verifiedUserId - 署名で確かめた user.id（無い・違う時は本人割引なし）
 */
function selfPartnerDiscount_(chatId, verifiedUserId) {
  try {
    if (typeof individualPartnerSelfFor_ !== 'function') return null;
    var id = String(chatId || '');
    if (!id || String(verifiedUserId || '') !== id) return null;
    var self = individualPartnerSelfFor_(id);
    if (!self) return null;
    var ref = (typeof getReferralPartnerRef_ === 'function') ? getReferralPartnerRef_(id) : '';
    if (ref && ref !== self.shopId) return null;
    var rate = Number(self.rate);
    if (!isFinite(rate) || rate < 0) rate = 30;
    var pct = Math.min(REFERRAL_TOTAL_CAP_PCT, Math.round((rate + effectiveReferralDiscount_(self, self.shopId)) * 100) / 100);
    return pct > 0 ? { shopId: self.shopId, name: self.name, pct: pct } : null;
  } catch (err) {
    Logger.log('⚠️ selfPartnerDiscount_: ' + err);
    return null;
  }
}

/** 紹介者ご本人の割引を、全体キャンペーンと同じ形にする（self: true・partnerName） */
function selfPartnerCampaign_(self) {
  if (!self || !(self.pct > 0)) return null;
  return {
    active: true,
    percent: self.pct,
    nameEn: SELF_PARTNER_LABEL_EN,
    nameKm: '',
    self: true,
    partnerName: String(self.name || '')
  };
}
