// ╔══════════════════════════════════════════════════════════════╗
// ║  Samurai Motors - 統合管理 Apps Script v6                    ║
// ║  業務管理 + 予約管理 + 3 Bot構成（Admin/Field/Booking）       ║
// ╠══════════════════════════════════════════════════════════════╣
// ║                                                              ║
// ║  【v5 → v6 変更点】                                          ║
// ║  ① 経費の複数枚レシート対応                                   ║
// ║  ② 予約管理シート (Customers / Bookings) 追加                ║
// ║  ③ Google Calendar (samuraimotors.japan@gmail.com) 連携     ║
// ║  ④ プラン所要時間自動計算（A30/B40/C50/D80 + SUV+15 + Opt）   ║
// ║  ⑤ 営業時間 9:00-18:00、移動バッファ30分の空き枠検索          ║
// ║  ⑥ 予約Bot (Booking Bot) 対話フロー                          ║
// ║  ⑦ 駐車写真フロー（前面写真 + 階数 受付）                     ║
// ║  ⑧ QR決済スクショ受付 + 24h催促トリガー                      ║
// ║  ⑨ 業務管理アプリ ↔ 予約Bot 連携（作業完了→QR自動送信）      ║
// ║  ⑩ 3 Bot Token対応（BOT_TOKENS で使い分け）                   ║
// ║                                                              ║
// ║  【更新手順】                                                 ║
// ║  ① Apps Script エディタで既存コードを全て削除                  ║
// ║  ② このコードを貼り付け → Ctrl+S で保存                      ║
// ║  ③ 「サービス」→ Drive API v2 / Calendar API を有効化         ║
// ║  ④ BOT_TOKENS / BOOKING_CALENDAR_ID を実値に差し替え          ║
// ║  ⑤ 「デプロイ」→「デプロイを管理」→ 鉛筆アイコン              ║
// ║  ⑥ バージョン「新しいバージョン」→「デプロイ」                 ║
// ║  ⑦ setupV6Sheets() を実行 → 全シート（既存+予約系）作成      ║
// ║  ⑧ setupV6Triggers() を実行 → トリガー一括設定（24h催促含む）║
// ║  ⑨ setupBookingWebhook() を実行 → Booking Bot Webhook設定    ║
// ║                                                              ║
// ╚══════════════════════════════════════════════════════════════╝

// ═══════════════════════════════════════════
//  設定
// ═══════════════════════════════════════════

// Google Driveフォルダ名
var PHOTO_FOLDER_NAME = 'SamuraiMotors_Photos';
var RECEIPT_FOLDER_NAME = 'SamuraiMotors_Receipts';

// シート名
var INVENTORY_SHEET_NAME = 'Inventory';
var TASKS_SHEET_NAME = 'Tasks';
var EXPENSES_SHEET_NAME = 'Expenses';
var DAILY_REPORTS_SHEET_NAME = 'DailyReports';
var ATTENDANCE_SHEET_NAME = 'Attendance';
// v6 追加: 予約管理シート
var CUSTOMERS_SHEET_NAME = 'Customers';
var BOOKINGS_SHEET_NAME = 'Bookings';
var VEHICLES_SHEET_NAME = 'Vehicles';
var CHATLOG_SHEET_NAME = 'ChatLog';

// デプロイ済みWebアプリURL（Webhook設定用）
// ※ 新しいデプロイを作成したらこのURLを更新すること
var DEPLOYED_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxJfqfid10yT_gRxzUb01qoN_RUVr6AcMuKzVpE7w3_cZoDKNewnBjKO4DO96LPA1hh/exec';

// Telegram Bot設定
// v6 から 3 Bot構成（同じトークンを共有しても動くが、本番では別々のトークンを推奨）
var BOT_TOKENS = {
  admin:   '8564495597:AAFJBCDq6wKGMusI_kPk1_EfC4_JcEqyz5Q', // @samurai_motors_admin_bot
  field:   '8248146123:AAEORbRSuqwLgZxcb-Pyc90DaDScH4W2j7w', // @quickwash_kh_bot
  booking: '8613749365:AAFxzFX9PMEcozXoHGFqJjIrqQpBcePSM6k'  // @samurai_motors_booking_bot
};
// 後方互換: 既存コードが参照する単一トークン（=admin token）
var TELEGRAM_BOT_TOKEN = BOT_TOKENS.admin;

// Booking Bot用ミニアプリURL（GitHub Pages）
// HTTPS必須・Telegram Mini App として開く際のURL
var BOOKING_APP_URL = 'https://ec20921-debug.github.io/samurai-motors-app/booking.html';

// Booking Botのusername（@なし）。t.me/USERNAME/app?startapp=... でMini App起動
var BOOKING_BOT_USERNAME = 'samurai_booking_bot'; // TODO: 実際のbot usernameに差し替え

// 駐車写真・支払いスクショの保存先Driveフォルダ名
var BOOKING_PARKING_FOLDER = 'SamuraiMotors_Parking';
var BOOKING_PAYMENT_FOLDER = 'SamuraiMotors_Payments';

// ABA決済情報（顧客への支払い案内に表示）
var BOOKING_ABA_INFO = {
  accountName: 'SAMURAI MOTORS',
  accountNumber: '000 123 456',     // TODO: 実際の口座番号
  qrImageUrl: ''                    // TODO: ABA KHQR画像URL（Drive公開リンク等）
};

// 24h催促の閾値（時間）
var BOOKING_REMINDER_HOURS = 24;

// 通知先チャットID（複数指定で両方に送信）
var TELEGRAM_CHAT_IDS = [
  '7500384947',   // 個人チャット（d suzuki）
  '-5178607881'   // グループ（【admin】Samurai motors業務管理）
];

// メッセージ転送設定
var ADMIN_GROUP_ID = '-5033046558';     // Adminグループ（新テスト用）

// スタッフ登録（複数人対応）
// 追加時: Chat IDをキーとして { name, role } を追加
var STAFF_REGISTRY = {
  '7500384947': { name: 'ロン', nameKh: 'រ៉ន', role: 'field' }
};

// 全フィールドスタッフのChat IDリスト（自動生成）
var FIELD_STAFF_IDS = Object.keys(STAFF_REGISTRY).filter(function(id) {
  return STAFF_REGISTRY[id].role === 'field';
});

// ═══════════════════════════════════════════
//  v6: 予約管理 設定
// ═══════════════════════════════════════════

// Google Calendar（予約用）
// samuraimotors.japan@gmail.com のメインカレンダーID（メールアドレスをそのままIDとして使用可能）
var BOOKING_CALENDAR_ID = 'samuraimotors.japan@gmail.com';

// 営業時間 (24時間表記)
var BUSINESS_HOUR_START = 9;   // 9:00
var BUSINESS_HOUR_END   = 18;  // 18:00

// 予約間隔バッファ（次の予約までの移動時間, 分）
var BOOKING_BUFFER_MIN = 30;

// 予約タイムゾーン
var BOOKING_TIMEZONE = 'Asia/Phnom_Penh';
var CAMBODIA_UTC_OFFSET = 7; // カンボジアはUTC+7固定（DST無し）

// カンボジア時間で指定した日時を正しいDate型に変換
// GASスクリプトのタイムゾーン（日本時間等）に関わらず正しく動作
function toCambodiaDate(dateStr, hour, min) {
  var parts = dateStr.split('-');
  return new Date(Date.UTC(
    parseInt(parts[0], 10),
    parseInt(parts[1], 10) - 1,
    parseInt(parts[2], 10),
    hour - CAMBODIA_UTC_OFFSET, // UTC変換: カンボジア9時 = UTC2時
    min || 0,
    0
  ));
}

// プラン基本所要時間（分） - セダン以下の値
// SUV以上は +15分
var PLAN_DURATIONS = {
  'A': 30,  // 清 KIYOME
  'B': 40,  // 鏡 KAGAMI
  'C': 50,  // 匠 TAKUMI
  'D': 80   // 将軍 SHOGUN
};
var SUV_EXTRA_MIN = 15;

// オプション所要時間（分）
// id: { name, nameKm, durationMin }
var BOOKING_OPTIONS = {
  'mirror_coat':       { name: 'ミラー撥水コーティング',     nameKm: 'ការការពារកញ្ចក់ចំហៀង',     durationMin: 5  },
  'glass_water_front': { name: 'ガラス撥水（前面のみ）',     nameKm: 'ការពារទឹកកញ្ចក់ខាងមុខ',    durationMin: 10 },
  'glass_water_3':     { name: 'ガラス撥水（3面）',          nameKm: 'ការពារទឹកកញ្ចក់ ៣ផ្នែក',    durationMin: 15 },
  'oil_remove_1':      { name: 'ガラス油膜落とし（フロント1面）', nameKm: 'លុបស្នាមប្រេងកញ្ចក់ ១ផ្នែក', durationMin: 15 },
  'oil_remove_3':      { name: 'ガラス油膜落とし（3面）',     nameKm: 'លុបស្នាមប្រេងកញ្ចក់ ៣ផ្នែក', durationMin: 25 },
  'oil_remove_all':    { name: 'ガラス油膜落とし（全面）',    nameKm: 'លុបស្នាមប្រេងកញ្ចក់ទាំងអស់', durationMin: 50 },
  'body_coat':         { name: 'ボディ撥水コーティング',     nameKm: 'ការការពារទឹកលើតួ',         durationMin: 60 }
};

// ═══════════════════════════════════════════
//  正しいヘッダー定義（23列）
// ═══════════════════════════════════════════

var CORRECT_HEADERS = [
  'Job ID',
  'ថ្ងៃចុះបញ្ជី（登録日時）',
  'ឈ្មោះ（顧客名）',
  'ទូរស័ព្ទ（電話番号）',
  'អគារ（建物）',
  'បន្ទប់（部屋番号）',
  'រថយន្ត（車種）',
  'ស្លាកលេខ（ナンバー）',
  'គម្រោង（プラン）',
  'Google Maps',
  'កំណត់សម្គាល់（備考）',
  'កាលវិភាគ（予約日時）',
  'ចាប់ផ្តើម（開始時刻）',
  'បញ្ចប់（終了時刻）',
  'រយៈពេល（所要分）',
  'មុន 1（ビフォー1）',
  'មុន 2（ビフォー2）',
  'មុន 3（ビフォー3）',
  'មុន 4（ビフォー4）',
  'ក្រោយ 1（アフター1）',
  'ក្រោយ 2（アフター2）',
  'ក្រោយ 3（アフター3）',
  'ក្រោយ 4（アフター4）',
  'តម្លៃ USD（売上金額USD）'
];

// プラン別の標準価格（USD）。Plan_Pricesシートで上書き可能
// 料金は [セダン価格, SUV価格] の2値で管理。
// 出張料は特別行として扱い、全プランに加算される。
// キャンペーン時はこのシートの数字だけ書き換えれば即反映。
var DEFAULT_PLAN_PRICES = {
  '清 KIYOME (A)': [12, 15],
  '鏡 KAGAMI (B)': [17, 20],
  '匠 TAKUMI (C)': [20, 23],
  '将軍 SHOGUN (D)': [32, 35],
  '出張料': [2, 2]  // 全プラン共通で加算される特別行
};

// 出張料の行名（Plan_Pricesシートでの識別用）
var DISPATCH_FEE_ROW = '出張料';

// ═══════════════════════════════════════════
//  メインルーター：action で処理を振り分け
// ═══════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // Telegram Webhookからのメッセージ（update_idがある場合）
    // === 非同期キュー方式 ===
    // 即座にキューに保存してokを返し、Telegramのタイムアウト/リトライを防止。
    // 実処理は1分毎のprocessTelegramQueue()トリガーで行う。
    if (data.update_id) {
      var botType = (e.parameter && e.parameter.bot) ? e.parameter.bot : 'admin';
      try {
        enqueueTelegramUpdate(data, botType);
      } catch (qErr) {
        Logger.log('enqueueTelegramUpdate error: ' + qErr.toString());
      }
      // Telegramに即座にokを返す（処理時間は数ミリ秒で終わる）
      return ContentService.createTextOutput('ok');
    }

    // ミニアプリからのリクエスト（actionがある場合）
    var action = data.action || 'job';

    switch (action) {
      case 'job':
        return handleJobSubmit(data);
      case 'job_start':
        return handleJobStart(data);
      case 'job_end':
        return handleJobEnd(data);
      // Phase 1: task/expense/daily_report/attendance は無効化（DISABLED_FEATURES.md §1-4）
      // --- v6 Booking Mini App ---
      case 'booking_register_customer':
        return handleBookingRegisterCustomerFromApp(data);
      case 'booking_add_vehicle':
        return handleBookingAddVehicleFromApp(data);
      case 'booking_create':
        return handleBookingCreateFromApp(data);
      // --- v6 Job ↔ Booking 連携 ---
      case 'booking_link_job':
        return handleBookingLinkJobFromApp(data);
      case 'booking_send_payment':
        return handleBookingSendPaymentFromApp(data);
      case 'booking_set_status':
        return handleBookingSetStatusFromApp(data);
      case 'booking_message':
        return handleBookingMessageFromApp(data);
      // --- v6 Phase2: 顧客問い合わせ ---
      case 'inquiry_reply':
        return handleInquiryReplyFromApp(data);
      // --- v6 Phase3: チャット履歴 ---
      case 'chat_history':
        return handleChatHistoryFromApp(data);
      case 'chat_summary':
        return handleChatSummaryFromApp(data);
      case 'chat_send':
        return handleChatSendFromApp(data);
      default:
        return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });
    }
  } catch (error) {
    Logger.log('doPost error: ' + error.toString());
    return jsonResponse({ status: 'error', message: error.toString() });
  }
}

// ═══════════════════════════════════════════
//  Telegram Webhook：メッセージルーティング
// ═══════════════════════════════════════════

function handleTelegramWebhook(update, botType) {
  // botType が未指定の場合は admin として扱う（後方互換）
  botType = botType || 'admin';

  // callback_query（インラインボタン押下）の処理
  if (update.callback_query) {
    return handleCallbackQuery(update.callback_query, botType);
  }

  var message = update.message;
  if (!message) {
    return ContentService.createTextOutput('ok');
  }

  var chatId = String(message.chat.id);
  var fromBot = message.from && message.from.is_bot;

  // ボット自身のメッセージは無視（ループ防止）
  if (fromBot) {
    return ContentService.createTextOutput('ok');
  }

  var senderName = (message.from.first_name || '') + ' ' + (message.from.last_name || '');
  senderName = senderName.trim();

  // 会話状態チェック（対話フロー中の場合）
  var convState = getConversationState(chatId);
  if (convState) {
    // message_idベースの重複チェック（admin/field会話フロー用）
    var admConvCache = CacheService.getScriptCache();
    var admConvKey = 'adm_conv_' + chatId + '_' + message.message_id;
    if (admConvCache.get(admConvKey)) {
      Logger.log('Duplicate admin conv blocked: chatId=' + chatId + ' msg_id=' + message.message_id);
      return ContentService.createTextOutput('ok');
    }
    admConvCache.put(admConvKey, '1', 300);

    handleConversationState(chatId, message, convState, senderName);
    return ContentService.createTextOutput('ok');
  }

  // --- Adminグループからのメッセージ ---
  // Phase 1: /task /tasklist コマンド・Admin→Field一般転送は無効化（DISABLED_FEATURES.md §1, §6）
  if (chatId === ADMIN_GROUP_ID) {
    // /reply <chatId> <message> : Booking Botから顧客に返信（コア機能）
    if (message.text && message.text.indexOf('/reply') === 0) {
      handleAdminReplyCommand(chatId, message.text);
      return ContentService.createTextOutput('ok');
    }
  }

  // --- 現場スタッフからのメッセージ ---
  // Phase 1: /receipt /tasks コマンド・Field→Admin一般転送は無効化（DISABLED_FEATURES.md §1, §2, §6）
  // STAFF_REGISTRY参照は維持（将来の復元時の分岐ポイント）

  return ContentService.createTextOutput('ok');
}

// ═══════════════════════════════════════════
//  Booking Bot Webhook（顧客向け）
//  ?bot=booking で受信したupdateを処理
// ═══════════════════════════════════════════

