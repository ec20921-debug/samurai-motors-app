/**
 * BotPoller.gs — Telegram getUpdates Polling
 *
 * 【責務】
 *   Webhook ではなく、GAS側から Telegram API の getUpdates を呼んで
 *   保留中の update を取得し、既存のキュー機構（enqueueTelegramUpdate）へ投入する。
 *
 * 【なぜ Polling か】
 *   GAS の Web App /exec は POST に対して 302 リダイレクトを返し、
 *   Telegram がそれを追わずリトライループに入る既知問題（2024+）があるため、
 *   Webhook 方式を諦めて Polling に切替。
 *
 * 【トリガー】
 *   pollTelegramUpdates: 1分間隔
 *     - 予約Bot / 業務Bot それぞれの offset を ScriptProperties で保持
 *     - 取得した update を enqueueTelegramUpdate() でキューへ
 *     - 以降の処理は従来どおり processTelegramQueue() が 1分間隔で実行
 *
 * 【offset 管理】
 *   ScriptProperties: poll_offset_{botType} に「次回取得すべき最小 update_id」を保存。
 *   Telegram は offset 以上の update を返すので、前回取得最大 +1 を保存する。
 */

/**
 * Polling メイン関数（1分間隔トリガー）
 * 両Botをまとめてポーリングし、取得した update を即座に処理まで進める。
 *
 * 【遅延最小化】
 *   pollTelegramUpdates と processTelegramQueue が別トリガーだと、
 *   タイミングによっては最大2分遅延が発生する。
 *   このため、polling の末尾で同じ実行内で processTelegramQueue を呼び、
 *   取得直後に顧客転送まで完了させる（最大1分遅延に短縮）。
 *   別途1分間隔で走る processTelegramQueue トリガーは、万が一失敗した
 *   update のリトライとして機能する。
 */
function pollTelegramUpdates() {
  pollBotUpdates(BOT_TYPE.BOOKING);
  pollBotUpdates(BOT_TYPE.FIELD);

  // ── ポーリング直後にキュー処理まで連続実行 ──
  try {
    processTelegramQueue();
  } catch (err) {
    Logger.log('⚠️ pollTelegramUpdates → processTelegramQueue error: ' + err);
  }
}

/**
 * 指定Botの getUpdates を呼んでキューに積む
 *
 * @param {string} botType - BOT_TYPE.BOOKING or BOT_TYPE.FIELD
 */
function pollBotUpdates(botType) {
  const props = PropertiesService.getScriptProperties();
  const offsetKey = STORAGE_KEYS.POLL_OFFSET_PREFIX + botType;
  const stored = props.getProperty(offsetKey);
  const offset = stored ? parseInt(stored, 10) : 0;

  const res = getUpdates(botType, offset, { limit: 100, timeout: 0 });
  if (!res || !res.ok) {
    Logger.log('⚠️ pollBotUpdates[' + botType + '] getUpdates 失敗: ' + JSON.stringify(res));
    return;
  }

  const updates = res.result || [];
  if (updates.length === 0) return;

  let maxUpdateId = offset - 1;
  let enqueued = 0;

  updates.forEach(function(update) {
    try {
      // ── 重複排除（既に processed_ マーカーあれば skip） ──
      const processedKey = STORAGE_KEYS.PROCESSED_PREFIX + update.update_id;
      if (!props.getProperty(processedKey)) {
        enqueueTelegramUpdate(update, botType);
        enqueued++;
      }
      if (update.update_id > maxUpdateId) {
        maxUpdateId = update.update_id;
      }
    } catch (err) {
      Logger.log('❌ pollBotUpdates enqueue error update_id=' + update.update_id + ' err=' + err);
    }
  });

  // ── 次回オフセット保存（最大 update_id + 1） ──
  // これを保存することで Telegram 側で当該 update が確認応答扱いになり、
  // getUpdates の結果から外れる（= 二度取得されない）。
  props.setProperty(offsetKey, String(maxUpdateId + 1));

  Logger.log('📡 poll[' + botType + '] 取得=' + updates.length + ' 投入=' + enqueued + ' next_offset=' + (maxUpdateId + 1));
}

/**
 * Polling開始前の初期化ヘルパー
 *   1. 両BotのWebhookを削除（getUpdatesはWebhook設定中は使えない）
 *   2. drop_pending_updates で溜まった古い update を破棄
 *   3. offset を 0 にリセット
 *
 * 【実行タイミング】Webhook方式からPolling方式への切替時に1回だけ実行
 */
function switchToPollingMode() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🔄 Webhook → Polling 切替開始');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  [BOT_TYPE.BOOKING, BOT_TYPE.FIELD].forEach(function(botType) {
    // Webhook削除 + 保留updateを破棄
    const res = callTelegramApi(botType, 'deleteWebhook', { drop_pending_updates: true });
    Logger.log('[' + botType + '] deleteWebhook: ' + JSON.stringify(res));

    // offset リセット
    const props = PropertiesService.getScriptProperties();
    props.deleteProperty(STORAGE_KEYS.POLL_OFFSET_PREFIX + botType);
    Logger.log('[' + botType + '] offset リセット');
  });

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ 切替完了。setupV7Triggers を実行して pollTelegramUpdates を登録してください');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Polling状態確認（デバッグ用）
 */
function showPollingStatus() {
  const props = PropertiesService.getScriptProperties();
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📡 Polling 状態');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  [BOT_TYPE.BOOKING, BOT_TYPE.FIELD].forEach(function(botType) {
    const offset = props.getProperty(STORAGE_KEYS.POLL_OFFSET_PREFIX + botType);
    Logger.log('[' + botType + '] next_offset=' + (offset || '(未設定/0)'));

    const wh = getWebhookInfo(botType);
    if (wh && wh.ok && wh.result) {
      Logger.log('[' + botType + '] webhook_url=' + (wh.result.url || '(空=Polling可)'));
      Logger.log('[' + botType + '] pending_update_count=' + (wh.result.pending_update_count || 0));
    }
  });
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
