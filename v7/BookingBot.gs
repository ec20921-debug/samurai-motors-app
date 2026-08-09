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

  // ── 顧客DM以外: 店舗グループの /register だけ受け付け、他は従来どおり無視 ──
  if (msg.chat.type !== 'private') {
    if (typeof handleShopGroupMessage_ === 'function' && handleShopGroupMessage_(msg)) {
      return;
    }
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

  // ── リピーター対策: メッセージのたびに「Booking」ボタンを自己修復 ──
  // /start を打たない既存客でも、何かの拍子にボタンが消えたら次の発言で復活する。
  // 毎回 API を叩くと無駄なので、24h に1回だけ設定する（CacheService でガード）。
  maybeRefreshBookingMenuButton_(msg.chat.id);

  // /start shop_<shop_id> → 提携店QR経由の流入（歓迎＋店タグ＋店舗グループ通知）
  if (text.indexOf('/start shop_') === 0 &&
      typeof handleShopStart_ === 'function' && handleShopStart_(msg, text)) {
    return;
  }

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

  // ── ⓪ 最初に「Booking」メニューボタンを確実にセット(最優先) ──
  // チラシ送信などの重い処理より前に置くことで、ボタンだけは即座に現れる。
  // 全ユーザー共通デフォルト(setupBookingBotMenuButton)が基本だが、
  // /start を打った人にはその場で個別にも明示設定して取りこぼしを無くす。
  ensureBookingMenuButton_(msg.chat.id);

  // ── ① まずブランドチラシを送信(視覚で世界観を伝える) ──
  // 2026-05-30: 新メニュー版チラシ(SAMURAI CAR CARE / GLASS + WASH)へ差し替え。
  // ソース = GitHub Pages ホストの flyer-2026-05.jpg(リポジトリ管理)。
  //
  // 【差替手順】新しいチラシに変えるとき:
  //   1. 新画像を本リポジトリと配信リポジトリ(samurai-motors-miniapp)の両方に
  //      「別名(バージョン入り)」で追加 例: flyer-2026-07.jpg（同期手順: docs/DEPLOY.md）
  //   2. 下の FLYER_URL のファイル名を新しいものに更新
  //   3. clasp push + git push（両リポジトリ）
  //   ※ ファイル名を変える理由: Telegram の URL キャッシュ回避(同名上書きだと
  //      旧画像がキャッシュ配信される恐れがあるため、毎回ファイル名を変える)
  //
  // フォールバックは Drive 版(GitHub Pages 障害時の保険)。
  // 2026-05-30: Drive 版も新チラシへ同期済(キャンペーン素材フォルダ内の
  //   SamuraiMoters_チラシ_2026-05.jpg を指す)。旧 ...pAHE は未使用(残置)。
  // 2026-07-03: 配信元を samurai-motors-miniapp（配信専用 public リポジトリ）へ分離。
  const FLYER_URL = 'https://ec20921-debug.github.io/samurai-motors-miniapp/flyer-2026-05.jpg';
  const FLYER_DRIVE_ID = '1ttiP6z9gUlxD-_0aPefChnUBOeYIf3MS';
  const FLYER_CAPTION = '🚗 SAMURAI MOTORS — Premium Japanese-style mobile car wash';
  let flyerSent = false;
  try {
    const r = sendPhoto(BOT_TYPE.BOOKING, msg.chat.id, FLYER_URL, { caption: FLYER_CAPTION });
    flyerSent = !!(r && r.ok);
    if (!flyerSent) Logger.log('⚠️ welcome flyer (GitHub) ok=false: ' + JSON.stringify(r).substring(0, 200));
  } catch (e) {
    Logger.log('⚠️ welcome flyer (GitHub) 例外: ' + e);
  }
  if (!flyerSent) {
    // フォールバック: 旧 Drive 版(Manage Versions で更新していればこちらが最新)
    try {
      sendPhotoFromDriveId(BOT_TYPE.BOOKING, msg.chat.id, FLYER_DRIVE_ID, { caption: FLYER_CAPTION });
    } catch (e2) {
      Logger.log('⚠️ flyer fallback (Drive) も失敗: ' + e2);
    }
  }

  // ── ② キャンペーンバナー(動的取得、チラシは evergreen)──
  let campaignLine = '';
  try {
    const bcfg = getBookingConfig();
    const camp = bcfg && bcfg.campaign;
    if (camp && camp.active && camp.percent > 0) {
      campaignLine =
        '━━━━━━━━━━━━━━━━\n' +
        '🎌 ' + (camp.nameEn || 'Special') + ' — ' + camp.percent + '% OFF\n' +
        '   (limited time, services only)\n' +
        '━━━━━━━━━━━━━━━━\n\n';
    }
  } catch (e) { /* 失敗しても welcome は送る */ }

  const text =
    'Hello' + (name ? ' ' + name : '') + '! 👋\n' +
    'Welcome to SAMURAI MOTORS.\n' +
    '\n' +
    'សួស្តី! សូមស្វាគមន៍\n' +
    '\n' +
    campaignLine +
    '👇 Tap the "Booking" button below to reserve your slot now\n' +
    '👇 ចុចប៊ូតុង "Booking" ខាងក្រោមឆ្វេងដើម្បីកក់\n' +
    '\n' +
    '🗓 Or use /book to start\n' +
    '📸 Or send a photo of your car for questions';

  // メニューボタンは冒頭の ensureBookingMenuButton_ で設定済み（取りこぼし防止）

  sendMessage(BOT_TYPE.BOOKING, msg.chat.id, text);

  // 管理グループにも通知
  sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
    'ℹ️ /start 受信: ' + buildDisplayName(extractCustomerFromMessage(msg)) +
    ' (chat_id=' + msg.chat.id + ')'
  );
}

/**
 * この顧客の「Booking」メニューボタン(左下)を確実に設定する。
 * /start 受信時に最優先で呼び、チラシ等の重い処理より前にボタンを出す。
 * 失敗しても welcome 本体は続行する（ボタンはデフォルト設定で出る想定）。
 *
 * @param {string|number} chatId
 */
function ensureBookingMenuButton_(chatId) {
  try {
    const url = getBookingMiniAppUrl();
    if (!url) {
      Logger.log('⚠️ ensureBookingMenuButton_: BOOKING_MINIAPP_URL 未設定');
      return;
    }
    setChatMenuButton(BOT_TYPE.BOOKING, {
      type: 'web_app',
      text: '🚗 Booking',
      web_app: { url: url }
    }, chatId);
  } catch (e) {
    Logger.log('⚠️ ensureBookingMenuButton_ error: ' + e);
  }
}

/**
 * 24h に1回だけ、この顧客の Booking メニューボタンを再設定する（自己修復）。
 * 既存客がメッセージを送るたびに呼ばれるが、CacheService で頻度を絞り
 * Telegram API の無駄打ちを防ぐ。設定済みフラグが生きていればスキップ。
 *
 * @param {string|number} chatId
 */
function maybeRefreshBookingMenuButton_(chatId) {
  try {
    const cache = CacheService.getScriptCache();
    const key = 'menubtn_' + chatId;
    if (cache.get(key)) return;           // 24h 以内に設定済み → スキップ
    ensureBookingMenuButton_(chatId);
    cache.put(key, '1', 21600);           // 6h（Cache上限）。失効後また設定し直す
  } catch (e) {
    Logger.log('⚠️ maybeRefreshBookingMenuButton_ error: ' + e);
  }
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