function handleBookingBotWebhook(update) {
  // callback_query処理
  if (update.callback_query) {
    var cb = update.callback_query;
    var cbChatId = String(cb.message.chat.id);
    var cbData = cb.data || '';

    if (cbData === 'booking_history') {
      answerBookingCallbackQuery(cb.id, '読み込み中...');
      showCustomerBookingHistory(cbChatId);
    } else if (cbData === 'booking_help') {
      answerBookingCallbackQuery(cb.id, '');
      sendBookingBotMessage(cbChatId,
        'ℹ️ *Samurai Motors*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '🚗 Mobile Car Wash Service / សេវាលាងឡានដល់ផ្ទះ\n'
        + '⏰ Hours / ម៉ោងធ្វើការ: 9:00 - 18:00\n\n'
        + 'Feel free to send us a message here.\n'
        + 'សំណួរផ្សេងៗសូមផ្ញើសារនៅទីនេះ។'
      );
    } else {
      answerBookingCallbackQuery(cb.id, '');
    }
    return ContentService.createTextOutput('ok');
  }

  var message = update.message;
  if (!message) {
    return ContentService.createTextOutput('ok');
  }

  var chatId = String(message.chat.id);
  var fromBot = message.from && message.from.is_bot;
  if (fromBot) return ContentService.createTextOutput('ok');

  var text = (message.text || '').trim();
  var firstName = (message.from.first_name || '').trim();

  // 会話状態チェック（駐車写真・支払いスクショ待ち等）
  var convState = getBookingConvState(chatId);
  if (convState) {
    // message_idベースの重複チェック（会話フロー用）
    var convCache = CacheService.getScriptCache();
    var convCacheKey = 'conv_msg_' + chatId + '_' + message.message_id;
    if (convCache.get(convCacheKey)) {
      Logger.log('Duplicate conv message blocked: chatId=' + chatId + ' msg_id=' + message.message_id);
      return ContentService.createTextOutput('ok');
    }
    convCache.put(convCacheKey, '1', 300);

    // /cancelで状態クリア
    if (text === '/cancel' || text === 'キャンセル') {
      clearBookingConvState(chatId);
      sendBookingBotMessage(chatId, '❌ Cancelled.\n❌ បានបោះបង់។');
      return ContentService.createTextOutput('ok');
    }
    handleBookingConversation(chatId, message, convState);
    return ContentService.createTextOutput('ok');
  }

  // /start: ミニアプリ起動ボタン送信
  if (text.indexOf('/start') === 0 || text === '予約' || text.toLowerCase() === 'book') {
    sendBookingBotWelcome(chatId, firstName);
    return ContentService.createTextOutput('ok');
  }

  // /help: 使い方
  if (text.indexOf('/help') === 0) {
    sendBookingBotMessage(chatId,
      'ℹ️ *Samurai Motors Booking Bot*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🚗 Tap the button to book\n'
      + '🚗 ចុចប៊ូតុងដើម្បីកក់\n\n'
      + 'How to use / របៀបប្រើ:\n'
      + '/start - Open booking / បើកការកក់\n'
      + '/mybookings - Booking history / ប្រវត្តិកក់\n'
      + '/help - This help / ជំនួយ'
    );
    return ContentService.createTextOutput('ok');
  }

  // /mybookings: 予約履歴
  if (text.indexOf('/mybookings') === 0 || text === '履歴' || text === 'history') {
    showCustomerBookingHistory(chatId);
    return ContentService.createTextOutput('ok');
  }

  // それ以外: 顧客からの問い合わせとして保存＋スタッフに通知
  // message_idベースの二重防御（LockServiceに加えて）
  var inqCache = CacheService.getScriptCache();
  var inqCacheKey = 'inq_msg_' + chatId + '_' + message.message_id;
  if (inqCache.get(inqCacheKey)) {
    Logger.log('Duplicate inquiry blocked: chatId=' + chatId + ' msg_id=' + message.message_id);
    return ContentService.createTextOutput('ok');
  }
  inqCache.put(inqCacheKey, '1', 300);

  var msgType = 'text';
  var msgContent = text;
  var mediaUrl = '';

  // テキストメッセージ
  if (text) {
    msgType = 'text';
    msgContent = text;
  }
  // 写真
  else if (message.photo && message.photo.length > 0) {
    msgType = 'photo';
    msgContent = message.caption || '（写真）';
    try {
      var photo = message.photo[message.photo.length - 1];
      var fi = getBookingBotFile(photo.file_id);
      if (fi && fi.result && fi.result.file_path) {
        var pUrl = 'https://api.telegram.org/file/bot' + BOT_TOKENS.booking + '/' + fi.result.file_path;
        var blob = UrlFetchApp.fetch(pUrl).getBlob();
        var folder = getOrCreateFolder('SamuraiMotors_Inquiries');
        var dateStr = Utilities.formatDate(new Date(), BOOKING_TIMEZONE, 'yyyyMMdd_HHmmss');
        blob.setName('inquiry_photo_' + chatId + '_' + dateStr + '.jpg');
        var saved = folder.createFile(blob);
        saved.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        mediaUrl = saved.getUrl();
      }
    } catch (e) { Logger.log('Inquiry photo save error: ' + e); }
  }
  // ボイスメモ（テキスト変換なし、Driveに保存して履歴として残す）
  else if (message.voice) {
    msgType = 'voice';
    msgContent = '（ボイスメモ ' + (message.voice.duration || 0) + '秒）';
    try {
      var vfi = getBookingBotFile(message.voice.file_id);
      if (vfi && vfi.result && vfi.result.file_path) {
        var vUrl = 'https://api.telegram.org/file/bot' + BOT_TOKENS.booking + '/' + vfi.result.file_path;
        var vBlob = UrlFetchApp.fetch(vUrl).getBlob();
        var vFolder = getOrCreateFolder('SamuraiMotors_Inquiries');
        var vDateStr = Utilities.formatDate(new Date(), BOOKING_TIMEZONE, 'yyyyMMdd_HHmmss');
        vBlob.setName('inquiry_voice_' + chatId + '_' + vDateStr + '.ogg');
        var vSaved = vFolder.createFile(vBlob);
        vSaved.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        mediaUrl = vSaved.getUrl();
      }
    } catch (e) { Logger.log('Inquiry voice save error: ' + e); }
  }
  // ドキュメント
  else if (message.document) {
    msgType = 'document';
    msgContent = message.caption || '（ファイル: ' + (message.document.file_name || '不明') + '）';
  }
  // スタンプ等
  else if (message.sticker) {
    msgType = 'sticker';
    msgContent = '（スタンプ: ' + (message.sticker.emoji || '') + '）';
  }
  // 何も判定できない場合はスキップ
  else {
    return ContentService.createTextOutput('ok');
  }

  // Inquiriesシートに保存
  var inquiryId = createInquiry(chatId, firstName, msgContent, msgType, mediaUrl);

  // ChatLogにも記録（顧客からの受信）
  logChatMessage(chatId, 'customer', msgContent, firstName, mediaUrl);

  // 顧客に受領メッセージ
  sendBookingBotMessage(chatId,
    '✅ *Message received!*\n'
    + '✅ *សារបានទទួល!*\n\n'
    + 'We will reply shortly.\n'
    + 'យើងនឹងឆ្លើយតបក្នុងពេលឆាប់ៗ។'
  );

  // フィールドスタッフ＋Adminに通知
  var typeIcon = { text: '💬', photo: '📷', voice: '🎤', document: '📎', sticker: '🏷️' };
  var notifyMsg = '📩 *新規問い合わせ / សារថ្មីពីអតិថិជន*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + inquiryId + '\n'
    + '👤 ' + firstName + '\n'
    + (typeIcon[msgType] || '💬') + ' ' + msgContent
    + (mediaUrl ? '\n🔗 ' + mediaUrl : '');

  // Field Bot経由でフィールドスタッフに通知（「返信」ボタン付き）
  var replyKeyboard = {
    inline_keyboard: [[
      { text: '💬 返信 / ឆ្លើយតប', callback_data: 'reply_inquiry_' + chatId }
    ]]
  };
  FIELD_STAFF_IDS.forEach(function(staffId) {
    sendFieldBotWithKeyboard(staffId, notifyMsg, replyKeyboard);
  });

  // Adminグループにも通知（参照用、返信ボタン付き）
  sendTelegramWithKeyboard(ADMIN_GROUP_ID, notifyMsg, {
    inline_keyboard: [[
      { text: '💬 返信 / Reply', callback_data: 'reply_inquiry_' + chatId }
    ]]
  });

  return ContentService.createTextOutput('ok');
}

// 予約Bot Welcomeメッセージ + ミニアプリ起動ボタン（英語メイン・クメール語サブ）
function sendBookingBotWelcome(chatId, firstName) {
  var greeting = firstName
    ? ('👋 Hello, ' + firstName + '! / សួស្តី!')
    : '👋 Hello! / សួស្តី!';

  var msg = greeting + '\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🚗 *Samurai Motors*\n'
    + 'Japanese-style Mobile Car Wash Service\n'
    + 'សេវាលាងឡានដល់ផ្ទះបែបជប៉ុន\n\n'
    + '👇 Tap the button below to book\n'
    + '👇 ចុចប៊ូតុងខាងក្រោមដើម្បីកក់';

  var keyboard = {
    inline_keyboard: [[
      {
        text: '🚗 Book Now / កក់ឥឡូវ',
        web_app: { url: BOOKING_APP_URL }
      }
    ], [
      { text: '📋 History / ប្រវត្តិ', callback_data: 'booking_history' },
      { text: 'ℹ️ Help / ជំនួយ', callback_data: 'booking_help' }
    ]]
  };

  sendBookingBotMessage(chatId, msg, keyboard);
}

// 顧客の予約履歴をテキスト一覧で表示（キャンセル機能はミニアプリのお問い合わせ経由）
function showCustomerBookingHistory(chatId) {
  var sheet = getBookingsSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    sendBookingBotMessage(chatId, '📋 No booking history.\n📋 មិនមានប្រវត្តិកក់ទេ។');
    return;
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 25).getValues();
  var mine = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][4] && data[i][4].toString() === chatId) {
      mine.push(data[i]);
    }
  }
  if (mine.length === 0) {
    sendBookingBotMessage(chatId, '📋 No booking history.\n📋 មិនមានប្រវត្តិកក់ទេ។');
    return;
  }

  // 新しい順に最大10件
  mine.reverse();
  var msg = '📋 *予約履歴 / ប្រវត្តិកក់*\n━━━━━━━━━━━━━━━\n\n';
  mine.slice(0, 10).forEach(function(row, idx) {
    var dateStr = row[5] instanceof Date ? Utilities.formatDate(row[5], SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd') : (row[5] ? row[5].toString().substring(0, 10) : '-');
    msg += (idx + 1) + '. 🆔 ' + row[0] + '\n'
        + '   📅 ' + dateStr + ' ' + (row[6] || '') + '\n'
        + '   ✨ プラン' + (row[9] || '') + ' / ' + (row[10] || '') + '\n'
        + '   💰 $' + (row[15] || 0) + '\n'
        + '   📌 ' + (row[16] || '-') + ' / 💳 ' + (row[17] || '-') + '\n\n';
  });

  msg += '━━━━━━━━━━━━━━━\n'
      + '💬 キャンセル・変更のご希望はミニアプリの\n'
      + '「お問い合わせ」からご連絡ください。\n'
      + '💬 សម្រាប់ការបោះបង់ ឬ ផ្លាស់ប្តូរ សូមទំនាក់ទំនងពី\n'
      + '"សារ" នៅក្នុងមីនីអេប។';

  sendBookingBotMessage(chatId, msg);
}

// ─── Booking Bot 専用Telegram送信ヘルパー ──────

// Booking Botからメッセージ送信
function sendBookingBotMessage(chatId, text, replyMarkup) {
  var token = BOT_TOKENS.booking;
  if (!token) return;

  var url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  var payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('sendBookingBotMessage error: ' + err.toString());
  }
}

// Booking Bot callback応答
function answerBookingCallbackQuery(callbackQueryId, text) {
  var token = BOT_TOKENS.booking;
  if (!token) return;
  var url = 'https://api.telegram.org/bot' + token + '/answerCallbackQuery';
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ callback_query_id: callbackQueryId, text: text || '' }),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('answerBookingCallbackQuery error: ' + err.toString());
  }
}

// Booking Bot メッセージ編集（キャンセルボタン後の表示更新用）
function editBookingBotMessage(chatId, messageId, text, replyMarkup) {
  var token = BOT_TOKENS.booking;
  if (!token) return;
  var url = 'https://api.telegram.org/bot' + token + '/editMessageText';
  var payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('editBookingBotMessage error: ' + err.toString());
  }
}

// Booking Bot Webhook設定
// ?bot=booking クエリ付きでwebhookを登録するので、doPostで識別できる
function setupBookingWebhook() {
  var gasUrl = ScriptApp.getService().getUrl() + '?bot=booking';
  var token = BOT_TOKENS.booking;
  var url = 'https://api.telegram.org/bot' + token + '/setWebhook?url=' + encodeURIComponent(gasUrl);
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('Booking Bot Webhook: ' + response.getContentText());
}

function removeBookingWebhook() {
  var token = BOT_TOKENS.booking;
  var url = 'https://api.telegram.org/bot' + token + '/deleteWebhook';
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('Booking Bot Webhook 解除: ' + response.getContentText());
}

// ═══════════════════════════════════════════
//  Booking Bot 会話状態管理（顧客とのDM用）
//  ※ Admin/Fieldの conv_ とは別 namespace
// ═══════════════════════════════════════════

