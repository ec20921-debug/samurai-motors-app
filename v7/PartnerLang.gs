/**
 * PartnerLang.gs — 提携先のグループへの通知の言語（2026-10-26）
 *
 * Daisuke「車屋とかの提携店は、クメール語と英語と日本語にしようか」「ケースバイケースだよね」→ グループごとに切り替え。
 *   - 設定 = v7 Database「店マスター」の「グループへの通知の言語」列（v7-operations が列とプルダウンを足す）。
 *     値は「クメール語＋英語＋日本語」のように並べた順に出す（km / en / ja・カンマ区切りも可）。空欄・読めない値は車屋の標準
 *   - 対象 = 車屋（店集金の提携店）のグループ宛: 連携完了の返事・QRからお客様が来た知らせ（ShopRouting）・あいさつ文（ShopGroupGreeting）・
 *     作業の開始/完了と写真（JobManager）・請求（ShopInvoice）。月次レポートは v7-operations/PartnerLangOps.gs が同じ列を読む
 *   - レジデンス等の提携先（英語）・個人提携（日本語＋英語）のグループは今の文面のまま（この設定は使わない）
 *   - 第2回（予定）: 車屋の QR から来たお客様宛にも言語の設定を広げる
 *
 * 【クメール語の新しい文は草案・Panha 校閲待ち（2026-10-26）】校閲を通すまで main に入れない・本番に出さない。文言を直すときは Panha を通す（Red Line #7）
 */

var PARTNER_GROUP_LANG_COL = 'グループへの通知の言語';
var PARTNER_LANG_SHOP_DEFAULT = ['km', 'en', 'ja'];   // 車屋の標準（Daisuke 2026-10-26）
var PARTNER_LANG_CACHE_KEY = 'shop_group_langs_v1';
var PARTNER_LANG_CACHE_SEC = 300;
var PARTNER_LANG_WORDS = { 'クメール語': 'km', '英語': 'en', '日本語': 'ja',
  km: 'km', en: 'en', ja: 'ja', khmer: 'km', english: 'en', japanese: 'ja' };
var __partnerLangMemo_ = null;

/** 「クメール語＋英語＋日本語」→ ['km','en','ja']。分からない語は無視。1つも無ければ null */
function parsePartnerLangs_(v) {
  var out = [];
  String(v || '').split(/[＋+,、，\/\s]+/).forEach(function(w) {
    var key = w.trim().toLowerCase();
    var code = Object.prototype.hasOwnProperty.call(PARTNER_LANG_WORDS, key) ? PARTNER_LANG_WORDS[key] : '';
    if (code && out.indexOf(code) < 0) out.push(code);
  });
  return out.length ? out : null;
}

/** 店マスター → { shop_id: 列の値 }（5分キャッシュ・実行内メモ）。読めない・列が無い時は {} */
function readShopGroupLangs_() {
  if (__partnerLangMemo_) return __partnerLangMemo_;
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get(PARTNER_LANG_CACHE_KEY);
    if (hit) return (__partnerLangMemo_ = JSON.parse(hit));
  } catch (ignore) {}
  var map = {};
  try {
    var sh = getSpreadsheet().getSheetByName('店マスター');
    if (sh && sh.getLastRow() >= 2) {
      var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function(h) { return String(h).trim(); });
      var ci = head.indexOf('shop_id'), li = head.indexOf(PARTNER_GROUP_LANG_COL);
      if (ci >= 0 && li >= 0) {
        sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(ci, li) + 1).getValues().forEach(function(r) {
          var id = String(r[ci] || '').trim();
          if (id && String(r[li] || '').trim()) map[id] = String(r[li]).trim();
        });
      }
    }
    try { cache.put(PARTNER_LANG_CACHE_KEY, JSON.stringify(map), PARTNER_LANG_CACHE_SEC); } catch (ignore) {}
  } catch (err) {
    Logger.log('⚠️ 店マスター（通知の言語）読み取り失敗・標準の言語で送る: ' + err);
  }
  return (__partnerLangMemo_ = map);
}

/** 車屋のグループに出す言語（並び順どおり）。設定が空欄・読めない時は標準（クメール語＋英語＋日本語） */
function shopGroupLangs_(shopId) {
  var map = readShopGroupLangs_();
  var v = (shopId && Object.prototype.hasOwnProperty.call(map, String(shopId))) ? map[String(shopId)] : '';
  return parsePartnerLangs_(v) || PARTNER_LANG_SHOP_DEFAULT.slice();
}

/** texts = {km, en, ja} を langs の順に並べた配列（その言語の文が無ければ飛ばす） */
function langLines_(langs, texts) {
  return (langs || []).map(function(l) { return texts[l]; }).filter(function(t) { return t; });
}

/** 1行にまとめる（「ក្រុម / Group / グループ」） */
function langJoin_(langs, texts, sep) {
  return langLines_(langs, texts).join(sep || ' / ');
}

