/**
 * FunnelLog.gs — ファネル計測ログ（Bot来訪 / ミニアプリ開 / 予約完了）
 *
 * 2026-10-08: Setup_MenuV2.gs から logFunnelEvent を移設し、書き込みを後回しにした。
 *   目的: 予約画面の起動(booking_init)から同期のシート書き込みを外して速くする。
 *   仕組み:
 *     - 通常は ScriptProperties に 'funnelq_' キーで一時保存するだけ（数十ms）
 *     - 毎時トリガー cleanupOldProcessedIds → flushFunnelQueue_ がまとめてシートへ書く
 *     - 安全弁: 書き出しの生存確認(funnel_flush_hb, 2h)が無い / 溜まりすぎ / 例外 → 従来どおりその場でシートに書く
 *     - 'queue_' / 'processed_' 接頭辞は使わない（processTelegramQueue に Telegram 更新として拾われるため）
 *   記録される時刻は発生時刻(ev.t)のまま。分析シートへの反映は最大約1時間遅れる（ダッシュボードは毎朝更新なので実害なし）。
 */

var FUNNEL_Q_PREFIX_   = 'funnelq_';
var FUNNEL_HB_KEY_     = 'funnel_flush_hb';   // CacheService: 書き出しが生きている印（7200秒）
var FUNNEL_CNT_KEY_    = 'funnel_q_count';    // CacheService: 溜まっている概算件数（21600秒）
var FUNNEL_Q_MAX_      = 100;                 // これ以上溜まっていたら直接書く
var FUNNEL_FLUSH_MAX_  = 200;                 // 1回の書き出し上限

/**
 * Funnel イベントを記録（本番コードから呼ぶ。失敗してもメイン処理を止めない）
 * 引数・列の並びは移設前と同じ。
 */
function logFunnelEvent(chatId, event, source, bookingId, metadata) {
  var ev = {
    t: Date.now(),
    c: String(chatId || ''),
    e: String(event || ''),
    s: String(source || ''),
    b: String(bookingId || ''),
    m: metadata ? JSON.stringify(metadata) : ''
  };
  try {
    if (enqueueFunnelEvent_(ev)) return;
  } catch (err) {
    Logger.log('⚠️ logFunnelEvent enqueue 失敗→直接書込: ' + err);
  }
  writeFunnelRow_(ev);
}

/** 条件を満たすときだけ一時保存する。保存したら true */
function enqueueFunnelEvent_(ev) {
  var cache = CacheService.getScriptCache();
  var c = cache.getAll([FUNNEL_HB_KEY_, FUNNEL_CNT_KEY_]);
  if (!c[FUNNEL_HB_KEY_]) return false;              // 書き出しが動いている保証が無い
  var n = Number(c[FUNNEL_CNT_KEY_] || 0);
  if (n >= FUNNEL_Q_MAX_) return false;
  var json = JSON.stringify(ev);
  if (json.length > 1000) return false;
  var key = FUNNEL_Q_PREFIX_ + ev.t + '_' + Utilities.getUuid().slice(0, 8);
  PropertiesService.getScriptProperties().setProperty(key, json);
  cache.put(FUNNEL_CNT_KEY_, String(n + 1), 21600);
  return true;
}

/** その場でシートに1行書く（移設前と同じ列） */
function writeFunnelRow_(ev) {
  try {
    appendRow(SHEET_NAMES.FUNNEL_LOG, funnelRowObject_(ev));
  } catch (err) {
    // ファネルログは欠損しても業務影響なし(計測のみ)
    Logger.log('⚠️ logFunnelEvent 失敗(無視可): ' + err);
  }
}

function funnelRowObject_(ev) {
  return {
    'タイムスタンプ':   new Date(ev.t),
    'チャットID':       ev.c,
    'イベント':         ev.e,
    'ソース':           ev.s,
    '予約ID':           ev.b,
    'メタデータ(JSON)': ev.m
  };
}

/**
 * 溜まったイベントをまとめてシートへ書く（毎時トリガー cleanupOldProcessedIds の末尾から呼ぶ）
 * @param {PropertiesService.Properties} props
 * @param {Object} all - props.getProperties() の結果（読み直しを省くため再利用）
 * @return {number} 書いた行数
 */
function flushFunnelQueue_(props, all) {
  var cache = CacheService.getScriptCache();
  var keys = funnelQueueKeys_(all);
  if (keys.length === 0) {
    cache.put(FUNNEL_HB_KEY_, '1', 7200);           // 生存確認だけ更新
    return 0;
  }
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return 0;                   // 予約処理中なら次回に回す
  try {
    all = props.getProperties();                    // ロック後に読み直し
    keys = funnelQueueKeys_(all).slice(0, FUNNEL_FLUSH_MAX_);
    var sheet = getSheet(SHEET_NAMES.FUNNEL_LOG);
    var headers = getHeaderMap(SHEET_NAMES.FUNNEL_LOG);
    var lastCol = sheet.getLastColumn();
    var rows = [];
    keys.forEach(function(k) {
      try {
        var obj = funnelRowObject_(JSON.parse(all[k]));
        var row = new Array(lastCol).fill('');
        Object.keys(obj).forEach(function(col) {
          if (headers[col]) row[headers[col] - 1] = obj[col];
        });
        rows.push(row);
      } catch (e) {
        Logger.log('⚠️ flushFunnelQueue_: 壊れた行を破棄 ' + k);
      }
    });
    if (rows.length > 0) {
      var start = sheet.getLastRow() + 1;
      var need = start + rows.length - 1 - sheet.getMaxRows();
      if (need > 0) sheet.insertRowsAfter(sheet.getMaxRows(), need);
      sheet.getRange(start, 1, rows.length, lastCol).setValues(rows);
      SpreadsheetApp.flush();
    }
    keys.forEach(function(k) { props.deleteProperty(k); });
    cache.remove(FUNNEL_CNT_KEY_);
    cache.put(FUNNEL_HB_KEY_, '1', 7200);
    return rows.length;
  } finally {
    lock.releaseLock();
  }
}

function funnelQueueKeys_(all) {
  return Object.keys(all).filter(function(k) { return k.indexOf(FUNNEL_Q_PREFIX_) === 0; }).sort();
}

/** 手動実行用（デプロイ直後の初回起動・巻き戻し前の吐き出し） */
function flushFunnelQueueNow() {
  var props = PropertiesService.getScriptProperties();
  var n = flushFunnelQueue_(props, props.getProperties());
  Logger.log('📊 flushFunnelQueueNow: ' + n + '行をファネルログへ書き出し');
}
