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

// Samurai Motors 公式 Facebook ページ（Day1 tools/meta_*.py の FB_PAGE_URL と同じ）
const SAMURAI_FB_PAGE_URL = 'https://www.facebook.com/samuraimotors.kh';

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

  // /start link_<連携コード> / bk_<予約ID> → 手入力ジョブのQR連携（2026-08-28）
  // 写真3方向配信＋顧客台帳・管理トピックへの紐付け（ManualCustomerLink.gs）
  if ((text.indexOf('/start link_') === 0 || text.indexOf('/start bk_') === 0) &&
      typeof handleManualLinkStart_ === 'function' && handleManualLinkStart_(msg, text)) {
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
function sendWelcomeMessage(msg, opts) {
  // opts（省略可・2026-08-10 提携店対応）:
  //   skipCampaign: true = キャンペーンバナー非表示（提携店経由は定価・キャンペーン対象外 = Daisuke裁可⑩）
  //   shopName: 紹介元の店名（表示すると「この店の客として扱われている」証明になる）
  opts = opts || {};
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
  // 2026-10-11: 全サービスチラシ（10/8 版・クメール語）へ差し替え（Daisuke 指示）。
  //   元 PDF = Deliverables/2026-10-08_SamuraiMotors_全サービスチラシ_km.pdf を 200dpi で JPG 化。
  //   Drive フォールバックも同じ画像（「キャンペーン素材」フォルダの SamuraiMotors_チラシ_2026-10-08.jpg）。
  const FLYER_URL = 'https://ec20921-debug.github.io/samurai-motors-miniapp/flyer-2026-10-08.jpg';
  const FLYER_DRIVE_ID = '1AOR1382WNdu1LJmOGG2depn1PQxHOHgH';
  const FLYER_CAPTION = '🚗 SAMURAI MOTORS — Premium Japanese car care, we come to you';
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
  // 提携店QR経由(skipCampaign)は表示しない: キャンペーン30%オフ×店コミッション30%の
  // 二重適用で当社手取りが定価の49%まで落ちるため（2026-08-10 Daisuke裁可）
  let campaignLine = '';
  try {
    const bcfg = getBookingConfig();
    const camp = bcfg && bcfg.campaign;
    if (!opts.skipCampaign && camp && camp.active && camp.percent > 0) {
      campaignLine =
        '━━━━━━━━━━━━━━━━\n' +
        '🎌 ' + (camp.nameEn || 'Special') + ' — ' + camp.percent + '% OFF\n' +
        '   (limited time, services only)\n' +
        '━━━━━━━━━━━━━━━━\n\n';
    }
  } catch (e) { /* 失敗しても welcome は送る */ }

  // 紹介元の店名行（提携店QR経由のみ。クメール語版は Panha 校閲後に追加予定）
  const referralLine = opts.shopName
    ? '🤝 Referred by ' + opts.shopName + ' — thank you!\n\n'
    : '';

  // 2026-10-11 改訂（Daisuke 指示）: クメール語を先に・お客様の行動は
  //   「① Booking ボタン ② メッセージ（ボイス可）」の2択に絞る・Facebook ページを添える。
  //   クメール語は Panha 校閲済み（条件付き承認・名前なしは「សួស្តីបង!」で分岐）。
  const greetKm = name ? 'សួស្តី ' + name + '! 👋' : 'សួស្តីបង! 👋';
  const greetEn = name ? 'Hello ' + name + '! ' : 'Hello! ';
  const text =
    greetKm + '\n' +
    'សូមស្វាគមន៍មកកាន់ SAMURAI MOTORS 🙏\n' +
    greetEn + 'Welcome to SAMURAI MOTORS.\n' +
    '\n' +
    'ការថែទាំរថយន្តគុណភាពជប៉ុន ដល់ទីតាំងអ្នក\n' +
    'Premium Japanese car care — we come to you.\n' +
    '\n' +
    referralLine +
    campaignLine +
    '👇 កក់ ឬសាកសួរ / Book or ask:\n' +
    '\n' +
    '① 🚗 ចុចប៊ូតុង «Booking» នៅជ្រុងខាងឆ្វេងក្រោម\n' +
    '   Tap the "Booking" button (bottom left)\n' +
    '\n' +
    '② 💬 ផ្ញើសារមកយើងនៅទីនេះ — ផ្ញើជាសារសំឡេងក៏បាន 🎤\n' +
    '   Or just send us a message here — voice messages OK 🎤\n' +
    '\n' +
    '📘 Facebook: ' + SAMURAI_FB_PAGE_URL;

  // メニューボタンは冒頭の ensureBookingMenuButton_ で設定済み（取りこぼし防止）

  // FB リンクのプレビューカードは大きく本文を押し流すので出さない
  sendMessage(BOT_TYPE.BOOKING, msg.chat.id, text, { disable_web_page_preview: true });

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

/**
 * 予約Bot のプロフィール説明文を設定する（2026-10-11 追加）
 *   - short description（About）: プロフィール画面・共有時に出る一言（上限120字）
 *   - description: トークを開いて START を押す前の空チャットに出る説明（上限512字）
 *
 * 【使い方】GASエディタからこの関数を1回実行するだけ。設定前の値もログに残す（戻すとき用）。
 * クメール語は Panha 校閲済み（2026-10-11・条件付き承認）。
 * START 前は Booking ボタンが見えないため、案内は「START を押した後に」の形にしてある。
 */
function setupBookingBotProfile() {
  const shortDescription =
    'ការថែទាំរថយន្តគុណភាពជប៉ុន ដល់ទីតាំងអ្នក 🚗 Premium Japanese car care — we come to you.';

  const description =
    '🚗 SAMURAI MOTORS — ភ្នំពេញ / Phnom Penh\n' +
    'ការថែទាំរថយន្តគុណភាពជប៉ុន ដល់ទីតាំងអ្នក\n' +
    'Premium Japanese car care — we come to you.\n' +
    '\n' +
    '✨ លាងដោយដៃ បែប Waterless · ស្រោបទឹកមិនជាប់លើកញ្ចក់ · ខាត់ចង្កៀងមុខ · ខាត់ខ្លួនរថយន្ត\n' +
    '✨ Waterless wash · Glass coating · Headlight · Polish\n' +
    '\n' +
    '📅 បន្ទាប់ពីចុច START — កក់តាមប៊ូតុង Booking ឬផ្ញើសារមកយើង (សារសំឡេងក៏បាន)\n' +
    '📅 After tapping START — book with the Booking button, or just message us (voice OK)\n' +
    '\n' +
    '📘 ' + SAMURAI_FB_PAGE_URL;

  // 上限チェック（超えると Telegram が拒否するので先に止める）
  if (shortDescription.length > 120 || description.length > 512) {
    Logger.log('❌ 文字数超過: short=' + shortDescription.length + '/120, description=' + description.length + '/512');
    return;
  }

  // 現在の値を記録（戻す時に使う）
  Logger.log('📝 変更前 short: ' + JSON.stringify(callTelegramApi(BOT_TYPE.BOOKING, 'getMyShortDescription', {})));
  Logger.log('📝 変更前 description: ' + JSON.stringify(callTelegramApi(BOT_TYPE.BOOKING, 'getMyDescription', {})));

  const r1 = callTelegramApi(BOT_TYPE.BOOKING, 'setMyShortDescription', { short_description: shortDescription });
  const r2 = callTelegramApi(BOT_TYPE.BOOKING, 'setMyDescription', { description: description });
  Logger.log((r1 && r1.ok ? '✅' : '❌') + ' short description (' + shortDescription.length + '字): ' + JSON.stringify(r1));
  Logger.log((r2 && r2.ok ? '✅' : '❌') + ' description (' + description.length + '字): ' + JSON.stringify(r2));
}