function setBookingConvState(chatId, stateObj) {
  PropertiesService.getScriptProperties().setProperty('booking_conv_' + chatId, JSON.stringify(stateObj));
}
function getBookingConvState(chatId) {
  var raw = PropertiesService.getScriptProperties().getProperty('booking_conv_' + chatId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function clearBookingConvState(chatId) {
  PropertiesService.getScriptProperties().deleteProperty('booking_conv_' + chatId);
}

// 状態に応じたルーティング
function handleBookingConversation(chatId, message, state) {
  switch (state.type) {
    case 'parking_photo':
      handleParkingPhotoFlow(chatId, message, state);
      break;
    case 'parking_floor':
      handleParkingFloorFlow(chatId, message, state);
      break;
    case 'payment_screenshot':
      handlePaymentScreenshotFlow(chatId, message, state);
      break;
    default:
      clearBookingConvState(chatId);
      sendBookingBotMessage(chatId, '状態が不明です。/start でやり直してください。');
  }
}

// ─── 1. 駐車情報依頼（予約完了直後） ───────────
// ① 予約サマリーを送信 → ② 写真依頼

function requestParkingInfo(chatId, bookingId) {
  // ① 予約サマリーメッセージ
  var booking = getBookingById(bookingId);
  var summaryMsg = '✅ *Booking Confirmed!*\n'
    + '✅ *ការកក់បានបញ្ជាក់!*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + bookingId + '\n';
  if (booking) {
    var sizeLabel = (booking.vehicleType === 'SUV以上') ? 'SUV & larger' : 'Sedan & smaller';
    summaryMsg += '📅 ' + booking.date + ' ' + booking.startTime + ' - ' + booking.endTime + '\n'
      + '🚙 ' + sizeLabel + '\n'
      + '✨ Plan ' + booking.planLetter + ' (' + booking.durationMin + 'min)\n'
      + '📍 ' + (booking.location || '-') + '\n'
      + '💰 $' + booking.amount + '\n';
  }
  summaryMsg += '\nWe will arrive shortly before your booking time.\n'
    + 'យើងនឹងទៅដល់មុនម៉ោងបន្តិច។\n\n'
    + 'Thank you! 🚗✨\n'
    + 'អរគុណច្រើន! 🚗✨';
  sendBookingBotMessage(chatId, summaryMsg);

  // ② 写真依頼メッセージ
  setBookingConvState(chatId, {
    type: 'parking_photo',
    bookingId: bookingId
  });
  sendBookingBotMessage(chatId,
    '📸 *Please send 1 photo of your parked car (front view)*\n'
    + '📸 *សូមផ្ញើរូបថតឡានចតរបស់អ្នក ១សន្លឹក (ថតពីមុខ)*\n\n'
    + '(We will also ask your parking floor next)\n'
    + '(បន្ទាប់មកនឹងសួរជាន់ចត)'
  );
}

// 駐車写真受信
function handleParkingPhotoFlow(chatId, message, state) {
  // 重複処理防止: すでに写真を保存済みならスキップ（リトライ対策）
  if (state.photoSaved) {
    Logger.log('handleParkingPhotoFlow: photo already saved for ' + state.bookingId);
    return;
  }

  if (!message.photo || message.photo.length === 0) {
    // テキストメッセージが来た場合 — 写真を待っている状態だが、
    // リトライによる重複送信を防ぐため、最初の1回のみ案内を送る
    if (!state.photoPrompted) {
      state.photoPrompted = true;
      setBookingConvState(chatId, state);
      sendBookingBotMessage(chatId, '📸 Please send a photo.\n📸 សូមផ្ញើរូបថត។');
    }
    return;
  }

  // 写真保存済みフラグを即座にセット（リトライによる重複処理防止）
  state.photoSaved = true;
  setBookingConvState(chatId, state);

  try {
    var largestPhoto = message.photo[message.photo.length - 1];
    var fileInfo = getBookingBotFile(largestPhoto.file_id);
    if (!fileInfo || !fileInfo.result || !fileInfo.result.file_path) {
      // 失敗時はフラグをリセットして再試行可能にする
      state.photoSaved = false;
      setBookingConvState(chatId, state);
      sendBookingBotMessage(chatId, '❌ Failed to get the photo. Please try again.\n❌ បានបរាជ័យ។ សូមព្យាយាមម្តងទៀត។');
      return;
    }

    var fileUrl = 'https://api.telegram.org/file/bot' + BOT_TOKENS.booking + '/' + fileInfo.result.file_path;
    var imageBlob = UrlFetchApp.fetch(fileUrl).getBlob();

    var folder = getOrCreateFolder(BOOKING_PARKING_FOLDER);
    var dateStr = Utilities.formatDate(new Date(), BOOKING_TIMEZONE, 'yyyyMMdd_HHmmss');
    imageBlob.setName('parking_' + state.bookingId + '_' + dateStr + '.jpg');
    var savedFile = folder.createFile(imageBlob);
    savedFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var photoUrl = savedFile.getUrl();

    // Bookingsシート S列(駐車写真URL)に保存
    updateBookingField(state.bookingId, 19, photoUrl);

    // 次のステップ: 駐車階数（状態を即座に切り替え）
    setBookingConvState(chatId, {
      type: 'parking_floor',
      bookingId: state.bookingId
    });
    sendBookingBotMessage(chatId,
      '✅ Photo received!\n✅ បានទទួលរូបថត!\n\n'
      + '🏢 *What floor is your car parked on?*\n'
      + '🏢 *សូមប្រាប់ជាន់ចតរបស់អ្នក*\n\n'
      + 'e.g. B2, Ground Floor, 3rd Floor, Outdoor');
  } catch (err) {
    Logger.log('handleParkingPhotoFlow error: ' + err.toString());
    sendBookingBotMessage(chatId, '❌ エラー: ' + err.toString());
  }
}

// 駐車階数受信
function handleParkingFloorFlow(chatId, message, state) {
  // 写真・スタンプ・音声など、テキスト以外のメッセージは無視（リトライ対策）
  if (message.photo || message.sticker || message.document || message.voice || message.video) {
    return;
  }
  var floor = (message.text || '').trim();
  if (!floor) {
    sendBookingBotMessage(chatId, '🏢 Please type the parking floor.\ne.g. B2, Ground Floor');
    return;
  }
  // Bookingsシート T列(駐車階数)に保存
  updateBookingField(state.bookingId, 20, floor);
  clearBookingConvState(chatId);

  sendBookingBotMessage(chatId,
    '✅ *Thank you for your response!*\n'
    + '✅ *សូមអរគុណសម្រាប់ការឆ្លើយតប!*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + state.bookingId + '\n'
    + '🏢 Floor: ' + floor + '\n\n'
    + 'We have received your parking info.\n'
    + 'យើងបានទទួលព័ត៌មានចតឡានរបស់អ្នក។\n\n'
    + 'See you soon! 🚗✨\n'
    + 'ជួបគ្នាឆាប់ៗ! 🚗✨'
  );

  // Adminグループにも通知
  var booking = getBookingById(state.bookingId);
  if (booking) {
    sendTelegramTo(ADMIN_GROUP_ID,
      '🅿️ *駐車情報受信*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🆔 ' + state.bookingId + '\n'
      + '👤 ' + booking.customerName + '\n'
      + '🏢 ' + floor + '\n'
      + '📷 [写真](' + booking.parkingPhotoUrl + ')'
    );
  }
}

// ─── 2. 支払い依頼送信（業務完了後に呼ぶ） ─────

// bookingId を指定して、顧客にABA QRと金額を送信
function sendPaymentRequest(bookingId) {
  var booking = getBookingById(bookingId);
  if (!booking) {
    Logger.log('sendPaymentRequest: booking not found: ' + bookingId);
    return false;
  }
  if (!booking.chatId) {
    Logger.log('sendPaymentRequest: no chatId for ' + bookingId);
    return false;
  }

  var msg = '✨ *作業が完了しました！*\n'
    + '✨ *ការងារបានបញ្ចប់!*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + bookingId + '\n'
    + '🚙 ' + (booking.vehicleInfo || '') + '\n'
    + '✨ プラン' + (booking.planLetter || '') + '\n\n'
    + '💰 *お支払い金額 / ចំនួនទឹកប្រាក់:*\n'
    + '   *$' + booking.amount + '*\n\n'
    + '💳 *ABA で下記にお支払いください*\n'
    + '💳 *សូមផ្ញើតាម ABA ខាងក្រោម*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🏦 ' + BOOKING_ABA_INFO.accountName + '\n'
    + '#️⃣ ' + BOOKING_ABA_INFO.accountNumber + '\n\n'
    + '📸 お支払い後、画面のスクリーンショットを送ってください。\n'
    + '📸 ក្រោយពេលបង់ប្រាក់ សូមផ្ញើ Screenshot។';

  // QR画像があれば先に送信
  if (BOOKING_ABA_INFO.qrImageUrl) {
    sendBookingBotPhoto(booking.chatId, BOOKING_ABA_INFO.qrImageUrl, '💳 ABA QR Code');
  }
  sendBookingBotMessage(booking.chatId, msg);

  // 支払いスクショ待ち状態へ
  setBookingConvState(booking.chatId, {
    type: 'payment_screenshot',
    bookingId: bookingId
  });

  return true;
}

// 支払いスクショ受信
function handlePaymentScreenshotFlow(chatId, message, state) {
  if (!message.photo || message.photo.length === 0) {
    sendBookingBotMessage(chatId,
      '📸 お支払い画面のスクリーンショット（写真）を送ってください。\n'
      + '📸 សូមផ្ញើ Screenshot ការបង់ប្រាក់។');
    return;
  }

  try {
    var largestPhoto = message.photo[message.photo.length - 1];
    var fileInfo = getBookingBotFile(largestPhoto.file_id);
    if (!fileInfo || !fileInfo.result || !fileInfo.result.file_path) {
      sendBookingBotMessage(chatId, '❌ 写真の取得に失敗しました。');
      return;
    }

    var fileUrl = 'https://api.telegram.org/file/bot' + BOT_TOKENS.booking + '/' + fileInfo.result.file_path;
    var imageBlob = UrlFetchApp.fetch(fileUrl).getBlob();

    var folder = getOrCreateFolder(BOOKING_PAYMENT_FOLDER);
    var dateStr = Utilities.formatDate(new Date(), BOOKING_TIMEZONE, 'yyyyMMdd_HHmmss');
    imageBlob.setName('payment_' + state.bookingId + '_' + dateStr + '.jpg');
    var savedFile = folder.createFile(imageBlob);
    savedFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var photoUrl = savedFile.getUrl();

    // Bookingsシート U列(支払いスクショURL) と R列(支払いステータス)を更新
    updateBookingField(state.bookingId, 21, photoUrl);          // U
    updateBookingField(state.bookingId, 18, '支払い済み（スクショ）'); // R

    clearBookingConvState(chatId);

    sendBookingBotMessage(chatId,
      '✅ *スクリーンショットを受け取りました！*\n'
      + '✅ *បានទទួល Screenshot!*\n'
      + '━━━━━━━━━━━━━━━\n'
      + 'お支払いありがとうございました🙏\n'
      + 'សូមអរគុណចំពោះការបង់ប្រាក់!\n\n'
      + 'またのご利用をお待ちしております。\n'
      + 'រង់ចាំជួបអ្នកម្តងទៀត។ 🚗✨'
    );

    // Adminグループに通知
    var booking = getBookingById(state.bookingId);
    sendTelegramTo(ADMIN_GROUP_ID,
      '💳 *入金スクショ受信*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🆔 ' + state.bookingId + '\n'
      + '👤 ' + (booking ? booking.customerName : '') + '\n'
      + '💰 $' + (booking ? booking.amount : '') + '\n'
      + '📷 [スクショ](' + photoUrl + ')\n\n'
      + '※自動で「支払い済み（スクショ）」に変更しました。シートで最終確認してください。'
    );
  } catch (err) {
    Logger.log('handlePaymentScreenshotFlow error: ' + err.toString());
    sendBookingBotMessage(chatId, '❌ エラー: ' + err.toString());
  }
}

// ─── 3. 24h催促 ───────────────────────────────

// 1時間ごとに実行: 24h以上経過した未払いの予約をAdmin/Fieldに通知
function checkUnpaidBookings() {
  var sheet = getBookingsSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var data = sheet.getRange(2, 1, lastRow - 1, 25).getValues();
  var now = new Date();
  var thresholdMs = BOOKING_REMINDER_HOURS * 60 * 60 * 1000;
  var notified = [];

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var bookingId       = row[0];
    var createdAt       = row[1];
    var customerName    = row[3];
    var bookingDate     = row[5];
    var startTime       = row[6];
    var amount          = row[15];
    var status          = row[16];
    var paymentStatus   = row[17];
    var reminderStatus  = row[21];

    if (!bookingId || !createdAt) continue;
    if (status === 'キャンセル') continue;
    if (paymentStatus && paymentStatus.indexOf('支払い済み') === 0) continue;
    if (reminderStatus === '催促済み') continue;

    // 作業完了かつ24h以上未払いを催促対象とする（作業中は対象外）
    if (status !== '作業完了') continue;

    var createdMs = new Date(createdAt).getTime();
    if (isNaN(createdMs)) continue;
    if (now.getTime() - createdMs < thresholdMs) continue;

    // 通知
    var dateStr = bookingDate instanceof Date ? Utilities.formatDate(bookingDate, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd') : (bookingDate ? bookingDate.toString().substring(0, 10) : '');
    var msg = '⚠️ *未払い催促アラート（24h超過）*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🆔 ' + bookingId + '\n'
      + '👤 ' + customerName + '\n'
      + '📅 ' + dateStr + ' ' + startTime + '\n'
      + '💰 $' + amount + '\n'
      + '📌 ' + status + ' / 💳 ' + (paymentStatus || '未払い') + '\n\n'
      + '※顧客にスタッフから個別連絡してください。';

    sendTelegramTo(ADMIN_GROUP_ID, msg);
    // フィールドスタッフにも
    FIELD_STAFF_IDS.forEach(function(staffId) {
      sendTelegramTo(staffId, msg);
    });

    // 催促ステータスを更新
    var rowNum = i + 2;
    sheet.getRange(rowNum, 22).setValue('催促済み'); // V列
    sheet.getRange(rowNum, 23).setValue(formatCambodiaTime(now)); // W列
    notified.push(bookingId);
  }

  if (notified.length > 0) {
    Logger.log('checkUnpaidBookings: 催促送信 ' + notified.length + '件 (' + notified.join(', ') + ')');
  }
}

// ─── ヘルパー: Bookingsシート更新 ──────────────

function updateBookingField(bookingId, colIndex, value) {
  var sheet = getBookingsSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === bookingId) {
      sheet.getRange(i + 2, colIndex).setValue(value);
      return true;
    }
  }
  return false;
}

// Booking Bot用 getFile API
function getBookingBotFile(fileId) {
  var token = BOT_TOKENS.booking;
  var url = 'https://api.telegram.org/bot' + token + '/getFile?file_id=' + fileId;
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    return JSON.parse(response.getContentText());
  } catch (err) {
    Logger.log('getBookingBotFile error: ' + err.toString());
    return null;
  }
}

// Booking Botから写真をURLで送信
function sendBookingBotPhoto(chatId, photoUrl, caption) {
  var token = BOT_TOKENS.booking;
  var url = 'https://api.telegram.org/bot' + token + '/sendPhoto';
  var payload = {
    chat_id: chatId,
    photo: photoUrl,
    caption: caption || '',
    parse_mode: 'Markdown'
  };
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('sendBookingBotPhoto error: ' + err.toString());
  }
}

// ─── 非同期キュー方式（Telegram Webhook処理） ─────
// doPostは即座にokを返し、実処理は1分毎のprocessTelegramQueue()で行う。
// これによりTelegramのタイムアウト（60秒）→リトライ→通知スパム問題を根本解決。

// キューにTelegram updateを追加
// 重要: 処理済みupdate_idは再キューしない（Telegramリトライ対策）
function enqueueTelegramUpdate(data, botType) {
  var props = PropertiesService.getScriptProperties();
  var updateId = data.update_id;

  // ① 処理済みチェック（別実行をまたぐリトライを排除）
  if (updateId && props.getProperty('processed_' + updateId)) {
    Logger.log('enqueue skip: update_id=' + updateId + ' は既に処理済み');
    return;
  }

  // キー: queue_<timestamp>_<update_id>  (sortすると時系列順)
  var ts = Date.now();
  var key = 'queue_' + String(ts).padStart(15, '0') + '_' + updateId;
  var payload = {
    data: data,
    botType: botType || 'admin',
    queuedAt: ts
  };
  props.setProperty(key, JSON.stringify(payload));
}

// キューに溜まったTelegram updateを順次処理（1分毎トリガーで実行）
function processTelegramQueue() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  // queue_ プレフィックスのキーのみ取り出して時系列ソート
  var keys = Object.keys(all).filter(function(k) {
    return k.indexOf('queue_') === 0;
  }).sort();

  if (keys.length === 0) return;

  var startTime = Date.now();
  var MAX_MS = 5 * 60 * 1000; // 5分（GASタイムアウト6分のマージン）
  var seen = {}; // 同一update_idの重複排除
  var processedCount = 0;
  var skippedDup = 0;
  var errorCount = 0;

  for (var i = 0; i < keys.length; i++) {
    // タイムアウト前に中断（次回トリガーで残りを処理）
    if (Date.now() - startTime > MAX_MS) {
      Logger.log('processTelegramQueue: 時間切れで中断 残=' + (keys.length - i));
      break;
    }

    var key = keys[i];
    try {
      var item = JSON.parse(all[key]);
      var updateId = item.data.update_id;

      // 同じupdate_idが複数キューに入っていたら1回だけ処理
      if (seen[updateId]) {
        props.deleteProperty(key);
        skippedDup++;
        continue;
      }
      seen[updateId] = true;

      // 実処理を呼び出す
      if (item.botType === 'booking') {
        handleBookingBotWebhook(item.data);
      } else {
        handleTelegramWebhook(item.data, item.botType);
      }

      // 処理済みマーカー（24h保持、cleanupOldProcessedIdsで掃除）
      if (updateId) {
        props.setProperty('processed_' + updateId, String(Date.now()));
      }
      props.deleteProperty(key);
      processedCount++;
    } catch (err) {
      Logger.log('processTelegramQueue error for ' + key + ': ' + err.toString());
      // エラーでも削除（無限ループ防止）
      try { props.deleteProperty(key); } catch (e2) {}
      errorCount++;
    }
  }

  Logger.log('processTelegramQueue: 処理=' + processedCount
    + ', 重複排除=' + skippedDup
    + ', エラー=' + errorCount
    + ', 所要=' + (Date.now() - startTime) + 'ms');
}

// キュー全消去（デバッグ/緊急時用）
function clearTelegramQueue() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var count = 0;
  Object.keys(all).forEach(function(k) {
    if (k.indexOf('queue_') === 0) {
      props.deleteProperty(k);
      count++;
    }
  });
  Logger.log('キュー全消去: ' + count + '件');
}

// 処理済みupdate_idマーカーを24h経過したものから削除（ScriptProperties肥大化防止）
// setupV6Triggersで1時間毎に自動実行される
function cleanupOldProcessedIds() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var cutoff = Date.now() - 24 * 60 * 60 * 1000;
  var count = 0;
  Object.keys(all).forEach(function(k) {
    if (k.indexOf('processed_') === 0) {
      var ts = parseInt(all[k], 10);
      if (!ts || ts < cutoff) {
        props.deleteProperty(k);
        count++;
      }
    }
  });
  Logger.log('古い処理済みID削除: ' + count + '件');
}

// 処理済みマーカー全消去（緊急時用）
function clearProcessedIds() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties();
  var count = 0;
  Object.keys(all).forEach(function(k) {
    if (k.indexOf('processed_') === 0) {
      props.deleteProperty(k);
      count++;
    }
  });
  Logger.log('処理済みID全消去: ' + count + '件');
}

// ─── トリガー設定 ────────────────────────────

function setupV6Triggers() {
  // 既存の同名トリガーを削除してから作成（重複防止）
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'checkUnpaidBookings' || fn === 'processTelegramQueue' || fn === 'cleanupOldProcessedIds') {
      ScriptApp.deleteTrigger(t);
      Logger.log('既存トリガー ' + fn + ' を削除');
    }
  });
  // 1時間ごとに未払いチェック
  ScriptApp.newTrigger('checkUnpaidBookings')
    .timeBased()
    .everyHours(1)
    .create();
  // 1分ごとにTelegramキューを処理
  ScriptApp.newTrigger('processTelegramQueue')
    .timeBased()
    .everyMinutes(1)
    .create();
  // 1時間ごとに古い処理済みIDマーカーを掃除
  ScriptApp.newTrigger('cleanupOldProcessedIds')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('v6トリガー作成完了: checkUnpaidBookings(1h) + processTelegramQueue(1min) + cleanupOldProcessedIds(1h)');
}

function removeV6Triggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'checkUnpaidBookings' || fn === 'processTelegramQueue' || fn === 'cleanupOldProcessedIds') {
      ScriptApp.deleteTrigger(t);
    }
  });
  Logger.log('v6トリガーを削除しました。');
}

// Admin/Field/Booking すべてのwebhookを設定
function setupAllBotWebhooks() {
  // Admin Bot (既存): クエリなし or ?bot=admin
  var gasUrl = ScriptApp.getService().getUrl();
  var adminUrl = 'https://api.telegram.org/bot' + BOT_TOKENS.admin
    + '/setWebhook?url=' + encodeURIComponent(gasUrl + '?bot=admin');
  Logger.log('Admin Bot: ' + UrlFetchApp.fetch(adminUrl, { muteHttpExceptions: true }).getContentText());

  // Field Bot
  if (BOT_TOKENS.field !== BOT_TOKENS.admin) {
    var fieldUrl = 'https://api.telegram.org/bot' + BOT_TOKENS.field
      + '/setWebhook?url=' + encodeURIComponent(gasUrl + '?bot=field');
    Logger.log('Field Bot: ' + UrlFetchApp.fetch(fieldUrl, { muteHttpExceptions: true }).getContentText());
  } else {
    Logger.log('Field Bot: skipped (same token as admin)');
  }

  // Booking Bot
  if (BOT_TOKENS.booking !== BOT_TOKENS.admin) {
    setupBookingWebhook();
  } else {
    Logger.log('Booking Bot: ⚠ admin と同じtoken。専用tokenに差し替えてください');
  }
}

// ═══════════════════════════════════════════
//  会話状態管理（PropertiesService）
// ═══════════════════════════════════════════

function setConversationState(chatId, stateObj) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('conv_' + chatId, JSON.stringify(stateObj));
}

