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
 *   kvGetStrict_(key, fresh): kvGet_ と同じだが、読めない時は例外（取り消せない送信の「送ったか」の確認用）。
 *                            fresh=true はタブと退避を読み直す（ロックの中の確かめ直しで、ロックの前に読んだ古い内容を使わない）
 *
 * 【安全側の作り】（日々の営業に支障を出さない・2026-10-31 Daisuke）
 *   - タブが読めない時: 読みは「最後に読めた内容」（Cache・5分）→ それも無ければ Script Properties（移行前の置き場）→ null
 *   - タブに書けない時: Script Properties の 1 キー（kv_retreat_v1・JSON）に退避して記録に残す。値は失わない。
 *     読む時は退避が最優先（退避した値の方が新しい）。毎分のキュー処理が自動でタブへ移す（kvAutoMigrate_）
 *   - 書きはロック（DocumentLock）で順番に。ScriptLock を持ったまま呼ばれても固まらない（別のロック）
 *     （v7 は v7 Database に付いた container-bound のスクリプトなので DocumentLock が取れる。取れない時だけ UserLock →
 *       ScriptLock に落ち、ログに出す。2026-10-31）
 *   - 消せなかった時は退避に「消した」印（空文字）を置く（タブに残った古い値が読まれない。毎分の処理がタブの行を空にする）
 *   - 退避から外すのはロックの中（毎分の処理がロックの中で退避を読み直してタブへ移すので、移したあとに古い退避で上書きしない）。
 *     退避は Script Properties の 1 キー（9KB まで）なので、大きくなったら管理グループに知らせる
 *   - タブの行が足りなければ足す（新しいシートは 1,000 行。範囲の外には書けない）
 *   - 書いたら Cache も同時に更新する（別の実行が1分以内に読んでも古い値にならない）
 *   - 移行前の Script Properties にまだ残っている値は、タブに無い時だけ読む（kvMigrateFromProperties で全部タブへ）
 *
 * 【値は文字のまま】（2026-10-31 不具合の修正）
 *   シートは「2026-10-26 15:25:36」のような文字を、そのまま書くと日付に変えてしまう（数字だけの文字は数値に）。
 *   読むと Date になり、String() すると「Mon Oct 26 2026 …」の形になって、日時の前後比べが狂う
 *   （@105 で Hiro さんのグループにチラシが再送された原因。毎時の安全網の「11時より前のグループには送らない」が効かなかった）。
 *   → 書く時は書式を書式なしテキスト（@）にしてから書く。読む時、日付・数値になっていたら元の文字の形に戻す
 *     （日付はシートのタイムゾーンで yyyy-MM-dd HH:mm:ss・時刻 0:00:00 は yyyy-MM-dd）。戻した行は次に書く時に文字で書き直す
 *     （毎分のキュー処理も 6 時間に 1 回確かめて書き直す・エディタからは kvRepairTextValues()）
 *
 * 【移行】本番へ入れると、毎分のキュー処理（processTelegramQueue）が kvAutoMigrate_ で自動的に 1 回 100 件ずつタブへ移す
 *   （移行前の値はタブに無い時だけ移す＝タブの方が新しい。退避した値はタブより新しいので上書き）。
 *   エディタで kvMigrateFromProperties() を手で実行してもよい（何度実行しても同じ結果）。kvStatus() で確認
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
// v2: v1 の Cache には日付に化けた値（「Mon Oct 26 2026 …」）が入っているので読まない（2026-10-31）
var KV_CACHE_META_ = 'kv_state_v2_meta';
var KV_CACHE_CHUNK_ = 'kv_state_v2_c';
var KV_TEXT_CHECKED_KEY_ = 'kv_text_checked_v1';   // Cache: 日付・数値に化けた行を確かめた印（6時間）
var KV_TEXT_CHECK_SEC_ = 6 * 60 * 60;
var KV_TEXT_RETRY_SEC_ = 10 * 60;                    // 確かめに失敗した時は 10 分あける（毎分やり直さない）
var KV_CACHE_SEC_ = 5 * 60;
var KV_CACHE_CHUNK_CHARS_ = 30000;   // CacheService は 1件 100KB まで（バイト。日本語・クメール語は 1 文字 3 バイト）
var KV_MEMO_MS_ = 3000;              // 同じ実行の中で何度も読む時の使い回し（3秒。別の実行の書き込みを長く見落とさない）
var KV_LOCK_MS_ = 10 * 1000;
var KV_RETREAT_KEY_ = 'kv_retreat_v1';   // タブに書けなかった値の退避先（Script Properties の 1 キー・JSON）
var KV_MIGRATE_PER_RUN_ = 100;
var KV_GROW_ROWS_ = 200;   // 行が足りない時に足す行数
var KV_RETREAT_WARN_CHARS_ = 7000;   // 退避（Script Properties 1 キー・9KB まで）がこれを超えたら知らせる
var __kvLockLogged_ = false;
var __kvMemo_ = null;
var __kvMemoAt_ = 0;
var __kvRetreatMemo_ = null;
var __kvRetreatMemoAt_ = 0;

