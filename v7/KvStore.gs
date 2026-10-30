/**
 * KvStore.gs — お客様ごと・お店ごと・予約ごとの小さな状態の置き場（v7 Database「状態」タブ）
 *
 * 【なぜ】（2026-10-31 Daisuke「設定が50個でいっぱい」→ 置き場の整理①）
 *   Script Properties は Bot の鍵・シートの住所など「設定」の置き場。ところが 2026-10 までに
 *   shop_ref_（お客様→紹介元の店）・shopref_at_（紹介元が付いた日）・src_ref_（流入元）・selfreg_*（本人登録リンクの状態）・
 *   srcgrp_（提携先グループの予約の印）・shop_greeting_sent_（あいさつ済み）が Script Properties に書かれ、
 *   お客様が増えるほど増える（消す仕組みが無いものもある）。設定画面（50個まで）が読み取り専用になり設定を足せなくなった。
 *   → これらを「状態」タブ（キー／値／更新日時）へ移す。Script Properties は設定だけに戻す（20個以内）。
 *
 * 【使い方】Script Properties と同じ感覚で使う（キーの名前は変えない）
 *   kvGet_(key)            : 値（無ければ null）
 *   kvSet_(key, value)     : 1件書く
 *   kvSetAll_({k: v, …})   : まとめて書く
 *   kvDelete_(key)         : 消す
 *   kvGetAll_(prefix)      : prefix で始まるキーを { key: value } で全部（読めない時は例外＝呼び元で止める）
 *
 * 【安全側の作り】（日々の営業に支障を出さない・2026-10-31 Daisuke）
 *   - タブが読めない時: 読みは「最後に読めた内容」（Cache・5分）→ それも無ければ Script Properties（移行前の置き場）→ null
 *   - タブに書けない時: Script Properties に退避して記録に残す（後で kvMigrateFromProperties が拾う）。値は失わない
 *   - 書きはロック（getDocumentLock）で順番に。ScriptLock を持ったまま呼ばれても固まらない（別のロック）
 *   - 書いたら Cache も同時に更新する（別の実行が1分以内に読んでも古い値にならない）
 *   - 移行前の Script Properties にまだ残っている値は、タブに無い時だけ読む（kvMigrateFromProperties で全部タブへ）
 *
 * 【移行】本番へ入れたあと、エディタで kvMigrateFromProperties() を1回実行（何度実行しても同じ結果）。kvStatus() で確認
 */

var KV_SHEET_NAME_ = '状態';
var KV_HEADERS_ = ['キー(key)', '値(value)', '更新日時(updated_at)'];
// Script Properties から「状態」タブへ移すキー（これ以外のキーは今までどおり Script Properties）
var KV_PREFIXES_ = [
  'shop_ref_', 'shopref_at_', 'shopref_dates_migrated_v1',   // ReferralAttribution.gs / ShopRouting.gs / CampaignShopFilter.gs
  'src_ref_',                                                 // SourceCampaign.gs
  'srcgrp_',                                                  // SourceGroupNotify.gs
  'selfreg_', 'partner_flyers_sent_',                         // PartnerSelfRegister.gs
  'shop_greeting_sent_'                                       // ShopGroupGreeting.gs
];
var KV_CACHE_META_ = 'kv_state_v1_meta';
var KV_CACHE_CHUNK_ = 'kv_state_v1_c';
var KV_CACHE_SEC_ = 5 * 60;
var KV_CACHE_CHUNK_CHARS_ = 90000;   // CacheService は 1件 100KB まで
var KV_MEMO_MS_ = 3000;              // 同じ実行の中で何度も読む時の使い回し（3秒。別の実行の書き込みを長く見落とさない）
var KV_LOCK_MS_ = 10 * 1000;
var __kvMemo_ = null;
var __kvMemoAt_ = 0;

// ====== 公開（_ 付きの内部関数だが、他ファイルから呼ぶ） ======

