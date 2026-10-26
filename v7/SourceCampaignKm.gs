/**
 * SourceCampaignKm.gs — 流入元（Picasso 等のレジデンス）のお客様向けクメール語（2026-10-26）
 *
 * Daisuke「お客さんへの通知は英語とクメール語で統一したい」（2026-10-26。Picasso の住民に英語＋日本語の予約確定が届いた件）。
 * 言語=en-ja の流入元の歓迎文・予約確定文（SourceCampaign.gs sendSourceWelcome_ / buildSourceCustomerConfirm_）と
 * 「管理側にも共有されます」の一言（SourceGroupNotify.gs sourceGroupShareNotice_）で、英語の行に添えていた日本語をクメール語に替える。
 *   - 予約画面（booking.html）は英語＋日本語のまま（Daisuke 同日「通知だけ」）。管理グループへの通知は日本語のまま
 *   - 言語=en-ja の意味は「英語メインの流入元」（予約画面は英語＋日本語・Bot の文面は英語＋クメール語）
 *
 * 【草案・Panha 校閲待ち（2026-10-26）】校閲を通すまで main に入れない・本番に出さない。文言を直すときは Panha を通す（Red Line #7）。
 * {place} などは sourceKm_ で差し込む。数字はアラビア数字（同じ Bot の時刻・金額と揃える）
 */

var SOURCE_KM = {
  // ── 歓迎文（/start <流入元コード>） ──
  welcome: 'សូមស្វាគមន៍មកកាន់ SAMURAI MOTORS — ការថែទាំរថយន្តគុណភាពជប៉ុន ដល់ទីតាំងអ្នក។',
  residents: 'ជូនចំពោះអ្នករស់នៅ {place}',
  allPct: 'បញ្ចុះតម្លៃ {pct}% លើគ្រប់សេវា',
  allPctAlways: 'បញ្ចុះតម្លៃ {pct}% លើគ្រប់សេវា — គ្រប់ពេល',
  itemPct: '{item} បញ្ចុះ {pct}%',
  forBookings: '{items} សម្រាប់ការកក់ {range}',
  range: 'ចាប់ពី{from} ដល់{to}',
  until: 'រហូតដល់{to}',
  from: 'ចាប់ពី{from}',
  date: 'ថ្ងៃទី{d} ខែ{m}',
  year: ' ឆ្នាំ {y}',
  noCombine: 'មិនអាចប្រើការបញ្ចុះតម្លៃច្រើនរួមគ្នាបានទេ។',
  park: 'ចតរថយន្តនៅកន្លែងដដែលដូចធម្មតា — យើងនឹងទៅដល់រថយន្តរបស់អ្នក។',
  noKey: 'មិនចាំបាច់ប្រគល់សោ ហើយក៏មិនចាំបាច់នៅចាំទេ។',
  photos: 'យើងនឹងផ្ញើរូបថតមុនលាង／ក្រោយលាង តាម Telegram។',
  share: 'ព័ត៌មានការកក់របស់អ្នក (ថ្ងៃ ម៉ោង លេខបន្ទប់ និងរថយន្ត) និងរូបថតមុនលាង／ក្រោយលាង ក៏នឹងចែករំលែកជាមួយផ្នែកគ្រប់គ្រងរបស់ {place} ផងដែរ។',
  pay: 'បង់ប្រាក់តាម ABA QR បន្ទាប់ពីលាងសម្អាតរួច។',
  hours: 'ម៉ោងបើក {h1}:00–{h2}:00',
  howToBook: 'របៀបកក់',
  step1: 'ចុចប៊ូតុង «Booking» នៅជ្រុងខាងឆ្វេងក្រោម — ជ្រើសរើសសេវា និងម៉ោង ហើយបញ្ចូលលេខបន្ទប់របស់អ្នក។',
  step2: 'ផ្ញើសារមកយើងនៅទីនេះ — ផ្ញើជាសារសំឡេងក៏បាន 🎤',
  pricesUsd: 'តម្លៃគិតជាដុល្លារអាមេរិក ក្នុងមួយរថយន្ត។',
  feePerBooking: 'ថ្លៃដឹកជញ្ជូន {fee}$ ក្នុងមួយការកក់។',
  // ── 予約確定文 ──
  confirmed: 'ការកក់ទទួលបានជោគជ័យ!',
  residentsDiscount: 'បញ្ចុះតម្លៃសម្រាប់អ្នករស់នៅ',
  deliveryFee: 'ថ្លៃដឹកជញ្ជូន',
  total: 'សរុប',
  next: 'ដំណើរការបន្ទាប់',
  remind: 'មុន 1 ម៉ោង យើងនឹងផ្ញើសាររំលឹកតាម Telegram',
  parkNoKey: 'ចតរថយន្តដូចធម្មតា — មិនចាំបាច់ប្រគល់សោ',
  photosShort: 'រូបថតមុនលាង／ក្រោយលាង តាម Telegram',
  payAfter: 'ក្រោយលាងសម្អាតរួច សូមបង់ប្រាក់តាម ABA QR',
  sendPhoto: 'សូមផ្ញើរូបថតពីខាងមុខរថយន្តនៅកន្លែងចត និងប្រាប់យើងថា អ្នកចតនៅជាន់ទីប៉ុន្មាន។',
  thanks: 'សូមអរគុណ!'
};