// ====== 公開（_ 付きの内部関数だが、他ファイルから呼ぶ） ======

/** 値を返す（無ければ null）。退避 → タブ → 最後に読めた内容 → Script Properties（移行前） の順 */
function kvGet_(key) {
  key = String(key || '');
  if (!key) return null;
  return kvGetFrom_(key, false);
}

/**
 * kvGet_ と同じだが、タブを読めず最後に読めた内容も無い時は例外。
 * 取り消せない送信（あいさつ文・チラシ・本人登録リンク）の前に「もう送ったか」を見る時に使う
 * （読めない時に「未送信」と読んで送ってしまわないように。呼び元は送らずに、あとの再試行に任せる）
 */
function kvGetStrict_(key, fresh) {
  key = String(key || '');
  if (!key) return null;
  return kvGetFrom_(key, true, !!fresh);
}

function kvGetFrom_(key, strict, fresh) {
  var retreat = kvRetreatLoad_(fresh, strict);
  if (Object.prototype.hasOwnProperty.call(retreat, key)) return retreat[key] === '' ? null : retreat[key];   // '' = 消した印
  var map = kvLoad_(!!fresh);
  if (map && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  if (!map && strict) throw new Error('状態タブを読めません（' + KV_SHEET_NAME_ + '）: ' + key);
  if (!kvIsManaged_(key)) return null;
  try {
    return PropertiesService.getScriptProperties().getProperty(key);
  } catch (err) {
    if (strict) throw err;
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
  var retreat = kvRetreatLoad_();
  Object.keys(retreat).forEach(function(k) {
    if (k.indexOf(prefix) === 0) { if (retreat[k]) out[k] = retreat[k]; else delete out[k]; }
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
    // 退避に同じキーが残っていたら外す（ロックの中で。毎分の移行が古い退避でタブを上書きしないように）
    kvRetreatRemove_(keys);
  });
  if (written) {
    // 移行前の置き場に同じキーが残っていたら消す（消したあとに古い値が顔を出さないように）
    keys.forEach(function(k) { kvLegacyDelete_(k); });
    return;
  }
  // タブに書けなかった → 退避（値を失わない。毎分の kvAutoMigrate_ が後でタブへ移す）
  Logger.log('⚠️ 状態タブに書けないので退避（' + KV_RETREAT_KEY_ + '）: ' + keys.join(','));
  var add = {};
  keys.forEach(function(k) { add[k] = (obj[k] === null || obj[k] === undefined) ? '' : String(obj[k]); });
  kvRetreatAdd_(add);
}

function kvDelete_(key) {
  key = String(key || '');
  if (!key) return;
  var written = kvWrite_(function(sheet, state) {
    kvBlankRow_(sheet, state, key);
    kvRetreatRemove_([key]);   // ロックの中で（kvSetAll_ と同じ）
  });
  kvLegacyDelete_(key);
  if (written) return;
  // タブから消せなかった → 退避に「消した」印（空文字）。読む時は退避が最優先なので、タブに残った古い値は読まれない
  //   （送り待ちの印などが残って送り直すのを防ぐ）。毎分の kvAutoMigrate_ がタブの行を空にして印を外す
  Logger.log('⚠️ 状態タブから消せないので退避に「消した」印（' + KV_RETREAT_KEY_ + '）: ' + key);
  var t = {};
  t[key] = '';
  kvRetreatAdd_(t);
}

/** その行を空にする（行は消さない＝行番号がずれない。空いた行は次に使い回す） */
function kvBlankRow_(sheet, state, key) {
  if (state.rows[key]) {
    sheet.getRange(state.rows[key], 1, 1, KV_HEADERS_.length).setValues([['', '', '']]);
    state.blanks.push(state.rows[key]);
    delete state.rows[key];
  }
  delete state.map[key];
}

// ====== 退避（タブに書けなかった値・Script Properties の 1 キー） ======

/**
 * 退避を読む。fresh=true はメモを使わず読み直す。strict=true は読めない時に例外
 * （退避は「タブに書けなかった値・消した印」の置き場。読めないのに「無い」と読むと、取り消せない送信をしてしまう）
 */
function kvRetreatLoad_(fresh, strict) {
  var now = Date.now();
  if (!fresh && __kvRetreatMemo_ && now - __kvRetreatMemoAt_ < KV_MEMO_MS_) return __kvRetreatMemo_;
  var map = {};
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(KV_RETREAT_KEY_);
    if (raw) map = JSON.parse(raw) || {};
  } catch (err) {
    if (strict) throw new Error('退避（' + KV_RETREAT_KEY_ + '）を読めません: ' + err);
    return {};
  }
  __kvRetreatMemo_ = map;
  __kvRetreatMemoAt_ = now;
  return map;
}

function kvRetreatSave_(map) {
  var props = PropertiesService.getScriptProperties();
  if (Object.keys(map).length) {
    var json = JSON.stringify(map);
    if (json.length > KV_RETREAT_WARN_CHARS_) {
      kvWarn_('warn_kv_retreat_big', '⚠️ 状態タブに書けない値が退避にたまっています（' + Object.keys(map).length + '件・' + json.length +
        '文字。上限は約 9KB で、超えると値を失います）。v7 Database「状態」タブが開けるか・行が多すぎないかを確かめてください');
    }
    props.setProperty(KV_RETREAT_KEY_, json);
  } else {
    props.deleteProperty(KV_RETREAT_KEY_);
  }
  __kvRetreatMemo_ = map;
  __kvRetreatMemoAt_ = Date.now();
}

function kvRetreatAdd_(obj) {
  try {
    var map = kvRetreatLoad_(true);
    Object.keys(obj).forEach(function(k) { map[k] = obj[k]; });
    kvRetreatSave_(map);
  } catch (err) {
    Logger.log('❌ 退避にも書けません（値が失われます）: ' + err + ' ' + JSON.stringify(obj));
    kvWarn_('warn_kv_retreat_lost', '❌ 状態タブにも退避にも書けず、値を失いました: ' + Object.keys(obj).join(', ') +
      '\n（あいさつ文・チラシの送付印などなら、二重に送られることがあります）' + err);
  }
}

/** 管理グループに知らせる（6時間に1回・IndividualPartner.gs warnOncePer_）。送れなくても止めない */
function kvWarn_(key, text) {
  try {
    if (typeof warnOncePer_ === 'function') warnOncePer_(key, 6 * 60 * 60, text);
  } catch (ignore) {}
}

function kvRetreatRemove_(keys) {
  try {
    var map = kvRetreatLoad_(true);
    var hit = false;
    keys.forEach(function(k) { if (Object.prototype.hasOwnProperty.call(map, k)) { delete map[k]; hit = true; } });
    if (hit) kvRetreatSave_(map);
  } catch (ignore) {}
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

/**
 * タブを読んで { map, rows: {key: 行番号}, blanks: [空いている行番号], fix: [文字でない行], cells: [文字に戻した2行目以降], sheet } を返す。
 * 無ければ作る。日付・数値に化けたセルは元の文字の形に戻して読む（fix に入れ、次に書く時に文字で書き直す）
 */
function kvReadSheet_(create) {
  var sheet = kvSheet_(create);
  if (!sheet) throw new Error('状態タブがありません');
  var values = sheet.getDataRange().getValues();
  var tz = kvSheetTimeZone_(sheet);
  var map = {}, rows = {}, blanks = [], fix = [], cells = [];
  for (var i = 1; i < values.length; i++) {
    var cell = [kvCellText_(values[i][0], tz), kvCellText_(values[i][1], tz), kvCellText_(values[i][2], tz)];
    cells.push(cell);
    if (!kvIsText_(values[i][0]) || !kvIsText_(values[i][1]) || !kvIsText_(values[i][2])) {
      // 値が数値・真偽値だった行は、先頭の 0 や長い数字の桁が戻せていないかもしれない（ログでキーを出す）
      var v = values[i][1];
      fix.push({ key: cell[0] || ('(空の行 ' + (i + 1) + ')'), lossy: typeof v === 'number' || typeof v === 'boolean' });
    }
    var k = cell[0];
    if (!k) { blanks.push(i + 1); continue; }
    map[k] = cell[1];
    rows[k] = i + 1;
  }
  return { map: map, rows: rows, blanks: blanks, fix: fix, cells: cells, sheet: sheet, lastRow: values.length };
}

/** セルの値を文字に戻す。Date はシートのタイムゾーンで yyyy-MM-dd HH:mm:ss（時刻 0:00:00 は yyyy-MM-dd）・数値は String */
function kvCellText_(v, tz) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    var d = new Date(Math.round(v.getTime() / 1000) * 1000);   // シートの日時の端数（ミリ秒）で 1 秒ずれないように
    var s = Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss');
    return s.slice(-9) === ' 00:00:00' ? s.slice(0, -9) : s;
  }
  return String(v);
}

