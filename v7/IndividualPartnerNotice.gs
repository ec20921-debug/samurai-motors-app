/**
 * IndividualPartnerNotice.gs — 個人提携の紹介者のグループへの「予約が入った」の文面（2026-10-28）
 *
 * 【目的】
 *   - 紹介されたお友達の予約: 日時・車種・メニューだけ（お名前・ナンバー・場所・金額は載せない・2026-10-26 Picasso と同じ方針）
 *   - 紹介者ご本人の予約（店マスター「本人chat_id」・ReferralAttribution.gs ⑦）: 2026-10-28 Daisuke「本人の予約もグループに通知。
 *     英語とクメール語で・金額と map も・コンドミニアム等の場合は、駐車場所が決まったら、ナンバーと停車した階数を別途」
 *     → 予約番号・日時・車種・メニュー・金額（本人割引）・地図・駐車のお願い。ご本人の予約なので金額と場所も載せる。
 *     紹介料・月報には今までどおり入れない（予約の「紹介元shop_id」は空のまま。送り先だけ本人の shop_id）
 *   言語は individualGroupLangs_（英語＋クメール語が標準）。短い見出しは同じ行に「 / 」で並べ、事実の行（日時・金額・リンク）は1回だけ
 *
 * 【呼び出し元】IndividualPartner.gs notifyIndividualPartnerBooking_（BookingLogic.gs createBooking がロックを外したあと）
 *
 * クメール語は Panha 校閲（2026-10-28・provisional・Run Kosal 確認待ち: native-check-queue「2026-10-28 個人提携グループ宛 予約の通知」）。
 *   ការកក់ទទួលបានជោគជ័យ・សរុប・ថ្លៃដឹកជញ្ជូន・សេវានៅហាង は予約確定文（BookingLogic.gs notifyBookingCreated）と同じ語。
 *   文言を直すときは Panha を通す（Red Line #7）
 */

var INDIVIDUAL_NOTICE_TEXT = {
  referralHead: { ja: 'ご予約が入りました（ご紹介）', en: 'New booking from your referral', km: 'មានការកក់ថ្មី ពីភ្ញៀវដែលអ្នកបានណែនាំមក' },
  selfHead:     { ja: 'ご予約を承りました', en: 'Booking confirmed', km: 'ការកក់ទទួលបានជោគជ័យ' },
  selfThanks:   { ja: '{name} さん、ありがとうございます！', en: 'Thank you, {name}!', km: 'សូមអរគុណ {name}!' },
  selfDiscount: { ja: 'ご本人割引 -{pct}%', en: 'Partner discount -{pct}%', km: 'បញ្ចុះតម្លៃ {pct}% សម្រាប់ដៃគូ' },
  deliveryFee:  { ja: '出張料', en: 'Delivery fee', km: 'ថ្លៃដឹកជញ្ជូន' },
  total:        { ja: '合計', en: 'Total', km: 'សរុប' },
  inStore:      { ja: '店舗作業（Samurai Motors 事務所）', en: 'In-store service', km: 'សេវានៅហាង' },
  // 出張作業だけ。見出しは英語・日本語だけ（クメール語は文の中に「建物に停める場合は」が入る・Panha 2026-10-28）
  parking: {
    ja: '📝 コンドミニアム等の場合:\n駐車場所が決まったら、ナンバーと停めた階を、このグループで別途お知らせください。',
    en: '📝 Condo / building parking:\nOnce your parking spot is decided, please send us your plate number and the floor you parked on, here in this group.',
    km: 'បើអ្នកចតនៅអគារ សូមផ្ញើស្លាកលេខ និងជាន់ដែលអ្នកចត មកក្នុងក្រុមនេះ ពេលដឹងកន្លែងចតហើយ។'
  }
};

var INDIVIDUAL_NOTICE_RULE = '━━━━━━━━━━━━━━━━';

/** 金額（数字+$ 後置・カンボジア慣習。予約確定文と同じ） */
function individualNoticeUsd_(n) {
  return (Number(n) || 0).toFixed(2) + '$';
}