function getConversationState(chatId) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('conv_' + chatId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function clearConversationState(chatId) {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('conv_' + chatId);
}

// 会話状態に応じた処理ルーター
function handleConversationState(chatId, message, state, senderName) {
  // キャンセルコマンド
  if (message.text && message.text === '/cancel') {
    clearConversationState(chatId);
    sendTelegramTo(chatId, '❌ 操作をキャンセルしました。');
    return;
  }

  // Phase 1: task_create / receipt_pending / pending_reason は無効化（DISABLED_FEATURES.md §1-2）
  switch (state.type) {
    case 'inquiry_reply':
      handleInquiryReplyFlow(chatId, message, state, senderName);
      break;
    default:
      clearConversationState(chatId);
      break;
  }
}

// ─── 問い合わせ返信フロー ─────────────────────
// スタッフが「返信」ボタンを押した後、メッセージ入力 → 顧客に送信
function handleInquiryReplyFlow(chatId, message, state, senderName) {
  var replyText = (message.text || '').trim();
  if (!replyText) {
    sendTelegramTo(chatId, '📝 テキストメッセージを入力してください。\nសូមវាយសារជាអក្សរ។');
    return;
  }

  var customerChatId = state.customerChatId;
  clearConversationState(chatId);

  // Booking Bot経由で顧客に送信
  var replyMsg = '💬 *Samurai Motors*\n'
    + '━━━━━━━━━━━━━━━\n'
    + replyText;

  try {
    sendBookingBotMessage(customerChatId, replyMsg);

    // ChatLogシートに記録（存在する場合）
    logChatMessage(customerChatId, 'staff', replyText, senderName || 'Staff');

    // 送信成功通知（送信者に）
    sendTelegramTo(chatId,
      '✅ *返信送信完了 / បានផ្ញើរួចរាល់*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '👤 → ' + customerChatId + '\n'
      + '💬 ' + replyText.substring(0, 200)
    );

    // Adminグループにログ（スタッフが返信した場合）
    if (chatId !== ADMIN_GROUP_ID) {
      sendTelegramTo(ADMIN_GROUP_ID,
        '📤 *スタッフ返信ログ*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '👤 ' + (senderName || 'Staff') + ' → 顧客 ' + customerChatId + '\n'
        + '💬 ' + replyText.substring(0, 200)
      );
    }
  } catch (e) {
    Logger.log('handleInquiryReplyFlow error: ' + e.toString());
    sendTelegramTo(chatId,
      '❌ 送信失敗 / ផ្ញើមិនបាន: ' + e.toString()
    );
  }
}

// ═══════════════════════════════════════════
//  Telegram Callback Query（インラインボタン）
// ═══════════════════════════════════════════

function handleCallbackQuery(callbackQuery, botType) {
  botType = botType || 'admin';
  var callbackId = callbackQuery.id;
  var data = callbackQuery.data;
  var chatId = String(callbackQuery.message.chat.id);
  var messageId = callbackQuery.message.message_id;

  // callback応答関数の選択（Field Bot or Admin Bot）
  var answerCb = (botType === 'field') ? answerFieldBotCallbackQuery : answerCallbackQuery;
  // メッセージ送信関数の選択
  var sendMsg = (botType === 'field') ? sendFieldBotMessage : sendTelegramTo;

  // Phase 1: task_done: / task_notdone: / expense_confirm: は無効化（DISABLED_FEATURES.md §1-2）

  // reply_inquiry_<顧客chatId> — 顧客への返信フロー開始
  if (data.indexOf('reply_inquiry_') === 0) {
    var customerChatId = data.replace('reply_inquiry_', '');
    answerCb(callbackId, '返信メッセージを入力してください');

    // 返信待ち会話状態をセット（admin/field両方で使える）
    setConversationState(chatId, {
      type: 'inquiry_reply',
      customerChatId: customerChatId
    });

    // スタッフに入力案内を送信（botTypeに応じてAdmin or Field Botで送信）
    sendMsg(chatId,
      '💬 *返信モード / របៀបឆ្លើយតប*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '📱 顧客ID: ' + customerChatId + '\n\n'
      + '返信メッセージを入力してください。\n'
      + 'សូមវាយសារឆ្លើយតប។\n\n'
      + '❌ /cancel でキャンセル'
    );
    return ContentService.createTextOutput('ok');
  }

  answerCallbackQuery(callbackId, '');
  return ContentService.createTextOutput('ok');
}

// Phase 1: updateTaskStatus は無効化（DISABLED_FEATURES.md §1）


// ═══════════════════════════════════════════
//  経費管理（レシートOCR）
// ═══════════════════════════════════════════

// Expensesシート取得（なければ作成）
// プラン価格・所要時間マスター（Plan_Prices シート）
// 構造: プラン名 / セダン価格USD / SUV価格USD / セダン所要時間(分) / SUV所要時間(分) / 備考
// 設定行: 【設定】で始まる行にバッファ・営業時間を格納
// - 価格・時間・バッファの変更はこのシートの数字を書き換えるだけで即反映
// - 出張料は特別行として扱われ、全プランに加算される
function getPlanPricesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Plan_Prices');
  if (!sheet) {
    sheet = ss.insertSheet('Plan_Prices');
    initPlanPricesSheet6Col(sheet);
  } else {
    // 既存シートが旧構造（4列以下）の場合は6列構造へマイグレーション
    var lastCol = sheet.getLastColumn();
    if (lastCol < 6) {
      migratePlanPricesTo6Col(sheet, lastCol);
    }
  }
  return sheet;
}

// 6列構造で新規作成
function initPlanPricesSheet6Col(sheet) {
  var headers = ['プラン名', 'セダン価格(USD)', 'SUV価格(USD)', 'セダン所要時間(分)', 'SUV所要時間(分)', '備考'];
  sheet.appendRow(headers);
  var hdr = sheet.getRange(1, 1, 1, headers.length);
  hdr.setFontWeight('bold');
  hdr.setBackground('#1a5276');
  hdr.setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 140);
  sheet.setColumnWidth(3, 140);
  sheet.setColumnWidth(4, 160);
  sheet.setColumnWidth(5, 160);
  sheet.setColumnWidth(6, 380);

  var rows = [
    ['清 KIYOME (A)',   12, 15, 30, 45, '無水洗車+タイヤワックス+エアチェック'],
    ['鏡 KAGAMI (B)',   17, 20, 40, 55, 'A+前3面ガラス撥水（簡易）'],
    ['匠 TAKUMI (C)',   20, 23, 50, 65, 'A+全面ガラス撥水（簡易）'],
    ['将軍 SHOGUN (D)', 32, 35, 80, 95, 'A+全面油膜落とし+全面ガラス撥水'],
    ['出張料',            2,  2, '',  '', '全プラン共通で加算（キャンペーン時はここを変更）'],
    ['', '', '', '', '', ''],
    ['【設定】移動バッファ(分)',  30, '', '', '', '洗車と洗車の間の移動時間'],
    ['【設定】営業開始時刻',       9, '', '', '', '例: 9 = 9:00'],
    ['【設定】営業終了時刻',      18, '', '', '', '例: 18 = 18:00']
  ];
  rows.forEach(function(row) { sheet.appendRow(row); });
}

// 旧4列以下 → 6列構造へマイグレーション
function migratePlanPricesTo6Col(sheet, lastCol) {
  var lastRow = sheet.getLastRow();

  // 既存データを読み込み（備考は旧D列=4列目）
  var existingData = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, Math.min(lastCol, 4)).getValues() : [];

  // シートをクリアして6列で再構築
  sheet.clear();
  initPlanPricesSheet6Col(sheet);

  // 既存の価格データを上書き（設定行はデフォルト値のまま）
  if (existingData.length > 0) {
    var planPricesSheet = sheet;
    var lastNewRow = planPricesSheet.getLastRow();
    var newData = planPricesSheet.getRange(2, 1, lastNewRow - 1, 6).getValues();

    for (var e = 0; e < existingData.length; e++) {
      var oldName = (existingData[e][0] || '').toString().trim();
      if (!oldName) continue;
      // 新シートの対応行を見つけて価格を上書き
      for (var n = 0; n < newData.length; n++) {
        var newName = (newData[n][0] || '').toString().trim();
        if (newName === oldName || (getPlanLetter(newName) && getPlanLetter(newName) === getPlanLetter(oldName))) {
          // セダン価格・SUV価格を復元
          if (existingData[e][1] !== '' && existingData[e][1] !== undefined) {
            planPricesSheet.getRange(n + 2, 2).setValue(existingData[e][1]);
          }
          if (lastCol >= 3 && existingData[e][2] !== '' && existingData[e][2] !== undefined) {
            planPricesSheet.getRange(n + 2, 3).setValue(existingData[e][2]);
          }
          // 備考を復元（旧D列→新F列）
          if (lastCol >= 4 && existingData[e][3]) {
            planPricesSheet.getRange(n + 2, 6).setValue(existingData[e][3]);
          }
          break;
        }
      }
    }
  }
  Logger.log('Plan_Prices シートを6列構造にマイグレーション完了');
}

// 出張料を取得（シート優先、なければデフォルト）
function getDispatchFee(vehicleType) {
  try {
    var sheet = getPlanPricesSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
      for (var i = 0; i < data.length; i++) {
        if (data[i][0] && data[i][0].toString() === DISPATCH_FEE_ROW) {
          var col = (vehicleType === 'SUV') ? 2 : 1;
          return parseFloat(data[i][col]) || 0;
        }
      }
    }
  } catch (e) {
    Logger.log('getDispatchFee error: ' + e.toString());
  }
  var fallback = DEFAULT_PLAN_PRICES[DISPATCH_FEE_ROW] || [0, 0];
  return (vehicleType === 'SUV') ? fallback[1] : fallback[0];
}

// プラン名＋車両タイプから売上金額（出張料込み）を取得
// vehicleType: 'セダン' または 'SUV'（未指定はセダン扱い）
// プラン名は (A)〜(D) のラベルだけ見て照合するので、ブランド名表記が変わってもOK
function getPlanPrice(planName, vehicleType) {
  if (!planName) return 0;
  var letter = getPlanLetter(planName);  // 'A'/'B'/'C'/'D' または ''
  var basePrice = 0;
  try {
    var sheet = getPlanPricesSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
      for (var i = 0; i < data.length; i++) {
        var rowName = data[i][0] ? data[i][0].toString() : '';
        if (!rowName) continue;
        // 行名が (A)〜(D) を含むか、プラン名そのものと一致するかで判定
        var rowLetter = getPlanLetter(rowName);
        var matched = false;
        if (letter && rowLetter === letter) matched = true;
        else if (rowName === planName.toString()) matched = true;
        if (matched) {
          var col = (vehicleType === 'SUV') ? 2 : 1;
          basePrice = parseFloat(data[i][col]) || 0;
          break;
        }
      }
    }
  } catch (e) {
    Logger.log('getPlanPrice error: ' + e.toString());
  }
  // フォールバック：DEFAULT_PLAN_PRICES から (A)〜(D) で検索
  if (basePrice === 0 && letter) {
    Object.keys(DEFAULT_PLAN_PRICES).forEach(function(key) {
      if (basePrice === 0 && getPlanLetter(key) === letter) {
        var fallback = DEFAULT_PLAN_PRICES[key];
        basePrice = (vehicleType === 'SUV') ? fallback[1] : fallback[0];
      }
    });
  }
  // 出張料を加算
  var dispatchFee = getDispatchFee(vehicleType);
  return basePrice + dispatchFee;
}

// プラン名から (A)〜(D) のレターを抽出
// 「清 KIYOME (A)」「PLAN A」「planA」「(B)」など色々な表記に対応
function getPlanLetter(planName) {
  if (!planName) return '';
  var s = planName.toString().toUpperCase();
  // "(A)" 形式
  var m = s.match(/\(([ABCD])\)/);
  if (m) return m[1];
  // "PLAN A" 形式
  m = s.match(/PLAN\s*([ABCD])/);
  if (m) return m[1];
  return '';
}

// ─── Plan_Pricesシートから全設定を一括読み込み（キャッシュ付き） ───
// 料金・所要時間・バッファ・営業時間をGSSで管理し、即座に反映
function getBookingConfig() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('booking_config_v2');
  if (cached) {
    try { return JSON.parse(cached); } catch(e) {}
  }

  var config = {
    planDurations: {},     // { 'A': { sedan: 30, suv: 45 }, ... }
    planPrices: {},        // { 'A': { sedan: 12, suv: 15 }, ... }
    planDescriptions: {},  // { 'A': '無水洗車+...', ... }
    planNames: {},         // { 'A': '清 KIYOME', ... }
    dispatchFee: { sedan: 2, suv: 2 },
    bufferMin: BOOKING_BUFFER_MIN,
    businessHourStart: BUSINESS_HOUR_START,
    businessHourEnd: BUSINESS_HOUR_END
  };

  try {
    var sheet = getPlanPricesSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      cache.put('booking_config_v2', JSON.stringify(config), 60);
      return config;
    }
    var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();

    for (var i = 0; i < data.length; i++) {
      var name = (data[i][0] || '').toString().trim();
      if (!name) continue;

      if (name === '出張料' || name === DISPATCH_FEE_ROW) {
        config.dispatchFee.sedan = parseFloat(data[i][1]) || 0;
        config.dispatchFee.suv   = parseFloat(data[i][2]) || 0;
      } else if (name.indexOf('【設定】') === 0) {
        // 設定行
        if (name.indexOf('バッファ') >= 0) {
          config.bufferMin = parseInt(data[i][1], 10) || BOOKING_BUFFER_MIN;
        } else if (name.indexOf('開始') >= 0) {
          config.businessHourStart = parseInt(data[i][1], 10) || BUSINESS_HOUR_START;
        } else if (name.indexOf('終了') >= 0) {
          config.businessHourEnd = parseInt(data[i][1], 10) || BUSINESS_HOUR_END;
        }
      } else {
        // プラン行
        var letter = getPlanLetter(name);
        if (letter) {
          // プラン名から表示名を抽出（例: "清 KIYOME (A)" → "清 KIYOME"）
          var displayName = name.replace(/\s*\([ABCD]\)\s*$/, '').trim();
          config.planNames[letter] = displayName;
          config.planPrices[letter] = {
            sedan: parseFloat(data[i][1]) || 0,
            suv:   parseFloat(data[i][2]) || 0
          };
          // 所要時間: シート値があればそちらを使い、なければハードコードのフォールバック
          var sedanDur = parseInt(data[i][3], 10);
          var suvDur   = parseInt(data[i][4], 10);
          var fallbackSedan = PLAN_DURATIONS[letter] || 0;
          var fallbackSuv   = fallbackSedan + SUV_EXTRA_MIN;
          config.planDurations[letter] = {
            sedan: isNaN(sedanDur) ? fallbackSedan : sedanDur,
            suv:   isNaN(suvDur)   ? fallbackSuv   : suvDur
          };
          config.planDescriptions[letter] = (data[i][5] || '').toString();
        }
      }
    }
  } catch (e) {
    Logger.log('getBookingConfig error: ' + e.toString());
  }

  // 60秒キャッシュ（シート変更は最大60秒後に反映）
  cache.put('booking_config_v2', JSON.stringify(config), 60);
  return config;
}


// ═══════════════════════════════════════════
//  Telegram送信ヘルパー
// ═══════════════════════════════════════════

// 特定チャットにメッセージ送信
function sendTelegramTo(chatId, message) {
  if (!TELEGRAM_BOT_TOKEN) return;

  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
  var payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('sendTelegramTo error: ' + err.toString());
  }
}

// インラインキーボード付きメッセージ送信
function sendTelegramWithKeyboard(chatId, text, replyMarkup) {
  if (!TELEGRAM_BOT_TOKEN) return;

  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
  var payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  };

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('sendTelegramWithKeyboard error: ' + err.toString());
  }
}

// ─── Field Bot 送信関数 ───────────────────────
// Field Botトークンでメッセージを送信
function sendFieldBotMessage(chatId, text) {
  var token = BOT_TOKENS.field;
  if (!token) return;
  var url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  var payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('sendFieldBotMessage error: ' + err.toString());
  }
}

// Field Botでインラインキーボード付きメッセージ送信
function sendFieldBotWithKeyboard(chatId, text, replyMarkup) {
  var token = BOT_TOKENS.field;
  if (!token) return;
  var url = 'https://api.telegram.org/bot' + token + '/sendMessage';
  var payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  };
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('sendFieldBotWithKeyboard error: ' + err.toString());
  }
}

// Field Botのcallback_query応答
function answerFieldBotCallbackQuery(callbackQueryId, text) {
  var token = BOT_TOKENS.field;
  if (!token) return;
  var url = 'https://api.telegram.org/bot' + token + '/answerCallbackQuery';
  var payload = {
    callback_query_id: callbackQueryId,
    text: text || ''
  };
  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('answerFieldBotCallbackQuery error: ' + err.toString());
  }
}

// callback_query応答
function answerCallbackQuery(callbackQueryId, text) {
  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/answerCallbackQuery';
  var payload = {
    callback_query_id: callbackQueryId,
    text: text || ''
  };

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('answerCallbackQuery error: ' + err.toString());
  }
}

// メッセージテキスト更新（ボタン削除用）
function editMessageText(chatId, messageId, newText) {
  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/editMessageText';
  var payload = {
    chat_id: chatId,
    message_id: messageId,
    text: newText,
    parse_mode: 'Markdown'
  };

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('editMessageText error: ' + err.toString());
  }
}

// メッセージ転送
function forwardMessage(toChatId, fromChatId, messageId) {
  if (!TELEGRAM_BOT_TOKEN) return;

  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/forwardMessage';
  var payload = {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId
  };

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('forwardMessage error: ' + err.toString());
  }
}

// 全チャットIDに一括送信
function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_IDS || TELEGRAM_CHAT_IDS.length === 0) {
    Logger.log('Telegram未設定。');
    return;
  }

  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';

  TELEGRAM_CHAT_IDS.forEach(function(chatId) {
    var payload = {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    };

    try {
      var response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var result = JSON.parse(response.getContentText());
      if (!result.ok) {
        Logger.log('Telegram error (chat ' + chatId + '): ' + response.getContentText());
      }
    } catch (err) {
      Logger.log('Telegram fetch error (chat ' + chatId + '): ' + err.toString());
    }
  });
}

