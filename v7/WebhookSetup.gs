/**
 * WebhookSetup.gs — 【非推奨】Webhook 登録関連
 *
 * 【重要】
 *   2026-04-15: GAS /exec の 302 リダイレクト問題で Webhook方式は廃止。
 *   本ファイルの setBookingWebhook / setFieldWebhook は使わないでください。
 *   代わりに BotPoller.gs の Polling方式で update を取得します。
 *
 * 【切替手順】
 *   1. switchToPollingMode() を実行（Webhook削除 + offset初期化）
 *   2. setupV7Triggers() を実行（pollTelegramUpdates トリガー登録）
 *   3. verifyBookingWebhook() で url=(空) を確認
 *
 * 本ファイルは verifyBookingWebhook / verifyFieldWebhook / diagnoseForward のみ
 * デバッグ用途で残しています。
 */

/**
 * 予約Bot の現在の Webhook 状態を確認（Polling移行後は url=(空) が正常）
 */
function verifyBookingWebhook() {
  const res = getWebhookInfo(BOT_TYPE.BOOKING);
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📌 予約Bot Webhook 状態');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  if (res.ok && res.result) {
    const r = res.result;
    Logger.log('URL: ' + (r.url || '(未設定=Polling可)'));
    Logger.log('保留中アップデート: ' + (r.pending_update_count || 0) + '件');
    if (r.last_error_message) {
      Logger.log('⚠️ 直近エラー: ' + r.last_error_message);
      Logger.log('   発生時刻: ' + new Date(r.last_error_date * 1000));
    } else {
      Logger.log('✅ エラーなし');
    }
  } else {
    Logger.log('❌ getWebhookInfo 失敗: ' + JSON.stringify(res));
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 業務Bot の Webhook 状態を確認
 */
function verifyFieldWebhook() {
  const res = getWebhookInfo(BOT_TYPE.FIELD);
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📌 業務Bot Webhook 状態');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  if (res.ok && res.result) {
    Logger.log('URL: ' + (res.result.url || '(未設定=Polling可)'));
    Logger.log('保留中: ' + (res.result.pending_update_count || 0));
  } else {
    Logger.log('❌ 取得失敗');
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 診断: 特定の顧客 chat_id でのメッセージ転送をシミュレート
 *
 * 使い方: 下の TEST_CHAT_ID に実機の chat_id を入れて実行
 * 期待動作: そのトピックに「診断テストメッセージ」が投稿される
 */
function diagnoseForward() {
  const TEST_CHAT_ID = '8066523739';  // 実機の顧客chat_id

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🔬 診断: forwardCustomerMessage シミュレーション');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  // Step 1: 顧客行を検索
  const row = findCustomerRow(TEST_CHAT_ID);
  if (!row) {
    Logger.log('❌ 顧客行が見つかりません chat_id=' + TEST_CHAT_ID);
    return;
  }
  Logger.log('✅ 顧客行あり: rowIndex=' + row.rowIndex);
  Logger.log('   トピックID(raw)=' + row.data['トピックID'] + ' (type=' + typeof row.data['トピックID'] + ')');

  const threadId = Number(row.data['トピックID']);
  if (!threadId || isNaN(threadId)) {
    Logger.log('❌ トピックID が数値変換できません');
    return;
  }
  Logger.log('✅ threadId=' + threadId);

  // Step 2: 管理グループの thread_id にメッセージ送信
  const cfg = getConfig();
  Logger.log('ADMIN_GROUP_ID=' + cfg.adminGroupId);

  const res = sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
    '🔬 診断テストメッセージ (' + new Date().toISOString() + ')',
    { message_thread_id: threadId }
  );

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  if (res.ok) {
    Logger.log('✅ 送信成功 message_id=' + (res.result && res.result.message_id));
  } else {
    Logger.log('❌ 送信失敗: ' + JSON.stringify(res));
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
