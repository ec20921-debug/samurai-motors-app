/**
 * QueueManager.gs — 非同期キュー管理
 *
 * 【責務】
 *   doPost から投入された Telegram update を ScriptProperties に溜め込み、
 *   1分間隔トリガー `processTelegramQueue` で順次処理する。
 *
 * 【なぜ CacheService ではなく ScriptProperties か】
 *   v6 で CacheService にキューを置いたら 6h TTL で通知が消失した。
 *   キュー系は永続性が必須 → ScriptProperties 一択。
 *
 * 【キーフォーマット】
 *   queue_{timestamp}_{update_id}       : キュー本体（JSON文字列）
 *   processed_{update_id}               : 重複排除マーカー（24h保持）
 *
 * 【トリガー】
 *   processTelegramQueue    : 1分間隔（キュー処理の本体）
 *   cleanupOldProcessedIds  : 1時間間隔（24h経過マーカー削除）
 */

/**
 * Telegram update をキューに投入する
 *
 * @param {Object} update - Telegram update オブジェクト
 * @param {string} botType - BOT_TYPE.BOOKING or BOT_TYPE.FIELD
 */
function enqueueTelegramUpdate(update, botType) {
  const props = PropertiesService.getScriptProperties();
  const ts = new Date().getTime();
  const key = STORAGE_KEYS.QUEUE_PREFIX + ts + '_' + update.update_id;
  const payload = JSON.stringify({
    botType: botType,
    update: update,
    enqueuedAt: ts
  });
  props.setProperty(key, payload);
}

/**
 * キューから update を取り出して処理する
 *
 * トリガー: 1分間隔
 * 1回の実行で最大 20件処理（GAS実行時間制限対策）
 */
function processTelegramQueue() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  // キューキーのみ抽出してタイムスタンプ順にソート
  const queueKeys = Object.keys(all)
    .filter(function(k) { return k.indexOf(STORAGE_KEYS.QUEUE_PREFIX) === 0; })
    .sort();

  if (queueKeys.length === 0) return;

  const MAX_PER_RUN = 20;
  const targets = queueKeys.slice(0, MAX_PER_RUN);

  let success = 0;
  let failed = 0;

  targets.forEach(function(key) {
    try {
      const payload = JSON.parse(all[key]);
      const update = payload.update;
      const botType = payload.botType;
      const updateId = update.update_id;

      // ── 重複排除マーカー（処理開始前にマーク） ──
      const processedKey = STORAGE_KEYS.PROCESSED_PREFIX + updateId;
      if (props.getProperty(processedKey)) {
        // 既に処理済み → キューから削除のみ
        props.deleteProperty(key);
        return;
      }

      // ── Bot種別ごとにハンドラへ振り分け ──
      // Phase 1 時点ではハンドラ未実装 → typeof で存在確認しスキップ
      if (botType === BOT_TYPE.BOOKING) {
        if (typeof handleBookingBotUpdate === 'function') {
          handleBookingBotUpdate(update);
        } else {
          Logger.log('⏭️ handleBookingBotUpdate 未実装（Phase 3 で実装予定） update_id=' + updateId);
        }
      } else if (botType === BOT_TYPE.FIELD) {
        if (typeof handleFieldBotUpdate === 'function') {
          handleFieldBotUpdate(update);
        } else {
          Logger.log('⏭️ handleFieldBotUpdate 未実装（Phase 4 で実装予定） update_id=' + updateId);
        }
      }

      // ── 完了マーカー + キュー削除 ──
      props.setProperty(processedKey, String(new Date().getTime()));
      props.deleteProperty(key);
      success++;

    } catch (err) {
      Logger.log('❌ processTelegramQueue error key=' + key + ' err=' + err);
      failed++;
      // 失敗したキューは削除せず残す（次回再試行）
      // ただしログで監視できるようにする
    }
  });

  if (success > 0 || failed > 0) {
    Logger.log('📬 queue processed: success=' + success + ' failed=' + failed + ' remaining=' + (queueKeys.length - targets.length));
  }
}

/**
 * 24時間経過した processed_* マーカーを削除する
 *
 * トリガー: 1時間間隔
 */
function cleanupOldProcessedIds() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = new Date().getTime();
  const cutoff = TTL.PROCESSED_ID * 1000; // 秒 → ミリ秒

  let deleted = 0;
  Object.keys(all).forEach(function(key) {
    if (key.indexOf(STORAGE_KEYS.PROCESSED_PREFIX) !== 0) return;
    const ts = parseInt(all[key], 10);
    if (isNaN(ts)) {
      // タイムスタンプ不正 → 削除
      props.deleteProperty(key);
      deleted++;
      return;
    }
    if (now - ts > cutoff) {
      props.deleteProperty(key);
      deleted++;
    }
  });

  if (deleted > 0) {
    Logger.log('🧹 cleanupOldProcessedIds: ' + deleted + '件削除');
  }
}

/**
 * キュー状況確認（デバッグ用）
 */
function showQueueStatus() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  let queueCount = 0;
  let processedCount = 0;
  Object.keys(all).forEach(function(k) {
    if (k.indexOf(STORAGE_KEYS.QUEUE_PREFIX) === 0) queueCount++;
    else if (k.indexOf(STORAGE_KEYS.PROCESSED_PREFIX) === 0) processedCount++;
  });

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📬 キュー状況');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('処理待ちキュー: ' + queueCount + '件');
  Logger.log('処理済みマーカー: ' + processedCount + '件');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Phase 1 デプロイ時に実行：トリガーを一括登録
 *
 * 既存の同名トリガーは一旦全削除してから作り直す（冪等）
 */
function setupV7Triggers() {
  const targets = ['processTelegramQueue', 'cleanupOldProcessedIds'];

  // ── 既存トリガー削除 ──
  const existing = ScriptApp.getProjectTriggers();
  let removed = 0;
  existing.forEach(function(t) {
    if (targets.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log('🗑️ 既存トリガー削除: ' + removed + '件');

  // ── 新規登録 ──
  ScriptApp.newTrigger('processTelegramQueue')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('⏰ processTelegramQueue: 1分間隔');

  ScriptApp.newTrigger('cleanupOldProcessedIds')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('⏰ cleanupOldProcessedIds: 1時間間隔');

  // ── PaymentManager は Phase 5 で追加予定 ──
  Logger.log('ℹ️ checkUnpaidReminders は Phase 5 実装時に別途追加');

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ トリガー設定完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
