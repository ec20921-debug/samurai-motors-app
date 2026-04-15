/**
 * 一時スクリプト: ADMIN_GROUP_ID 取得用
 *
 * 【目的】
 *   管理グループの chat_id を取得する。実行後はこのファイルを削除してOK。
 *
 * 【実行前の準備】
 *   1. 予約Bot (@samurai_motors_booking_bot) が管理グループに追加済みであること
 *   2. 管理グループの General トピックで何でもいいのでメッセージを1通送信する
 *      （例: 「test」、予約Botへのメンション不要。普通のテキストでOK）
 *   3. 下の TEMP_BOT_TOKEN に予約Botのトークンを貼り付け（GASエディタ上のみ）
 *      ⚠️ このファイルをGitHubにコミットする前に、必ずトークンを空文字に戻すこと
 *
 * 【実行手順】
 *   関数選択プルダウンで `getAdminGroupId` を選んで ▶ 実行
 *   実行ログ（表示 > ログ）で ADMIN_GROUP_ID = -100xxxxxxxxxx を確認
 *
 * 【処理内容】
 *   Step 1. 現在のWebhookを取得・記録（v6 が稼働中の場合は復元用に保存）
 *   Step 2. Webhookを一時削除（getUpdates は Webhook設定中だと動作しないため）
 *   Step 3. getUpdates で直近メッセージを取得し、グループIDを抽出
 *   Step 4. Webhookを元のURLに復元（v6 運用を止めない）
 */

// ⚠️ 実行時のみ予約Botのトークンを貼り付け。実行後は必ず空文字に戻してコミットすること
const TEMP_BOT_TOKEN = '';

function getAdminGroupId() {
  if (!TEMP_BOT_TOKEN) {
    Logger.log('❌ TEMP_BOT_TOKEN が未設定です。予約Botのトークンを貼り付けてから再実行してください');
    return;
  }

  const base = 'https://api.telegram.org/bot' + TEMP_BOT_TOKEN;

  // ── Step 1: 現在のWebhookを取得・保存 ──
  const infoRes = UrlFetchApp.fetch(base + '/getWebhookInfo', { muteHttpExceptions: true });
  const info = JSON.parse(infoRes.getContentText());
  const originalWebhookUrl = (info.result && info.result.url) || '';
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📌 現在のWebhook: ' + (originalWebhookUrl || '(未設定)'));

  // ── Step 2: Webhookを一時削除 ──
  UrlFetchApp.fetch(base + '/deleteWebhook', { muteHttpExceptions: true });
  Logger.log('🗑️ Webhook一時削除');
  Utilities.sleep(1500); // Telegram側の反映待ち

  // ── Step 3: getUpdates で直近メッセージ取得 ──
  const updRes = UrlFetchApp.fetch(base + '/getUpdates', { muteHttpExceptions: true });
  const upd = JSON.parse(updRes.getContentText());
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📨 取得した更新: ' + (upd.result ? upd.result.length : 0) + '件');

  const groupIds = {};
  if (upd.result && upd.result.length > 0) {
    upd.result.forEach(function(u) {
      const msg = u.message || u.edited_message || u.channel_post || u.my_chat_member;
      if (msg && msg.chat) {
        const c = msg.chat;
        Logger.log('  - chat.id=' + c.id + ' / title=' + (c.title || '(DM)') + ' / type=' + c.type);
        if (c.type === 'supergroup' || c.type === 'group') {
          groupIds[c.id] = c.title || '(名称不明)';
        }
      }
    });
  }

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  const keys = Object.keys(groupIds);
  if (keys.length > 0) {
    Logger.log('✅ 検出されたグループ:');
    keys.forEach(function(id) {
      Logger.log('   ADMIN_GROUP_ID = ' + id + '   (' + groupIds[id] + ')');
    });
  } else {
    Logger.log('⚠️ グループが検出されませんでした');
    Logger.log('   対処法:');
    Logger.log('   1. 「Samurai Motors 管理 V7」グループで1通メッセージを送信');
    Logger.log('   2. 1分程度待ってから再度 getAdminGroupId を実行');
  }

  // ── Step 4: Webhookを復元 ──
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  if (originalWebhookUrl) {
    const setRes = UrlFetchApp.fetch(
      base + '/setWebhook?url=' + encodeURIComponent(originalWebhookUrl),
      { muteHttpExceptions: true }
    );
    const setData = JSON.parse(setRes.getContentText());
    if (setData.ok) {
      Logger.log('🔄 Webhook復元成功: ' + originalWebhookUrl);
    } else {
      Logger.log('❌ Webhook復元失敗: ' + setRes.getContentText());
      Logger.log('   → 手動で v6 の setupWebhook を再実行してください');
    }
  } else {
    Logger.log('ℹ️ 元々Webhook未設定のため復元不要');
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ 完了');
}
