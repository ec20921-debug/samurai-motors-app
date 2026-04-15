/**
 * WebhookSetup.gs — 一時スクリプト：Webhook 登録・確認
 *
 * 【目的】
 *   GAS を Webアプリとしてデプロイした後、Telegram 側に Webhook URL を登録する。
 *   Phase 2 時点では予約Botのみ。業務Bot は Phase 4 で別途登録。
 *
 * 【実行手順】
 *   1. GASエディタ右上「デプロイ」→「新しいデプロイ」
 *       - 種類: ウェブアプリ
 *       - 次のユーザーとして実行: 自分
 *       - アクセスできるユーザー: 全員
 *      → URL（https://script.google.com/macros/s/AKfyc.../exec）をコピー
 *
 *   2. 下の WEB_APP_URL に貼り付け（GASエディタ上のみ）
 *      ⚠️ GitHubコミット前に空文字に戻すこと
 *
 *   3. setBookingWebhook を実行
 *      → ログに「✅ setWebhook 成功」が出れば完了
 *
 *   4. verifyBookingWebhook で Telegram 側の設定を確認
 *
 * 【実行後】
 *   - WEB_APP_URL を空文字に戻す
 *   - このファイルは Phase 4 まで残しておく（業務Bot Webhook 登録で再利用）
 */

// ⚠️ デプロイ後にウェブアプリURLを貼り付け。実行後は必ず空文字に戻すこと
const WEB_APP_URL = '';

/**
 * 予約Botの Webhook を登録する
 * URL には ?bot=booking を付与して Router で識別できるようにする
 */
function setBookingWebhook() {
  if (!WEB_APP_URL) {
    Logger.log('❌ WEB_APP_URL が未設定です。デプロイ後のURLを貼り付けてから再実行してください');
    return;
  }

  const url = WEB_APP_URL + '?bot=booking';
  const res = setWebhook(BOT_TYPE.BOOKING, url);

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  if (res.ok) {
    Logger.log('✅ setWebhook 成功');
    Logger.log('   URL: ' + url);
    Logger.log('   description: ' + (res.description || ''));
  } else {
    Logger.log('❌ setWebhook 失敗: ' + JSON.stringify(res));
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 業務Botの Webhook を登録する（Phase 4 で使用）
 */
function setFieldWebhook() {
  if (!WEB_APP_URL) {
    Logger.log('❌ WEB_APP_URL が未設定です');
    return;
  }

  const url = WEB_APP_URL + '?bot=field';
  const res = setWebhook(BOT_TYPE.FIELD, url);

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  if (res.ok) {
    Logger.log('✅ 業務Bot setWebhook 成功');
    Logger.log('   URL: ' + url);
  } else {
    Logger.log('❌ 業務Bot setWebhook 失敗: ' + JSON.stringify(res));
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 予約Bot の現在の Webhook 状態を確認
 */
function verifyBookingWebhook() {
  const res = getWebhookInfo(BOT_TYPE.BOOKING);
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📌 予約Bot Webhook 状態');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  if (res.ok && res.result) {
    const r = res.result;
    Logger.log('URL: ' + (r.url || '(未設定)'));
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
    Logger.log('URL: ' + (res.result.url || '(未設定)'));
    Logger.log('保留中: ' + (res.result.pending_update_count || 0));
  } else {
    Logger.log('❌ 取得失敗');
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
