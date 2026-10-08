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
var FUNNEL_FLUSH_MAX_  = 100;                 // 1回の書き出し上限
var FUNNEL_RUN_KEY_    = 'funnel_flush_running';   // CacheService: 書き出し同士の排他（予約のスクリプトロックは使わない）

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
  // ここまで来たら保存済み。カウンタ更新の失敗では直接書き込みに落とさない（二重記録防止）
  try { cache.put(FUNNEL_CNT_KEY_, String(n + 1), 21600); } catch (e) {}
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
  // 書き出し同士の排他は CacheService の旗で行う（予約確定の ScriptLock を待たせない）
  if (cache.get(FUNNEL_RUN_KEY_)) return 0;
  cache.put(FUNNEL_RUN_KEY_, '1', 300);
  // 書き出し中も直接書き込みへ切り替わらないよう、先に生存確認を延長
  cache.put(FUNNEL_HB_KEY_, '1', 7200);
  try {
    keys = keys.slice(0, FUNNEL_FLUSH_MAX_);
    var sheet = getSheet(SHEET_NAMES.FUNNEL_LOG);
    var headers = getHeaderMap(SHEET_NAMES.FUNNEL_LOG);
    var lastCol = sheet.getLastColumn();
    var written = 0;
    keys.forEach(function(k) {
      var raw = props.getProperty(k);
      if (!raw) return;                             // 他の実行が書き出し済み
      var ev;
      try { ev = JSON.parse(raw); } catch (pe) {
        Logger.log('⚠️ flushFunnelQueue_: 壊れた行を破棄 ' + k);
        try { props.deleteProperty(k); } catch (e2) {}
        return;
      }
      try {
        var obj = funnelRowObject_(ev);
        var row = new Array(lastCol).fill('');
        Object.keys(obj).forEach(function(col) {
          if (headers[col]) row[headers[col] - 1] = obj[col];
        });
        sheet.appendRow(row);                       // 1行ずつ（同時の直接書き込みと行が重ならない）
        written++;
      } catch (e) {
        Logger.log('⚠️ flushFunnelQueue_: 書けなかった行（次回再試行） ' + k + ' : ' + e);
        return;
      }
      try { props.deleteProperty(k); } catch (e3) { Logger.log('⚠️ flushFunnelQueue_: キー削除失敗 ' + k); }
    });
    cache.remove(FUNNEL_CNT_KEY_);
    cache.put(FUNNEL_HB_KEY_, '1', 7200);
    return written;
  } finally {
    cache.remove(FUNNEL_RUN_KEY_);
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