/** 値を返す（無ければ null）。タブ → 最後に読めた内容 → Script Properties（移行前） の順 */
function kvGet_(key) {
  key = String(key || '');
  if (!key) return null;
  var map = kvLoad_(false);
  if (map && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  if (!kvIsManaged_(key)) return null;
  try {
    return PropertiesService.getScriptProperties().getProperty(key);
  } catch (err) {
    return null;
  }
}

/** prefix で始まるキーを全部 { key: value } で返す。タブが読めず最後に読めた内容も無い時は例外（呼び元で送信などを止める） */
function kvGetAll_(prefix) {
  prefix = String(prefix || '');
  var map = kvLoad_(false);
  if (!map) throw new Error('状態タブを読めません（' + KV_SHEET_NAME_ + '）');
  var out = {};
  // 移行前の Script Properties に残っているもの（タブの値が優先）
  try {
    var all = PropertiesService.getScriptProperties().getProperties();
    Object.keys(all).forEach(function(k) {
      if (k.indexOf(prefix) === 0 && kvIsManaged_(k) && all[k]) out[k] = all[k];
    });
  } catch (ignore) {}
  Object.keys(map).forEach(function(k) {
    if (k.indexOf(prefix) === 0 && map[k]) out[k] = map[k];
  });
  return out;
}

function kvSet_(key, value) {
  var obj = {};
  obj[String(key)] = value;
  kvSetAll_(obj);
}

/** まとめて書く（{ key: value }）。null / undefined は空文字で書く */
function kvSetAll_(obj) {
  var keys = Object.keys(obj || {});
  if (!keys.length) return;
  var written = kvWrite_(function(sheet, state) {
    var now = kvNow_();
    keys.forEach(function(k) {
      var v = (obj[k] === null || obj[k] === undefined) ? '' : String(obj[k]);
      kvWriteRow_(sheet, state, k, v, now);
      state.map[k] = v;
    });
  });
  if (written) {
    // 移行前の置き場に同じキーが残っていたら消す（消したあとに古い値が顔を出さないように）
    keys.forEach(function(k) { kvLegacyDelete_(k); });
    return;
  }
  // タブに書けなかった → Script Properties へ退避（値を失わない。kvMigrateFromProperties が後でタブへ移す）
  Logger.log('⚠️ 状態タブに書けないので Script Properties へ退避: ' + keys.join(','));
  var props = PropertiesService.getScriptProperties();
  keys.forEach(function(k) {
    var v = (obj[k] === null || obj[k] === undefined) ? '' : String(obj[k]);
    props.setProperty(k, v);
  });
}

function kvDelete_(key) {
  key = String(key || '');
  if (!key) return;
  kvWrite_(function(sheet, state) {
    if (state.rows[key]) {
      sheet.getRange(state.rows[key], 1, 1, KV_HEADERS_.length).setValues([['', '', '']]);
      state.blanks.push(state.rows[key]);
      delete state.rows[key];
    }
    delete state.map[key];
  });
  kvLegacyDelete_(key);
}

// ====== 読み ======

/** { key: value } を返す。読めない時は null。fresh=true はタブを読み直す（書く直前用） */
function kvLoad_(fresh) {
  var now = Date.now();
  if (!fresh && __kvMemo_ && now - __kvMemoAt_ < KV_MEMO_MS_) return __kvMemo_;
  var map = null;
  if (!fresh) map = kvCacheGet_();
  if (!map) {
    try {
      var state = kvReadSheet_(true);
      map = state.map;
      kvCachePut_(map);
    } catch (err) {
      Logger.log('⚠️ 状態タブを読めません: ' + err);
      map = fresh ? null : kvCacheGet_();
    }
  }
  if (map) { __kvMemo_ = map; __kvMemoAt_ = now; }
  return map;
}

/** タブを読んで { map, rows: {key: 行番号}, blanks: [空いている行番号], sheet } を返す。無ければ作る */
function kvReadSheet_(create) {
  var sheet = kvSheet_(create);
  if (!sheet) throw new Error('状態タブがありません');
  var values = sheet.getDataRange().getValues();
  var map = {}, rows = {}, blanks = [];
  for (var i = 1; i < values.length; i++) {
    var k = String(values[i][0] || '');
    if (!k) { blanks.push(i + 1); continue; }
    map[k] = String(values[i][1] === null || values[i][1] === undefined ? '' : values[i][1]);
    rows[k] = i + 1;
  }
  return { map: map, rows: rows, blanks: blanks, sheet: sheet, lastRow: values.length };
}

function kvSheet_(create) {
  var ss = (typeof getSpreadsheet === 'function')
    ? getSpreadsheet()
    : SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'));
  var sheet = ss.getSheetByName(KV_SHEET_NAME_);
  if (sheet || !create) return sheet;
  sheet = ss.insertSheet(KV_SHEET_NAME_);
  sheet.getRange(1, 1, 1, KV_HEADERS_.length).setValues([KV_HEADERS_]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  try { sheet.setColumnWidth(1, 260); sheet.setColumnWidth(2, 420); sheet.setColumnWidth(3, 160); } catch (ignore) {}
  Logger.log('🗂 状態タブを作成: ' + KV_SHEET_NAME_);
  return sheet;
}

// ====== 書き ======

/** ロックを取り、タブを読み直してから fn(sheet, state) で書く。書けたら true（Cache・メモも更新）。書けなければ false */
function kvWrite_(fn) {
  var lock = kvLock_();
  var locked = false;
  try {
    try { locked = !!lock && lock.tryLock(KV_LOCK_MS_); } catch (err) { locked = false; }
    if (lock && !locked) {
      Logger.log('⚠️ 状態タブのロックを取れません');
      return false;
    }
    var state = kvReadSheet_(true);
    fn(state.sheet, state);
    kvCachePut_(state.map);
    __kvMemo_ = state.map;
    __kvMemoAt_ = Date.now();
    return true;
  } catch (err) {
    Logger.log('⚠️ 状態タブに書けません: ' + err);
    return false;
  } finally {
    if (locked) { try { lock.releaseLock(); } catch (ignore) {} }
  }
}

function kvWriteRow_(sheet, state, key, value, now) {
  var row = state.rows[key];
  if (!row) {
    row = state.blanks.length ? state.blanks.shift() : (state.lastRow + 1);
    if (row > state.lastRow) state.lastRow = row;
    state.rows[key] = row;
  }
  sheet.getRange(row, 1, 1, KV_HEADERS_.length).setValues([[key, value, now]]);
}

/** 書き込み用のロック。ScriptLock を持ったまま呼ばれる場所（あいさつ文・本人登録リンク）があるので DocumentLock を使う */
function kvLock_() {
  try {
    if (typeof LockService.getDocumentLock === 'function') {
      var dl = LockService.getDocumentLock();
      if (dl) return dl;
    }
  } catch (ignore) {}
  try { return LockService.getScriptLock(); } catch (ignore) {}
  return null;
}

function kvLegacyDelete_(key) {
  if (!kvIsManaged_(key)) return;
  try { PropertiesService.getScriptProperties().deleteProperty(key); } catch (ignore) {}
}

// ====== Cache（最後に読めた内容・5分） ======

function kvCacheGet_() {
  try {
    var cache = CacheService.getScriptCache();
    var meta = cache.get(KV_CACHE_META_);
    if (!meta) return null;
    var n = Number(meta) || 0;
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(KV_CACHE_CHUNK_ + i);
    var parts = cache.getAll(keys);
    var json = '';
    for (var j = 0; j < n; j++) {
      if (!parts[KV_CACHE_CHUNK_ + j]) return null;   // 欠けたら使わない
      json += parts[KV_CACHE_CHUNK_ + j];
    }
    return JSON.parse(json || '{}');
  } catch (err) {
    return null;
  }
}

function kvCachePut_(map) {
  try {
    var cache = CacheService.getScriptCache();
    var json = JSON.stringify(map || {});
    var put = {};
    var n = 0;
    for (var i = 0; i < json.length; i += KV_CACHE_CHUNK_CHARS_) {
      put[KV_CACHE_CHUNK_ + n] = json.substring(i, i + KV_CACHE_CHUNK_CHARS_);
      n++;
    }
    put[KV_CACHE_META_] = String(n);
    cache.putAll(put, KV_CACHE_SEC_);
  } catch (ignore) {}
}

// ====== 小物 ======

function kvIsManaged_(key) {
  key = String(key || '');
  for (var i = 0; i < KV_PREFIXES_.length; i++) {
    if (key.indexOf(KV_PREFIXES_[i]) === 0) return true;
  }
  return false;
}

function kvNow_() {
  try { return Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss'); } catch (err) { return new Date().toISOString(); }
}

// ====== 移行・確認（エディタから実行） ======

/**
 * 移行前に Script Properties に残っている対象キーを「状態」タブへ移し、Script Properties から消す。
 * 何度実行しても同じ結果。Script Properties の値を優先する（タブに書けず退避した値は新しい方なので）
 */
function kvMigrateFromProperties() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var keys = Object.keys(all).filter(function(k) { return kvIsManaged_(k); }).sort();
  Logger.log('🚚 移す対象: ' + keys.length + '件');
  if (!keys.length) { Logger.log('✅ 移すものはありません'); return; }
  var moved = 0;
  for (var i = 0; i < keys.length; i += 50) {
    var batch = keys.slice(i, i + 50);
    var obj = {};
    batch.forEach(function(k) { obj[k] = all[k]; });
    var ok = kvWrite_(function(sheet, state) {
      var now = kvNow_();
      batch.forEach(function(k) { kvWriteRow_(sheet, state, k, obj[k], now); state.map[k] = obj[k]; });
    });
    if (!ok) throw new Error('状態タブに書けないので中止しました（' + i + '件目から）。Script Properties はそのまま');
    // 書けたことをタブから読み直して確かめてから消す
    var check = kvReadSheet_(false).map;
    batch.forEach(function(k) {
      if (check[k] === String(all[k])) { props.deleteProperty(k); moved++; }
      else Logger.log('⚠️ 確認できず残しました: ' + k);
    });
  }
  Logger.log('✅ 移行完了: ' + moved + '/' + keys.length + '件を状態タブへ。残りの Script Properties: ' + Object.keys(props.getProperties()).length + '個');
}

/** 状態タブと Script Properties の件数を表示する */
function kvStatus() {
  var state = kvReadSheet_(false);
  var all = PropertiesService.getScriptProperties().getProperties();
  var legacy = Object.keys(all).filter(function(k) { return kvIsManaged_(k); });
  var byPrefix = {};
  Object.keys(state.map).forEach(function(k) {
    var p = (k.match(/^[a-z_]+?_/) || [k])[0];
    byPrefix[p] = (byPrefix[p] || 0) + 1;
  });
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🗂 状態タブ: ' + Object.keys(state.map).length + '件 ' + JSON.stringify(byPrefix));
  Logger.log('🔑 Script Properties: 全部 ' + Object.keys(all).length + '個／まだ移していない対象 ' + legacy.length + '個' + (legacy.length ? ' → kvMigrateFromProperties() を実行' : ''));
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
