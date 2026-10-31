/**
 * RestaurantPartner.gs — 飲食店の提携（2026-10-29・第1号 PJ Restaurant）
 *
 * 【目的】Daisuke 2026-10-29「お客様が当社に直接払う形（Picasso・個人提携と同じ）にしたい」→「飲食店の型を新しく作る」・
 *   紹介料 30%・グループに届けるのは「予約の知らせ＋月次レポート」（写真は送らない）。（2026-10-31〜 グループへの月次レポートは停止中・あいさつ文からも月次レポートと10日払いの文を外した。ShopProvisioningManager.gs PARTNER_MONTHLY_REPORT_TO_GROUPS）
 *   お金の流れと通知の仕組みは個人提携（IndividualPartner.gs）と同じ。違うのは文面と、本人登録・紹介チラシの自動送付が無いこと
 *   （チラシは Day1 tools/motors_restaurant_flyer で作り、Daisuke がグループに手で送る）
 *
 * 【設定】v7 Database「店マスター」の「提携種別」=「飲食店」（RESTAURANT_PARTNER_KIND）。紹介料率は「紹介料率(%)」（空欄=30）。
 *   グループの言語は個人提携と同じ（空欄＝英語＋クメール語・individualGroupLangs_）
 *
 * 【文面】あいさつ文（連携の直後に1回）・連携完了の返事・予約の知らせの見出し。月次レポートは個人提携と同じ文（v7-operations/IndividualPartnerOps.gs）。
 *   v7-operations/IndividualPartnerOps.gs restaurantGroupGreetingText_（営業ボードの表示）と同じ文。直すときは両方を直す
 *   クメール語は Panha 校閲（2026-10-29・provisional・Run Kosal 確認待ち）。文言を直すときは Panha を通す（Red Line #7）
 *
 * 【呼び出し元】ShopGroupGreeting.gs buildShopGroupGreeting_ / ShopRouting.gs（/register の返事）/ IndividualPartner.gs notifyIndividualPartnerBooking_
 */

var RESTAURANT_TEXT = {
  // 予約の知らせの見出し（1行・「 / 」で並べる）
  noticeHead: { ja: 'ご予約が入りました（お店の QR から）', en: 'New booking via your QR', km: 'មានការកក់ថ្មី តាម QR របស់ហាងអ្នក' }
};

/**
 * 飲食店のグループの「はじめのご案内」（連携直後に1回）
 * @param {number} rate - 紹介料率(%)（0 の時は紹介料の行を出さない）
 * @param {Array<string>} [langs] - individualGroupLangs_
 */
function buildRestaurantGroupGreeting_(name, rate, langs) {
  var n = String(name || '').trim() || 'Partner';
  var r = Number(rate) >= 0 ? Number(rate) : 30;
  var pct = r + '%';
  return individualText_(langs, {
    ja: n + ' さん、SAMURAI MOTORS へようこそ！\nこのグループで、ご案内とお知らせをお送りします。\n\n' +
      '【しくみ】\n' +
      '・お店のお客様は、チラシの QR からご予約いただき、お支払いは SAMURAI MOTORS に直接いただきます\n' +
      '・ご予約が入ると、ここでお知らせします（日時・メニュー・車種。お名前や写真はお送りしません）\n' +
      '\n' +
      'ご不明な点は、このグループでお気軽にどうぞ。よろしくお願いします！',
    en: 'Welcome to SAMURAI MOTORS, ' + n + '! We\'ll send updates in this group.\n\n' +
      '[How it works]\n' +
      '- Your guests book with the QR on our flyer and pay SAMURAI MOTORS directly.\n' +
      '- When a guest books, we\'ll let you know here (date, time, menu and car — no names or photos).\n' +
      '\n' +
      'Feel free to ask anything in this group. Thank you!',
    // クメール語: お金の向きは1文1主語（ភ្ញៀវ…បង់ប្រាក់ឱ្យ SAMURAI MOTORS ដោយផ្ទាល់・patterns #63）。ほかは個人提携の確定文から流用（Panha 2026-10-29）
    km: 'សូមស្វាគមន៍ ' + n + ' មកកាន់ SAMURAI MOTORS! យើងនឹងផ្ញើដំណឹងមកក្នុងក្រុមនេះ។\n\n' +
      '[របៀបដំណើរការ]\n' +
      '- ភ្ញៀវហាងអ្នកកក់តាម QR លើខិត្តប័ណ្ណរបស់យើង។ ភ្ញៀវបង់ប្រាក់ឱ្យ SAMURAI MOTORS ដោយផ្ទាល់។\n' +
      '- ពេលភ្ញៀវកក់ យើងនឹងប្រាប់អ្នកនៅទីនេះ អំពីថ្ងៃ ម៉ោង សេវា និងប្រភេទរថយន្ត (មិនផ្ញើឈ្មោះ ឬរូបថតទេ)\n' +
      '\n' +
      'បើមានអ្វីចង់សួរ សូមកុំស្ទាក់ស្ទើរសួរក្នុងក្រុមនេះ។ សូមអរគុណ!'
  });
}

/** /register の連携完了の返事 */
function restaurantConnectedText_(name, langs) {
  return individualText_(langs, {
    ja: '✅ 連携完了！\n提携店: ' + name + '\nお店の QR からのご予約が、このグループに届くようになりました。',
    en: '✅ Connected!\nPartner: ' + name + '\nWhen a guest books through your QR, you\'ll get a message here.',
    km: '✅ បានភ្ជាប់ក្រុមហើយ!\nដៃគូ: ' + name + '\nដំណឹងអំពីការកក់តាម QR របស់ហាងអ្នក នឹងផ្ញើមកក្នុងក្រុមនេះ។'
  });
}
