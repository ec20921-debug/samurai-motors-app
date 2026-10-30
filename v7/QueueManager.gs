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
 *   processed_ids_v1                    : 処理済み update_id の一覧（1つのキーに最新 400 件。2026-10-31〜）
 *   processed_{update_id}               : 旧・重複排除マーカー（2026-10-31 まで。24h で消し切る）
 *
 * 【なぜ processed_* を1つのキーにまとめたか】（2026-10-31）
 *   1日分のマーカーが数百個になり、Script Properties の設定画面（50個まで）が読み取り専用になっていた。
 *   永続性は必要（v6 の教訓）なので Cache には移さず、1つのキーに最新 400 件を持つ（約 5KB・1件 9KB の上限内）
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
  const seen = loadProcessedIds_(all);

  targets.forEach(function(key) {
    try {
      const payload = JSON.parse(all[key]);
      const update = payload.update;
      const botType = payload.botType;
      const updateId = update.update_id;

      // ── 重複排除マーカー（処理開始前にマーク） ──
      const processedKey = STORAGE_KEYS.PROCESSED_PREFIX + updateId;   // 旧マーカー（移行期間だけ見る）
      if (seen.indexOf(String(updateId)) >= 0 || props.getProperty(processedKey)) {
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

      // ── 完了マーカー（1つのキーにまとめて保存）+ キュー削除 ──
      seen.push(String(updateId));
      if (seen.length > PROCESSED_IDS_MAX_) seen.splice(0, seen.length - PROCESSED_IDS_MAX_);
      props.setProperty(STORAGE_KEYS.PROCESSED_IDS, JSON.stringify(seen));
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

var PROCESSED_IDS_MAX_ = 400;

/** 処理済み update_id の一覧（文字列の配列）。読めない・壊れている時は空から */
function loadProcessedIds_(all) {
  try {
    const raw = (all && all[STORAGE_KEYS.PROCESSED_IDS]) || PropertiesService.getScriptProperties().getProperty(STORAGE_KEYS.PROCESSED_IDS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch (err) {
    return [];
  }
}

/**
 * 24時間経過した旧 processed_* マーカーを削除する（2026-10-31 からは新しく作られない。残りを消し切るまで動かす）
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

  // 2026-10-08: 溜めておいたファネルログをまとめてシートへ（FunnelLog.gs。失敗しても本処理に影響させない）
  try {
    if (typeof flushFunnelQueue_ === 'function') flushFunnelQueue_(props, all);
  } catch (err) {
    Logger.log('⚠️ flushFunnelQueue_ 失敗(次回に持ち越し): ' + err);
  }
}

/**
 * キュー状況確認（デバッグ用）
 */
function showQueueStatus() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  let queueCount = 0;
  let processedCount = 0;   // 旧マーカー（残っている数）
  Object.keys(all).forEach(function(k) {
    if (k.indexOf(STORAGE_KEYS.QUEUE_PREFIX) === 0) queueCount++;
    else if (k.indexOf(STORAGE_KEYS.PROCESSED_PREFIX) === 0) processedCount++;
  });
  const seenCount = loadProcessedIds_(all).length;

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📬 キュー状況');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('処理待ちキュー: ' + queueCount + '件');
  Logger.log('処理済み一覧(processed_ids_v1): ' + seenCount + '件 / 旧マーカー残り: ' + processedCount + '件');
  Logger.log('Script Properties 全体: ' + Object.keys(all).length + '個');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Phase 1 デプロイ時に実行：トリガーを一括登録
 *
 * 既存の同名トリガーは一旦全削除してから作り直す（冪等）
 */
function setupV7Triggers() {
  const targets = [
    'processTelegramQueue',
    'cleanupOldProcessedIds',
    'pollTelegramUpdates',
    'checkUnpaidReminders'
  ];

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
  ScriptApp.newTrigger('pollTelegramUpdates')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('⏰ pollTelegramUpdates: 1分間隔（Polling方式）');

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

  // ── Phase 5: 24h催促 ──
  ScriptApp.newTrigger('checkUnpaidReminders')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('⏰ checkUnpaidReminders: 1時間間隔（24h未払い催促）');

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ トリガー設定完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
