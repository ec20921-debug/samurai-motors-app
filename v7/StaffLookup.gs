/**
 * StaffLookup.gs — 現場スタッフの特定（チャットID → スタッフID・名前）
 *
 * 2026-10-31（中核の表の設計 v0.1 7章「今の GAS で先に直せること」）:
 *   作業記録の「スタッフID」「スタッフ名」は、現場アプリもサーバーも情報を持っているのに
 *   ずっと空欄だった（実測 145件中 145件）。Router が署名（Telegram initData）か専用リンクで
 *   確かめた送り主（body._authUserId）を、スタッフマスターで スタッフID・名前 に引き直して書く。
 *
 * 正本は v7-operations（経費・勤務関連）の「スタッフマスター」。v7 からは StaffGate.gs と同じ
 * OPERATIONS_SPREADSHEET_ID で読む。読めない時は最後に読めた一覧（6時間）→ それも無ければ空
 * （作業記録は従来どおり空欄のまま・業務は止めない）。
 */

var STAFF_LOOKUP_CACHE_KEY_ = 'staff_lookup_v1';
var STAFF_LOOKUP_LKG_KEY_   = 'staff_lookup_lkg_v1';
var STAFF_LOOKUP_MISS_KEY_  = 'staff_lookup_miss_v1';   // 読めなかった印（この間は他のスプレッドシートを開きに行かない）
var STAFF_LOOKUP_CACHE_SEC_ = 600;          // 10分（スタッフマスターの変更が反映されるまでの最大時間）
var STAFF_LOOKUP_LKG_SEC_   = 6 * 3600;     // シートが読めない間だけ使う最後に読めた一覧
var STAFF_LOOKUP_MISS_SEC_  = 120;

/**
 * チャットID → スタッフ（有効な行だけ）。例外は外に出さない（作業記録の保存・通知を巻き込まない）
 * @return {{staffId:string, nameJp:string, nameEn:string}|null}
 */
function staffByChatId_(chatId) {
  try {
    var id = String(chatId || '').trim();
    if (!id) return null;
    var map = staffLookupMap_();
    return (map && Object.prototype.hasOwnProperty.call(map, id)) ? map[id] : null;
  } catch (e) {
    Logger.log('⚠️ staffByChatId_（スタッフは空のまま続行）: ' + e);
    return null;
  }
}

/**
 * 作業記録に書く2列。送り主が確かめられない・スタッフマスターに無い時は {}（何も書かない）
 * 送り主は Router が入れる body._staffUserId（スタッフ専用の操作で StaffGate が確かめたスタッフ＝署名または専用リンク）、
 * 無ければ body._authUserId（署名で確かめた本人）
 */
function jobStaffColumns_(body) {
  try {
    var st = staffByChatId_((body && (body._staffUserId || body._authUserId)) || '');
    if (!st || !st.staffId) return {};
    return { 'スタッフID': st.staffId, 'スタッフ名': st.nameJp || st.nameEn || '' };
  } catch (e) {
    Logger.log('⚠️ jobStaffColumns_（スタッフは空のまま続行）: ' + e);
    return {};
  }
}

/**
 * 作業記録の既存行を更新する時: スタッフIDが空の行だけ、この送信の送り主で埋める（入っている値は上書きしない）
 * @param {Object} updates - updateRow に渡すオブジェクト（ここに足す）
 * @param {Object|null} rowData - 既存行（readRow の結果）。無ければ空扱い
 * @return {Object} updates
 */
function jobStaffFill_(updates, rowData, body) {
  updates = updates || {};
  try {
    if (rowData && String(rowData['スタッフID'] || '').trim()) return updates;
    var cols = jobStaffColumns_(body);
    Object.keys(cols).forEach(function(k) { updates[k] = cols[k]; });
  } catch (e) {
    Logger.log('⚠️ jobStaffFill_（スタッフは空のまま続行）: ' + e);
  }
  return updates;
}

/** { chatId: {staffId, nameJp, nameEn} }。読めない時は最後に読めた一覧、それも無ければ null */
function staffLookupMap_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(STAFF_LOOKUP_CACHE_KEY_);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* 読み直す */ }
  }
  var lkg = null;
  try { lkg = JSON.parse(cache.get(STAFF_LOOKUP_LKG_KEY_) || 'null'); } catch (e1) { lkg = null; }
  if (cache.get(STAFF_LOOKUP_MISS_KEY_)) return lkg;   // 直前に読めなかった: 2分は開きに行かない（作業の保存を待たせない）
  var map = staffLookupReadSheet_();
  if (map) {
    var json = JSON.stringify(map);
    cache.put(STAFF_LOOKUP_CACHE_KEY_, json, STAFF_LOOKUP_CACHE_SEC_);
    cache.put(STAFF_LOOKUP_LKG_KEY_, json, STAFF_LOOKUP_LKG_SEC_);
    return map;
  }
  cache.put(STAFF_LOOKUP_MISS_KEY_, '1', STAFF_LOOKUP_MISS_SEC_);
  return lkg;
}

function staffLookupReadSheet_() {
  try {
    var ssId = PropertiesService.getScriptProperties().getProperty('OPERATIONS_SPREADSHEET_ID');
    if (!ssId) return null;
    var sheet = SpreadsheetApp.openById(ssId).getSheetByName('スタッフマスター');
    if (!sheet) return null;
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return null;
    var head = values[0].map(function(h) { return String(h).trim(); });
    var cId = head.indexOf('Chat ID'), cOn = head.indexOf('有効'), cSid = head.indexOf('スタッフID');
    var cJp = head.indexOf('氏名(JP)'), cEn = head.indexOf('Name(EN)');
    if (cId < 0 || cOn < 0 || cSid < 0) return null;
    var map = {};
    for (var i = 1; i < values.length; i++) {
      var r = values[i];
      var on = r[cOn];
      var chat = String(r[cId] || '').trim();
      if (!chat || !(on === true || String(on).toUpperCase() === 'TRUE')) continue;
      map[chat] = {
        staffId: String(r[cSid] || '').trim(),
        nameJp:  cJp >= 0 ? String(r[cJp] || '').trim() : '',
        nameEn:  cEn >= 0 ? String(r[cEn] || '').trim() : ''
      };
    }
    return map;
  } catch (err) {
    Logger.log('⚠️ staffLookupReadSheet_: ' + err);
    return null;
  }
}