/** {n} 等を差し込んだ texts を返す（値に $& などがあっても特殊展開しない） */
function langFill_(texts, vars) {
  var out = {};
  Object.keys(texts).forEach(function(l) {
    var t = texts[l];
    Object.keys(vars || {}).forEach(function(k) { t = t.split('{' + k + '}').join(String(vars[k])); });
    out[l] = t;
  });
  return out;
}

// ====== 車屋のグループ宛の文面 ======
// クメール語は草案（Panha 校閲待ち・2026-10-26）。日本語は 2026-10-26 新設
var SHOP_GROUP_TEXT = {
  connected:    { km: 'បានភ្ជាប់ក្រុមហើយ!', en: 'Connected!', ja: '連携完了！' },
  newCustomer:  { km: 'មានភ្ញៀវថ្មីមកតាម QR របស់ហាងអ្នក!', en: 'New customer from your QR!', ja: 'お店のQRからお客様が来ました！' },
  name:         { km: 'ឈ្មោះ', en: 'Name', ja: 'お名前' },
  followUp:     { km: 'ភ្ញៀវទើបតែបើក Bot កក់របស់យើង។ យើងនឹងទាក់ទងបន្ត!', en: 'They just opened our booking bot. We will follow up!',
                  ja: '予約Botを開いたところです。こちらからご案内します！' },
  shop:         { km: 'ហាង', en: 'Shop', ja: 'お店' },
  ordersHere:   { km: 'ការកក់របស់ភ្ញៀវដែលកក់តាម QR របស់ហាងអ្នក នឹងបង្ហាញនៅក្នុងក្រុមនេះ។',
                  en: 'Orders from your QR code will appear in this group.',
                  ja: 'このグループに、お店のQR経由のご注文が届くようになりました。' },
  startQr:      { km: 'ចាប់ផ្តើមលាងសម្អាត (ភ្ញៀវដែលកក់តាម QR របស់ហាងអ្នក)', en: 'Job started (customer from your QR)', ja: '作業開始（お店の QR からのお客様）' },
  endQr:        { km: 'លាងសម្អាតរួចរាល់ (ភ្ញៀវដែលកក់តាម QR របស់ហាងអ្នក)', en: 'Job finished (customer from your QR)', ja: '作業完了（お店の QR からのお客様）' },
  startShop:    { km: 'ចាប់ផ្តើមលាងសម្អាត (ការងាររបស់ហាង)', en: 'Job started (your shop)', ja: '作業開始（お店のご依頼）' },
  endShop:      { km: 'លាងសម្អាតរួចរាល់ (ការងាររបស់ហាង)', en: 'Job finished (your shop)', ja: '作業完了（お店のご依頼）' },
  minutes:      { km: '{n} នាទី', en: '{n} min', ja: '{n}分' },
  beforePhotos: { km: 'រូបថតមុនលាង', en: 'Before photos', ja: '作業前の写真' },
  afterPhotos:  { km: 'រូបថតក្រោយលាង', en: 'After photos', ja: '作業後の写真' }
};

/** 連携完了の返事（/register・車屋） */
function shopGroupConnectedText_(langs, shopName) {
  return '✅ ' + langJoin_(langs, SHOP_GROUP_TEXT.connected) + '\n' +
    langJoin_(langs, SHOP_GROUP_TEXT.shop) + ': ' + shopName + '\n\n' +
    langLines_(langs, SHOP_GROUP_TEXT.ordersHere).join('\n');
}

/**
 * 作業の開始・完了（車屋のグループ宛）
 * @param {Array} langs
 * @param {Object} p - { phase: 'start'|'end', who: 'qr'|'shop', name, car, duration, photos: 'before'|'after'|'' }
 *   name / car / duration は渡した時だけ行を出す（空なら「-」）
 */
function shopGroupJobText_(langs, p) {
  var head = SHOP_GROUP_TEXT[(p.phase === 'start' ? 'start' : 'end') + (p.who === 'qr' ? 'Qr' : 'Shop')];
  var lines = langLines_(langs, head);
  lines[0] = (p.phase === 'start' ? '▶️ ' : '✅ ') + lines[0];
  if (p.name !== undefined) lines.push('👤 ' + (p.name || '-'));
  if (p.car !== undefined) lines.push('🚗 ' + (p.car || '-'));
  if (p.duration !== undefined) lines.push('⏱ ' + langJoin_(langs, langFill_(SHOP_GROUP_TEXT.minutes, { n: p.duration })));
  if (p.photos) lines.push(shopGroupPhotosLine_(langs, p.photos));
  return lines.join('\n');
}

/** 「📷 រូបថតមុនលាង / Before photos / 作業前の写真 ↓」 */
function shopGroupPhotosLine_(langs, which) {
  return '📷 ' + langJoin_(langs, which === 'before' ? SHOP_GROUP_TEXT.beforePhotos : SHOP_GROUP_TEXT.afterPhotos) + ' ↓';
}
