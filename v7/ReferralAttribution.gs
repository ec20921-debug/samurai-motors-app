/**
 * ReferralAttribution.gs — 紹介元（店QR の shop_ref）の決め方と、個人提携の「配分の設定」（2026-10-27）
 *
 * 【決まり】Daisuke 2026-10-27「配分の設定と、最初の紹介者で固定の2つを実装して」
 *   ① 最初の紹介者をずっと（Daisuke 2026-10-26「最初の紹介者をずっとにしないとだめ」）:
 *      有効な紹介元がすでにあるお客様は、別の提携先・紹介者の QR を読んでも紹介元を変えない（紹介料の行き先が変わらない）
 *   ② 既存客は対象外（2026-08-24 確定スキーム「既存客対象外」・2026-10-26 Daisuke 再確認）:
 *      紹介元なしで作業完了の予約があるお客様は、紹介 QR を読んでも紹介元を付けない
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
 *
 * 【まだ決めていないこと（2026-10-27 時点・実装していない）】紹介の期限（今は無期限）／紹介されたお客様が紹介者になった時
 *   （①により最初の紹介者のまま）／高額メニューの率（同じ率）／標準の配分（空欄=30%＋0%のまま）
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

// ====== ①② 店QR を読んだ時の紹介元 ======

/**
 * 店QR を読んだ時、紹介元をどうするか。
 * @return {{action: string, keptShopId?: string}}
 *   action = 'tag'（この店QRを紹介元にする）／ 'keep'（最初の紹介者 keptShopId のまま）／ 'existing'（既存客なので付けない）
 */
function referralDecision_(chatId, scannedShopId) {
  var prev = getShopRefForCustomer(chatId);
  if (prev && prev === scannedShopId) return { action: 'tag' };   // 同じ QR の読み直し
  if (prev) {
    var kept = validPartnerShopId_(prev);   // 停止中・店マスターに無い紹介元は無いのと同じ（読めない時は残す側）
    if (kept) return { action: 'keep', keptShopId: kept };
  }
  if (isExistingCustomer_(chatId)) return { action: 'existing' };
  return { action: 'tag' };
}

/**
 * 紹介元なしで当社を使ったことがあるか（予約タブに このチャットID の、キャンセル以外で「紹介元shop_id」が空の行がある）。
 * 作業完了の前（予約確定・作業中）も数える: 紹介なしで予約済みのお客様に紹介元が付くと、その予約の決済の判定が
 *   今の紐付けに倒れて取り違えるため（予約の「紹介元shop_id」が空 → getValidShopRefForBooking_ が今の紐付けを見る）。
 * 「紹介元shop_id」列が無い時は、キャンセル以外の行があれば既存客。
 * 読めない時は false（従来どおり紹介元を付ける。付け間違いは予約タブの「紹介元shop_id」を手で直せる）＋管理グループに知らせる
 */
function isExistingCustomer_(chatId) {
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
      if (!refs || !String(refs[i][0] || '').trim()) return true;
    }
    return false;
  } catch (err) {
    Logger.log('⚠️ isExistingCustomer_ 読み取り失敗（新しいお客様として扱う）: ' + err);
    if (typeof warnOncePer_ === 'function') {
      warnOncePer_('warn_existing_customer_unreadable', 60 * 60,
        '⚠️ 予約タブを読めず、紹介QRのお客様が既存客か判定できませんでした（新しいお客様として紹介元を付けています）。\n' +
        '既存客に紹介元が付いていたら、Script Properties の shop_ref_<chat_id> と予約タブの「紹介元shop_id」を直してください（1時間に1回だけ知らせます）\n' + err);
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
