/**
 * IndividualSelfJob.gs — 個人提携の紹介者ご本人の車: そのグループへ作業の開始・完了と写真（2026-10-30）
 *
 * 【なぜ】
 *   2026-10-30 Daisuke「ひろさん自身の車の時は写真も送って欲しいな ビフォーアフター」。
 *   個人提携のグループには作業の通知・写真を送らない作り（ShopRouting.gs notifyShopGroupByShopId_・2026-10-26。
 *   紹介されたお友達の車・ナンバー・写真を紹介者に見せないため）なので、Hiro Sato さん（PTN-011）ご本人の
 *   BK-20261028-001 でも写真が届かず、Run Kosal さんが手で転送していた。
 *
 * 【しくみ】
 *   お客様の chat_id が店マスター「本人chat_id」の個人提携（individualPartnerSelfFor_）＝紹介者ご本人の車の時だけ、
 *   その紹介者のグループ（Bot連携が連携済）へ:
 *     作業開始 → 見出し・車・📷 作業前の写真 ↓ ＋ 写真（apiJobStart。写真を分けて送る作業は写真の回）
 *     作業終了 → 見出し・車・所要時間・📷 作業後の写真 ↓ ＋ 写真（apiJobEnd）
 *   お友達の車は今までどおり送らない。飲食店は本人の扱いが無いので対象外（individualPartnerSelfFor_）。
 *   言語は individualGroupLangs_（店マスター「グループへの通知の言語」・空欄＝英語＋クメール語）。言語ごとに1行（車屋のグループと同じ形）。
 *   同じ送信の再実行では送り直さない（JobIdempotency.gs の印・届いた後にだけ付ける）。
 *
 * クメール語は Panha 校閲済み（2026-10-30・47/50・provisional・Run Kosal 確認待ち: native-check-queue W1・W2）。
 *   អ្នក（既存のグループ通知と同じ・លោកអ្នក は硬い）。ចាប់ផ្តើម の脚字 ត/ដ は v7 全体の方針待ち（R1）。文言を直すときは Panha を通す（Red Line #7）。
 *   写真の行・所要時間は PartnerLang.gs の校閲済みの文（shopGroupPhotosLine_・SHOP_GROUP_TEXT.minutes）を使う。
 */

var INDIVIDUAL_SELF_JOB_TEXT = {
  start: { ja: '作業開始（ご自身のお車）', en: 'Job started (your car)', km: 'ការងារចាប់ផ្តើមហើយ (រថយន្តរបស់អ្នក)' },
  end:   { ja: '作業完了（ご自身のお車）', en: 'Job finished (your car)', km: 'ការងារបញ្ចប់ហើយ (រថយន្តរបស់អ្នក)' }
};

/**
 * 紹介者ご本人の車なら、そのグループへ開始／完了と写真を送る
 * @param {string} phase - 'start' | 'end'
 * @param {string} customerChatId - お客様の chat_id
 * @param {Object} p - { car, duration, blobs, opts }（opts は apiJobStart / apiJobEnd の opts＝送り済みの印に使う）
 * @return {string} 送った（または同じ送信の再実行で送り済みの）shop_id。送らなければ ''
 */
function notifyIndividualSelfJob_(phase, customerChatId, p) {
  try {
    p = p || {};
    var self = (customerChatId && typeof individualPartnerSelfFor_ === 'function') ? individualPartnerSelfFor_(customerChatId) : null;
    if (!self || !self.shopId) return '';
    var key = (phase === 'start' ? 'selfstart:' : 'selfend:') + self.shopId;
    if (jobCustSent_(p.opts, key)) return self.shopId;
    var link = findShopLinkByShopId_(self.shopId);
    var groupChatId = (link && String(link.obj['状態']) === '連携済') ? String(link.obj['グループchat_id'] || '') : '';
    if (!groupChatId) return '';

    var blobs = p.blobs || [];
    var res = sendMessage(BOT_TYPE.BOOKING, groupChatId, individualSelfJobText_(individualGroupLangs_(self.shopId), phase, p.car, p.duration, blobs.length > 0));
    if (!(res && res.ok)) {
      if (typeof warnSourceGroupFailed_ === 'function') warnSourceGroupFailed_(link, (phase === 'start' ? '作業開始' : '作業完了') + '（ご本人のお車）', res);
      return '';
    }
    if (blobs.length > 0) {
      try {
        sendPhotoAlbum(BOT_TYPE.BOOKING, groupChatId, blobs, '', {});
      } catch (e) {
        Logger.log('⚠️ 紹介者のグループへの写真送信失敗(' + phase + '): ' + e);
      }
    }
    jobMarkCustSent_(p.opts, key);
    return self.shopId;
  } catch (err) {
    Logger.log('⚠️ notifyIndividualSelfJob_(' + phase + '): ' + err);
    return '';
  }
}

/** 見出し（言語ごとに1行）・車・所要時間（完了だけ）・写真の行（写真がある時だけ） */
function individualSelfJobText_(langs, phase, car, duration, hasPhotos) {
  var start = phase === 'start';
  var lines = langLines_(langs, start ? INDIVIDUAL_SELF_JOB_TEXT.start : INDIVIDUAL_SELF_JOB_TEXT.end);
  if (!lines.length) lines = [INDIVIDUAL_SELF_JOB_TEXT[start ? 'start' : 'end'].en];
  lines[0] = (start ? '▶️ ' : '✅ ') + lines[0];
  if (car) lines.push('🚗 ' + car);
  if (!start && Number(duration) > 0) lines.push('⏱ ' + langJoin_(langs, langFill_(SHOP_GROUP_TEXT.minutes, { n: duration })));
  if (hasPhotos) lines.push(shopGroupPhotosLine_(langs, start ? 'before' : 'after'));
  return lines.join('\n');
}