/** 文字（または空）として入っているか。日付・数値・真偽値に化けていたら false */
function kvIsText_(v) {
  return v === null || v === undefined || typeof v === 'string';
}

/** シートが日付に変えた時のタイムゾーン（＝スプレッドシートの設定・本番は Asia/Tokyo）。読めなければスクリプトの設定 */
function kvSheetTimeZone_(sheet) {
  try {
    var tz = sheet.getParent().getSpreadsheetTimeZone();
    if (tz) return tz;
  } catch (ignore) {}
  try { return Session.getScriptTimeZone(); } catch (ignore) {}
  return 'Asia/Tokyo';
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
    kvFixTextRows_(state);   // 日付・数値に化けていた行を文字で書き直す（fn が同じ行を書く・消すのはこのあと）
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
    if (row > state.lastRow) {
      state.lastRow = row;
      kvEnsureRows_(sheet, state, row);
    }
    state.rows[key] = row;
  }
  kvSetTextRow_(sheet, row, [key, value, now]);
}

/** row 行目まで書けるように、足りなければ行を足す（シートの範囲の外には書けない。新しいシートは 1,000 行） */
function kvEnsureRows_(sheet, state, row) {
  if (!state.maxRows) state.maxRows = sheet.getMaxRows();
  if (row <= state.maxRows) return;
  var add = Math.max(KV_GROW_ROWS_, row - state.maxRows);
  sheet.insertRowsAfter(state.maxRows, add);
  state.maxRows += add;
  Logger.log('➕ 状態タブに ' + add + ' 行を足した（' + state.maxRows + ' 行）');
}

