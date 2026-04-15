/**
 * BookingBot.gs — 予約Bot の update 処理（Phase 2 最小版）
 *
 * 【Phase 2 時点のスコープ】
 *   - /start コマンド応答（クメール語+英語の挨拶）
 *   - 顧客からのDM → CustomerChat へ転送
 *   - 管理グループからの返信 → handleAdminReply
 *
 * 【Phase 3 で追加予定】
 *   - /book コマンドで予約ミニアプリ起動
 *   - web_app_data 受信で予約確定処理
 *   - 予約フロー用の会話状態管理
 *
 * 【呼び出し元】
 *   QueueManager.processTelegramQueue() から botType===BOOKING の update で呼ばれる
 */

/**
 * 予約Bot の update を処理するメインディスパッチャ
 * QueueManager から botType===BOOKING で呼ばれる
 *
 * @param {Object} update - Telegram update
 */
function handleBookingBotUpdate(update) {
  try {
    // message / edited_message を処理（Phase 2）
    const msg = update.message || update.edited_message;
    if (!msg) {
      // callback_query 等は Phase 3 以降
      return;
    }
    dispatchBookingMessage(msg);
  } catch (err) {
    Logger.log('❌ handleBookingBotUpdate error: ' + err + ' stack=' + (err.stack || ''));
  }
}

/**
 * メッセージの発信元に応じて振り分ける
 *   - 管理グループから → handleAdminReply
 *   - 顧客DM から → handleCustomerMessage
 */
function dispatchBookingMessage(msg) {
  if (!msg.chat) return;

  const cfg = getConfig();
  const chatId = String(msg.chat.id);
  const adminGroupId = String(cfg.adminGroupId);

  // ── 管理グループからの返信 ──
  if (chatId === adminGroupId) {
    handleAdminReply(msg);
    return;
  }

  // ── 顧客DM以外は無視（他グループに誤って追加されても反応しない） ──
  if (msg.chat.type !== 'private') {
    Logger.log('ℹ️ 非対応チャット種別: type=' + msg.chat.type + ' id=' + chatId);
    return;
  }

  handleCustomerMessage(msg);
}

/**
 * 顧客からのDMメッセージ処理
 */
function handleCustomerMessage(msg) {
  // /start コマンド → 挨拶のみ返す（転送しない）
  if (msg.text && msg.text.trim() === '/start') {
    sendWelcomeMessage(msg);
    // /start も新規顧客登録のきっかけにする：トピックだけ作っておく
    ensureCustomerTopic(msg);
    return;
  }

  // それ以外の全メッセージ → 管理者トピックへ転送
  forwardCustomerMessage(msg);
}

/**
 * /start 応答：クメール語メインで挨拶
 */
function sendWelcomeMessage(msg) {
  const from = msg.from || {};
  const name = from.first_name || '';
  const cfg = getConfig();

  const text =
    'សួស្តី' + (name ? ' ' + name : '') + '! 🚗\n' +
    'សូមស្វាគមន៍មកកាន់ Samurai Motors — សេវាលាងឡានតាមផ្ទះ។\n' +
    '\n' +
    'Hello! Welcome to Samurai Motors — mobile car wash service.\n' +
    '\n' +
    '📸 សូមផ្ញើរូបថតឡានរបស់អ្នកឬសួរអ្វីមួយ។\n' +
    '📸 Please send a photo of your car or ask us anything.\n' +
    '\n' +
    '🗓 ការកក់ / Booking: /book';

  sendMessage(BOT_TYPE.BOOKING, msg.chat.id, text);

  // 管理グループにも通知
  sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
    'ℹ️ /start 受信: ' + buildDisplayName(extractCustomerFromMessage(msg)) +
    ' (chat_id=' + msg.chat.id + ')'
  );
}

/**
 * 顧客のトピックが存在することを保証する（/start で呼ばれる）
 * 既存なら何もしない、未作成なら作成
 */
function ensureCustomerTopic(msg) {
  const customer = extractCustomerFromMessage(msg);
  const topic = getOrCreateTopic(customer);
  if (topic.isNew) {
    const cfg = getConfig();
    sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
      '🆕 新規顧客が /start を実行しました\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      '氏名: ' + buildDisplayName(customer) + '\n' +
      'Chat ID: ' + customer.chatId,
      { message_thread_id: topic.threadId }
    );
  }
}
