/**
 * TelegramAPI.gs — Telegram Bot API ラッパー
 *
 * 【責務】
 *   Telegram API への HTTP 呼び出しを一元化する。
 *   各 Bot（予約Bot / 業務Bot）のトークンは botType で切り替える。
 *
 * 【設計方針】
 *   - エラーはログ出力のみ（呼び出し側でリトライ判断）
 *   - muteHttpExceptions: true で 4xx/5xx でも throw しない
 *   - 戻り値は Telegram API の JSON レスポンス（ok フィールドで成否判定）
 */

// ====== 共通ユーティリティ ======

/**
 * Telegram API を呼び出す共通関数
 *
 * @param {string} botType - BOT_TYPE.BOOKING or BOT_TYPE.FIELD
 * @param {string} method  - getMe / sendMessage 等のメソッド名
 * @param {Object} payload - POSTペイロード
 * @return {Object} Telegram API レスポンス（JSON パース済み）
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

// ====== メッセージ送信 ======

/**
 * テキストメッセージ送信
 *
 * @param {string} botType
 * @param {string|number} chatId
 * @param {string} text
 * @param {Object} [options] - parse_mode / reply_markup / message_thread_id 等
 */
function sendMessage(botType, chatId, text, options) {
  const payload = Object.assign({
    chat_id: chatId,
    text: text
  }, options || {});
  return callTelegramApi(botType, 'sendMessage', payload);
}

/**
 * 写真1枚送信
 *
 * @param {string} botType
 * @param {string|number} chatId
 * @param {string} photo - file_id or URL
 * @param {Object} [options] - caption / message_thread_id 等
 */
function sendPhoto(botType, chatId, photo, options) {
  const payload = Object.assign({
    chat_id: chatId,
    photo: photo
  }, options || {});
  return callTelegramApi(botType, 'sendPhoto', payload);
}

/**
 * 複数写真をまとめて送信（アルバム形式）
 *
 * @param {string} botType
 * @param {string|number} chatId
 * @param {Array<Object>} media - [{type:'photo', media: file_id_or_url, caption?: string}, ...]
 * @param {Object} [options]
 */
function sendMediaGroup(botType, chatId, media, options) {
  const payload = Object.assign({
    chat_id: chatId,
    media: media
  }, options || {});
  return callTelegramApi(botType, 'sendMediaGroup', payload);
}

/**
 * メッセージ編集（テキスト）
 */
function editMessageText(botType, chatId, messageId, text, options) {
  const payload = Object.assign({
    chat_id: chatId,
    message_id: messageId,
    text: text
  }, options || {});
  return callTelegramApi(botType, 'editMessageText', payload);
}

/**
 * メッセージ転送
 */
function forwardMessage(botType, chatId, fromChatId, messageId, options) {
  const payload = Object.assign({
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId
  }, options || {});
  return callTelegramApi(botType, 'forwardMessage', payload);
}

// ====== コールバック ======

function answerCallbackQuery(botType, callbackQueryId, options) {
  const payload = Object.assign({
    callback_query_id: callbackQueryId
  }, options || {});
  return callTelegramApi(botType, 'answerCallbackQuery', payload);
}

// ====== フォーラムトピック ======

/**
 * フォーラムトピック作成
 *
 * @param {string} botType
 * @param {string|number} chatId - 管理グループの chat_id
 * @param {string} name - トピック名
 * @param {Object} [options] - icon_color / icon_custom_emoji_id
 */
function createForumTopic(botType, chatId, name, options) {
  const payload = Object.assign({
    chat_id: chatId,
    name: name
  }, options || {});
  return callTelegramApi(botType, 'createForumTopic', payload);
}

/**
 * フォーラムトピック名編集
 */
function editForumTopic(botType, chatId, messageThreadId, options) {
  const payload = Object.assign({
    chat_id: chatId,
    message_thread_id: messageThreadId
  }, options || {});
  return callTelegramApi(botType, 'editForumTopic', payload);
}

/**
 * フォーラムトピックをクローズ
 */
function closeForumTopic(botType, chatId, messageThreadId) {
  return callTelegramApi(botType, 'closeForumTopic', {
    chat_id: chatId,
    message_thread_id: messageThreadId
  });
}

// ====== ファイル取得 ======

/**
 * file_id から Telegram 上のファイル情報を取得し、ダウンロード URL を返す
 *
 * @param {string} botType
 * @param {string} fileId
 * @return {{ok: boolean, url?: string, filePath?: string, error?: string}}
 */
function getFileUrl(botType, fileId) {
  const res = callTelegramApi(botType, 'getFile', { file_id: fileId });
  if (!res.ok || !res.result || !res.result.file_path) {
    return { ok: false, error: 'GET_FILE_FAILED' };
  }
  const token = getBotToken(botType);
  const url = 'https://api.telegram.org/file/bot' + token + '/' + res.result.file_path;
  return { ok: true, url: url, filePath: res.result.file_path };
}

/**
 * file_id のファイルを Blob として取得（Drive 保存用）
 *
 * @param {string} botType
 * @param {string} fileId
 * @return {{ok: boolean, blob?: Blob, error?: string}}
 */
function fetchTelegramFile(botType, fileId) {
  const info = getFileUrl(botType, fileId);
  if (!info.ok) return info;
  try {
    const res = UrlFetchApp.fetch(info.url, { muteHttpExceptions: true });
    return { ok: true, blob: res.getBlob() };
  } catch (err) {
    Logger.log('❌ fetchTelegramFile error: ' + err);
    return { ok: false, error: String(err) };
  }
}

// ====== Polling（Long/Short poll） ======

/**
 * getUpdates で保留中の update を取得する（Polling方式）
 *
 * @param {string} botType
 * @param {number} offset - 取得開始する update_id（前回最大 update_id + 1）
 * @param {Object} [options] - { limit, timeout, allowed_updates }
 */
function getUpdates(botType, offset, options) {
  const payload = Object.assign({
    offset: offset || 0,
    limit: 100,
    timeout: 0  // GAS は long-poll と相性悪いので short-poll 固定
  }, options || {});
  return callTelegramApi(botType, 'getUpdates', payload);
}

// ====== Webhook 管理 ======

function setWebhook(botType, url) {
  return callTelegramApi(botType, 'setWebhook', { url: url });
}

function getWebhookInfo(botType) {
  return callTelegramApi(botType, 'getWebhookInfo', {});
}

function deleteWebhook(botType) {
  return callTelegramApi(botType, 'deleteWebhook', {});
}