/** 1行を書式なしテキスト（@）にしてから書く（シートに日時・数字の文字を日付・数値に変えさせない） */
function kvSetTextRow_(sheet, row, vals) {
  var range = sheet.getRange(row, 1, 1, KV_HEADERS_.length);
  range.setNumberFormat('@');
  range.setValues([vals]);
}

/**
 * kvReadSheet_ が見つけた「文字でない行」があれば、2行目以降を読んだ値（元の文字の形）のまま、まとめて文字で書き直す
 * （書式・値の 2 回だけ。行ごとに書くと行数ぶん時間がかかり、その間ロックを持ち続けるため）。書き直した「文字でない行」の数
 */
function kvFixTextRows_(state) {
  var fix = state.fix || [];
  state.fix = [];
  if (!fix.length || !state.cells.length) return 0;
  var range = state.sheet.getRange(2, 1, state.cells.length, KV_HEADERS_.length);
  range.setNumberFormat('@');
  range.setValues(state.cells);
  var lossy = fix.filter(function(f) { return f.lossy; }).map(function(f) { return f.key; });
  Logger.log('🔤 状態タブ: 日付・数値に化けていた ' + fix.length + ' 行を文字に書き直した' +
    (lossy.length ? '（値が数値だった行: ' + lossy.slice(0, 20).join(', ') + (lossy.length > 20 ? ' ほか' + (lossy.length - 20) + '行' : '') +
      '。先頭の 0 や 16 桁以上の数字は戻せないので、気になる時は元の値を確かめる）' : ''));
  return fix.length;
}

