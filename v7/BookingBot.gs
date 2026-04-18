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

  Logger.log('🟢 dispatchBookingMessage: chat.id=' + chatId +
    ' vs adminGroupId=' + adminGroupId +
    ' chat.type=' + msg.chat.type +
    ' thread_id=' + (msg.message_thread_id || '-'));

  // ── 管理グループからの返信 ──
  if (chatId === adminGroupId) {
    Logger.log('→ route: handleAdminReply');
    handleAdminReply(msg);
    return;
  }

  // ── 顧客DM以外は無視（他グループに誤って追加されても反応しない） ──
  if (msg.chat.type !== 'private') {
    Logger.log('ℹ️ 非対応チャット種別: type=' + msg.chat.type + ' id=' + chatId);
    return;
  }

  Logger.log('→ route: handleCustomerMessage');
  handleCustomerMessage(msg);
}

/**
 * 顧客からのDMメッセージ処理
 */
function handleCustomerMessage(msg) {
  const text = (msg.text || '').trim();

  // /start コマンド → 挨拶のみ返す（転送しない）
  if (text === '/start') {
    sendWelcomeMessage(msg);
    // /start も新規顧客登録のきっかけにする：トピックだけ作っておく
    ensureCustomerTopic(msg);
    return;
  }

  // /book コマンド → 予約ミニアプリ起動ボタン
  if (text === '/book') {
    sendBookingMiniApp(msg);
    return;
  }

  // 写真メッセージは支払いスクショの可能性をまず判定（Phase 5）
  // 該当する未払い予約があれば、それとして処理し通常転送はスキップ
  var isPhoto = msg.photo && msg.photo.length > 0;
  if (isPhoto && typeof tryHandlePaymentScreenshot === 'function') {
    try {
      if (tryHandlePaymentScreenshot(msg)) {
        return;
      }
    } catch (e) {
      Logger.log('⚠️ tryHandlePaymentScreenshot エラー、通常転送に流す: ' + e);
    }
  }

  // それ以外の全メッセージ → 管理者トピックへ転送
  forwardCustomerMessage(msg);

  // 支払いスクショでない写真には軽い受領メッセージを返す
  // （駐車場所の写真など、作業前の写真を想定。支払い確認の自動返信は誤解を招くため出さない）
  if (isPhoto) {
    try {
      sendMessage(BOT_TYPE.BOOKING, msg.chat.id,
        '📸 សូមអរគុណសម្រាប់រូបថត! / Thanks for the photo!\n' +
        'ក្រុមការងាររបស់យើងបានទទួលហើយ។\n' +
        'Our team has received it.'
      );
    } catch (err) {
      Logger.log('⚠️ photo thanks reply 失敗: ' + err);
    }
  }
}

/**
 * 予約ミニアプリ起動ボタンを送信
 * Telegram Web Apps の web_app ボタン仕様に従い、booking.html を開く
 */
function sendBookingMiniApp(msg) {
  const url = getBookingMiniAppUrl();
  if (!url) {
    sendMessage(BOT_TYPE.BOOKING, msg.chat.id,
      '⚠️ ការកក់មិនអាចបានទេឥឡូវ / Booking unavailable now\n' +
      '(BOOKING_MINIAPP_URL 未設定)'
    );
    return;
  }

  const text =
    '🗓 សូមចុចប៊ូតុងខាងក្រោមដើម្បីធ្វើការកក់\n' +
    '🗓 Tap below to book your car wash';

  sendMessage(BOT_TYPE.BOOKING, msg.chat.id, text, {
    reply_markup: {
      inline_keyboard: [[
        {
          text: '🚗 ការកក់ / Booking',
          web_app: { url: url }
        }
      ]]
    }
  });
}

/**
 * 予約ミニアプリの URL を取得
 * PropertiesService から BOOKING_MINIAPP_URL を取得
 */
function getBookingMiniAppUrl() {
  return PropertiesService.getScriptProperties().getProperty('BOOKING_MINIAPP_URL') || '';
}

/**
 * /start 応答：クメール語メインで挨拶
 * 顧客がDMで直接問い合わせするのではなく、
 * 左下のメニューボタンからミニアプリを開いて予約してもらうよう誘導する。
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
    '━━━━━━━━━━━━━━━━\n' +
    '👇 សូមកក់តាមរយៈប៊ូតុងខាងក្រោមឆ្វេង\n' +
    '👇 Please book using the button at the bottom-left\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '\n' +
    '🗓 ការកក់ / Booking: /book\n' +
    '\n' +
    '📸 ឬផ្ញើរូបថតឡានរបស់អ្នកសម្រាប់សំណួរ\n' +
    '📸 Or send a photo of your car for questions.';

  // ── メニューボタンをこの顧客向けに明示設定（booking mini-app 直起動） ──
  // デフォルトでも setupBookingBotMenuButton() で全ユーザーに設定されるが、
  // /start を打つ新規顧客にはその場で再設定して即ボタンが現れるようにする。
  try {
    const url = getBookingMiniAppUrl();
    if (url) {
      setChatMenuButton(BOT_TYPE.BOOKING, {
        type: 'web_app',
        text: '🚗 Booking',
        web_app: { url: url }
      }, msg.chat.id);
    }
  } catch (e) {
    Logger.log('⚠️ setChatMenuButton for user error: ' + e);
  }

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

/**
 * 予約Bot のデフォルト メニューボタン（左下）を「🚗 Booking」ミニアプリ起動に設定する
 *
 * 【使い方】
 *   BOOKING_MINIAPP_URL を PropertiesService に登録後、GASエディタから1回実行するだけ。
 *   全ユーザーの左下ボタンがミニアプリ直起動になる。
 *   URL を変えたらもう一度実行すればOK。
 *
 * 【Telegram 仕様】
 *   setChatMenuButton を chat_id 指定なしで呼ぶと全ユーザー共通のデフォルト設定になる。
 *   ただし一度個別ユーザーにセットされた場合は、個別設定が優先される（/start で同じURLを再設定している）。
 */
function setupBookingBotMenuButton() {
  const url = getBookingMiniAppUrl();
  if (!url) {
    Logger.log('❌ BOOKING_MINIAPP_URL が未登録です。PropertiesService に登録してから再実行してください');
    return;
  }

  const res = setChatMenuButton(BOT_TYPE.BOOKING, {
    type: 'web_app',
    text: '🚗 Booking',
    web_app: { url: url }
  });

  if (res && res.ok) {
    Logger.log('✅ 予約Bot メニューボタン設定完了: ' + url);
  } else {
    Logger.log('❌ メニューボタン設定失敗: ' + JSON.stringify(res));
  }
}

/**
 * 予約Bot のメニューボタンをデフォルト（= /commands リスト表示）に戻す
 * 復旧用
 */
function resetBookingBotMenuButton() {
  const res = setChatMenuButton(BOT_TYPE.BOOKING, { type: 'default' });
  Logger.log('🔄 メニューボタン初期化: ' + JSON.stringify(res));
}