// Drive写真をTelegramに送信
function sendPhotoGroupToTelegram(links, caption) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_IDS || TELEGRAM_CHAT_IDS.length === 0) return false;

  var validLinks = links.filter(function(l) { return l && l.length > 0; });
  if (validLinks.length === 0) return false;

  var fileIds = validLinks.map(function(link) {
    var match = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    match = link.match(/id=([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    return null;
  }).filter(function(id) { return id !== null; });

  if (fileIds.length === 0) return false;

  var photoBlobs = [];
  if (fileIds.length === 1) {
    try {
      photoBlobs.push(DriveApp.getFileById(fileIds[0]).getBlob());
    } catch (err) {
      Logger.log('sendPhoto getBlob error: ' + err.toString());
      return false;
    }
  } else {
    try {
      for (var i = 0; i < fileIds.length; i++) {
        photoBlobs.push(DriveApp.getFileById(fileIds[i]).getBlob().setName('photo_' + i + '.jpg'));
      }
    } catch (err) {
      Logger.log('sendMediaGroup getBlob error: ' + err.toString());
      return false;
    }
  }

  TELEGRAM_CHAT_IDS.forEach(function(chatId) {
    try {
      if (fileIds.length === 1) {
        var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendPhoto';
        UrlFetchApp.fetch(url, {
          method: 'post',
          payload: { 'chat_id': chatId, 'caption': caption, 'photo': photoBlobs[0] },
          muteHttpExceptions: true
        });
      } else {
        var media = [];
        var formData = { 'chat_id': chatId };
        for (var i = 0; i < photoBlobs.length; i++) {
          var mediaItem = { type: 'photo', media: 'attach://photo_' + i };
          if (i === 0) mediaItem.caption = caption;
          media.push(mediaItem);
          formData['photo_' + i] = photoBlobs[i];
        }
        formData['media'] = JSON.stringify(media);
        var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMediaGroup';
        UrlFetchApp.fetch(url, {
          method: 'post',
          payload: formData,
          muteHttpExceptions: true
        });
      }
    } catch (err) {
      Logger.log('sendPhoto/MediaGroup error (chat ' + chatId + '): ' + err.toString());
    }
  });
  return true;
}

// ═══════════════════════════════════════════
//  GETリクエスト
// ═══════════════════════════════════════════

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'status';

  // Phase 1: inventory/tasks/expenses/daily_reports/attendance は無効化（DISABLED_FEATURES.md）

  // --- v6 Booking Mini App ---
  if (action === 'booking_init') {
    return handleBookingInitGet(e);
  }
  if (action === 'booking_slots') {
    return handleBookingSlotsGet(e);
  }
  if (action === 'booking_options') {
    return handleBookingOptionsGet(e);
  }
  if (action === 'booking_history') {
    return handleBookingHistoryGet(e);
  }
  if (action === 'booking_today') {
    return handleBookingTodayGet(e);
  }

  // --- Phase2: 顧客問い合わせ ---
  if (action === 'inquiries') {
    return handleInquiriesGet(e);
  }

  return ContentService
    .createTextOutput('Samurai Motors v6 is active.')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ═══════════════════════════════════════════
//  ヘッダー修正
// ═══════════════════════════════════════════

function fixHeaders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];

  var headerRange = sheet.getRange(1, 1, 1, CORRECT_HEADERS.length);
  headerRange.setValues([CORRECT_HEADERS]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#c8102e');
  headerRange.setFontColor('#ffffff');
  sheet.setFrozenRows(1);

  sheet.setColumnWidth(1, 140);
  for (var c = 2; c <= 14; c++) sheet.setColumnWidth(c, 160);
  sheet.setColumnWidth(15, 100);
  for (var c = 16; c <= 23; c++) sheet.setColumnWidth(c, 200);
  sheet.setColumnWidth(24, 130);  // 売上金額USD

  Logger.log('ヘッダーを23列に修正しました。');
}

// ═══════════════════════════════════════════
//  ジョブ管理（v4から継承）
// ═══════════════════════════════════════════

function handleJobSubmit(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];

  if (sheet.getLastRow() === 0) {
    var headerRange = sheet.getRange(1, 1, 1, CORRECT_HEADERS.length);
    headerRange.setValues([CORRECT_HEADERS]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#c8102e');
    headerRange.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 140);
    for (var c = 2; c <= 14; c++) sheet.setColumnWidth(c, 160);
    sheet.setColumnWidth(15, 100);
    for (var c = 16; c <= 23; c++) sheet.setColumnWidth(c, 200);
  }

  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');
  var jobId = 'SM-' + dateStr + '-' + String(sheet.getLastRow()).padStart(3, '0');

  var registered = data.registered ? formatCambodiaTime(new Date(data.registered)) : formatCambodiaTime(now);
  var startTime = data.startTime ? formatCambodiaTime(new Date(data.startTime)) : '';
  var endTime = data.endTime ? formatCambodiaTime(new Date(data.endTime)) : '';

  var duration = data.duration || 0;
  if (!duration && data.startTime && data.endTime) {
    var startMs = new Date(data.startTime).getTime();
    var endMs = new Date(data.endTime).getTime();
    duration = Math.round((endMs - startMs) / 60000);
  }

  var beforeLinks = ['','','',''];
  var afterLinks = ['','','',''];
  var hasNewPhotos = (data.beforePhotos && data.beforePhotos.length > 0) ||
                     (data.afterPhotos && data.afterPhotos.length > 0);

  try {
    if (hasNewPhotos) {
      var parentFolder = getOrCreateFolder(PHOTO_FOLDER_NAME);
      var jobFolder = parentFolder.createFolder(jobId + '_' + (data.name || 'unknown'));
      jobFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

      if (data.beforePhotos) {
        for (var i = 0; i < data.beforePhotos.length && i < 4; i++) {
          if (data.beforePhotos[i]) {
            var link = saveBase64Image(jobFolder, data.beforePhotos[i], 'before_' + (i+1));
            beforeLinks[i] = link;
          }
        }
      }

      if (data.afterPhotos) {
        for (var i = 0; i < data.afterPhotos.length && i < 4; i++) {
          if (data.afterPhotos[i]) {
            var link = saveBase64Image(jobFolder, data.afterPhotos[i], 'after_' + (i+1));
            afterLinks[i] = link;
          }
        }
      }
    } else {
      var existingLinks = findExistingPhotoLinks(dateStr, data.name || 'unknown');
      if (existingLinks) {
        beforeLinks = existingLinks.before;
        afterLinks = existingLinks.after;
      }
    }
  } catch (photoErr) {
    Logger.log('Photo save error: ' + photoErr.toString());
  }

  var newRow = sheet.getLastRow() + 1;

  // 売上金額（プラン＋車両タイプから自動算出。data.priceで上書き可能）
  // vehicleType: 'セダン' または 'SUV'（未指定はセダン扱い）
  var vehicleType = data.vehicleType || 'セダン';
  var priceUSD = (data.price !== undefined && data.price !== '') ? parseFloat(data.price) : getPlanPrice(data.plan, vehicleType);

  // プラン名に車両タイプを併記してシートに保存（例: "PLAN A (セダン)"）
  var planLabel = data.plan || '';
  if (planLabel && vehicleType) {
    planLabel = planLabel + ' (' + vehicleType + ')';
  }

  sheet.appendRow([
    jobId, registered,
    data.name || '', data.phone || '',
    data.building || '', data.room || '',
    data.carModel || '', data.plate || '',
    planLabel, data.mapUrl || '',
    data.notes || '', data.scheduled || '',
    startTime, endTime, duration,
    '', '', '', '',
    '', '', '', '',
    priceUSD || 0
  ]);

  setPhotoHyperlinks(sheet, newRow, beforeLinks, afterLinks);

  try {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS && TELEGRAM_CHAT_IDS.length > 0) {
      var msg = '📋 *記録保存完了（កំណត់ត្រាបានរក្សាទុក）*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '🆔 ' + jobId + '\n'
        + '👤 ' + (data.name || '-') + '\n'
        + '🏢 ' + (data.building || '-') + ' ' + (data.room || '') + '\n'
        + '🚘 ' + (data.carModel || '-') + ' | ' + (data.plate || '-') + '\n'
        + '📦 ' + (data.plan || '-') + '\n'
        + '⏱ ' + duration + ' 分（នាទី）\n';

      sendTelegram(msg);
    }
  } catch (tgErr) {
    Logger.log('Telegram notify error: ' + tgErr.toString());
  }

  return jsonResponse({ status: 'ok', jobId: jobId });
}

// ═══════════════════════════════════════════
//  作業開始・完了ハンドラー（v4から継承）
// ═══════════════════════════════════════════

function handleJobStart(data) {
  var beforeLinks = [];
  var folderUrl = '';

  try {
    var parentFolder = getOrCreateFolder(PHOTO_FOLDER_NAME);
    var now = new Date();
    var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');
    var folderName = dateStr + '_' + (data.name || 'unknown');

    var jobFolder = parentFolder.createFolder(folderName);
    jobFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    folderUrl = jobFolder.getUrl();

    if (data.beforePhotos && data.beforePhotos.length > 0) {
      for (var i = 0; i < data.beforePhotos.length; i++) {
        if (data.beforePhotos[i]) {
          var link = saveBase64Image(jobFolder, data.beforePhotos[i], 'before_' + (i + 1));
          beforeLinks.push(link);
        }
      }
    }
  } catch (photoErr) {
    Logger.log('handleJobStart photo save error: ' + photoErr.toString());
  }

  try {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS && TELEGRAM_CHAT_IDS.length > 0) {
      var startFormatted = data.startTime ? formatCambodiaTime(new Date(data.startTime)) : formatCambodiaTime(new Date());

      var msg = '🚗 *作業スタート（ការងារចាប់ផ្តើម）*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '👤 ' + (data.name || '-') + '\n'
        + '🏢 ' + (data.building || '-') + ' ' + (data.room || '') + '\n'
        + '🚘 ' + (data.carModel || '-') + ' | ' + (data.plate || '-') + '\n'
        + '📦 ' + (data.plan || '-') + '\n'
        + '▶ 開始（ចាប់ផ្តើម）: ' + startFormatted + '\n';

      sendTelegram(msg);

      if (beforeLinks.length > 0) {
        sendPhotoGroupToTelegram(beforeLinks, '📸 ビフォー写真（រូបថតមុន）');
      }
    }
  } catch (tgErr) {
    Logger.log('handleJobStart Telegram error: ' + tgErr.toString());
  }

  // ─── v6: 予約Bot連携（作業開始時のステータス更新） ───
  try {
    if (data.bookingId) {
      var booking = getBookingById(data.bookingId);
      if (booking && booking.status !== '作業完了' && booking.status !== '作業中') {
        updateBookingField(data.bookingId, 17, '作業中');
      }
    }
  } catch (linkErr) {
    Logger.log('handleJobStart booking link error: ' + linkErr.toString());
  }

  return jsonResponse({ status: 'ok', photoLinks: beforeLinks, folderUrl: folderUrl });
}

function handleJobEnd(data) {
  var afterLinks = [];

  try {
    var parentFolder = getOrCreateFolder(PHOTO_FOLDER_NAME);
    var now = new Date();
    var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');
    var folderName = dateStr + '_' + (data.name || 'unknown');

    var jobFolder = null;
    var folders = parentFolder.getFoldersByName(folderName);
    if (folders.hasNext()) {
      jobFolder = folders.next();
    } else {
      jobFolder = parentFolder.createFolder(folderName);
      jobFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }

    if (data.afterPhotos && data.afterPhotos.length > 0) {
      for (var i = 0; i < data.afterPhotos.length; i++) {
        if (data.afterPhotos[i]) {
          var link = saveBase64Image(jobFolder, data.afterPhotos[i], 'after_' + (i + 1));
          afterLinks.push(link);
        }
      }
    }
  } catch (photoErr) {
    Logger.log('handleJobEnd photo save error: ' + photoErr.toString());
  }

  try {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS && TELEGRAM_CHAT_IDS.length > 0) {
      var endFormatted = data.endTime ? formatCambodiaTime(new Date(data.endTime)) : formatCambodiaTime(new Date());
      var durationMin = data.duration || 0;

      var msg = '✅ *作業完了（ការងារបានបញ្ចប់）*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '👤 ' + (data.name || '-') + '\n'
        + '🏢 ' + (data.building || '-') + ' ' + (data.room || '') + '\n'
        + '🚘 ' + (data.carModel || '-') + ' | ' + (data.plate || '-') + '\n'
        + '📦 ' + (data.plan || '-') + '\n'
        + '⏹ 終了（បញ្ចប់）: ' + endFormatted + '\n'
        + '⏱ 所要時間（រយៈពេល）: ' + durationMin + ' 分\n';

      sendTelegram(msg);

      if (afterLinks.length > 0) {
        sendPhotoGroupToTelegram(afterLinks, '✨ アフター写真（រូបថតក្រោយ）');
      }
    }
  } catch (tgErr) {
    Logger.log('handleJobEnd Telegram error: ' + tgErr.toString());
  }

  // ─── v6: 予約Bot連携 ───
  // 関連する予約があれば、ステータスを「作業完了」に + 顧客に支払い依頼を送信
  try {
    completeBookingForJob(data);
  } catch (linkErr) {
    Logger.log('completeBookingForJob error: ' + linkErr.toString());
  }

  return jsonResponse({ status: 'ok', photoLinks: afterLinks });
}

// ═══════════════════════════════════════════
//  v6: Job ↔ Booking 連携
// ═══════════════════════════════════════════

// handleJobEnd 完了時に呼ばれる
// data.bookingId があれば直接、なければ Bookings.X列(Job ID) で逆引き
function completeBookingForJob(data) {
  var booking = null;

  if (data.bookingId) {
    booking = getBookingById(data.bookingId);
  } else if (data.jobId) {
    booking = findBookingByJobId(data.jobId);
  }

  // jobIdとbookingIdの両方ない時は何もしない（旧来の単発ジョブ）
  if (!booking) {
    Logger.log('completeBookingForJob: no booking linked, skip');
    return;
  }

  // すでに作業完了済みなら2重実行しない
  if (booking.status === '作業完了') {
    Logger.log('completeBookingForJob: already 作業完了 for ' + booking.bookingId);
    return;
  }

  // ステータス更新（Q列=17）
  updateBookingField(booking.bookingId, 17, '作業完了');

  // Job ID紐付け（Bookings X列=24）
  if (data.jobId) {
    updateBookingField(booking.bookingId, 24, data.jobId);
  }

  // 顧客に支払い依頼送信
  sendPaymentRequest(booking.bookingId);

  // Adminグループにも完了通知
  sendTelegramTo(ADMIN_GROUP_ID,
    '✅ *予約作業完了 → 支払い依頼送信*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + booking.bookingId + '\n'
    + '👤 ' + booking.customerName + '\n'
    + '💰 $' + booking.amount + '\n'
    + '📌 顧客にABA QRと金額を送信しました。\n'
    + '   スクショ受信で自動的に「支払い済み」に変わります。'
  );
}

// Job IDから予約を逆引き（Bookings.X列=24）
function findBookingByJobId(jobId) {
  if (!jobId) return null;
  var sheet = getBookingsSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var data = sheet.getRange(2, 1, lastRow - 1, 25).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][23] && data[i][23].toString() === jobId.toString()) {
      return getBookingById(data[i][0]);
    }
  }
  return null;
}

// 予約にJob IDを紐付ける（job-managerから呼ぶ用）
function linkJobToBooking(bookingId, jobId) {
  return updateBookingField(bookingId, 24, jobId);
}

// ═══════════════════════════════════════════
//  写真関連ヘルパー（v4から継承）
// ═══════════════════════════════════════════

function findExistingPhotoLinks(dateStr, name) {
  try {
    var parentFolders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
    if (!parentFolders.hasNext()) return null;
    var parentFolder = parentFolders.next();

    var folderName = dateStr + '_' + name;
    var folders = parentFolder.getFoldersByName(folderName);
    if (!folders.hasNext()) return null;

    var jobFolder = folders.next();
    var files = jobFolder.getFiles();

    var beforeLinks = ['', '', '', ''];
    var afterLinks = ['', '', '', ''];

    while (files.hasNext()) {
      var file = files.next();
      var fileName = file.getName();
      var url = file.getUrl();

      if (fileName.indexOf('before_') === 0) {
        var numMatch = fileName.match(/before_(\d+)/);
        if (numMatch) {
          var idx = parseInt(numMatch[1], 10) - 1;
          if (idx >= 0 && idx < 4) beforeLinks[idx] = url;
        }
      } else if (fileName.indexOf('after_') === 0) {
        var numMatch = fileName.match(/after_(\d+)/);
        if (numMatch) {
          var idx = parseInt(numMatch[1], 10) - 1;
          if (idx >= 0 && idx < 4) afterLinks[idx] = url;
        }
      }
    }

    var hasAny = beforeLinks.some(function(l) { return l !== ''; }) ||
                 afterLinks.some(function(l) { return l !== ''; });

    if (hasAny) {
      return { before: beforeLinks, after: afterLinks };
    }
    return null;
  } catch (e) {
    Logger.log('findExistingPhotoLinks error: ' + e.toString());
    return null;
  }
}

function setPhotoHyperlinks(sheet, row, beforeLinks, afterLinks) {
  for (var i = 0; i < 4; i++) {
    if (beforeLinks[i]) {
      var cell = sheet.getRange(row, 16 + i);
      cell.setFormula('=HYPERLINK("' + beforeLinks[i] + '","📷 Before ' + (i+1) + '")');
    }
  }
  for (var i = 0; i < 4; i++) {
    if (afterLinks[i]) {
      var cell = sheet.getRange(row, 20 + i);
      cell.setFormula('=HYPERLINK("' + afterLinks[i] + '","📷 After ' + (i+1) + '")');
    }
  }
}

// Phase 1: 在庫管理は無効化（project_inventory_architecture.md で詳細保存）

// ═══════════════════════════════════════════
//  ユーティリティ
// ═══════════════════════════════════════════

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function formatCambodiaTime(date) {
  return Utilities.formatDate(date, 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss');
}

// 日本語→クメール語翻訳（スタッフ通知用）
function translateToKhmer(japaneseText) {
  if (!japaneseText) return '';
  try {
    return LanguageApp.translate(japaneseText, 'ja', 'km');
  } catch (err) {
    Logger.log('翻訳エラー: ' + err.toString());
    return japaneseText; // 翻訳失敗時は原文を返す
  }
}

function getOrCreateFolder(folderName) {
  var folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}

function saveBase64Image(folder, base64Data, filename) {
  var parts = base64Data.split(',');
  var mimeMatch = parts[0].match(/:(.*?);/);
  var mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  var raw = parts.length > 1 ? parts[1] : parts[0];

  var blob = Utilities.newBlob(Utilities.base64Decode(raw), mimeType, filename + '.jpg');
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return file.getUrl();
}

// ═══════════════════════════════════════════
//  セットアップ・Webhook
// ═══════════════════════════════════════════
// Phase 1: v5 トリガー/シート系は廃止。setupV6Triggers / setupV6Sheets を使用。

// Telegram Webhook設定（後方互換: Adminのみ）
function setupWebhook() {
  var gasUrl = DEPLOYED_WEBAPP_URL;
  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/setWebhook?url=' + encodeURIComponent(gasUrl + '?bot=admin');

  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('Admin Webhook設定結果: ' + response.getContentText());
}

function removeWebhook() {
  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/deleteWebhook';
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('Admin Webhook解除結果: ' + response.getContentText());
}

// v6: 3 Bot 一括Webhook設定
// Admin / Field / Booking それぞれ別Tokenの場合、bot=パラメータで識別
// 同一Tokenの場合はAdmin Webhookのみ設定（重複登録を避ける）
function setupAllWebhooks() {
  // DEPLOYED_WEBAPP_URL を使用（エディタ実行時 ScriptApp.getService().getUrl() は /dev を返すため）
  var gasUrl = DEPLOYED_WEBAPP_URL;
  var results = {};

  var bots = [
    { name: 'admin',   token: BOT_TOKENS.admin   },
    { name: 'field',   token: BOT_TOKENS.field   },
    { name: 'booking', token: BOT_TOKENS.booking }
  ];

  // Tokenが重複している場合は1回だけ登録（後勝ちで上書きされるのを防ぐ）
  var registeredTokens = {};
  for (var i = 0; i < bots.length; i++) {
    var bot = bots[i];
    if (!bot.token) {
      results[bot.name] = 'SKIP (no token)';
      continue;
    }
    if (registeredTokens[bot.token]) {
      results[bot.name] = 'SKIP (token shared with ' + registeredTokens[bot.token] + ')';
      continue;
    }
    var webhookUrl = gasUrl + '?bot=' + bot.name;
    var apiUrl = 'https://api.telegram.org/bot' + bot.token + '/setWebhook?url=' + encodeURIComponent(webhookUrl);
    try {
      var res = UrlFetchApp.fetch(apiUrl, { muteHttpExceptions: true });
      results[bot.name] = res.getContentText();
      registeredTokens[bot.token] = bot.name;
    } catch (e) {
      results[bot.name] = 'ERROR: ' + e.toString();
    }
  }

  Logger.log('=== Webhook設定結果 ===');
  for (var name in results) {
    Logger.log(name + ': ' + results[name]);
  }
  return results;
}

// v6: 3 Bot 一括Webhook解除
function removeAllWebhooks() {
  var bots = ['admin', 'field', 'booking'];
  var seenTokens = {};
  for (var i = 0; i < bots.length; i++) {
    var name = bots[i];
    var token = BOT_TOKENS[name];
    if (!token || seenTokens[token]) continue;
    seenTokens[token] = true;
    try {
      var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/deleteWebhook', { muteHttpExceptions: true });
      Logger.log(name + ': ' + res.getContentText());
    } catch (e) {
      Logger.log(name + ' ERROR: ' + e.toString());
    }
  }
}

// v6: 各BotのWebhook状態を確認
function checkAllWebhooks() {
  var bots = ['admin', 'field', 'booking'];
  for (var i = 0; i < bots.length; i++) {
    var name = bots[i];
    var token = BOT_TOKENS[name];
    if (!token) continue;
    try {
      var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo', { muteHttpExceptions: true });
      Logger.log('=== ' + name + ' ===');
      Logger.log(res.getContentText());
    } catch (e) {
      Logger.log(name + ' ERROR: ' + e.toString());
    }
  }
}

// ═══════════════════════════════════════════
//  v6: 予約管理（Bookings / Customers / Calendar）
// ═══════════════════════════════════════════

// ─── シート ──────────────────────────────────

// 顧客マスタシート取得・作成
// 連絡はTelegramチャンネル経由で行うため電話番号は保持しない
function getCustomersSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CUSTOMERS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CUSTOMERS_SHEET_NAME);
    var headers = [
      'Customer ID',     // A: SM-XXXX
      '氏名',            // B
      'Telegram chat_id',// C
      'Telegram username',// D: @username（あれば）
      '累計予約回数',    // E
      '最終利用日',      // F
      '登録日',          // G
      '備考'             // H
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#1976d2');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 100);
    sheet.setColumnWidth(2, 150);
    sheet.setColumnWidth(8, 250);
  }
  return sheet;
}

