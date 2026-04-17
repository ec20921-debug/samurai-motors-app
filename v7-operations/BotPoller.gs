/**
 * BotPoller.gs — 内務Bot ポーリング
 *
 * 【責務】
 *   Telegram getUpdates をポーリングし、受信した update を
 *   QueueManager.enqueueInternalUpdate() でキューに積む。
 *
 * 【設計方針】
 *   - Webhook ではなくポーリング方式（v7 と同じく運用シンプルさを優先）
 *   - 1分間隔トリガー `pollInternalBot` で実行
 *   - offset は ScriptProperties に保存（キー: poll_offset_internal）
 *   - 1回の実行で最大 100件まで取得（Telegram API 上限）
 */

/**
 * 内務Bot のポーリング本体（1分トリガー想定）
 */
function pollInternalBot() {
  const props = PropertiesService.getScriptProperties();
  const offsetKey = STORAGE_KEYS.POLL_OFFSET_PREFIX + BOT_TYPE.INTERNAL;
  const offset = parseInt(props.getProperty(offsetKey) || '0', 10);

  const res = getUpdates(BOT_TYPE.INTERNAL, offset);
  if (!res || !res.ok) {
    Logger.log('⚠️ pollInternalBot: getUpdates failed res=' + JSON.stringify(res));
    return;
  }

  const updates = res.result || [];
  if (updates.length === 0) return;

  let maxUpdateId = offset - 1;
  let enqueued = 0;

  updates.forEach(function(update) {
    try {
      enqueueInternalUpdate(update);
      enqueued++;
      if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;
    } catch (err) {
      Logger.log('❌ enqueueInternalUpdate error update_id=' + update.update_id + ' err=' + err);
    }
  });

  // 次回オフセット = 今回最大 update_id + 1
  props.setProperty(offsetKey, String(maxUpdateId + 1));

  Logger.log('📡 pollInternalBot: 取得=' + updates.length + ' enqueued=' + enqueued + ' nextOffset=' + (maxUpdateId + 1));
}

/**
 * 1分トリガー一括セットアップ
 * - pollInternalBot       : 1分
 * - processInternalQueue  : 1分
 * - cleanupOldProcessedIds: 1時間
 */
function setupInternalBotTriggers() {
  // 既存の同名トリガーを削除
  const existing = ScriptApp.getProjectTriggers();
  existing.forEach(function(t) {
    const fn = t.getHandlerFunction();
    if (fn === 'pollInternalBot' || fn === 'processInternalQueue' || fn === 'cleanupOldProcessedIds') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('pollInternalBot').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('processInternalQueue').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('cleanupOldProcessedIds').timeBased().everyHours(1).create();

  Logger.log('✅ 内務Bot トリガー設定完了');
  Logger.log('  - pollInternalBot        : 1分');
  Logger.log('  - processInternalQueue   : 1分');
  Logger.log('  - cleanupOldProcessedIds : 1時間');
}

/**
 * 全トリガー削除（初期化・停止用）
 */
function removeInternalBotTriggers() {
  const existing = ScriptApp.getProjectTriggers();
  let removed = 0;
  existing.forEach(function(t) {
    const fn = t.getHandlerFunction();
    if (fn === 'pollInternalBot' || fn === 'processInternalQueue' || fn === 'cleanupOldProcessedIds') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log('🧹 削除トリガー数: ' + removed);
}

/**
 * ポーリングオフセットをリセット（デバッグ用）
 * 使うと直近の update を再取得するので通常は使わない
 */
function resetInternalPollOffset() {
  const props = PropertiesService.getScriptProperties();
  const key = STORAGE_KEYS.POLL_OFFSET_PREFIX + BOT_TYPE.INTERNAL;
  props.deleteProperty(key);
  Logger.log('🧹 ' + key + ' を削除しました');
}