/**
 * 書き込み用のロック。ScriptLock を持ったまま呼ばれる場所（あいさつ文・チラシ・本人登録リンクの送付印）があるので、
 * ScriptLock とは別の DocumentLock を使う（v7 は v7 Database に付いた container-bound なので取れる）。
 * DocumentLock が取れない時だけ UserLock（実行はすべて同じアカウント）→ ScriptLock に落ちる。
 * ScriptLock に落ちると、ScriptLock を持ったままの呼び元では取れずに退避へ回る（値は失わない）。落ちたらログに出す
 */
function kvLock_() {
  try {
    if (typeof LockService.getDocumentLock === 'function') {
      var dl = LockService.getDocumentLock();
      if (dl) return dl;
    }
  } catch (ignore) {}
  if (!__kvLockLogged_) {
    __kvLockLogged_ = true;
    Logger.log('⚠️ 状態タブ: DocumentLock を取れない（container-bound でない？）→ UserLock / ScriptLock で書く');
  }
  try {
    if (typeof LockService.getUserLock === 'function') {
      var ul = LockService.getUserLock();
      if (ul) return ul;
    }
  } catch (ignore) {}
  try { return LockService.getScriptLock(); } catch (ignore) {}
  return null;
}

/** どのロックで書いているか（kvStatus 用） */
function kvLockKind_() {
  try { if (typeof LockService.getDocumentLock === 'function' && LockService.getDocumentLock()) return 'DocumentLock'; } catch (ignore) {}
  try { if (typeof LockService.getUserLock === 'function' && LockService.getUserLock()) return 'UserLock'; } catch (ignore) {}
  return 'ScriptLock';
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
 * 移行前に Script Properties に残っている対象キーと、退避した値を「状態」タブへ移し、Script Properties から消す。
 * 何度実行しても同じ結果。移行前の値はタブに無い時だけ（タブの方が新しい）。退避した値はタブより新しいので上書き。
 * @param {number=} limit 1回に移す上限（省略時は全部）
 * @return {number} 残り（まだ移していない件数）
 */
function kvMigrateFromProperties(limit) {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var legacy = Object.keys(all).filter(function(k) { return kvIsManaged_(k); }).sort();
  var retreatKeys = Object.keys(kvRetreatLoad_(true)).sort();   // 件数を見るだけ（移す値はロックの中で読み直す）
  var total = legacy.length + retreatKeys.length;
  Logger.log('🚚 移す対象: 移行前 ' + legacy.length + '件・退避 ' + retreatKeys.length + '件');
  if (!total) { Logger.log('✅ 移すものはありません'); return 0; }
  var max = (typeof limit === 'number' && limit > 0) ? limit : total;
  var moved = 0, skipped = 0;
  // 退避した値（新しい）→ 上書き
  if (retreatKeys.length) {
    // ロックの中で退避を読み直して移す（ロックの前に読んだ値だと、そのあとに書かれた新しい値を古い退避で上書きする）。
    // 退避から外すのも同じロックの中で、外す直前に読み直して「移した値のまま」のものだけ
    var res = { applied: 0, moved: 0 };
    var limitRetreat = max;
    var ok1 = kvWrite_(function(sheet, state) {
      var cur = kvRetreatLoad_(true);
      var rk = Object.keys(cur).sort().slice(0, limitRetreat);
      var now = kvNow_();
      rk.forEach(function(k) {
        if (cur[k] === '') kvBlankRow_(sheet, state, k);   // 「消した」印 → タブの行を空にする
        else { kvWriteRow_(sheet, state, k, cur[k], now); state.map[k] = cur[k]; }
      });
      res.applied = rk.length;
      var check1 = kvReadSheet_(false).map;
      var latest = kvRetreatLoad_(true);
      rk.forEach(function(k) {
        var done = cur[k] === '' ? !check1[k] : check1[k] === String(cur[k]);
        if (done && latest[k] === cur[k]) {
          delete latest[k];
          if (kvIsManaged_(k)) props.deleteProperty(k);   // 移行前の置き場に同じキーが残っていれば消す（設定のキーは触らない）
          res.moved++;
        }
      });
      kvRetreatSave_(latest);
    });
    if (!ok1) throw new Error('状態タブに書けないので中止しました（退避の分）。Script Properties はそのまま');
    moved += res.moved;
    max -= res.applied;
  }
  // 移行前の値 → タブに無いものだけ
  for (var i = 0; i < legacy.length && max > 0; i += 50) {
    var batch = legacy.slice(i, Math.min(i + 50, i + max));
    var current = kvReadSheet_(true).map;
    var toWrite = batch.filter(function(k) { return !Object.prototype.hasOwnProperty.call(current, k); });
    var ok = kvWrite_(function(sheet, state) {
      var now = kvNow_();
      toWrite.forEach(function(k) { kvWriteRow_(sheet, state, k, all[k], now); state.map[k] = all[k]; });
    });
    if (!ok) throw new Error('状態タブに書けないので中止しました（' + i + '件目から）。Script Properties はそのまま');
    var check = kvReadSheet_(false).map;
    batch.forEach(function(k) {
      if (Object.prototype.hasOwnProperty.call(check, k)) { props.deleteProperty(k); if (toWrite.indexOf(k) >= 0) moved++; else skipped++; }
      else Logger.log('⚠️ 確認できず残しました: ' + k);
    });
    max -= batch.length;
  }
  var remain = Object.keys(props.getProperties()).filter(function(k) { return kvIsManaged_(k); }).length + Object.keys(kvRetreatLoad_(true)).length;
  Logger.log('✅ 移行: ' + moved + '件を状態タブへ・' + skipped + '件はタブの値を優先（Script Properties 側だけ消した）・残り ' + remain + '件。Script Properties 全体: ' + Object.keys(props.getProperties()).length + '個');
  return remain;
}

/**
 * 日付・数値に化けた行を文字に書き直す（エディタから実行してよい・何度実行しても同じ）。
 * 書き直しは kvWrite_ がタブを読み直した時に行う（kvFixTextRows_）。書けたら true
 */
function kvRepairTextValues() {
  var ok = kvWrite_(function() {});
  Logger.log(ok ? '✅ 状態タブ: 文字でない行の確認・書き直しを終えた（書き直した行があれば上に件数）' : '⚠️ 状態タブに書けない（あとで毎分の処理が再試行）');
  return ok;
}

/** 毎分のキュー処理から。6 時間に 1 回だけ、化けた行が無いか確かめて書き直す（本番へ入れた直後の 1 回で既存の行が直る） */
function kvAutoFixText_() {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get(KV_TEXT_CHECKED_KEY_)) return;
    cache.put(KV_TEXT_CHECKED_KEY_, 'trying', KV_TEXT_RETRY_SEC_);   // 途中で止まっても毎分やり直さない
    if (kvWrite_(function() {})) cache.put(KV_TEXT_CHECKED_KEY_, '1', KV_TEXT_CHECK_SEC_);
  } catch (err) {
    Logger.log('⚠️ kvAutoFixText_（次回に持ち越し）: ' + err);
  }
}

