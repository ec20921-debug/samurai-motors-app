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
 *   - 読み方・別名・区切りは v7-operations/PartnerLangOps.gs と同じ（別 GAS のため複製）。直すときは両方を直す
 *
 * クメール語は Panha 校閲（2026-10-26・provisional・Run Kosal 確認待ち: native-check-queue「2026-10-26 提携店グループ宛 三言語通知」）。
 * 文言を直すときは Panha を通す（Red Line #7）
 */

var PARTNER_GROUP_LANG_COL = 'グループへの通知の言語';
var PARTNER_LANG_SHOP_DEFAULT = ['km', 'en', 'ja'];   // 車屋の標準（Daisuke 2026-10-26）
var PARTNER_LANG_CACHE_KEY = 'shop_group_langs_v1';
var PARTNER_LANG_CACHE_SEC = 300;
var PARTNER_LANG_LKG_KEY = 'shop_group_langs_lkg_v1';   // 最後に読めた内容（読めない時に全店が標準へ倒れないように）
var PARTNER_LANG_LKG_SEC = 6 * 60 * 60;
var PARTNER_LANG_SPLIT = /[＋+,、，・\/&＆→＞>\s]+|と/;
var PARTNER_LANG_WORDS = {
  'クメール語': 'km', 'クメール': 'km', 'カンボジア語': 'km', '英語': 'en', '英': 'en', '日本語': 'ja', '日本': 'ja',
  km: 'km', en: 'en', ja: 'ja', khmer: 'km', english: 'en', japanese: 'ja'
};
var __partnerLangMemo_ = null;

/** 「クメール語＋英語＋日本語」→ ['km','en','ja']。分からない語は無視。1つも無ければ null */
function parsePartnerLangs_(v) {
  var out = [];
  String(v || '').split(PARTNER_LANG_SPLIT).forEach(function(w) {
    var key = String(w || '').trim().toLowerCase();
    var code = Object.prototype.hasOwnProperty.call(PARTNER_LANG_WORDS, key) ? PARTNER_LANG_WORDS[key] : '';
    if (code && out.indexOf(code) < 0) out.push(code);
  });
  return out.length ? out : null;
}

/**
 * 店マスター → { shop_id: 列の値 }（5分キャッシュ・実行内メモ）。列が無い時は {}。
 * 読めない時は最後に読めた内容（6時間）、それも無ければ {}（＝全店が標準）
 * @param {boolean} [fresh] - キャッシュを使わず読み直す（連携完了・あいさつ文など取り消せない1回きりの送信の前）
 */
function readShopGroupLangs_(fresh) {
  if (__partnerLangMemo_ && !fresh) return __partnerLangMemo_;
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (ignore) {}
  if (cache && !fresh) {
    try {
      var hit = JSON.parse(cache.get(PARTNER_LANG_CACHE_KEY) || 'null');
      if (hit && typeof hit === 'object') return (__partnerLangMemo_ = hit);
    } catch (ignore) {}
  }
  var map = {};
  try {
    var sh = getSpreadsheet().getSheetByName('店マスター');
    if (!sh) throw new Error('店マスター タブがありません');
    if (sh.getLastRow() >= 2) {
      var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function(h) { return String(h).trim(); });
      var ci = head.indexOf('shop_id'), li = head.indexOf(PARTNER_GROUP_LANG_COL);
      if (ci >= 0 && li >= 0) {
        var n = sh.getLastRow() - 1;
        var ids = sh.getRange(2, ci + 1, n, 1).getValues(), vals = sh.getRange(2, li + 1, n, 1).getValues();   // 2列だけ読む
        ids.forEach(function(r, k) {
          var id = String(r[0] || '').trim(), v = String(vals[k][0] || '').trim();
          if (id && v) map[id] = v;
        });
      }
    }
    if (cache) {
      var json = JSON.stringify(map);
      try { cache.put(PARTNER_LANG_CACHE_KEY, json, PARTNER_LANG_CACHE_SEC); } catch (ignore) {}
      try { cache.put(PARTNER_LANG_LKG_KEY, json, PARTNER_LANG_LKG_SEC); } catch (ignore) {}
    }
  } catch (err) {
    Logger.log('⚠️ 店マスター（通知の言語）読み取り失敗: ' + err);
    try {
      var lkg = cache ? JSON.parse(cache.get(PARTNER_LANG_LKG_KEY) || 'null') : null;
      if (lkg && typeof lkg === 'object') { map = lkg; Logger.log('ℹ️ 通知の言語: 最後に読めた内容（6時間以内）を使う'); }
    } catch (ignore) {}
  }
  return (__partnerLangMemo_ = map);
}

