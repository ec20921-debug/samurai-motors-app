/**
 * QueueManager.gs — 非同期キュー管理（v7-ops版、簡素化）
 *
 * 【責務】
 *   内務Bot からの Telegram update を ScriptProperties に溜め込み、
 *   1分間隔トリガー `processInternalQueue` で順次処理する。
 *
 * 【v7 との違い】
 *   内務Bot はスタッフ数名 × ほぼ打刻のみ、という低頻度ユースケース。
 *   v7 のような大量メッセージ転送は無いため、処理ロジックを簡素化。
 *
 * 【キー形式】
 *   queue_{timestamp}_{update_id}    : キュー本体
 *   processed_{update_id}            : 重複排除マーカー（24h）
 */

/**
 * update をキューに投入する
 */
function enqueueInternalUpdate(update) {
  const props = PropertiesService.getScriptProperties();
  const ts = new Date().getTime();
  const key = STORAGE_KEYS.QUEUE_PREFIX + ts + '_' + update.update_id;
  props.setProperty(key, JSON.stringify({
    update: update,
    enqueuedAt: ts
  }));
}

/**
 * キューから update を取り出して処理する
 * 1分間隔トリガー想定、1回の実行で最大 20件
 */
function processInternalQueue() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

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
      const updateId = update.update_id;

      // 重複排除マーカーチェック
      const processedKey = STORAGE_KEYS.PROCESSED_PREFIX + updateId;
      if (props.getProperty(processedKey)) {
        props.deleteProperty(key);
        return;
      }

      // ハンドラへディスパッチ
      if (typeof handleInternalBotUpdate === 'function') {
        handleInternalBotUpdate(update);
      } else {
        Logger.log('⏭️ handleInternalBotUpdate 未実装（Phase 1b 以降） update_id=' + updateId);
      }

      props.setProperty(processedKey, String(new Date().getTime()));
      props.deleteProperty(key);
      success++;

    } catch (err) {
      Logger.log('❌ processInternalQueue error key=' + key + ' err=' + err);
      failed++;
      // 失敗キューは残す（次回再試行）
    }
  });

  if (success > 0 || failed > 0) {
    Logger.log('📬 internal queue processed: success=' + success + ' failed=' + failed);
  }
}

/**
 * 24時間経過した processed_* マーカー削除（1時間トリガー）
 */
function cleanupOldProcessedIds() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = new Date().getTime();
  const cutoff = TTL.PROCESSED_ID * 1000;

  let deleted = 0;
  Object.keys(all).forEach(function(key) {
    if (key.indexOf(STORAGE_KEYS.PROCESSED_PREFIX) !== 0) return;
    const ts = parseInt(all[key], 10);
    if (isNaN(ts) || (now - ts > cutoff)) {
      props.deleteProperty(key);
      deleted++;
    }
  });

  if (deleted > 0) Logger.log('🧹 cleanupOldProcessedIds: ' + deleted + '件削除');
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
  Logger.log('📬 v7-ops キュー状況');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('処理待ち: ' + queueCount + '件');
  Logger.log('処理済みマーカー: ' + processedCount + '件');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
