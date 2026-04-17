/**
 * TelegramAPI.gs — 内務Bot API ラッパー
 *
 * v7 の TelegramAPI.gs から流用。内務Bot は1種類のみなので、
 * BOT_TYPE.INTERNAL 固定で動作する想定。
 */

/**
 * Telegram API を呼び出す共通関数
 */
function callTelegramApi(botType, method, payload) {
  const token = getBotToken(botType);
  if (!token) {
    Logger.log('❌ callTelegramApi: トークン未登録 botType=' + botType);
    return { ok: false, error: 'NO_TOKEN' };
  }

  const url = 'https://api.telegram.org/bot' + token + '/' + method;
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    const body = res.getContentText();
    const data = JSON.parse(body);

    if (!data.ok) {
      Logger.log('⚠️ Telegram API ' + method + ' failed: code=' + code + ' body=' + body);
    }
    return data;
  } catch (err) {
    Logger.log('❌ callTelegramApi error method=' + method + ' err=' + err);
    return { ok: false, error: String(err) };
  }
}

/**
 * テキストメッセージ送信
 */
function sendMessage(botType, chatId, text, options) {
  const payload = Object.assign({
    chat_id: chatId,
    text: text
  }, options || {});
  return callTelegramApi(botType, 'sendMessage', payload);
}

/**
 * 写真送信
 */
function sendPhoto(botType, chatId, photo, options) {
  const payload = Object.assign({
    chat_id: chatId,
    photo: photo
  }, options || {});
  return callTelegramApi(botType, 'sendPhoto', payload);
}

/**
 * コールバック応答
 */
function answerCallbackQuery(botType, callbackQueryId, options) {
  const payload = Object.assign({
    callback_query_id: callbackQueryId
  }, options || {});
  return callTelegramApi(botType, 'answerCallbackQuery', payload);
}

/**
 * Bot 左下メニューボタン設定
 */
function setChatMenuButton(botType, menuButton, chatId) {
  const payload = { menu_button: menuButton };
  if (chatId) payload.chat_id = chatId;
  return callTelegramApi(botType, 'setChatMenuButton', payload);
}

/**
 * getUpdates（ポーリング方式）
 */
function getUpdates(botType, offset, options) {
  const payload = Object.assign({
    offset: offset || 0,
    limit: 100,
    timeout: 0
  }, options || {});
  return callTelegramApi(botType, 'getUpdates', payload);
}

/**
 * Webhook 管理
 */
function setWebhook(botType, url) {
  return callTelegramApi(botType, 'setWebhook', { url: url });
}

function deleteWebhook(botType) {
  return callTelegramApi(botType, 'deleteWebhook', {});
}

function getWebhookInfo(botType) {
  return callTelegramApi(botType, 'getWebhookInfo', {});
}

/**
 * Bot 情報取得（動作確認用）
 */
function getMe(botType) {
  return callTelegramApi(botType, 'getMe', {});
}