var SOURCE_KM_MONTHS = ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា',
  'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'];

/** SOURCE_KM[key] に {name} を差し込む（値に $& などがあっても特殊展開しない） */
function sourceKm_(key, vars) {
  var t = SOURCE_KM[key] || '';
  Object.keys(vars || {}).forEach(function(k) {
    t = t.split('{' + k + '}').join(String(vars[k]));
  });
  return t;
}

/** 品目名（クメール語の行用）: ブランド名はラテン字のまま、ヘッドライトの添えだけ ចង្កៀងមុខ（glossary） */
function sourceItemNameKm_(code) {
  return sourceItemName_(code).replace(/ \(headlight\)$/, ' (ចង្កៀងមុខ)');
}

function sourceItemsLineKm_(cfg) {
  return Object.keys(cfg.itemPct || {}).map(function(code) {
    return sourceKm_('itemPct', { item: sourceItemNameKm_(code), pct: cfg.itemPct[code] });
  }).join(' · ');
}

function sourcePerkLineKm_(cfg) {
  var parts = [];
  if (cfg.servicePct > 0) parts.push(sourceKm_('allPct', { pct: cfg.servicePct }));
  var items = sourceItemsLineKm_(cfg);
  if (items) parts.push(items);
  return parts.join(' · ');
}

/** 期間（sourcePeriodRangeEn_ と同じ場合分け）: 「ចាប់ពីថ្ងៃទី26 ខែតុលា ដល់ថ្ងៃទី1 ខែវិច្ឆិកា ឆ្នាំ 2026」 */
function sourcePeriodKm_(cfg) {
  function f(ymd, withYear) {
    var p = ymd.split('-');
    return sourceKm_('date', { d: Number(p[2]), m: SOURCE_KM_MONTHS[Number(p[1]) - 1] }) +
      (withYear ? sourceKm_('year', { y: p[0] }) : '');
  }
  if (cfg.start && cfg.end) {
    var crossYear = cfg.start.substring(0, 4) !== cfg.end.substring(0, 4);
    return sourceKm_('range', { from: f(cfg.start, crossYear), to: f(cfg.end, true) });
  }
  return cfg.end ? sourceKm_('until', { to: f(cfg.end, true) }) : sourceKm_('from', { from: f(cfg.start, true) });
}

/** 営業時間（料金設定シート連動）「ម៉ោងបើក 9:00–18:00」 */
function sourceHoursKm_() {
  var c = getBookingConfig();
  return sourceKm_('hours', { h1: Number(c.businessHourStart), h2: Number(c.businessHourEnd) });
}