// 車両マスタシート取得・作成（1顧客に複数台）
function getVehiclesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(VEHICLES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(VEHICLES_SHEET_NAME);
    var headers = [
      'Vehicle ID',   // A: VH-XXXX
      'Customer ID',  // B: SM-XXXX
      'ニックネーム', // C: 顧客が呼びやすい名前（例:「白いCamry」「妻の車」）
      'メーカー',     // D
      'モデル',       // E
      '色',           // F
      'ナンバー',     // G
      '車種区分',     // H: セダン以下/SUV以上
      '登録日',       // I
      '備考',         // J
      'アクティブ'    // K: TRUE/FALSE（廃車・売却で非表示にできる）
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#388e3c');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 100);
    sheet.setColumnWidth(2, 100);
    sheet.setColumnWidth(3, 150);

    // 車種区分ドロップダウン
    var typeRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['セダン以下', 'SUV以上'], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, 8, 1000, 1).setDataValidation(typeRule);

    // アクティブ列はチェックボックス
    sheet.getRange(2, 11, 1000, 1).insertCheckboxes();
  }
  return sheet;
}

// 予約履歴シート取得・作成
function getBookingsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(BOOKINGS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(BOOKINGS_SHEET_NAME);
    var headers = [
      'Booking ID',          // A: BK-YYYYMMDD-NNN
      '作成日時',             // B
      'Customer ID',         // C: SM-XXXX
      '顧客名',               // D
      '顧客 chat_id',         // E
      '予約日',               // F: yyyy-MM-dd
      '開始時刻',             // G: HH:mm
      '終了時刻',             // H: HH:mm
      '所要時間(分)',         // I
      'プラン',               // J: A/B/C/D
      '車種',                 // K: セダン以下/SUV以上
      'オプション',           // L: カンマ区切りのid
      '場所',                 // M
      'Vehicle ID',          // N: VH-XXXX
      '車両情報',             // O: 表示用テキスト（メーカー モデル 色 ナンバー）
      '金額',                 // P
      'ステータス',           // Q: 仮予約/確定/作業中/作業完了/キャンセル
      '支払いステータス',     // R: 未払い/支払い済み(スクショ)/支払い済み(手動)/支払い済み(現金)/キャンセル
      '駐車写真URL',          // S
      '駐車階数',             // T
      '支払いスクショURL',    // U
      '催促ステータス',       // V: 未催促/催促済み
      '催促日時',             // W
      '関連Job ID',           // X
      'カレンダーEventID'      // Y
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#c8102e');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(13, 220); // 場所
    sheet.setColumnWidth(15, 220); // 車両情報
    sheet.setColumnWidth(19, 200); // 駐車写真
    sheet.setColumnWidth(21, 200); // 支払いスクショ

    // 支払いステータス列(R=18)にドロップダウン
    var paymentRule = SpreadsheetApp.newDataValidation()
      .requireValueInList([
        '未払い',
        '支払い済み（スクショ）',
        '支払い済み（手動）',
        '支払い済み（現金）',
        'キャンセル'
      ], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, 18, 1000, 1).setDataValidation(paymentRule);

    // ステータス列(Q=17)にドロップダウン
    var statusRule = SpreadsheetApp.newDataValidation()
      .requireValueInList([
        '仮予約',
        '確定',
        '作業中',
        '作業完了',
        'キャンセル'
      ], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, 17, 1000, 1).setDataValidation(statusRule);

    // 催促ステータス列(V=22)
    var reminderRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['未催促', '催促済み'], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, 22, 1000, 1).setDataValidation(reminderRule);
  }
  return sheet;
}

// ─── ID生成 ──────────────────────────────────

function generateBookingId() {
  var sheet = getBookingsSheet();
  var now = new Date();
  var dateStr = Utilities.formatDate(now, BOOKING_TIMEZONE, 'yyyyMMdd');
  var lastRow = sheet.getLastRow();
  var count = 1;
  if (lastRow >= 2) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    ids.forEach(function(row) {
      if (row[0] && row[0].toString().indexOf('BK-' + dateStr) === 0) count++;
    });
  }
  return 'BK-' + dateStr + '-' + String(count).padStart(3, '0');
}

function generateCustomerId() {
  var sheet = getCustomersSheet();
  var lastRow = sheet.getLastRow();
  // SM-0001 から連番
  var maxNum = 0;
  if (lastRow >= 2) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    ids.forEach(function(row) {
      var id = row[0] ? row[0].toString() : '';
      var m = id.match(/^SM-(\d+)$/);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
      }
    });
  }
  return 'SM-' + String(maxNum + 1).padStart(4, '0');
}

// ─── 顧客マスタ ──────────────────────────────

// chat_id で顧客を検索（無ければ新規作成）
// 電話番号は持たない（Telegramで連絡可能なため）
function findOrCreateCustomer(chatId, name, username) {
  var sheet = getCustomersSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    for (var i = 0; i < data.length; i++) {
      if (data[i][2] && data[i][2].toString() === chatId.toString()) {
        // 既存顧客: 名前/usernameを更新
        var rowNum = i + 2;
        if (name) sheet.getRange(rowNum, 2).setValue(name);
        if (username) sheet.getRange(rowNum, 4).setValue(username);
        return {
          customerId: data[i][0],
          name: name || data[i][1],
          chatId: chatId,
          username: username || data[i][3],
          totalBookings: data[i][4] || 0,
          isNew: false
        };
      }
    }
  }
  // 新規作成
  var customerId = generateCustomerId();
  var now = new Date();
  sheet.appendRow([
    customerId,
    name || '',
    chatId.toString(),
    username || '',
    0,
    '',
    formatCambodiaTime(now),
    ''
  ]);
  return {
    customerId: customerId,
    name: name || '',
    chatId: chatId,
    username: username || '',
    totalBookings: 0,
    isNew: true
  };
}

// ─── 車両マスタ ─────────────────────────

function generateVehicleId() {
  var sheet = getVehiclesSheet();
  var lastRow = sheet.getLastRow();
  var maxNum = 0;
  if (lastRow >= 2) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    ids.forEach(function(row) {
      var id = row[0] ? row[0].toString() : '';
      var m = id.match(/^VH-(\d+)$/);
      if (m) {
        var n = parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
      }
    });
  }
  return 'VH-' + String(maxNum + 1).padStart(4, '0');
}

// 顧客の登録車両（アクティブのみ）を取得
function getCustomerVehicles(customerId) {
  var sheet = getVehiclesSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  var result = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][1] && data[i][1].toString() === customerId && data[i][10] !== false) {
      result.push({
        vehicleId: data[i][0],
        customerId: data[i][1],
        nickname: data[i][2],
        maker: data[i][3],
        model: data[i][4],
        color: data[i][5],
        plate: data[i][6],
        vehicleType: data[i][7],
        registered: data[i][8],
        notes: data[i][9],
        active: data[i][10] !== false
      });
    }
  }
  return result;
}

// 車両を新規登録
// data: { customerId, nickname, maker, model, color, plate, vehicleType, notes }
function addVehicle(data) {
  var sheet = getVehiclesSheet();
  var vehicleId = generateVehicleId();
  var now = new Date();
  sheet.appendRow([
    vehicleId,
    data.customerId || '',
    data.nickname || '',
    data.maker || '',
    data.model || '',
    data.color || '',
    data.plate || '',
    data.vehicleType || 'セダン以下',
    formatCambodiaTime(now),
    data.notes || '',
    true  // active
  ]);
  return vehicleId;
}

// Vehicle ID から車両情報取得
function getVehicleById(vehicleId) {
  var sheet = getVehiclesSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString() === vehicleId) {
      return {
        vehicleId: data[i][0],
        customerId: data[i][1],
        nickname: data[i][2],
        maker: data[i][3],
        model: data[i][4],
        color: data[i][5],
        plate: data[i][6],
        vehicleType: data[i][7],
        registered: data[i][8],
        notes: data[i][9],
        active: data[i][10] !== false
      };
    }
  }
  return null;
}

// 車両情報を1行テキスト化
function formatVehicleInfo(vehicle) {
  if (!vehicle) return '';
  var parts = [];
  if (vehicle.maker) parts.push(vehicle.maker);
  if (vehicle.model) parts.push(vehicle.model);
  if (vehicle.color) parts.push('(' + vehicle.color + ')');
  if (vehicle.plate) parts.push(vehicle.plate);
  return parts.join(' ');
}

// 累計予約回数 +1, 最終利用日更新
function incrementCustomerBooking(customerId, lastUsedDate) {
  if (!customerId) {
    Logger.log('incrementCustomerBooking: customerId is empty');
    return;
  }
  var sheet = getCustomersSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('incrementCustomerBooking: no data rows in Customers sheet');
    return;
  }
  var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  var customerIdStr = customerId.toString();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString() === customerIdStr) {
      var rowNum = i + 2;
      var current = parseInt(data[i][4], 10) || 0;
      var newCount = current + 1;
      sheet.getRange(rowNum, 5).setValue(newCount);
      sheet.getRange(rowNum, 6).setValue(lastUsedDate || '');
      Logger.log('incrementCustomerBooking: ' + customerIdStr + ' → ' + newCount + '回目');
      return;
    }
  }
  Logger.log('incrementCustomerBooking: customer not found: ' + customerIdStr);
}

// ─── 所要時間計算 ───────────────────────────

// プラン文字（A/B/C/D）+ 車種 + オプション配列 → 合計分
// Plan_Pricesシートの値を優先、なければハードコードのフォールバック
function calcBookingDuration(planLetter, vehicleType, optionIds) {
  var config = getBookingConfig();
  var isSuv = (vehicleType === 'SUV以上' || vehicleType === 'SUV');
  var base = 0;

  if (config.planDurations[planLetter]) {
    base = isSuv ? config.planDurations[planLetter].suv : config.planDurations[planLetter].sedan;
  } else {
    // フォールバック: ハードコード値
    base = PLAN_DURATIONS[planLetter] || 0;
    if (isSuv) base += SUV_EXTRA_MIN;
  }

  var optTotal = 0;
  if (optionIds && optionIds.length > 0) {
    optionIds.forEach(function(id) {
      if (BOOKING_OPTIONS[id]) optTotal += BOOKING_OPTIONS[id].durationMin;
    });
  }
  return base + optTotal;
}

// ─── Calendar連携 ───────────────────────────

// 指定日の空き枠を返す（30分刻み）
// dateStr: 'yyyy-MM-dd', durationMin: 必要時間（分）
// returns: ['09:00', '09:30', ...] 形式の開始時刻配列
function findAvailableSlots(dateStr, durationMin) {
  var calendar;
  try {
    calendar = CalendarApp.getCalendarById(BOOKING_CALENDAR_ID);
    if (!calendar) {
      Logger.log('findAvailableSlots: Calendar not found: ' + BOOKING_CALENDAR_ID);
      return { slots: [], debug: 'Calendar not found: ' + BOOKING_CALENDAR_ID };
    }
  } catch (e) {
    Logger.log('findAvailableSlots calendar error: ' + e.toString());
    return { slots: [], debug: 'Calendar error: ' + e.toString() };
  }

  // Plan_Pricesシートから営業時間・バッファを取得
  var config = getBookingConfig();
  var hourStart = config.businessHourStart;
  var hourEnd   = config.businessHourEnd;
  var bufferMin = config.bufferMin;

  // 営業時間の範囲をカンボジア時間で構築
  var dayStart = toCambodiaDate(dateStr, hourStart, 0);
  var dayEnd   = toCambodiaDate(dateStr, hourEnd, 0);

  // 既存イベントを取得
  var events = calendar.getEvents(dayStart, dayEnd);
  var busyRanges = events.map(function(ev) {
    return { start: ev.getStartTime().getTime(), end: ev.getEndTime().getTime() };
  });

  var slots = [];
  var slotStart = new Date(dayStart);
  // バッファは予約の「後」に必要なので、最終予約は dayEnd - durationMin まで
  var lastPossible = new Date(dayEnd.getTime() - durationMin * 60 * 1000);

  while (slotStart.getTime() <= lastPossible.getTime()) {
    var slotEnd = new Date(slotStart.getTime() + durationMin * 60 * 1000);
    // この枠が既存イベント＋バッファと衝突するか
    var conflict = false;
    for (var i = 0; i < busyRanges.length; i++) {
      var b = busyRanges[i];
      // 既存イベントの前後にバッファを設ける
      var bufferedStart = b.start - bufferMin * 60 * 1000;
      var bufferedEnd   = b.end   + bufferMin * 60 * 1000;
      if (slotStart.getTime() < bufferedEnd && slotEnd.getTime() > bufferedStart) {
        conflict = true;
        break;
      }
    }
    // 過去時刻は除外
    if (!conflict && slotStart.getTime() > Date.now()) {
      slots.push(Utilities.formatDate(slotStart, BOOKING_TIMEZONE, 'HH:mm'));
    }
    // 次の30分刻み
    slotStart = new Date(slotStart.getTime() + 30 * 60 * 1000);
  }
  return { slots: slots, debug: 'OK, events=' + busyRanges.length + ', buffer=' + bufferMin + 'min, hours=' + hourStart + '-' + hourEnd };
}

// Calendarに予約イベントを作成
function createBookingCalendarEvent(booking) {
  try {
    var calendar = CalendarApp.getCalendarById(BOOKING_CALENDAR_ID);
    if (!calendar) {
      Logger.log('createBookingCalendarEvent: Calendar not found');
      return '';
    }
    // カンボジア時間で正しくイベントを作成
    var timeParts = booking.startTime.split(':');
    var startDate = toCambodiaDate(booking.date, parseInt(timeParts[0], 10), parseInt(timeParts[1], 10));
    var endDate = new Date(startDate.getTime() + booking.durationMin * 60 * 1000);

    var title = '【' + booking.bookingId + '】' + booking.customerName + ' / プラン' + booking.planLetter + ' (' + booking.vehicleType + ')';
    var optionNames = (booking.optionIds || []).map(function(id) {
      return BOOKING_OPTIONS[id] ? BOOKING_OPTIONS[id].name : id;
    }).join(', ');
    var description =
      '予約番号: ' + booking.bookingId + '\n' +
      '顧客: ' + booking.customerName + ' (' + booking.customerId + ')\n' +
      'プラン: ' + booking.planLetter + ' / ' + booking.vehicleType + '\n' +
      'オプション: ' + (optionNames || 'なし') + '\n' +
      '所要時間: ' + booking.durationMin + '分\n' +
      '車両: ' + (booking.vehicleInfo || '-') + '\n' +
      '金額: $' + (booking.amount || 0) + '\n' +
      '場所: ' + (booking.location || '-');

    var event = calendar.createEvent(title, startDate, endDate, {
      description: description,
      location: booking.location || ''
    });
    return event.getId();
  } catch (e) {
    Logger.log('createBookingCalendarEvent error: ' + e.toString());
    return '';
  }
}

// ─── 予約レコード作成 ───────────────────────