/** 日時の行の中身（最初の言語が日本語なら 10/30(金)、ほかは Fri 30 Oct 2026） */
function individualNoticeWhen_(langs, info) {
  var first = (langs || INDIVIDUAL_LANG_DEFAULT)[0];
  var d = first === 'ja' ? individualDateJa_(info.date) : sourceGroupDate_(info.date);
  return d + ' · ' + info.startTime + '–' + info.endTime;
}

/** 車種・メニューの2行（お友達の予約と同じ書き方） */
function individualNoticeCarAndMenu_(info) {
  var services = [];
  if (info.plan) services.push(info.plan.name || info.plan.planFull || 'SAMURAI WASH');
  (info.options || []).forEach(function(l) {
    if (l && l.opt) services.push(optionDisplayName_(l.opt));
  });
  var car = [info.carModel, sourceGroupVehicleEn_(info.vehicleType)].filter(Boolean).join(' / ');
  return '🚗 ' + (car || '-') + '\n🧽 ' + (services.join(' + ') || '-');
}

/**
 * 紹介されたお友達の予約（名前・ナンバー・場所・金額は載せない）
 * @param {Array<string>} langs - individualGroupLangs_
 * @param {Object} info - { plan, options, vehicleType, carModel, date, startTime, endTime }
 * @param {Object} [head] - 見出し { ja, en, km }（飲食店は RestaurantPartner.gs RESTAURANT_TEXT.noticeHead・2026-10-29）。省略時はご紹介の見出し
 */
function individualReferralBookingNotice_(langs, info, head) {
  return '📅 ' + individualLine_(langs, head || INDIVIDUAL_NOTICE_TEXT.referralHead) + '\n' +
    '🗓 ' + individualNoticeWhen_(langs, info) + '\n' +
    individualNoticeCarAndMenu_(info);
}

/**
 * 紹介者ご本人の予約（金額・地図・駐車のお願い入り）
 * @param {Array<string>} langs - individualGroupLangs_
 * @param {Object} info - お友達の予約の項目＋ { bookingId, name, selfPct, serviceSubtotal, discountAmount, dispatchFee, amount, mapsUrl, inStore }
 *   selfPct = 本人割引が効いた時の率（流入元の特典など別の割引の時は 0 ＝割引の名前を出さない）
 */
function individualSelfBookingNotice_(langs, info) {
  var T = INDIVIDUAL_NOTICE_TEXT;
  var name = String(info.name || '').trim() || 'Partner';
  var serviceSubtotal = Number(info.serviceSubtotal) || 0;
  var discount = Number(info.discountAmount) || 0;
  var fee = Number(info.dispatchFee) || 0;
  var lines = [
    '✅ ' + individualLine_(langs, T.selfHead),
    individualLine_(langs, langFill_(T.selfThanks, { name: name })),
    INDIVIDUAL_NOTICE_RULE,
    '📋 ' + info.bookingId,
    '📅 ' + individualNoticeWhen_(langs, info),
    individualNoticeCarAndMenu_(info)
  ];
  // 金額: サービス料金（割引前 → 割引後）。出張料がある時だけ出張料と合計の行（「出張料なし」とは書かない）
  var price = '💵 ' + individualNoticeUsd_(serviceSubtotal);
  if (discount > 0) {
    price += ' → ' + individualNoticeUsd_(Math.max(0, serviceSubtotal - discount));
    if (Number(info.selfPct) > 0) price += ' (' + individualLine_(langs, langFill_(T.selfDiscount, { pct: Number(info.selfPct) })) + ')';
  }
  lines.push(price);
  if (fee > 0) {
    lines.push('🚚 ' + individualLine_(langs, T.deliveryFee) + ': ' + individualNoticeUsd_(fee));
    lines.push('💵 ' + individualLine_(langs, T.total) + ': ' + individualNoticeUsd_(info.amount));
  }
  if (info.inStore) {
    lines.push('🏪 ' + individualLine_(langs, T.inStore));
  } else {
    if (info.mapsUrl) lines.push('📍 ' + info.mapsUrl);
    lines.push(INDIVIDUAL_NOTICE_RULE);
    lines.push(individualJoin_(langs, T.parking, '\n'));
  }
  return lines.join('\n');
}
