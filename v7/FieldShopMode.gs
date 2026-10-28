/**
 * FieldShopMode.gs — 現場アプリ「お店の仕事」モードのサーバー側（2026-10-28）
 *
 * 現場アプリ field/ の「お店の仕事」（2026-10-27 本番）は、お店と決めた金額をそのまま送る
 *   （v2.mode = 'shop'・v2.price_mode = 'agreed'・v2.agreed_price・v2.guide_price〈目安＝業者価格〉）。
 * ① 管理グループの支払い行: 「定価・率」と「現場で金額を変えています」の注意の代わりに
 *    「お店と決めた金額 $X（目安 $Y・差 ±$Z）」を出す（FieldPayment.gs fieldPayAdminLine_ から呼ぶ）
 * ② 作業開始で、作業前からあった傷・へこみを文章でお店のグループへ（写真は今までどおり作業前の写真と一緒に届く）
 *    お店に届くクメール語は Run Kosal の確認が済むまで出さない: ScriptProperties「SHOP_DAMAGE_NOTE」= on で送る（既定は送らない）
 */

/** お店と決めた金額で送られた作業か（現場アプリ「お店の仕事」） */
function fieldIsAgreedPrice_(body) {
  return !!(body && body.v2 && body.v2.price_mode === 'agreed');
}

/** 金額の表示（$20 / $24.5） */
function fieldUsd_(n) {
  return '$' + (Math.round(Number(n) * 100) / 100);
}

/**
 * お店と決めた金額が目安から大きく離れているか（現場アプリ sjOff と同じ: 目安の 0.5倍未満・1.5倍超）。
 * 自動で請求が届く前の歯止めとして管理グループに注意を出す（目安が無い時は出さない＝現場アプリが毎回確認している）
 */
function fieldAgreedOff_(body) {
  var p = Number(body && body.amount) || 0;
  var g = Number(body && body.v2 && body.v2.guide_price) || 0;
  return g > 0 && p > 0 && (p < g * 0.5 || p > g * 1.5);
}

/**
 * 管理グループの「支払い」行に付ける内訳（お店の仕事・店の車）。例: （お店と決めた金額 $20・目安 $24.5・差 −$4.5）
 * 目安が無い（BODY など）時は「目安なし」
 */
function fieldAgreedAdminNote_(body) {
  var p = Number(body && body.amount) || 0;
  var g = Number(body && body.v2 && body.v2.guide_price) || 0;
  if (!(g > 0)) return '（お店と決めた金額 ' + fieldUsd_(p) + '・目安なし）';
  var d = Math.round((p - g) * 100) / 100;
  return '（お店と決めた金額 ' + fieldUsd_(p) + '・目安 ' + fieldUsd_(g) + (d === 0 ? '・目安どおり' : '・差 ' + (d > 0 ? '+' : '−') + fieldUsd_(Math.abs(d))) + '）';
}

// ====== 作業前からあった傷・へこみ（お店のグループ宛） ======
// クメール語は Panha 校閲（2026-10-27・provisional・native-check-queue）。Run Kosal の確認後に SHOP_DAMAGE_NOTE=on
var SHOP_DAMAGE_TEXT_ = {
  head: { km: 'ស្នាមកោស / ស្នាមជ្រុញ ដែលមានតាំងពីមុនធ្វើសេវា ({n} កន្លែង)',
          en: 'Scratches / dents already there before our work ({n})',
          ja: '作業前からあった傷・へこみ（{n}か所）' },
  note: { km: 'រូបថតដូចខាងលើ។ រថយន្តមានស្ថានភាពនេះ តាំងពីមុនពេលយើងធ្វើសេវា។',
          en: 'See the photos above. The car was already in this condition before our work.',
          ja: '写真は上のとおりです。作業の前から、この状態でした。' }
};
var SHOP_DAMAGE_NUM_ = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
var SHOP_DAMAGE_MAX_ = 30;      // 1通に載せる上限（Telegram の 4096 文字に収める）。超えた分は「…」
var SHOP_DAMAGE_MEMO_MAX_ = 80; // ひとことの上限（文字単位で切る＝絵文字を半分に切らない）

/** 傷の文章をお店のグループへ送るか（ScriptProperties「SHOP_DAMAGE_NOTE」= on） */
function shopDamageNoteOn_() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty('SHOP_DAMAGE_NOTE') || '').trim().toLowerCase() === 'on';
  } catch (err) {
    return false;
  }
}

/**
 * 傷・へこみの文章（言語は店マスター「グループへの通知の言語」の順）。傷が無ければ ''
 * @param {Array} langs - shopGroupLangs_ の値
 * @param {Array} damages - 現場アプリの v2.damage（{x, y, memo, photo}）
 */
function shopDamageText_(langs, damages) {
  var list = (Array.isArray(damages) ? damages : []).filter(function(d) { return d && (String(d.memo || '').trim() || d.photo); });
  if (!list.length) return '';
  var head = langLines_(langs, langFill_(SHOP_DAMAGE_TEXT_.head, { n: list.length }));
  if (head.length) head[0] = '⚠️ ' + head[0];
  var items = list.slice(0, SHOP_DAMAGE_MAX_).map(function(d, i) {
    var memo = Array.from(String(d.memo || '').replace(/\s+/g, ' ').trim()).slice(0, SHOP_DAMAGE_MEMO_MAX_).join('');
    return (SHOP_DAMAGE_NUM_[i] || '(' + (i + 1) + ')') + ' ' + (memo || '📷');
  });
  if (list.length > SHOP_DAMAGE_MAX_) items.push('…');
  return head.concat(items, [''], langLines_(langs, SHOP_DAMAGE_TEXT_.note)).join('\n');
}

/**
 * 作業開始（お店の仕事）: 作業前の写真のあとに、傷・へこみの文章をお店のグループへ。失敗しても作業は止めない
 * 「お店の仕事」モード（v2.mode = 'shop'）の作業だけ。予約の流れで店を選んだ作業には送らない
 * @param {string} shopId - apiJobStart が確かめた店（作業前の写真をお店のグループへ送れた時だけ呼ぶ）
 * @param {Object} body - job_start の本文（v2.mode・v2.damage）
 */
function notifyShopDamage_(shopId, body) {
  try {
    if (!shopId || !(body && body.v2 && body.v2.mode === 'shop') || !shopDamageNoteOn_()) return '';
    var text = shopDamageText_(shopGroupLangs_(shopId), body && body.v2 && body.v2.damage);
    if (!text) return '';
    return notifyShopGroupByShopId_(shopId, text, null);
  } catch (err) {
    Logger.log('⚠️ notifyShopDamage_: ' + err);
    return '';
  }
}