// 予約をシートとカレンダーに登録
// data: { customerId, customerName, chatId, date, startTime, planLetter, vehicleType, optionIds, location, vehicleId, vehicleInfo, amount }
function createBookingRecord(data) {
  var sheet = getBookingsSheet();
  var bookingId = generateBookingId();
  var now = new Date();

  var durationMin = calcBookingDuration(data.planLetter, data.vehicleType, data.optionIds || []);

  // 終了時刻計算
  var startParts = data.startTime.split(':');
  var startMins = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
  var endMins = startMins + durationMin;
  var endTime = String(Math.floor(endMins / 60)).padStart(2, '0') + ':' + String(endMins % 60).padStart(2, '0');

  // Calendar登録
  var eventId = createBookingCalendarEvent({
    bookingId: bookingId,
    customerId: data.customerId,
    customerName: data.customerName,
    date: data.date,
    startTime: data.startTime,
    durationMin: durationMin,
    planLetter: data.planLetter,
    vehicleType: data.vehicleType,
    optionIds: data.optionIds,
    vehicleInfo: data.vehicleInfo,
    amount: data.amount,
    location: data.location
  });

  var optionsStr = (data.optionIds || []).join(',');

  sheet.appendRow([
    bookingId,                          // A
    formatCambodiaTime(now),            // B
    data.customerId || '',              // C
    data.customerName || '',            // D
    (data.chatId || '').toString(),     // E
    data.date || '',                    // F
    data.startTime || '',               // G
    endTime,                            // H
    durationMin,                        // I
    data.planLetter || '',              // J
    data.vehicleType || '',             // K
    optionsStr,                         // L
    data.location || '',                // M
    data.vehicleId || '',               // N Vehicle ID
    data.vehicleInfo || '',             // O 車両情報
    data.amount || 0,                   // P
    '確定',                             // Q
    '未払い',                           // R
    '',                                 // S 駐車写真
    '',                                 // T 階数
    '',                                 // U 支払いスクショ
    '未催促',                           // V
    '',                                 // W 催促日時
    '',                                 // X Job ID
    eventId                             // Y EventID
  ]);

  // 顧客マスタの累計回数更新
  if (data.customerId) {
    incrementCustomerBooking(data.customerId, data.date);
  }

  return {
    bookingId: bookingId,
    durationMin: durationMin,
    endTime: endTime,
    eventId: eventId
  };
}

// 予約をBooking IDで取得
function getBookingById(bookingId) {
  var sheet = getBookingsSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var data = sheet.getRange(2, 1, lastRow - 1, 25).getValues();
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] && data[i][0].toString() === bookingId) {
      return {
        rowNum: i + 2,
        bookingId: data[i][0],
        created: data[i][1],
        customerId: data[i][2],
        customerName: data[i][3],
        chatId: data[i][4],
        date: data[i][5],
        startTime: data[i][6],
        endTime: data[i][7],
        durationMin: data[i][8],
        planLetter: data[i][9],
        vehicleType: data[i][10],
        optionIds: data[i][11] ? data[i][11].toString().split(',').filter(function(s){return s;}) : [],
        location: data[i][12],
        vehicleId: data[i][13],
        vehicleInfo: data[i][14],
        amount: data[i][15],
        status: data[i][16],
        paymentStatus: data[i][17],
        parkingPhotoUrl: data[i][18],
        floorNumber: data[i][19],
        paymentScreenshotUrl: data[i][20],
        reminderStatus: data[i][21],
        reminderTime: data[i][22],
        relatedJobId: data[i][23],
        eventId: data[i][24]
      };
    }
  }
  return null;
}

// 重複予約チェック: 同一chatId + 同日 + 同時刻の予約が既にあるか
// キャンセル済みは除外
function findDuplicateBooking(chatId, date, startTime) {
  var sheet = getBookingsSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var chatIdStr = chatId.toString();
  var data = sheet.getRange(2, 1, lastRow - 1, 25).getValues();
  for (var i = 0; i < data.length; i++) {
    if (!data[i][0]) continue;
    var rowChatId = (data[i][4] || '').toString();
    var rowStatus = (data[i][16] || '').toString();
    if (rowChatId !== chatIdStr) continue;
    if (rowStatus === 'キャンセル') continue;

    // 日付比較（Date型とString型の両方に対応）
    var rowDate = data[i][5];
    var rowDateStr = '';
    if (rowDate instanceof Date) {
      rowDateStr = Utilities.formatDate(rowDate, BOOKING_TIMEZONE, 'yyyy-MM-dd');
    } else {
      rowDateStr = (rowDate || '').toString();
    }
    var rowTime = (data[i][6] || '').toString();

    if (rowDateStr === date && rowTime === startTime) {
      return {
        bookingId: data[i][0],
        durationMin: data[i][8],
        endTime: data[i][7],
        amount: data[i][15]
      };
    }
  }
  return null;
}

// ─── 価格計算（プラン基本料金 + 出張料 + オプション） ───
function calcBookingAmount(planLetter, vehicleType) {
  // プラン名はジョブ管理と統一
  var planNames = {
    'A': '清 KIYOME (A)',
    'B': '鏡 KAGAMI (B)',
    'C': '匠 TAKUMI (C)',
    'D': '将軍 SHOGUN (D)'
  };
  var planName = planNames[planLetter] || '';
  if (!planName) return 0;
  // 既存のgetPlanPrice(planName, vehicleType)は出張料込みで返す
  var vt = (vehicleType === 'SUV以上' || vehicleType === 'SUV') ? 'SUV' : 'セダン';
  return getPlanPrice(planName, vt);
}

// ─── テスト関数 ──────────────────────────

function testBookingSheets() {
  var c = getCustomersSheet();
  var b = getBookingsSheet();
  Logger.log('Customers列数: ' + c.getLastColumn());
  Logger.log('Bookings列数: ' + b.getLastColumn());
}

// ═══════════════════════════════════════════
//  Phase 2: 顧客問い合わせ（Inquiries）
// ═══════════════════════════════════════════

var INQUIRIES_SHEET_NAME = 'Inquiries';

function getInquiriesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INQUIRIES_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(INQUIRIES_SHEET_NAME);
    var headers = [
      'Inquiry ID',    // A
      '日時',          // B
      '顧客名',        // C
      'Chat ID',       // D
      'メッセージ',     // E
      '種別',          // F: text/voice/photo/document/sticker
      'メディアURL',    // G: Drive保存先（写真・ボイス等）
      'ステータス',     // H: 未対応/対応済み
      '返信内容',       // I
      '返信者',        // J
      '返信日時'        // K
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#5B2C6F');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(3, 120);
    sheet.setColumnWidth(5, 300);
    sheet.setColumnWidth(7, 200);
    sheet.setColumnWidth(9, 300);
  }
  return sheet;
}

// 問い合わせIDを生成: INQ-YYYYMMDD-NNN
function generateInquiryId() {
  var sheet = getInquiriesSheet();
  var now = new Date();
  var dateStr = Utilities.formatDate(now, BOOKING_TIMEZONE, 'yyyyMMdd');
  var lastRow = sheet.getLastRow();
  var count = 0;
  if (lastRow >= 2) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    ids.forEach(function(row) {
      if (row[0] && row[0].toString().indexOf('INQ-' + dateStr) === 0) count++;
    });
  }
  return 'INQ-' + dateStr + '-' + String(count + 1).padStart(3, '0');
}

// 問い合わせを保存
function createInquiry(chatId, customerName, message, msgType, mediaUrl) {
  var sheet = getInquiriesSheet();
  var inquiryId = generateInquiryId();
  var now = formatCambodiaTime(new Date());

  sheet.appendRow([
    inquiryId,              // A
    now,                    // B
    customerName || '',     // C
    chatId.toString(),      // D
    message || '',          // E
    msgType || 'text',      // F
    mediaUrl || '',         // G
    '未対応',               // H
    '',                     // I
    '',                     // J
    ''                      // K
  ]);
  return inquiryId;
}

// 問い合わせ一覧を取得（API用）
function handleInquiriesGet(e) {
  var sheet = getInquiriesSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ status: 'ok', inquiries: [] });
  }
  var data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  var inquiries = [];
  for (var i = 0; i < data.length; i++) {
    if (!data[i][0]) continue;
    inquiries.push({
      inquiryId: data[i][0],
      created: data[i][1],
      customerName: data[i][2],
      chatId: data[i][3] ? data[i][3].toString() : '',
      message: data[i][4],
      msgType: data[i][5] || 'text',
      mediaUrl: data[i][6] || '',
      status: data[i][7] || '未対応',
      reply: data[i][8] || '',
      replyBy: data[i][9] || '',
      replyAt: data[i][10] || ''
    });
  }
  // 新しい順
  inquiries.reverse();
  return jsonResponse({ status: 'ok', inquiries: inquiries });
}

// 問い合わせに返信（ミニアプリから）
function handleInquiryReplyFromApp(data) {
  if (!data.inquiryId || !data.reply) {
    return jsonResponse({ status: 'error', message: 'inquiryId and reply required' });
  }

  var sheet = getInquiriesSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ status: 'error', message: 'Inquiry not found' });
  }

  var ids = sheet.getRange(2, 1, lastRow - 1, 4).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] && ids[i][0].toString() === data.inquiryId) {
      var rowNum = i + 2;
      var chatId = ids[i][3] ? ids[i][3].toString() : '';
      var replyBy = data.replyBy || 'Staff';
      var replyAt = formatCambodiaTime(new Date());

      // シートを更新
      sheet.getRange(rowNum, 8).setValue('対応済み');     // H: ステータス
      sheet.getRange(rowNum, 9).setValue(data.reply);     // I: 返信内容
      sheet.getRange(rowNum, 10).setValue(replyBy);       // J: 返信者
      sheet.getRange(rowNum, 11).setValue(replyAt);       // K: 返信日時

      // Booking Botから顧客に返信メッセージを送信
      if (chatId) {
        sendBookingBotMessage(chatId,
          '💬 *Reply from Samurai Motors*\n'
          + '💬 *ការឆ្លើយតបពី Samurai Motors*\n'
          + '━━━━━━━━━━━━━━━\n'
          + data.reply
        );
      }

      // Adminグループにも通知
      sendTelegramTo(ADMIN_GROUP_ID,
        '✅ *問い合わせ返信済み*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '🆔 ' + data.inquiryId + '\n'
        + '👤 返信者: ' + replyBy + '\n'
        + '💬 ' + data.reply
      );

      return jsonResponse({ status: 'ok', inquiryId: data.inquiryId });
    }
  }
  return jsonResponse({ status: 'error', message: 'Inquiry not found: ' + data.inquiryId });
}

function testCalcDuration() {
  // PLAN D + SUV + ボディ撥水 = 80 + 15 + 60 = 155
  var d = calcBookingDuration('D', 'SUV以上', ['body_coat']);
  Logger.log('D+SUV+body_coat: ' + d + '分 (期待: 155)');
  // PLAN A + セダン + ミラー = 30 + 0 + 5 = 35
  var d2 = calcBookingDuration('A', 'セダン以下', ['mirror_coat']);
  Logger.log('A+セダン+mirror: ' + d2 + '分 (期待: 35)');
}

function testFindSlots() {
  // 明日の空き枠を90分の予約で探す
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var dateStr = Utilities.formatDate(tomorrow, BOOKING_TIMEZONE, 'yyyy-MM-dd');
  var result = findAvailableSlots(dateStr, 90);
  var slots = result.slots || result;
  Logger.log('明日の空き枠 (90分): ' + JSON.stringify(slots) + ' debug: ' + (result.debug || ''));
}

function testCreateDummyBooking() {
  var customer = findOrCreateCustomer('999999999', 'テスト太郎', 'test_user');
  Logger.log('Customer: ' + customer.customerId);

  // 車両を新規登録
  var vehicleId = addVehicle({
    customerId: customer.customerId,
    nickname: '白いCamry',
    maker: 'Toyota',
    model: 'Camry',
    color: '白',
    plate: '2AA-1234',
    vehicleType: 'セダン以下'
  });
  Logger.log('Vehicle: ' + vehicleId);

  var vehicle = getVehicleById(vehicleId);
  var amount = calcBookingAmount('A', vehicle.vehicleType);
  var tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  var dateStr = Utilities.formatDate(tomorrow, BOOKING_TIMEZONE, 'yyyy-MM-dd');
  var result = createBookingRecord({
    customerId: customer.customerId,
    customerName: customer.name,
    chatId: '999999999',
    date: dateStr,
    startTime: '10:00',
    planLetter: 'A',
    vehicleType: vehicle.vehicleType,
    optionIds: [],
    location: 'テスト場所',
    vehicleId: vehicleId,
    vehicleInfo: formatVehicleInfo(vehicle),
    amount: amount
  });
  Logger.log('Booking: ' + result.bookingId + ' / 所要: ' + result.durationMin + '分 / 終了: ' + result.endTime);
}

function testMultiVehicle() {
  var customer = findOrCreateCustomer('888888888', '田中花子', 'hanako');
  addVehicle({ customerId: customer.customerId, nickname: '夫の車', maker: 'Toyota', model: 'Land Cruiser', color: '黒', plate: '2BB-5555', vehicleType: 'SUV以上' });
  addVehicle({ customerId: customer.customerId, nickname: '私の車',   maker: 'Honda',  model: 'Civic',         color: '赤', plate: '2BB-7777', vehicleType: 'セダン以下' });
  var vehicles = getCustomerVehicles(customer.customerId);
  Logger.log('登録車両数: ' + vehicles.length);
  vehicles.forEach(function(v) {
    Logger.log('  - ' + v.vehicleId + ' / ' + v.nickname + ' / ' + formatVehicleInfo(v) + ' / ' + v.vehicleType);
  });
}

// ─── ミニアプリ用 API ハンドラ ─────────────

// GET ?action=booking_init&chatId=X&name=Y&username=Z
// 顧客判定 + 既存車両一覧 + プラン定義 + オプション定義をまとめて返す
function handleBookingInitGet(e) {
  var p = e.parameter || {};
  var chatId = p.chatId || '';
  var name = p.name || '';
  var username = p.username || '';

  if (!chatId) {
    return jsonResponse({ status: 'error', message: 'chatId required' });
  }

  // 既存顧客検索（無ければ未登録扱い）
  var sheet = getCustomersSheet();
  var lastRow = sheet.getLastRow();
  var customer = null;
  if (lastRow >= 2) {
    var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    for (var i = 0; i < data.length; i++) {
      if (data[i][2] && data[i][2].toString() === chatId.toString()) {
        customer = {
          customerId: data[i][0],
          name: data[i][1],
          chatId: data[i][2],
          username: data[i][3],
          totalBookings: data[i][4] || 0,
          lastUsed: data[i][5] || ''
        };
        break;
      }
    }
  }

  // Plan_Pricesシートから設定を取得
  var config = getBookingConfig();

  // プラン定義（フロント表示用）- シートの値を使用
  var planLetters = ['A', 'B', 'C', 'D'];
  var defaultPlanNames = { 'A': '清 KIYOME', 'B': '鏡 KAGAMI', 'C': '匠 TAKUMI', 'D': '将軍 SHOGUN' };
  var plans = [];
  planLetters.forEach(function(letter) {
    var dur = config.planDurations[letter] || { sedan: PLAN_DURATIONS[letter] || 0, suv: (PLAN_DURATIONS[letter] || 0) + SUV_EXTRA_MIN };
    var price = config.planPrices[letter] || { sedan: 0, suv: 0 };
    var desc = config.planDescriptions[letter] || '';
    var dispatchSedan = config.dispatchFee.sedan || 0;
    var dispatchSuv   = config.dispatchFee.suv || 0;
    plans.push({
      letter: letter,
      name: config.planNames[letter] || defaultPlanNames[letter] || '',
      jp: desc,
      durationSedan: dur.sedan,
      durationSuv: dur.suv,
      priceSedan: price.sedan + dispatchSedan,
      priceSuv: price.suv + dispatchSuv
    });
  });

  // オプション定義
  var options = [];
  Object.keys(BOOKING_OPTIONS).forEach(function(id) {
    var o = BOOKING_OPTIONS[id];
    options.push({
      id: id,
      name: o.name,
      nameKm: o.nameKm,
      durationMin: o.durationMin
    });
  });

  // 既存車両（あれば）
  var vehicles = customer ? getCustomerVehicles(customer.customerId) : [];

  return jsonResponse({
    status: 'ok',
    customer: customer,  // null = 未登録（最初に名前入力が必要）
    vehicles: vehicles,
    plans: plans,
    options: options,
    businessHours: { start: config.businessHourStart, end: config.businessHourEnd },
    bufferMin: config.bufferMin,
    dispatchFee: config.dispatchFee
  });
}

// GET ?action=booking_slots&date=2026-04-15&plan=A&vehicleType=セダン以下&options=mirror_coat,glass_water_3
function handleBookingSlotsGet(e) {
  var p = e.parameter || {};
  var dateStr = p.date || '';
  var planLetter = (p.plan || '').toUpperCase();
  var vehicleType = p.vehicleType || 'セダン以下';
  var optionIds = p.options ? p.options.split(',').filter(function(s){return s;}) : [];

  if (!dateStr || !planLetter) {
    return jsonResponse({ status: 'error', message: 'date and plan required' });
  }

  var durationMin = calcBookingDuration(planLetter, vehicleType, optionIds);
  if (durationMin === 0) {
    return jsonResponse({ status: 'error', message: 'Invalid plan: ' + planLetter });
  }

  var result = findAvailableSlots(dateStr, durationMin);
  return jsonResponse({
    status: 'ok',
    date: dateStr,
    durationMin: durationMin,
    slots: result.slots || result,
    debug: result.debug || ''
  });
}

// GET ?action=booking_options
// オプションだけ取得したい時用（軽量）
function handleBookingOptionsGet(e) {
  var options = [];
  Object.keys(BOOKING_OPTIONS).forEach(function(id) {
    var o = BOOKING_OPTIONS[id];
    options.push({ id: id, name: o.name, nameKm: o.nameKm, durationMin: o.durationMin });
  });
  return jsonResponse({ status: 'ok', options: options });
}

// GET ?action=booking_history&chatId=X
// この顧客の過去予約を返す（マイページ用）
function handleBookingHistoryGet(e) {
  var p = e.parameter || {};
  var chatId = p.chatId || '';
  if (!chatId) {
    return jsonResponse({ status: 'error', message: 'chatId required' });
  }

  var sheet = getBookingsSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ status: 'ok', bookings: [] });
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 25).getValues();
  var bookings = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][4] && data[i][4].toString() === chatId.toString()) {
      bookings.push({
        bookingId: data[i][0],
        date: data[i][5] instanceof Date ? Utilities.formatDate(data[i][5], SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd') : (data[i][5] ? data[i][5].toString().substring(0, 10) : ''),
        startTime: data[i][6],
        endTime: data[i][7],
        planLetter: data[i][9],
        vehicleType: data[i][10],
        location: data[i][12],
        vehicleInfo: data[i][14],
        amount: data[i][15],
        status: data[i][16],
        paymentStatus: data[i][17]
      });
    }
  }
  // 新しい順
  bookings.reverse();
  return jsonResponse({ status: 'ok', bookings: bookings });
}