/** 毎分のキュー処理から呼ぶ。移すものがある時だけ、1回 KV_MIGRATE_PER_RUN_ 件まで（本処理を長く待たせない） */
function kvAutoMigrate_(all) {
  kvAutoFixText_();
  try {
    var has = false;
    if (all) {
      has = Object.prototype.hasOwnProperty.call(all, KV_RETREAT_KEY_) ||
        Object.keys(all).some(function(k) { return kvIsManaged_(k); });
    } else {
      has = true;
    }
    if (!has) return;
    kvMigrateFromProperties(KV_MIGRATE_PER_RUN_);
  } catch (err) {
    Logger.log('⚠️ kvAutoMigrate_（次回に持ち越し）: ' + err);
  }
}

/** 状態タブと Script Properties の件数を表示する */
function kvStatus() {
  var state = kvReadSheet_(false);
  var all = PropertiesService.getScriptProperties().getProperties();
  var legacy = Object.keys(all).filter(function(k) { return kvIsManaged_(k); });
  __kvRetreatMemo_ = null;
  var retreatN = Object.keys(kvRetreatLoad_()).length;
  var byPrefix = {};
  Object.keys(state.map).forEach(function(k) {
    var p = (k.match(/^[a-z_]+?_/) || [k])[0];
    byPrefix[p] = (byPrefix[p] || 0) + 1;
  });
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🗂 状態タブ: ' + Object.keys(state.map).length + '件 ' + JSON.stringify(byPrefix) + '・書き込みのロック: ' + kvLockKind_());
  Logger.log('🔑 Script Properties: 全部 ' + Object.keys(all).length + '個／まだ移していない対象 ' + legacy.length + '個／退避 ' + retreatN + '件' + ((legacy.length || retreatN) ? '（毎分のキュー処理が自動で移す。急ぐなら kvMigrateFromProperties()）' : ''));
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