/**
 * そのグループに出す言語（並び順どおり）。例外は外へ出さない
 *   レジデンス等の提携先 = 英語・個人提携 = 日本語＋英語（固定。この設定は使わない）
 *   車屋 = 店マスターの設定。空欄・読めない時は標準（クメール語＋英語＋日本語）
 * @param {boolean} [fresh] - 設定を読み直す（readShopGroupLangs_）
 */
function shopGroupLangs_(shopId, fresh) {
  try {
    if (shopId && typeof sourcePartnerState_ === 'function' && sourcePartnerState_(shopId) === true) return ['en'];
    if (shopId && typeof individualPartnerState_ === 'function' && individualPartnerState_(shopId) === true) return ['ja', 'en'];
    var map = readShopGroupLangs_(fresh);
    var v = (shopId && map && Object.prototype.hasOwnProperty.call(map, String(shopId))) ? map[String(shopId)] : '';
    return parsePartnerLangs_(v) || PARTNER_LANG_SHOP_DEFAULT.slice();
  } catch (err) {
    Logger.log('⚠️ shopGroupLangs_（標準の言語で送る）: ' + err);
    return PARTNER_LANG_SHOP_DEFAULT.slice();
  }
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
// クメール語は Panha 校閲（2026-10-26・provisional）。作業は洗車以外もあるので លាង でなく ការងារ / ធ្វើសេវា。日本語は 2026-10-26 新設
var SHOP_GROUP_TEXT = {
  connected:    { km: 'បានភ្ជាប់ក្រុមហើយ!', en: 'Connected!', ja: '連携完了！' },
  newCustomer:  { km: 'មានភ្ញៀវថ្មីមកតាម QR របស់ហាងអ្នក!', en: 'New customer from your QR!', ja: 'お店のQRからお客様が来ました！' },
  name:         { km: 'ឈ្មោះ', en: 'Name', ja: 'お名前' },
  followUp:     { km: 'ភ្ញៀវទើបតែបើក Bot សម្រាប់កក់ របស់យើង។ យើងនឹងទាក់ទងបន្ត!', en: 'They just opened our booking bot. We will follow up!',
                  ja: '予約Botを開いたところです。こちらからご案内します！' },
  shop:         { km: 'ហាង', en: 'Shop', ja: 'お店' },
  ordersHere:   { km: 'ដំណឹងអំពីការកក់តាម QR របស់ហាងអ្នក នឹងផ្ញើមកក្នុងក្រុមនេះ។',
                  en: 'Orders from your QR code will appear in this group.',
                  ja: 'このグループに、お店のQR経由のご注文が届くようになりました。' },
  startQr:      { km: 'ការងារចាប់ផ្តើមហើយ (ភ្ញៀវដែលកក់តាម QR របស់ហាងអ្នក)', en: 'Job started (customer from your QR)', ja: '作業開始（お店の QR からのお客様）' },
  endQr:        { km: 'ការងារបញ្ចប់ហើយ (ភ្ញៀវដែលកក់តាម QR របស់ហាងអ្នក)', en: 'Job finished (customer from your QR)', ja: '作業完了（お店の QR からのお客様）' },
  startShop:    { km: 'ការងារចាប់ផ្តើមហើយ (តាមការស្នើសុំ របស់ហាងអ្នក)', en: 'Job started (your shop)', ja: '作業開始（お店のご依頼）' },
  endShop:      { km: 'ការងារបញ្ចប់ហើយ (តាមការស្នើសុំ របស់ហាងអ្នក)', en: 'Job finished (your shop)', ja: '作業完了（お店のご依頼）' },
  minutes:      { km: '{n} នាទី', en: '{n} min', ja: '{n}分' },
  beforePhotos: { km: 'រូបថតមុនធ្វើសេវា', en: 'Before photos', ja: '作業前の写真' },
  afterPhotos:  { km: 'រូបថតក្រោយធ្វើសេវា', en: 'After photos', ja: '作業後の写真' }
};

/** 連携完了の返事（/register・車屋） */
function shopGroupConnectedText_(langs, shopName) {
  return '✅ ' + langJoin_(langs, SHOP_GROUP_TEXT.connected) + '\n' +
    langJoin_(langs, SHOP_GROUP_TEXT.shop) + ': ' + shopName + '\n\n' +
    langLines_(langs, SHOP_GROUP_TEXT.ordersHere).join('\n');
}

/**
 * 作業の開始・完了（車屋のグループ宛）。見出しは言語ごとに1行
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

/** 「📷 រូបថតមុនធ្វើសេវា / Before photos / 作業前の写真 ↓」 */
function shopGroupPhotosLine_(langs, which) {
  return '📷 ' + langJoin_(langs, which === 'before' ? SHOP_GROUP_TEXT.beforePhotos : SHOP_GROUP_TEXT.afterPhotos) + ' ↓';
}