// POST action=booking_register_customer { chatId, name, username }
function handleBookingRegisterCustomerFromApp(data) {
  if (!data.chatId || !data.name) {
    return jsonResponse({ status: 'error', message: 'chatId and name required' });
  }
  var customer = findOrCreateCustomer(data.chatId, data.name, data.username || '');
  return jsonResponse({ status: 'ok', customer: customer });
}

// POST action=booking_add_vehicle { customerId, nickname, maker, model, color, plate, vehicleType }
function handleBookingAddVehicleFromApp(data) {
  if (!data.customerId) {
    return jsonResponse({ status: 'error', message: 'customerId required' });
  }
  var vehicleId = addVehicle({
    customerId: data.customerId,
    nickname: data.nickname || '',
    maker: data.maker || '',
    model: data.model || '',
    color: data.color || '',
    plate: data.plate || '',
    vehicleType: data.vehicleType || 'セダン以下',
    notes: data.notes || ''
  });
  var vehicle = getVehicleById(vehicleId);
  return jsonResponse({ status: 'ok', vehicle: vehicle });
}

// POST action=booking_create
// data: { chatId, name, customerId, vehicleId, planLetter, optionIds, date, startTime, location }
function handleBookingCreateFromApp(data) {
  if (!data.chatId || !data.planLetter || !data.date || !data.startTime) {
    return jsonResponse({ status: 'error', message: 'Missing required fields' });
  }

  // 重複予約防止: 同一ユーザーが同日同時刻に既に予約済みでないか確認
  var existingBooking = findDuplicateBooking(data.chatId, data.date, data.startTime);
  if (existingBooking) {
    Logger.log('Duplicate booking blocked: ' + existingBooking.bookingId + ' for chatId=' + data.chatId);
    return jsonResponse({
      status: 'ok',
      bookingId: existingBooking.bookingId,
      durationMin: existingBooking.durationMin,
      endTime: existingBooking.endTime,
      amount: existingBooking.amount,
      duplicate: true
    });
  }

  // 顧客取得（無ければ作成）
  var customer = findOrCreateCustomer(data.chatId, data.name || '', data.username || '');

  // 車両取得: vehicleIdがあればマスタから、なければvehicleTypeを直接使用
  var vehicle = null;
  var vehicleType = data.vehicleType || 'セダン以下';
  if (data.vehicleId) {
    vehicle = getVehicleById(data.vehicleId);
    if (vehicle) vehicleType = vehicle.vehicleType;
  }

  // 直前の二重チェック: その日時にまだ空きがあるか
  var durationMin = calcBookingDuration(data.planLetter, vehicleType, data.optionIds || []);
  var slotResult = findAvailableSlots(data.date, durationMin);
  var slots = slotResult.slots || slotResult;
  if (slots.indexOf(data.startTime) < 0) {
    return jsonResponse({ status: 'error', message: 'This time slot is no longer available. Please select another time.', slots: slots });
  }

  var amount = calcBookingAmount(data.planLetter, vehicleType);
  var vehicleInfo = vehicle ? formatVehicleInfo(vehicle) : vehicleType;
  var result = createBookingRecord({
    customerId: customer.customerId,
    customerName: customer.name,
    chatId: data.chatId,
    date: data.date,
    startTime: data.startTime,
    planLetter: data.planLetter,
    vehicleType: vehicleType,
    optionIds: data.optionIds || [],
    location: data.location || '',
    vehicleId: data.vehicleId || '',
    vehicleInfo: vehicleInfo,
    amount: amount
  });

  // Adminグループに通知
  var sizeLabel = (vehicleType === 'SUV以上') ? 'SUV & larger' : 'Sedan & smaller';
  sendTelegramTo(ADMIN_GROUP_ID,
    '🎉 *New Booking*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + result.bookingId + '\n'
    + '👤 ' + customer.name + '\n'
    + '📅 ' + data.date + ' ' + data.startTime + ' - ' + result.endTime + '\n'
    + '🚙 ' + sizeLabel + '\n'
    + '✨ Plan ' + data.planLetter + ' (' + result.durationMin + 'min)\n'
    + '📍 ' + (data.location || '-') + '\n'
    + '💰 $' + amount
  );

  // Booking Botから顧客に駐車情報依頼を送る
  try {
    requestParkingInfo(data.chatId, result.bookingId);
  } catch (e) {
    Logger.log('requestParkingInfo error: ' + e.toString());
  }

  return jsonResponse({
    status: 'ok',
    bookingId: result.bookingId,
    durationMin: result.durationMin,
    endTime: result.endTime,
    amount: amount
  });
}

// ─── v6: Job ↔ Booking 連携API ─────────────────

// GET ?action=booking_today
// 今日と明日の予約一覧を返す（job-managerの予約選択用）
function handleBookingTodayGet(e) {
  var p = e.parameter || {};
  var sheet = getBookingsSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return jsonResponse({ status: 'ok', bookings: [] });
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 25).getValues();
  var now = new Date();
  var todayStr = Utilities.formatDate(now, BOOKING_TIMEZONE, 'yyyy-MM-dd');
  var tomorrowStr = Utilities.formatDate(new Date(now.getTime() + 24*3600*1000), BOOKING_TIMEZONE, 'yyyy-MM-dd');
  var targetDates = p.date ? [p.date] : [todayStr, tomorrowStr];

  var bookings = [];
  var ssTz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  for (var i = 0; i < data.length; i++) {
    var dateValue = data[i][5];
    // 日付文字列の取得: Dateオブジェクトの場合はスプレッドシートのTZで読み取る
    var dateStr = '';
    if (dateValue instanceof Date) {
      dateStr = Utilities.formatDate(dateValue, ssTz, 'yyyy-MM-dd');
    } else if (dateValue) {
      dateStr = dateValue.toString().substring(0, 10);
    }
    if (targetDates.indexOf(dateStr) < 0) continue;
    if (data[i][16] === 'キャンセル') continue;

    // 時刻フォーマット: DateオブジェクトならHH:mm文字列に変換
    var startTime = data[i][6];
    var endTime = data[i][7];
    if (startTime instanceof Date) startTime = Utilities.formatDate(startTime, ssTz, 'HH:mm');
    else if (startTime) startTime = startTime.toString();
    if (endTime instanceof Date) endTime = Utilities.formatDate(endTime, ssTz, 'HH:mm');
    else if (endTime) endTime = endTime.toString();

    bookings.push({
      bookingId:    data[i][0],
      customerName: data[i][3],
      chatId:       data[i][4],
      date:         dateStr,
      startTime:    startTime || '',
      endTime:      endTime || '',
      planLetter:   data[i][9],
      vehicleType:  data[i][10],
      location:     data[i][12],
      vehicleInfo:  data[i][14],
      amount:       data[i][15],
      status:       data[i][16],
      paymentStatus: data[i][17],
      parkingPhoto: data[i][18],
      floor:        data[i][19],
      jobId:        data[i][23]
    });
  }
  // 開始時刻順
  bookings.sort(function(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.startTime || '') < (b.startTime || '') ? -1 : 1;
  });

  return jsonResponse({ status: 'ok', bookings: bookings, today: todayStr, tomorrow: tomorrowStr });
}

// POST action=booking_link_job { bookingId, jobId }
// 既存の予約に Job ID を紐付ける（job-managerの作業開始時に呼ぶ）
function handleBookingLinkJobFromApp(data) {
  if (!data.bookingId || !data.jobId) {
    return jsonResponse({ status: 'error', message: 'bookingId and jobId required' });
  }
  var ok = linkJobToBooking(data.bookingId, data.jobId);
  if (!ok) {
    return jsonResponse({ status: 'error', message: 'Booking not found: ' + data.bookingId });
  }
  // ステータスも「作業中」に変更
  updateBookingField(data.bookingId, 17, '作業中');
  return jsonResponse({ status: 'ok', bookingId: data.bookingId, jobId: data.jobId });
}

// POST action=booking_send_payment { bookingId }
// 手動で支払い依頼を再送信
function handleBookingSendPaymentFromApp(data) {
  if (!data.bookingId) {
    return jsonResponse({ status: 'error', message: 'bookingId required' });
  }
  var ok = sendPaymentRequest(data.bookingId);
  if (!ok) {
    return jsonResponse({ status: 'error', message: '送信に失敗しました（予約が見つからないか chatId 未登録）' });
  }
  return jsonResponse({ status: 'ok' });
}

// POST action=booking_message { chatId, customerName, bookingId?, message }
// ミニアプリ「お問い合わせ」タブから送信された顧客メッセージをAdminグループに転送
function handleBookingMessageFromApp(data) {
  if (!data.chatId || !data.message) {
    return jsonResponse({ status: 'error', message: 'chatId and message required' });
  }

  var customerName = data.customerName || '（名前未登録）';
  var bookingRef = data.bookingId ? ('\n📋 予約: ' + data.bookingId) : '';

  // メッセージを255文字以上はトリム（Telegramは4096文字まで対応だが念のため）
  var customerMsg = String(data.message).substring(0, 2000);

  var adminMsg = '💬 *Booking Bot 顧客メッセージ*\n'
               + '━━━━━━━━━━━━━━━\n'
               + '👤 ' + customerName + '\n'
               + '🆔 ChatID: `' + data.chatId + '`' + bookingRef + '\n'
               + '━━━━━━━━━━━━━━━\n'
               + customerMsg + '\n'
               + '━━━━━━━━━━━━━━━\n'
               + '↩️ 返信: `/reply ' + data.chatId + ' <メッセージ>`';

  try {
    sendTelegramTo(ADMIN_GROUP_ID, adminMsg);
  } catch (e) {
    Logger.log('handleBookingMessageFromApp admin notify error: ' + e.toString());
    return jsonResponse({ status: 'error', message: '管理者への転送に失敗しました' });
  }

  // 顧客に受信確認メッセージを送信（BookingBot経由）
  try {
    sendBookingBotMessage(data.chatId,
      '✅ *メッセージを受信しました*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '担当者からの返信をお待ちください。\n'
      + 'សូមរង់ចាំការឆ្លើយតបពីបុគ្គលិកយើងខ្ញុំ។'
    );
  } catch (e2) {
    Logger.log('handleBookingMessageFromApp confirm error: ' + e2.toString());
  }

  return jsonResponse({ status: 'ok' });
}

// Admin グループで `/reply <chatId> <message>` を受信したとき
// BookingBot経由で顧客に返信を送信
function handleAdminReplyCommand(adminChatId, text) {
  // /reply 123456 メッセージ本文
  var m = text.match(/^\/reply\s+(\S+)\s+([\s\S]+)$/);
  if (!m) {
    sendTelegramTo(adminChatId,
      '⚠️ フォーマットエラー\n\n'
      + '正しい使い方:\n'
      + '`/reply <chatId> <メッセージ>`\n\n'
      + '例:\n'
      + '`/reply 123456 明日10時にお伺いします`'
    );
    return;
  }

  var targetChatId = m[1];
  var replyBody = m[2];

  var replyMsg = '💬 *Samurai Motors より*\n'
               + '━━━━━━━━━━━━━━━\n'
               + replyBody;

  try {
    sendBookingBotMessage(targetChatId, replyMsg);
    sendTelegramTo(adminChatId,
      '✅ 返信を送信しました\n'
      + '👤 ChatID: `' + targetChatId + '`\n'
      + '━━━━━━━━━━━━━━━\n'
      + replyBody.substring(0, 300)
    );
  } catch (e) {
    Logger.log('handleAdminReplyCommand error: ' + e.toString());
    sendTelegramTo(adminChatId,
      '❌ 送信失敗: ' + e.toString() + '\n'
      + 'ChatID `' + targetChatId + '` が正しいか確認してください。'
    );
  }
}

// POST action=booking_set_status { bookingId, status, paymentStatus }
// Adminから予約ステータスを手動変更（仮予約→確定 等）
function handleBookingSetStatusFromApp(data) {
  if (!data.bookingId) {
    return jsonResponse({ status: 'error', message: 'bookingId required' });
  }
  var booking = getBookingById(data.bookingId);
  if (!booking) {
    return jsonResponse({ status: 'error', message: 'Booking not found' });
  }
  if (data.status) updateBookingField(data.bookingId, 17, data.status);
  if (data.paymentStatus) updateBookingField(data.bookingId, 18, data.paymentStatus);

  // 「作業完了」に変更された場合は支払い依頼も自動送信
  if (data.status === '作業完了' && booking.status !== '作業完了') {
    try { sendPaymentRequest(data.bookingId); } catch (e) {}
  }
  return jsonResponse({ status: 'ok' });
}

// ─── セットアップ関数 (v6) ──────────────

function setupV6Sheets() {
  // Phase 1: コア機能のシートのみ作成
  getCustomersSheet();
  getVehiclesSheet();
  getBookingsSheet();
  Logger.log('v6 シート作成完了: Customers, Vehicles, Bookings');
}

// ═══════════════════════════════════════════
//  テスト関数
// ═══════════════════════════════════════════

function testFixHeaders() {
  fixHeaders();
}

// Phase 1: testDailySummary / testCreateTask / testReceiptOCR は削除（DISABLED_FEATURES.md）

function testTelegram() {
  sendTelegram('🧪 テスト通知\nSamurai Motors v6 Telegram連携テストです。');
}

// Adminグループにミニアプリメニューボタンを送信（ピン留め用）
function sendAdminMenu() {
  var botUsername = 'quickwash_kh_bot';
  var baseUrl = 'https://ec20921-debug.github.io/samurai-motors-app';

  // t.me/bot?startapp=xxx 形式でTelegram内ミニアプリとして開く
  function appLink(page) {
    return 'https://t.me/' + botUsername + '/app?startapp=' + encodeURIComponent(page);
  }

  // Phase 1: コア機能のミニアプリのみ表示
  var msg = '📱 *Admin メニュー*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '下のボタンからミニアプリを開けます。\n'
    + 'このメッセージをピン留めしておくと便利です。\n\n'
    + '🚗 [洗車登録](' + baseUrl + '/job-manager.html)\n'
    + '🏠 [ホーム](' + baseUrl + '/home.html)';

  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
  var payload = {
    chat_id: ADMIN_GROUP_ID,
    text: msg,
    parse_mode: 'Markdown'
  };

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  Logger.log('Adminメニュー送信結果: ' + response.getContentText());
}

// ═══════════════════════════════════════════
//  ChatLog: チャット履歴記録・取得
// ═══════════════════════════════════════════

// ChatLogシート取得（なければ作成）
function getChatLogSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CHATLOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CHATLOG_SHEET_NAME);
    var headers = ['ID', 'DateTime', 'ChatID', 'Direction', 'SenderName', 'Message', 'MediaURL', 'RelatedBookingId'];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#607D8B');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// チャットメッセージを記録
// direction: 'customer'（受信）or 'staff'（送信）
function logChatMessage(chatId, direction, message, senderName, mediaUrl, bookingId) {
  try {
    var sheet = getChatLogSheet();
    var now = new Date();
    var dateStr = Utilities.formatDate(now, BOOKING_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
    var id = 'CHAT-' + Utilities.formatDate(now, BOOKING_TIMEZONE, 'yyyyMMddHHmmss') + '-' + Math.floor(Math.random() * 1000);
    sheet.appendRow([
      id,
      dateStr,
      String(chatId),
      direction,
      senderName || '',
      message || '',
      mediaUrl || '',
      bookingId || ''
    ]);
    return id;
  } catch (e) {
    Logger.log('logChatMessage error: ' + e.toString());
    return null;
  }
}

// 顧客chatIdでチャット履歴を取得（API用）
function getChatHistory(chatId) {
  var sheet = getChatLogSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var messages = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][2]) === String(chatId)) {
      messages.push({
        id: data[i][0],
        dateTime: data[i][1],
        chatId: data[i][2],
        direction: data[i][3],
        senderName: data[i][4],
        message: data[i][5],
        mediaUrl: data[i][6],
        bookingId: data[i][7]
      });
    }
  }
  return messages;
}

// 全顧客のチャットサマリー（ダッシュボー���用：各顧客の最新メッセージ）
function getChatSummary() {
  var sheet = getChatLogSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var customerMap = {};

  for (var i = 0; i < data.length; i++) {
    var cId = String(data[i][2]);
    // 最新のメッセージで上書き（データは時系列順を仮定）
    if (!customerMap[cId]) {
      customerMap[cId] = {
        chatId: cId,
        lastMessage: data[i][5],
        lastDirection: data[i][3],
        lastSender: data[i][4],
        lastDateTime: data[i][1],
        messageCount: 1
      };
    } else {
      customerMap[cId].lastMessage = data[i][5];
      customerMap[cId].lastDirection = data[i][3];
      customerMap[cId].lastSender = data[i][4];
      customerMap[cId].lastDateTime = data[i][1];
      customerMap[cId].messageCount++;
    }
  }

  // 配列に変換して最新順にソート
  var result = Object.keys(customerMap).map(function(k) { return customerMap[k]; });
  result.sort(function(a, b) {
    return String(b.lastDateTime).localeCompare(String(a.lastDateTime));
  });
  return result;
}

// ─── Chat API ハンドラー（ミニアプリから呼び出し） ─────

// POST action=chat_history { chatId }
function handleChatHistoryFromApp(data) {
  if (!data.chatId) {
    return jsonResponse({ status: 'error', message: 'chatId required' });
  }
  var messages = getChatHistory(String(data.chatId));
  return jsonResponse({ status: 'ok', messages: messages });
}

// POST action=chat_summary
function handleChatSummaryFromApp(data) {
  var summary = getChatSummary();
  return jsonResponse({ status: 'ok', summary: summary });
}

// POST action=chat_send { chatId, message, senderName }
// ミニアプリからBooking Bot経由で顧客にメッセージ送信
function handleChatSendFromApp(data) {
  if (!data.chatId || !data.message) {
    return jsonResponse({ status: 'error', message: 'chatId and message required' });
  }

  var replyMsg = '💬 *Samurai Motors*\n'
    + '━━━━━━━━━━━━━━━\n'
    + data.message;

  try {
    sendBookingBotMessage(String(data.chatId), replyMsg);
    logChatMessage(data.chatId, 'staff', data.message, data.senderName || 'App');
    return jsonResponse({ status: 'ok', message: 'sent' });
  } catch (e) {
    Logger.log('handleChatSendFromApp error: ' + e.toString());
    return jsonResponse({ status: 'error', message: e.toString() });
  }
}
