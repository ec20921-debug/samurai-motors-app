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
    if (data.update_id) {
      // 重複排除：同じ update_id を2度処理しない（Telegramのリトライ対策）
      // GAS処理が遅い場合Telegramが60秒後にリトライするため、300秒キャッシュ
      var cache = CacheService.getScriptCache();
      var cacheKey = 'tg_upd_' + data.update_id;
      if (cache.get(cacheKey)) {
        Logger.log('Duplicate webhook blocked: update_id=' + data.update_id);
        return ContentService.createTextOutput('ok');
      }
      cache.put(cacheKey, '1', 300); // 5分間キャッシュ

      // どのBotから来たwebhookか? URLパラメータ ?bot=admin|field|booking で識別
      var botType = (e.parameter && e.parameter.bot) ? e.parameter.bot : 'admin';
      if (botType === 'booking') {
        return handleBookingBotWebhook(data);
      }
      // admin / field は既存処理に流す（botTypeを渡して将来の分岐に備える）
      return handleTelegramWebhook(data, botType);
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
      case 'task_create':
        return handleTaskCreateFromApp(data);
      case 'task_update':
        return handleTaskUpdateFromApp(data);
      case 'task_edit':
        return handleTaskEditFromApp(data);
      case 'expense_create':
        return handleExpenseCreateFromApp(data);
      case 'expense_edit':
        return handleExpenseEditFromApp(data);
      case 'daily_report':
        return handleDailyReportFromApp(data);
      case 'attendance':
        return handleAttendanceFromApp(data);
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
    return handleCallbackQuery(update.callback_query);
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
    handleConversationState(chatId, message, convState, senderName);
    return ContentService.createTextOutput('ok');
  }

  // --- Adminグループからのメッセージ ---
  if (chatId === ADMIN_GROUP_ID) {
    // /task コマンド: タスク作成対話開始
    if (message.text && message.text.indexOf('/task') === 0) {
      handleAdminTaskCommand(chatId, message);
      return ContentService.createTextOutput('ok');
    }

    // /tasklist コマンド: タスク一覧表示
    if (message.text && message.text.indexOf('/tasklist') === 0) {
      showAllTasks(chatId);
      return ContentService.createTextOutput('ok');
    }

    // /reply <chatId> <message> : Booking Botから顧客に返信
    // 例: /reply 123456 明日の10時にお伺いします
    if (message.text && message.text.indexOf('/reply') === 0) {
      handleAdminReplyCommand(chatId, message.text);
      return ContentService.createTextOutput('ok');
    }

    // テキストメッセージ転送
    if (message.text) {
      // /start等のコマンドは転送しない
      if (message.text.indexOf('/') === 0) {
        return ContentService.createTextOutput('ok');
      }
      // 全フィールドスタッフに転送
      FIELD_STAFF_IDS.forEach(function(staffId) {
        sendTelegramTo(staffId,
          '📩 *管理者メッセージ*\n'
          + '━━━━━━━━━━━━━━━\n'
          + '👤 ' + senderName + '\n'
          + '💬 ' + message.text
        );
      });
    }

    // スタンプ・写真・ドキュメント・音声は全スタッフに転送
    if (message.sticker || message.photo || message.document || message.voice) {
      FIELD_STAFF_IDS.forEach(function(staffId) {
        forwardMessage(staffId, chatId, message.message_id);
      });
    }
  }

  // --- 現場スタッフからのメッセージ ---
  if (STAFF_REGISTRY[chatId]) {
    var staffName = STAFF_REGISTRY[chatId].name;

    // /receipt コマンド: レシート経費登録モード開始
    if (message.text && message.text.indexOf('/receipt') === 0) {
      setConversationState(chatId, { type: 'receipt_pending', step: 'waiting_photo' });
      sendTelegramTo(chatId, '📸 *レシート経費登録*\n━━━━━━━━━━━━━━━\nレシートの写真を送ってください。\nOCRで読み取り、経費を自動登録します。');
      return ContentService.createTextOutput('ok');
    }

    // /tasks コマンド: 自分のタスク一覧表示
    if (message.text && message.text.indexOf('/tasks') === 0) {
      showMyTasks(chatId, staffName);
      return ContentService.createTextOutput('ok');
    }

    // テキストメッセージをAdminに転送
    if (message.text) {
      if (message.text.indexOf('/start') === 0) {
        return ContentService.createTextOutput('ok');
      }
      sendTelegramTo(ADMIN_GROUP_ID,
        '📩 *現場スタッフ*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '👤 ' + staffName + '\n'
        + '💬 ' + message.text
      );
    }

    // スタンプ・写真・ドキュメント・音声をAdminに転送
    if (message.sticker || message.photo || message.document || message.voice) {
      forwardMessage(ADMIN_GROUP_ID, chatId, message.message_id);
    }
  }

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

  // それ以外: ミニアプリへの誘導
  sendBookingBotWelcome(chatId, firstName);
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
    var dateStr = row[5] ? Utilities.formatDate(new Date(row[5]), BOOKING_TIMEZONE, 'yyyy-MM-dd') : '-';
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
  if (!message.photo || message.photo.length === 0) {
    // テキストメッセージが来た場合は無視（写真を待っている状態）
    sendBookingBotMessage(chatId, '📸 Please send a photo.\n📸 សូមផ្ញើរូបថត។');
    return;
  }

  // 重複処理防止: すでに写真を保存済みならスキップ
  if (state.photoSaved) {
    Logger.log('handleParkingPhotoFlow: photo already saved for ' + state.bookingId);
    return;
  }

  try {
    var largestPhoto = message.photo[message.photo.length - 1];
    var fileInfo = getBookingBotFile(largestPhoto.file_id);
    if (!fileInfo || !fileInfo.result || !fileInfo.result.file_path) {
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
    '✅ *Parking info received!*\n'
    + '✅ *ព័ត៌មានចតឡានបានទទួល!*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + state.bookingId + '\n'
    + '🏢 Floor: ' + floor + '\n\n'
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
    var dateStr = bookingDate ? Utilities.formatDate(new Date(bookingDate), BOOKING_TIMEZONE, 'yyyy-MM-dd') : '';
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

// ─── トリガー設定 ────────────────────────────

function setupV6Triggers() {
  // 既存トリガーは触らない
  // 1時間ごとに未払いチェック
  ScriptApp.newTrigger('checkUnpaidBookings')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('v6トリガー: checkUnpaidBookings (1時間毎) を作成しました。');
}

function removeV6Triggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'checkUnpaidBookings') {
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

  switch (state.type) {
    case 'task_create':
      handleTaskCreateFlow(chatId, message, state);
      break;
    case 'receipt_pending':
      handleReceiptFlow(chatId, message, state, senderName);
      break;
    case 'pending_reason':
      handlePendingReasonFlow(chatId, message, state);
      break;
    default:
      clearConversationState(chatId);
      break;
  }
}

// ═══════════════════════════════════════════
//  タスク管理
// ═══════════════════════════════════════════

// Tasksシート取得（なければ作成）
function getTasksSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TASKS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(TASKS_SHEET_NAME);
    var headers = [
      'Task ID', '作成日時', '担当者', '担当者ChatID', '期限',
      'やるべきこと', 'ステータス', '完了日時', '未完了理由',
      '繰返しルール', '親タスクID', '関連経費ID'
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#2196F3');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);  // Task ID
    sheet.setColumnWidth(6, 300);  // やるべきこと
  }

  return sheet;
}

// タスク作成
function createTask(assignee, assigneeChatId, deadline, description, recurrence, expenseId) {
  var sheet = getTasksSheet();
  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');

  // Task ID生成
  var lastRow = sheet.getLastRow();
  var count = 1;
  if (lastRow >= 2) {
    // 同日のタスク数をカウント
    var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    data.forEach(function(row) {
      if (row[0] && row[0].toString().indexOf('TASK-' + dateStr) === 0) {
        count++;
      }
    });
  }
  var taskId = 'TASK-' + dateStr + '-' + String(count).padStart(3, '0');

  sheet.appendRow([
    taskId,
    formatCambodiaTime(now),
    assignee || '',
    assigneeChatId || '',
    deadline || '',
    description || '',
    '未着手',
    '',  // 完了日時
    '',  // 未完了理由
    recurrence || '',
    '',  // 親タスクID
    expenseId || ''
  ]);

  return taskId;
}

// タスクステータス絵文字判定
function getTaskStatusEmoji(deadline, status) {
  if (status === '完了') return '🟢';

  var now = new Date();
  var today = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyy-MM-dd');

  if (!deadline) return '🟡';

  // 期限との差を計算
  var deadlineDate = new Date(deadline + 'T23:59:59+07:00');
  var diffDays = Math.floor((deadlineDate - now) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return '🔴';  // 期限超過
  if (diffDays <= 2) return '🟡';  // 期限近い
  return '🟢';  // 余裕あり
}

// --- タスク作成対話フロー ---

// /task コマンド処理（Admin用）
function handleAdminTaskCommand(chatId, message) {
  // 対話フロー開始
  setConversationState(chatId, {
    type: 'task_create',
    step: 'assignee',
    data: {}
  });

  // スタッフ一覧を表示
  var staffList = Object.keys(STAFF_REGISTRY).map(function(id) {
    return '• ' + STAFF_REGISTRY[id].name;
  }).join('\n');

  sendTelegramTo(chatId,
    '📝 *タスク作成*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '担当者を入力してください。\n\n'
    + '登録スタッフ:\n' + staffList + '\n• 飯泉\n\n'
    + '（/cancel でキャンセル）'
  );
}

// タスク作成の対話ステップ処理
function handleTaskCreateFlow(chatId, message, state) {
  var text = (message.text || '').trim();
  if (!text) {
    sendTelegramTo(chatId, 'テキストで入力してください。');
    return;
  }

  var data = state.data || {};

  switch (state.step) {
    case 'assignee':
      data.assignee = text;
      // Chat IDを検索
      data.assigneeChatId = '';
      Object.keys(STAFF_REGISTRY).forEach(function(id) {
        if (STAFF_REGISTRY[id].name === text) {
          data.assigneeChatId = id;
        }
      });
      // 飯泉さんの場合はAdminグループに通知
      if (text === '飯泉') {
        data.assigneeChatId = ADMIN_GROUP_ID;
      }

      setConversationState(chatId, { type: 'task_create', step: 'deadline', data: data });
      sendTelegramTo(chatId, '📅 期限を入力してください。\n例: 2026-04-15\n（期限なしの場合は「なし」）');
      break;

    case 'deadline':
      if (text === 'なし' || text === '無し') {
        data.deadline = '';
      } else {
        data.deadline = text;
      }
      setConversationState(chatId, { type: 'task_create', step: 'description', data: data });
      sendTelegramTo(chatId, '📋 やるべきことを入力してください。');
      break;

    case 'description':
      data.description = text;
      // タスク作成実行
      var taskId = createTask(
        data.assignee,
        data.assigneeChatId,
        data.deadline,
        data.description,
        '',  // 繰返しルール
        ''   // 関連経費ID
      );

      clearConversationState(chatId);

      var emoji = getTaskStatusEmoji(data.deadline, '未着手');
      var msg = '✅ *タスク作成完了*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '🆔 ' + taskId + '\n'
        + '👤 担当: ' + data.assignee + '\n'
        + '📅 期限: ' + (data.deadline || 'なし') + '\n'
        + emoji + ' ' + data.description;

      sendTelegramTo(chatId, msg);

      // 担当者にも通知（スタッフの場合：クメール語翻訳付き）
      if (data.assigneeChatId && data.assigneeChatId !== ADMIN_GROUP_ID && data.assigneeChatId !== chatId) {
        var descKh = translateToKhmer(data.description);
        sendTelegramTo(data.assigneeChatId,
          '📌 *ការងារថ្មីត្រូវបានបន្ថែម*\n'
          + '━━━━━━━━━━━━━━━\n'
          + '📅 ថ្ងៃកំណត់: ' + (data.deadline || 'គ្មាន') + '\n'
          + '📋 ' + descKh + '\n'
          + '🇯🇵 ' + data.description
        );
      }
      break;
  }
}

// タスク一覧表示（Admin用 - 全タスク）
function showAllTasks(chatId) {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    sendTelegramTo(chatId, '📋 タスクはまだありません。');
    return;
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  var activeTasks = data.filter(function(row) {
    return row[6] !== '完了';  // ステータスが完了でないもの
  });

  if (activeTasks.length === 0) {
    sendTelegramTo(chatId, '✅ 未完了のタスクはありません。');
    return;
  }

  var msg = '📋 *タスク一覧（未完了）*\n━━━━━━━━━━━━━━━\n\n';
  activeTasks.forEach(function(row, idx) {
    var emoji = getTaskStatusEmoji(row[4], row[6]);
    msg += (idx + 1) + '. ' + emoji + ' ' + row[5] + '\n'
      + '   👤 ' + row[2] + ' | 📅 ' + (row[4] || 'なし') + '\n\n';
  });

  sendTelegramTo(chatId, msg);
}

// タスク一覧表示（スタッフ用 - 自分のタスクのみ、インラインキーボード付き）
function showMyTasks(chatId, staffName) {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    sendTelegramTo(chatId, '📋 タスクはありません。');
    return;
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  var myTasks = data.filter(function(row) {
    return row[2] === staffName && row[6] !== '完了';
  });

  if (myTasks.length === 0) {
    sendTelegramTo(chatId, '✅ គ្មានការងារមិនទាន់រួច។ អរគុណ!\n（未完了のタスクはありません。お疲れ様です！）');
    return;
  }

  var msg = '📋 *ការងាររបស់អ្នក*\n（あなたのタスク）\n━━━━━━━━━━━━━━━\n\n';
  var keyboard = [];

  myTasks.forEach(function(row, idx) {
    var emoji = getTaskStatusEmoji(row[4], row[6]);
    var descJp = row[5];
    var descKh = translateToKhmer(descJp);
    msg += (idx + 1) + '. ' + emoji + ' ' + descKh + '\n'
      + '   🇯🇵 ' + descJp + '\n'
      + '   📅 ថ្ងៃកំណត់: ' + (row[4] || 'គ្មាន') + '\n\n';

    keyboard.push([
      { text: '✅ ' + descKh.substring(0, 15), callback_data: 'task_done:' + row[0] },
      { text: '❌ មិនទាន់រួច', callback_data: 'task_notdone:' + row[0] }
    ]);
  });

  sendTelegramWithKeyboard(chatId, msg, { inline_keyboard: keyboard });
}

// 繰返しタスクの自動生成（毎日UTC 0:00に実行）
function generateRecurringTasks() {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  var today = new Date();
  var dayOfMonth = today.getDate();
  var currentMonth = Utilities.formatDate(today, 'Asia/Phnom_Penh', 'yyyy-MM');

  data.forEach(function(row) {
    var recurrence = row[9]; // 繰返しルール
    if (!recurrence) return;

    // monthly:DD パターン
    var monthlyMatch = recurrence.match(/^monthly:(\d+)$/);
    if (monthlyMatch) {
      var targetDay = parseInt(monthlyMatch[1], 10);
      if (dayOfMonth !== targetDay) return;

      // 今月既に生成済みか確認
      var parentId = row[0]; // 親タスクID
      var alreadyExists = data.some(function(r) {
        return r[10] === parentId && r[1].toString().indexOf(currentMonth) === 0;
      });

      if (!alreadyExists) {
        var taskId = createTask(
          row[2],  // 担当者
          row[3],  // ChatID
          Utilities.formatDate(today, 'Asia/Phnom_Penh', 'yyyy-MM-dd'), // 期限=当日
          row[5],  // やるべきこと
          '',      // 繰返しなし（インスタンス）
          ''
        );

        // 親タスクIDを設定
        var newLastRow = sheet.getLastRow();
        sheet.getRange(newLastRow, 11).setValue(parentId);

        Logger.log('繰返しタスク生成: ' + taskId + ' (親: ' + parentId + ')');
      }
    }
  });
}

// 初期繰返しタスク登録
function seedRecurringTasks() {
  // ABA給与支払い（毎月10日）
  createTask(
    '飯泉',
    ADMIN_GROUP_ID,
    '',  // 期限は生成時に設定
    'ABA給与支払い',
    'monthly:10',
    ''
  );
  Logger.log('繰返しタスクテンプレートを登録しました。');
}

// ═══════════════════════════════════════════
//  Telegram Callback Query（インラインボタン）
// ═══════════════════════════════════════════

function handleCallbackQuery(callbackQuery) {
  var callbackId = callbackQuery.id;
  var data = callbackQuery.data;
  var chatId = String(callbackQuery.message.chat.id);
  var messageId = callbackQuery.message.message_id;

  // task_done:TASK-XXXXXXX
  if (data.indexOf('task_done:') === 0) {
    var taskId = data.replace('task_done:', '');
    updateTaskStatus(taskId, '完了');

    answerCallbackQuery(callbackId, '✅ タスク完了！');

    // メッセージを更新（ボタンを削除して完了表示）
    editMessageText(chatId, messageId,
      '✅ *タスク完了*: ' + taskId + '\n完了時刻: ' + formatCambodiaTime(new Date())
    );

    // Adminグループにも通知
    sendTelegramTo(ADMIN_GROUP_ID,
      '✅ *タスク完了通知*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🆔 ' + taskId + '\n'
      + '⏰ ' + formatCambodiaTime(new Date())
    );

    return ContentService.createTextOutput('ok');
  }

  // task_notdone:TASK-XXXXXXX
  if (data.indexOf('task_notdone:') === 0) {
    var taskId = data.replace('task_notdone:', '');

    answerCallbackQuery(callbackId, '理由を入力してください');

    // 理由入力待ちの会話状態を設定
    setConversationState(chatId, {
      type: 'pending_reason',
      taskId: taskId
    });

    sendTelegramTo(chatId,
      '❌ *タスク未完了*: ' + taskId + '\n\n'
      + 'なぜ完了できなかったか、理由を入力してください。\n'
      + '（例: 部品が届いていない、時間が足りなかった 等）'
    );

    return ContentService.createTextOutput('ok');
  }

  // expense_confirm:EXP-XXXXXXX
  if (data.indexOf('expense_confirm:') === 0) {
    var expenseId = data.replace('expense_confirm:', '');
    answerCallbackQuery(callbackId, '✅ 経費確認済み');
    editMessageText(chatId, messageId, '✅ 経費 ' + expenseId + ' を確認しました。');
    return ContentService.createTextOutput('ok');
  }

  answerCallbackQuery(callbackId, '');
  return ContentService.createTextOutput('ok');
}

// タスクステータス更新
function updateTaskStatus(taskId, newStatus, reason) {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();

  for (var r = 2; r <= lastRow; r++) {
    if (sheet.getRange(r, 1).getValue() === taskId) {
      sheet.getRange(r, 7).setValue(newStatus);  // ステータス
      if (newStatus === '完了') {
        sheet.getRange(r, 8).setValue(formatCambodiaTime(new Date()));  // 完了日時
      }
      if (reason) {
        sheet.getRange(r, 9).setValue(reason);  // 未完了理由
      }
      return true;
    }
  }
  return false;
}

// 未完了理由入力処理
function handlePendingReasonFlow(chatId, message, state) {
  var reason = (message.text || '').trim();
  if (!reason) {
    sendTelegramTo(chatId, 'テキストで理由を入力してください。');
    return;
  }

  var taskId = state.taskId;
  updateTaskStatus(taskId, '未完了', reason);
  clearConversationState(chatId);

  sendTelegramTo(chatId,
    '📝 未完了理由を記録しました。\n'
    + '🆔 ' + taskId + '\n'
    + '💬 ' + reason
  );

  // Adminグループにも通知
  sendTelegramTo(ADMIN_GROUP_ID,
    '⚠️ *タスク未完了報告*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + taskId + '\n'
    + '💬 理由: ' + reason
  );
}

// 旧: sendMorningTaskNotification()
// v5.1以降は sendDailySummary() → sendStaffMorningTasks() に統合されたため削除。
// トリガーは sendDailySummary だけで Admin通知とスタッフ通知の両方が送信される。

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

function getExpensesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EXPENSES_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(EXPENSES_SHEET_NAME);
    var headers = [
      'Expense ID', '登録日時', '取引日', '品目・摘要', '金額',
      '通貨', '取引先', '勘定科目', '登録者', 'レシート写真',
      'OCR原文', 'ステータス', '関連タスクID'
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#4CAF50');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);   // Expense ID
    sheet.setColumnWidth(4, 250);   // 品目・摘要
    sheet.setColumnWidth(10, 200);  // レシート写真
    sheet.setColumnWidth(11, 300);  // OCR原文
  }

  return sheet;
}

// レシート処理フロー
function handleReceiptFlow(chatId, message, state, senderName) {
  if (state.step === 'waiting_photo') {
    // 写真が送信されたか確認
    if (!message.photo || message.photo.length === 0) {
      sendTelegramTo(chatId, '📸 写真を送ってください。テキストではなくレシートの写真が必要です。');
      return;
    }

    // 処理中メッセージ
    sendTelegramTo(chatId, '⏳ レシートを処理中...');

    try {
      // Telegramから写真をダウンロード
      var photoArray = message.photo;
      var largestPhoto = photoArray[photoArray.length - 1]; // 最大解像度
      var fileId = largestPhoto.file_id;

      // getFile APIでファイルパス取得
      var fileInfo = getTelegramFile(fileId);
      if (!fileInfo || !fileInfo.result || !fileInfo.result.file_path) {
        sendTelegramTo(chatId, '❌ 写真の取得に失敗しました。もう一度送ってください。');
        clearConversationState(chatId);
        return;
      }

      // 写真をダウンロード
      var fileUrl = 'https://api.telegram.org/file/bot' + TELEGRAM_BOT_TOKEN + '/' + fileInfo.result.file_path;
      var imageBlob = UrlFetchApp.fetch(fileUrl).getBlob();

      // Google Driveに保存
      var receiptFolder = getOrCreateFolder(RECEIPT_FOLDER_NAME);
      var now = new Date();
      var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd_HHmmss');
      var staffName = STAFF_REGISTRY[chatId] ? STAFF_REGISTRY[chatId].name : senderName;
      var fileName = 'receipt_' + dateStr + '_' + staffName + '.jpg';

      imageBlob.setName(fileName);
      var savedFile = receiptFolder.createFile(imageBlob);
      savedFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      var photoUrl = savedFile.getUrl();

      // OCR実行
      var ocrText = performOCR(imageBlob);
      var parsed = parseReceiptText(ocrText);

      // 経費レコード作成
      var expenseId = createExpenseRecord({
        date: parsed.date || Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyy-MM-dd'),
        description: parsed.description || '',
        amount: parsed.amount || 0,
        currency: parsed.currency || 'USD',
        vendor: parsed.vendor || '',
        category: parsed.category || '消耗品費',
        registeredBy: staffName,
        photoUrl: photoUrl,
        ocrText: ocrText
      });

      clearConversationState(chatId);

      // 確認メッセージ
      var confirmMsg = '✅ *経費登録完了*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '🆔 ' + expenseId + '\n'
        + '📅 取引日: ' + (parsed.date || '不明') + '\n'
        + '🏪 取引先: ' + (parsed.vendor || '不明') + '\n'
        + '📝 品目: ' + (parsed.description || '不明') + '\n'
        + '💰 金額: ' + (parsed.amount || '不明') + ' ' + (parsed.currency || 'USD') + '\n'
        + '📂 勘定科目: ' + (parsed.category || '消耗品費') + '\n'
        + '📷 [レシート写真](' + photoUrl + ')\n\n'
        + '※ 内容に間違いがあれば管理者にお知らせください。';

      sendTelegramTo(chatId, confirmMsg);

      // Adminグループにも通知
      sendTelegramTo(ADMIN_GROUP_ID,
        '💰 *新規経費登録*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '🆔 ' + expenseId + '\n'
        + '👤 登録者: ' + staffName + '\n'
        + '📅 ' + (parsed.date || '不明') + '\n'
        + '🏪 ' + (parsed.vendor || '不明') + '\n'
        + '💰 ' + (parsed.amount || '?') + ' ' + (parsed.currency || 'USD') + '\n'
        + '📷 [レシート](' + photoUrl + ')'
      );

    } catch (err) {
      Logger.log('handleReceiptFlow error: ' + err.toString());
      clearConversationState(chatId);
      sendTelegramTo(chatId, '❌ レシート処理中にエラーが発生しました: ' + err.toString());
    }
  }
}

// Telegram getFile API
function getTelegramFile(fileId) {
  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/getFile?file_id=' + fileId;
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    return JSON.parse(response.getContentText());
  } catch (err) {
    Logger.log('getTelegramFile error: ' + err.toString());
    return null;
  }
}

// OCR実行（Google Drive API v3）
function performOCR(imageBlob) {
  try {
    // Drive API v3: 画像をGoogle Docs形式で作成するとOCRが自動実行される
    var resource = {
      name: 'ocr_temp_' + Date.now(),
      mimeType: 'application/vnd.google-apps.document'
    };

    // v3では Drive.Files.create() を使用
    var file = Drive.Files.create(resource, imageBlob, {
      ocrLanguage: 'en'
    });

    // テキスト抽出
    var doc = DocumentApp.openById(file.id);
    var text = doc.getBody().getText();

    // 一時ファイル削除
    DriveApp.getFileById(file.id).setTrashed(true);

    return text || '';
  } catch (err) {
    Logger.log('performOCR error: ' + err.toString());
    return '';
  }
}

// OCRテキストからレシート情報をパース
function parseReceiptText(ocrText) {
  var result = {
    date: '',
    description: '',
    amount: 0,
    currency: 'USD',
    vendor: '',
    category: '消耗品費'
  };

  if (!ocrText) return result;

  // 日付パターン検索
  var datePatterns = [
    /(\d{4}[-\/]\d{2}[-\/]\d{2})/,           // 2026-04-07 or 2026/04/07
    /(\d{2}[-\/]\d{2}[-\/]\d{4})/,           // 07-04-2026 or 07/04/2026
    /(\d{2}[-\/]\d{2}[-\/]\d{2})\s/          // 07/04/26
  ];

  for (var i = 0; i < datePatterns.length; i++) {
    var dateMatch = ocrText.match(datePatterns[i]);
    if (dateMatch) {
      result.date = dateMatch[1];
      break;
    }
  }

  // 金額パターン検索
  var amountPatterns = [
    /(?:TOTAL|Total|total|AMOUNT|Amount)[:\s]*\$?\s*([\d,]+\.?\d*)/i,
    /\$\s*([\d,]+\.?\d*)/,
    /USD\s*([\d,]+\.?\d*)/i,
    /KHR\s*([\d,]+\.?\d*)/i,
    /([\d,]+\.?\d*)\s*(?:USD|usd)/
  ];

  for (var i = 0; i < amountPatterns.length; i++) {
    var amountMatch = ocrText.match(amountPatterns[i]);
    if (amountMatch) {
      result.amount = parseFloat(amountMatch[1].replace(/,/g, ''));
      // 通貨判定
      if (amountPatterns[i].toString().indexOf('KHR') >= 0) {
        result.currency = 'KHR';
      }
      break;
    }
  }

  // 取引先（最初の行を取得）
  var lines = ocrText.split('\n').filter(function(l) { return l.trim().length > 0; });
  if (lines.length > 0) {
    result.vendor = lines[0].trim().substring(0, 50);
  }

  // 品目・摘要（2行目以降のキーワード）
  if (lines.length > 1) {
    // 商品名らしい行を探す
    var descLines = lines.slice(1, 4).join(' ').substring(0, 100);
    result.description = descLines;
  }

  // 勘定科目の自動判定
  var lowerText = ocrText.toLowerCase();
  if (lowerText.indexOf('electric') >= 0 || lowerText.indexOf('ភ្លើង') >= 0 || lowerText.indexOf('power') >= 0) {
    result.category = '水道光熱費';
  } else if (lowerText.indexOf('water') >= 0 || lowerText.indexOf('ទឹក') >= 0) {
    result.category = '水道光熱費';
  } else if (lowerText.indexOf('phone') >= 0 || lowerText.indexOf('internet') >= 0 || lowerText.indexOf('wifi') >= 0) {
    result.category = '通信費';
  } else if (lowerText.indexOf('fuel') >= 0 || lowerText.indexOf('gas') >= 0 || lowerText.indexOf('petrol') >= 0) {
    result.category = '旅費交通費';
  } else if (lowerText.indexOf('food') >= 0 || lowerText.indexOf('restaurant') >= 0 || lowerText.indexOf('meal') >= 0) {
    result.category = '会議費';
  }

  return result;
}

// 経費レコード作成
function createExpenseRecord(data) {
  var sheet = getExpensesSheet();
  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');

  // Expense ID生成
  var lastRow = sheet.getLastRow();
  var count = 1;
  if (lastRow >= 2) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    ids.forEach(function(row) {
      if (row[0] && row[0].toString().indexOf('EXP-' + dateStr) === 0) {
        count++;
      }
    });
  }
  var expenseId = 'EXP-' + dateStr + '-' + String(count).padStart(3, '0');

  // 精算ステータス（デフォルトは未精算。data.settlementStatusで上書き可能）
  var settlementStatus = data.settlementStatus || '未精算';

  // 写真URL配列（後方互換: photoUrl単一指定もサポート）
  var photoUrls = [];
  if (data.photoUrls && data.photoUrls.length > 0) {
    photoUrls = data.photoUrls;
  } else if (data.photoUrl) {
    photoUrls = [data.photoUrl];
  }

  sheet.appendRow([
    expenseId,
    formatCambodiaTime(now),
    data.date || '',
    data.description || '',
    data.amount || 0,
    data.currency || 'USD',
    data.vendor || '',
    data.category || '消耗品費',
    data.registeredBy || '',
    '',  // レシート写真（後で書き込み）
    data.ocrText || '',
    settlementStatus,
    ''  // 関連タスクID（自動生成廃止）
  ]);

  // 写真セルへの書き込み
  if (photoUrls.length > 0) {
    var newRow = sheet.getLastRow();
    setExpensePhotoUrls(sheet, newRow, photoUrls);
  }

  return expenseId;
}

// 経費写真URLをセルに書き込み（複数枚対応）
// 1枚: HYPERLINK式で「📷 レシート」表示
// 2枚以上: HYPERLINK式で1枚目「📷 レシート (N枚)」+ メモに全URL改行
function setExpensePhotoUrls(sheet, row, urls) {
  if (!urls || urls.length === 0) {
    sheet.getRange(row, 10).setValue('');
    sheet.getRange(row, 10).clearNote();
    return;
  }
  if (urls.length === 1) {
    sheet.getRange(row, 10).setFormula(
      '=HYPERLINK("' + urls[0] + '","📷 レシート")'
    );
    sheet.getRange(row, 10).clearNote();
  } else {
    sheet.getRange(row, 10).setFormula(
      '=HYPERLINK("' + urls[0] + '","📷 レシート (' + urls.length + '枚)")'
    );
    // 全URLをセルメモに保存（複数URL保持の正本）
    sheet.getRange(row, 10).setNote(urls.join('\n'));
  }
}

// 経費写真URLをセルから読み取り（複数枚対応・後方互換）
function getExpensePhotoUrls(sheet, row) {
  var cell = sheet.getRange(row, 10);
  var note = cell.getNote();
  if (note) {
    return note.split('\n').map(function(s){ return s.trim(); }).filter(function(s){ return s; });
  }
  // メモが無ければ式から1枚目URLを抽出
  var formula = cell.getFormula();
  if (formula && formula.toUpperCase().indexOf('HYPERLINK') >= 0) {
    var m = formula.match(/HYPERLINK\("([^"]+)"/);
    if (m) return [m[1]];
  }
  // 旧データでURLが直接入っている場合
  var value = cell.getValue();
  if (value && value.toString().indexOf('http') === 0) {
    return [value.toString()];
  }
  return [];
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

  if (action === 'inventory') {
    return handleInventoryGet();
  }

  if (action === 'tasks') {
    return handleTasksGet();
  }

  if (action === 'expenses') {
    return handleExpensesGet();
  }

  if (action === 'daily_reports') {
    return handleDailyReportsGet(e);
  }

  if (action === 'attendance') {
    return handleAttendanceGet(e);
  }

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

  return ContentService
    .createTextOutput('Samurai Motors v6 is active.')
    .setMimeType(ContentService.MimeType.TEXT);
}

// タスク一覧API（ミニアプリ用）
function handleTasksGet() {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse({ status: 'ok', tasks: [] });
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  var tasks = data.map(function(row) {
    return {
      id: row[0],
      created: row[1],
      assignee: row[2],
      assigneeChatId: row[3],
      deadline: row[4] ? row[4].toString().substring(0, 10) : '',
      description: row[5],
      status: row[6],
      completedAt: row[7],
      reason: row[8],
      recurrence: row[9],
      parentId: row[10],
      expenseId: row[11]
    };
  });

  return jsonResponse({ status: 'ok', tasks: tasks });
}

// ミニアプリからのタスク作成
function handleTaskCreateFromApp(data) {
  var taskId = createTask(
    data.assignee || '',
    data.assigneeChatId || '',
    data.deadline || '',
    data.description || '',
    data.recurrence || '',
    ''
  );

  // 担当者に通知（クメール語+日本語）
  if (data.assigneeChatId && data.assigneeChatId !== ADMIN_GROUP_ID) {
    var descKh = translateToKhmer(data.description || '');
    sendTelegramTo(data.assigneeChatId,
      '📌 *ការងារថ្មីត្រូវបានបន្ថែម*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '📅 ថ្ងៃកំណត់: ' + (data.deadline || 'គ្មាន') + '\n'
      + '📋 ' + descKh + '\n'
      + '🇯🇵 ' + (data.description || '')
    );
  }

  // Adminグループにも通知
  var emoji = getTaskStatusEmoji(data.deadline || '', '未着手');
  sendTelegramTo(ADMIN_GROUP_ID,
    '📝 *タスク作成（ミニアプリ）*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + taskId + '\n'
    + '👤 担当: ' + (data.assignee || '') + '\n'
    + '📅 期限: ' + (data.deadline || 'なし') + '\n'
    + emoji + ' ' + (data.description || '')
  );

  return jsonResponse({ status: 'ok', taskId: taskId });
}

// ミニアプリからのタスク更新
function handleTaskUpdateFromApp(data) {
  var taskId = data.taskId;
  var newStatus = data.status;
  var reason = data.reason || '';

  var success = updateTaskStatus(taskId, newStatus, reason);

  if (!success) {
    return jsonResponse({ status: 'error', message: 'Task not found: ' + taskId });
  }

  // Adminグループに通知
  if (newStatus === '完了') {
    sendTelegramTo(ADMIN_GROUP_ID,
      '✅ *タスク完了通知*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🆔 ' + taskId + '\n'
      + '⏰ ' + formatCambodiaTime(new Date())
    );
  } else if (newStatus === '未完了' && reason) {
    sendTelegramTo(ADMIN_GROUP_ID,
      '⚠️ *タスク未完了報告*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🆔 ' + taskId + '\n'
      + '💬 理由: ' + reason
    );
  }

  return jsonResponse({ status: 'ok', taskId: taskId, newStatus: newStatus });
}

// ミニアプリからのタスク編集
function handleTaskEditFromApp(data) {
  var taskId = data.taskId;
  if (!taskId) {
    return jsonResponse({ status: 'error', message: 'taskId is required' });
  }

  var updates = {};
  if (data.assignee !== undefined) updates.assignee = data.assignee;
  if (data.assigneeChatId !== undefined) updates.assigneeChatId = data.assigneeChatId;
  if (data.deadline !== undefined) updates.deadline = data.deadline;
  if (data.description !== undefined) updates.description = data.description;

  var success = editTaskDetails(taskId, updates);
  if (!success) {
    return jsonResponse({ status: 'error', message: 'Task not found: ' + taskId });
  }

  // Adminグループに編集通知
  var parts = ['✏️ *タスク編集*\n━━━━━━━━━━━━━━━\n🆔 ' + taskId];
  if (updates.assignee) parts.push('👤 担当: ' + updates.assignee);
  if (updates.deadline !== undefined) parts.push('📅 期限: ' + (updates.deadline || 'なし'));
  if (updates.description) parts.push('📋 ' + updates.description);
  sendTelegramTo(ADMIN_GROUP_ID, parts.join('\n'));

  // 担当者が変わった場合や内容が変わった場合、担当者にも通知
  var chatId = data.assigneeChatId || '';
  if (chatId && chatId !== ADMIN_GROUP_ID) {
    var descKh = translateToKhmer(updates.description || data.currentDescription || '');
    sendTelegramTo(chatId,
      '✏️ *ការងារត្រូវបានកែប្រែ*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '📅 ថ្ងៃកំណត់: ' + (updates.deadline !== undefined ? (updates.deadline || 'គ្មាន') : '') + '\n'
      + '📋 ' + descKh + '\n'
      + '🇯🇵 ' + (updates.description || data.currentDescription || '')
    );
  }

  return jsonResponse({ status: 'ok', taskId: taskId });
}

// タスク詳細を更新する汎用関数
function editTaskDetails(taskId, updates) {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();

  for (var r = 2; r <= lastRow; r++) {
    if (sheet.getRange(r, 1).getValue() === taskId) {
      // C列=担当者, D列=担当者ChatID, E列=期限, F列=やるべきこと
      if (updates.assignee !== undefined) sheet.getRange(r, 3).setValue(updates.assignee);
      if (updates.assigneeChatId !== undefined) sheet.getRange(r, 4).setValue(updates.assigneeChatId);
      if (updates.deadline !== undefined) sheet.getRange(r, 5).setValue(updates.deadline);
      if (updates.description !== undefined) sheet.getRange(r, 6).setValue(updates.description);
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════
//  勤怠管理
// ═══════════════════════════════════════════

// Attendanceシート取得（なければ作成）
function getAttendanceSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ATTENDANCE_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(ATTENDANCE_SHEET_NAME);
    var headers = [
      'Record ID', '日付', 'スタッフ名', 'ChatID',
      '出勤時刻', '退勤時刻', '勤務時間（分）', 'メモ'
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#00695C');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(5, 140);
    sheet.setColumnWidth(6, 140);
  }

  return sheet;
}

// ミニアプリからの勤怠打刻
function handleAttendanceFromApp(data) {
  var sheet = getAttendanceSheet();
  var now = new Date();
  var todayStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyy-MM-dd');
  var timeStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'HH:mm:ss');
  var staff = data.staff || '';
  var chatId = data.chatId || '';
  var type = data.type || ''; // 'clock_in' or 'clock_out'
  var memo = data.memo || '';

  if (!staff || !type) {
    return jsonResponse({ status: 'error', message: 'staff and type are required' });
  }

  var lastRow = sheet.getLastRow();

  if (type === 'clock_in') {
    // 既に今日出勤済みか確認
    var existing = findTodayAttendance(sheet, todayStr, staff, lastRow);
    if (existing > 0) {
      return jsonResponse({ status: 'error', message: '本日すでに出勤打刻済みです' });
    }

    var recordId = 'ATT-' + Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd-HHmmss');
    sheet.appendRow([recordId, todayStr, staff, chatId, timeStr, '', '', memo]);

    // Admin通知
    sendTelegramTo(ADMIN_GROUP_ID,
      '🟢 *出勤打刻*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '👤 ' + staff + '\n'
      + '⏰ ' + timeStr + '\n'
      + '📅 ' + todayStr
    );

    return jsonResponse({ status: 'ok', type: 'clock_in', time: timeStr, recordId: recordId });

  } else if (type === 'clock_out') {
    // 今日の出勤レコードを探す
    var row = findTodayAttendance(sheet, todayStr, staff, lastRow);
    if (row <= 0) {
      return jsonResponse({ status: 'error', message: '本日の出勤記録がありません' });
    }

    // 既に退勤済みか確認
    var existingOut = sheet.getRange(row, 6).getValue();
    if (existingOut) {
      return jsonResponse({ status: 'error', message: '本日すでに退勤打刻済みです' });
    }

    sheet.getRange(row, 6).setValue(timeStr);
    if (memo) sheet.getRange(row, 8).setValue(memo);

    // 勤務時間を計算
    var clockInStr = sheet.getRange(row, 5).getValue().toString();
    var inParts = clockInStr.split(':');
    var outParts = timeStr.split(':');
    var inMin = parseInt(inParts[0]) * 60 + parseInt(inParts[1]);
    var outMin = parseInt(outParts[0]) * 60 + parseInt(outParts[1]);
    var workMin = outMin - inMin;
    if (workMin < 0) workMin += 1440; // 日跨ぎ対応
    sheet.getRange(row, 7).setValue(workMin);

    var hours = Math.floor(workMin / 60);
    var mins = workMin % 60;

    // Admin通知
    sendTelegramTo(ADMIN_GROUP_ID,
      '🔴 *退勤打刻*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '👤 ' + staff + '\n'
      + '⏰ ' + timeStr + '\n'
      + '📅 ' + todayStr + '\n'
      + '⏱ 勤務時間: ' + hours + '時間' + mins + '分'
    );

    return jsonResponse({ status: 'ok', type: 'clock_out', time: timeStr, workMinutes: workMin });
  }

  return jsonResponse({ status: 'error', message: 'Invalid type: ' + type });
}

// 今日の出勤レコード行を探す
function findTodayAttendance(sheet, todayStr, staff, lastRow) {
  for (var r = 2; r <= lastRow; r++) {
    var date = sheet.getRange(r, 2).getValue().toString();
    var name = sheet.getRange(r, 3).getValue().toString();
    if (date === todayStr && name === staff) {
      return r;
    }
  }
  return -1;
}

// 勤怠一覧API（ミニアプリ用）
function handleAttendanceGet(e) {
  var sheet = getAttendanceSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse({ status: 'ok', records: [] });
  }

  var filterStaff = (e && e.parameter && e.parameter.staff) ? e.parameter.staff : '';
  var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var records = [];

  data.forEach(function(row) {
    if (filterStaff && row[2] !== filterStaff) return;
    records.push({
      id: row[0],
      date: row[1],
      staff: row[2],
      chatId: row[3],
      clockIn: row[4],
      clockOut: row[5],
      workMinutes: row[6],
      memo: row[7]
    });
  });

  return jsonResponse({ status: 'ok', records: records });
}

// 本日の勤怠サマリー取得（日次サマリー用）
function getTodayAttendance(today) {
  var result = [];
  try {
    var sheet = getAttendanceSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return result;

    var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    data.forEach(function(row) {
      if (row[1].toString() === today) {
        result.push({
          staff: row[2],
          clockIn: row[4],
          clockOut: row[5],
          workMinutes: row[6]
        });
      }
    });
  } catch (e) {
    Logger.log('getTodayAttendance error: ' + e.toString());
  }
  return result;
}

// ═══════════════════════════════════════════
//  日報管理
// ═══════════════════════════════════════════

// DailyReportsシート取得（なければ作成）
function getDailyReportsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DAILY_REPORTS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(DAILY_REPORTS_SHEET_NAME);
    var headers = [
      'Report ID', '登録日時', '報告日', '報告者', '報告者ChatID',
      '洗車以外の業務', '特記事項・連絡', 'ステータス'
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#7B1FA2');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(6, 350);
    sheet.setColumnWidth(7, 250);
  }

  return sheet;
}

// ミニアプリからの日報登録
function handleDailyReportFromApp(data) {
  var sheet = getDailyReportsSheet();
  var now = new Date();
  var reportId = 'RPT-' + Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd-HHmmss');
  var timestamp = formatCambodiaTime(now);

  var reportDate = data.reportDate || Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyy-MM-dd');
  var reporter = data.reporter || '';
  var reporterChatId = data.reporterChatId || '';
  var otherWork = data.otherWork || '';
  var notes = data.notes || '';

  sheet.appendRow([
    reportId, timestamp, reportDate, reporter, reporterChatId,
    otherWork, notes, '提出済'
  ]);

  // Adminグループに通知
  var msg = '📝 *日報提出*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '👤 報告者: ' + reporter + '\n'
    + '📅 日付: ' + reportDate + '\n';

  if (otherWork) {
    msg += '🔧 洗車以外の業務:\n' + otherWork + '\n';
  }
  if (notes) {
    msg += '📌 特記事項:\n' + notes + '\n';
  }

  sendTelegramTo(ADMIN_GROUP_ID, msg);

  return jsonResponse({ status: 'ok', reportId: reportId });
}

// 日報一覧API（ミニアプリ用）
function handleDailyReportsGet(e) {
  var sheet = getDailyReportsSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse({ status: 'ok', reports: [] });
  }

  // 日付フィルター（オプション）
  var filterDate = (e && e.parameter && e.parameter.date) ? e.parameter.date : '';
  var filterReporter = (e && e.parameter && e.parameter.reporter) ? e.parameter.reporter : '';

  var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var reports = [];

  data.forEach(function(row) {
    var report = {
      id: row[0],
      timestamp: row[1],
      reportDate: row[2] ? row[2].toString().substring(0, 10) : '',
      reporter: row[3],
      reporterChatId: row[4],
      otherWork: row[5],
      notes: row[6],
      status: row[7]
    };

    // フィルター適用
    if (filterDate && report.reportDate !== filterDate) return;
    if (filterReporter && report.reporter !== filterReporter) return;

    reports.push(report);
  });

  return jsonResponse({ status: 'ok', reports: reports });
}

// 本日の日報サマリー取得（日次サマリー用）
function getTodayDailyReports(today) {
  var result = [];
  try {
    var sheet = getDailyReportsSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return result;

    var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    data.forEach(function(row) {
      var reportDate = row[2] ? row[2].toString().substring(0, 10) : '';
      if (reportDate === today) {
        result.push({
          reporter: row[3],
          otherWork: row[5],
          notes: row[6]
        });
      }
    });
  } catch (e) {
    Logger.log('getTodayDailyReports error: ' + e.toString());
  }
  return result;
}

// ミニアプリからの経費登録
function handleExpenseCreateFromApp(data) {
  var photoUrls = [];

  // 入力統一: receiptPhotos配列を優先、無ければreceiptPhoto単体（旧仕様）
  var photosToSave = [];
  if (data.receiptPhotos && data.receiptPhotos.length > 0) {
    photosToSave = data.receiptPhotos;
  } else if (data.receiptPhoto) {
    photosToSave = [data.receiptPhoto];
  }

  // レシート写真をDriveに保存（複数枚）
  if (photosToSave.length > 0) {
    try {
      var receiptFolder = getOrCreateFolder(RECEIPT_FOLDER_NAME);
      var now = new Date();
      var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd_HHmmss');
      var who = (data.registeredBy || 'unknown');
      for (var i = 0; i < photosToSave.length; i++) {
        var fileName = 'receipt_' + dateStr + '_' + who + '_' + (i + 1);
        var link = saveBase64Image(receiptFolder, photosToSave[i], fileName);
        if (link) photoUrls.push(link);
      }
    } catch (photoErr) {
      Logger.log('handleExpenseCreateFromApp photo error: ' + photoErr.toString());
    }
  }

  var settlementStatus = data.settlementStatus || '未精算';

  var expenseId = createExpenseRecord({
    date: data.date || '',
    description: data.description || '',
    amount: data.amount || 0,
    currency: data.currency || 'USD',
    vendor: data.vendor || '',
    category: data.category || '消耗品費',
    registeredBy: data.registeredBy || '',
    photoUrls: photoUrls,
    ocrText: '',
    settlementStatus: settlementStatus
  });

  // Adminグループに通知
  var statusLabel = settlementStatus === '未精算' ? '⚠️ 未精算（立替え）' : '✅ 精算済み';
  var photoLinks = '';
  if (photoUrls.length === 1) {
    photoLinks = '\n📷 [レシート](' + photoUrls[0] + ')';
  } else if (photoUrls.length > 1) {
    photoLinks = '\n📷 レシート (' + photoUrls.length + '枚):';
    for (var p = 0; p < photoUrls.length; p++) {
      photoLinks += '\n  [' + (p + 1) + '枚目](' + photoUrls[p] + ')';
    }
  }
  sendTelegramTo(ADMIN_GROUP_ID,
    '💰 *新規経費登録（ミニアプリ）*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + expenseId + '\n'
    + '👤 登録者: ' + (data.registeredBy || '-') + '\n'
    + '📅 ' + (data.date || '-') + '\n'
    + '🏪 ' + (data.vendor || '-') + '\n'
    + '📝 ' + (data.description || '-') + '\n'
    + '💰 ' + (data.amount || '?') + ' ' + (data.currency || 'USD') + '\n'
    + '💳 ' + statusLabel
    + photoLinks
  );

  return jsonResponse({ status: 'ok', expenseId: expenseId, photoUrls: photoUrls });
}

// 経費編集（ミニアプリ用）
function handleExpenseEditFromApp(data) {
  var sheet = getExpensesSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return jsonResponse({ status: 'error', message: '経費データが見つかりません' });
  }

  // Expense IDで行を検索
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var targetRow = -1;
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0].toString() === data.expenseId) {
      targetRow = i + 2;
      break;
    }
  }

  if (targetRow < 0) {
    return jsonResponse({ status: 'error', message: 'ID not found: ' + data.expenseId });
  }

  // 写真の処理（複数枚対応）
  // - data.existingPhotoUrls: 残す既存URL配列（編集UIで削除されなかったもの）
  // - data.receiptPhotos: 追加アップロードされた新規base64配列
  // - data.receiptPhoto: 後方互換（単体）
  // 上記いずれも未指定のとき、現状の写真をそのまま維持する
  var photoFieldsTouched = (data.existingPhotoUrls !== undefined)
    || (data.receiptPhotos !== undefined && data.receiptPhotos !== null)
    || (data.receiptPhoto !== undefined && data.receiptPhoto !== null && data.receiptPhoto !== '');

  if (photoFieldsTouched) {
    var finalUrls = [];
    if (data.existingPhotoUrls && data.existingPhotoUrls.length > 0) {
      finalUrls = finalUrls.concat(data.existingPhotoUrls);
    }
    var newPhotos = [];
    if (data.receiptPhotos && data.receiptPhotos.length > 0) {
      newPhotos = data.receiptPhotos;
    } else if (data.receiptPhoto) {
      newPhotos = [data.receiptPhoto];
    }
    if (newPhotos.length > 0) {
      try {
        var receiptFolder = getOrCreateFolder(RECEIPT_FOLDER_NAME);
        var now = new Date();
        var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd_HHmmss');
        for (var i = 0; i < newPhotos.length; i++) {
          var fileName = 'receipt_edit_' + dateStr + '_' + (i + 1);
          var link = saveBase64Image(receiptFolder, newPhotos[i], fileName);
          if (link) finalUrls.push(link);
        }
      } catch (photoErr) {
        Logger.log('handleExpenseEditFromApp photo error: ' + photoErr.toString());
      }
    }
    setExpensePhotoUrls(sheet, targetRow, finalUrls);
  }

  // 各フィールドを更新（列: 3=日付, 4=説明, 5=金額, 6=通貨, 7=店名, 12=ステータス）
  if (data.date) sheet.getRange(targetRow, 3).setValue(data.date);
  if (data.description) sheet.getRange(targetRow, 4).setValue(data.description);
  if (data.amount) sheet.getRange(targetRow, 5).setValue(data.amount);
  if (data.currency) sheet.getRange(targetRow, 6).setValue(data.currency);
  if (data.vendor !== undefined) sheet.getRange(targetRow, 7).setValue(data.vendor);
  if (data.settlementStatus) sheet.getRange(targetRow, 12).setValue(data.settlementStatus);

  return jsonResponse({ status: 'ok', expenseId: data.expenseId });
}

// 経費一覧API（ミニアプリ用）
function handleExpensesGet() {
  var sheet = getExpensesSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse({ status: 'ok', expenses: [] });
  }

  var range = sheet.getRange(2, 1, lastRow - 1, 13);
  var values = range.getValues();
  var formulas = range.getFormulas();
  var notes = range.getNotes();

  var expenses = values.map(function(row, i) {
    // 写真URL（複数枚対応）
    var photoUrls = [];
    var note = notes[i][9];
    if (note) {
      photoUrls = note.split('\n').map(function(s){ return s.trim(); }).filter(function(s){ return s; });
    } else {
      var formula = formulas[i][9];
      if (formula && formula.toUpperCase().indexOf('HYPERLINK') >= 0) {
        var m = formula.match(/HYPERLINK\("([^"]+)"/);
        if (m) photoUrls = [m[1]];
      } else if (row[9] && row[9].toString().indexOf('http') === 0) {
        photoUrls = [row[9].toString()];
      }
    }

    return {
      id: row[0],
      created: row[1],
      date: row[2] ? row[2].toString().substring(0, 10) : '',
      description: row[3],
      amount: row[4],
      currency: row[5],
      vendor: row[6],
      category: row[7],
      registeredBy: row[8],
      photoUrl: photoUrls.length > 0 ? photoUrls[0] : '',  // 後方互換
      photoUrls: photoUrls,
      status: row[11],
      taskId: row[12]
    };
  });

  return jsonResponse({ status: 'ok', expenses: expenses });
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

// ═══════════════════════════════════════════
//  日次サマリー（v5: 時間変更、在庫削除、経費追加）
// ═══════════════════════════════════════════

// ════════════════════════════════════════════
//  毎朝 JST 9:00 配信（メインエントリポイント）
//  Admin向けレポート + 各スタッフ向け個別タスク通知
// ════════════════════════════════════════════
function sendDailySummary() {
  // カンボジア時間の「今日」と「昨日」を取得
  var now = new Date();
  var todayKh = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyy-MM-dd');
  var tomorrowKh = Utilities.formatDate(new Date(now.getTime() + 24 * 3600 * 1000), 'Asia/Phnom_Penh', 'yyyy-MM-dd');
  // 前日を文字列ベースで計算（タイムゾーンずれ防止）
  var todayParts = todayKh.split('-');
  var todayDateObj = new Date(parseInt(todayParts[0]), parseInt(todayParts[1]) - 1, parseInt(todayParts[2]));
  var yesterdayDateObj = new Date(todayDateObj.getTime() - 24 * 3600 * 1000);
  var yesterdayKh = Utilities.formatDate(yesterdayDateObj, 'Asia/Phnom_Penh', 'yyyy-MM-dd');

  Logger.log('sendDailySummary: today=' + todayKh + ', yesterday=' + yesterdayKh);

  // ① Admin向けレポート送信
  sendAdminReport(yesterdayKh, todayKh, tomorrowKh);

  // ② 各フィールドスタッフ向け個別タスク通知
  sendStaffMorningTasks(todayKh, tomorrowKh, yesterdayKh);
}

// ════════════════════════════════════════════
//  Admin向け：昨日の業績 + 今日/明日のアクション
// ════════════════════════════════════════════
function sendAdminReport(yesterday, today, tomorrow) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];
  var sheetUrl = ss.getUrl();

  // === 昨日の洗車実績 ===
  var jobsResult = getJobsForDate(yesterday);
  var yesterdayJobs = jobsResult.jobs;
  var totalRevenue = jobsResult.revenue;
  var totalDuration = jobsResult.duration;

  // === 昨日の経費 ===
  var expenseSummary = getExpenseSummaryForDate(yesterday);

  // === 昨日の勤怠 ===
  var attendance = getTodayAttendance(yesterday);

  // === 昨日の日報 ===
  var dailyReports = getTodayDailyReports(yesterday);

  // === 今日アクションが必要なタスク（今日期限・明日期限・期限超過） ===
  var actionTasks = getActionableTasks(today, tomorrow);

  // === 未精算の立替え経費（飯泉さん向けアラート） ===
  var unpaidExpenses = getUnpaidExpenses();

  // === メッセージ組み立て ===
  var msg = '☀️ *' + today + ' 朝のレポート*\n';
  msg += '━━━━━━━━━━━━━━━━━━\n\n';

  // 昨日の実績ヘッダー
  msg += '📅 *' + yesterday + ' の実績*\n\n';

  // 売上
  msg += '💵 *売上・稼働*\n';
  msg += '  洗車件数: *' + yesterdayJobs.length + '件*\n';
  if (yesterdayJobs.length > 0) {
    msg += '  売上合計: *' + formatMoney(totalRevenue) + ' USD*\n';
    msg += '  稼働時間: ' + totalDuration + '分\n';
  }
  msg += '\n';

  // 経費
  if (expenseSummary.count > 0) {
    msg += '💸 *経費*\n';
    msg += '  件数: ' + expenseSummary.count + '件\n';
    msg += '  合計: *' + formatMoney(expenseSummary.totalUSD) + ' USD*';
    if (expenseSummary.totalKHR > 0) {
      msg += ' / ' + formatMoney(expenseSummary.totalKHR) + ' KHR';
    }
    msg += '\n';
    if (expenseSummary.unpaidUSD > 0) {
      msg += '  ⚠️ 未精算（要支払）: ' + formatMoney(expenseSummary.unpaidUSD) + ' USD\n';
    }
    msg += '\n';
  }

  // 勤怠
  if (attendance.length > 0) {
    msg += '👥 *スタッフ勤怠*\n';
    attendance.forEach(function(a) {
      var hours = Math.floor((a.workMinutes || 0) / 60);
      var mins = (a.workMinutes || 0) % 60;
      var workStr = a.clockOut ? hours + 'h' + mins + 'm' : '勤務中';
      msg += '  ' + a.staff
        + ' ' + a.clockIn
        + (a.clockOut ? '〜' + a.clockOut : '〜')
        + ' (' + workStr + ')\n';
    });
    msg += '\n';
  }

  // 日報
  if (dailyReports.length > 0) {
    msg += '📝 *日報*\n';
    dailyReports.forEach(function(report) {
      msg += '  👤 ' + report.reporter + '\n';
      if (report.otherWork) msg += '    🔧 ' + report.otherWork + '\n';
      if (report.notes) msg += '    📌 ' + report.notes + '\n';
    });
    msg += '\n';
  }

  // 区切り
  msg += '━━━━━━━━━━━━━━━━━━\n';
  msg += '⚡ *今日アクション必要*\n\n';

  // 期限超過タスク
  if (actionTasks.overdue.length > 0) {
    msg += '🔴 *期限超過 (' + actionTasks.overdue.length + '件)*\n';
    actionTasks.overdue.forEach(function(t) {
      msg += '  ' + t.assignee + ': ' + t.desc + '（' + t.deadline + '）\n';
    });
    msg += '\n';
  }

  // 今日が期限
  if (actionTasks.today.length > 0) {
    msg += '🟡 *今日まで (' + actionTasks.today.length + '件)*\n';
    actionTasks.today.forEach(function(t) {
      msg += '  ' + t.assignee + ': ' + t.desc + '\n';
    });
    msg += '\n';
  }

  // 明日が期限（1日前アラート）
  if (actionTasks.tomorrow.length > 0) {
    msg += '🟢 *明日まで (' + actionTasks.tomorrow.length + '件)*\n';
    actionTasks.tomorrow.forEach(function(t) {
      msg += '  ' + t.assignee + ': ' + t.desc + '\n';
    });
    msg += '\n';
  }

  // アクションがない場合
  if (actionTasks.overdue.length === 0 && actionTasks.today.length === 0 && actionTasks.tomorrow.length === 0) {
    msg += '✅ 期限が迫っているタスクはありません\n\n';
  }

  // 未精算の立替えアラート（飯泉さん宛）
  if (unpaidExpenses.length > 0) {
    msg += '💳 *未精算の立替え (' + unpaidExpenses.length + '件)*\n';
    msg += '  → 飯泉さん要対応\n';
    var unpaidTotal = 0;
    unpaidExpenses.forEach(function(e) {
      msg += '  ' + e.id + ' / ' + e.registeredBy + ' / ' + formatMoney(e.amount) + ' ' + e.currency + '\n';
      if (e.currency === 'USD') unpaidTotal += e.amount;
    });
    msg += '  合計: *' + formatMoney(unpaidTotal) + ' USD*\n\n';
  }

  // フッター
  msg += '━━━━━━━━━━━━━━━━━━\n';
  msg += '📄 [スプレッドシートを開く](' + sheetUrl + ')';

  sendTelegramTo(ADMIN_GROUP_ID, msg);
  Logger.log('Admin朝レポート送信完了: ' + yesterday);
}

// ════════════════════════════════════════════
//  各フィールドスタッフ向け：個別タスク通知
//  クメール語挨拶 + 自分のタスクのみ
// ════════════════════════════════════════════
function sendStaffMorningTasks(today, tomorrow, yesterday) {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();

  FIELD_STAFF_IDS.forEach(function(staffId) {
    var staffInfo = STAFF_REGISTRY[staffId];
    var staffName = staffInfo.name;
    var staffNameKh = staffInfo.nameKh || staffName;

    // このスタッフの「今日まで・明日まで・期限超過」のタスクのみ抽出
    var myTasks = [];
    data.forEach(function(row) {
      if (row[6] === '完了') return;
      if (row[2] !== staffName) return;
      var deadline = row[4] ? Utilities.formatDate(new Date(row[4]), 'Asia/Phnom_Penh', 'yyyy-MM-dd') : '';
      if (!deadline) return; // 期限なしは通知しない
      if (deadline > tomorrow) return; // 明日より先のタスクは通知しない

      var status;
      var emoji;
      if (deadline < today) { status = 'overdue'; emoji = '🔴'; }
      else if (deadline === today) { status = 'today'; emoji = '🟡'; }
      else { status = 'tomorrow'; emoji = '🟢'; }

      myTasks.push({
        id: row[0],
        descJp: row[5] || '',
        deadline: deadline,
        status: status,
        emoji: emoji
      });
    });

    // 昨日の勤怠データを取得して労いメッセージに使う
    var yesterdayWork = '';
    try {
      var att = getTodayAttendance(yesterday);
      att.forEach(function(a) {
        if (a.staff === staffName && a.workMinutes) {
          var h = Math.floor(a.workMinutes / 60);
          var m = a.workMinutes % 60;
          yesterdayWork = h + 'h' + m + 'm';
        }
      });
    } catch (e) {}

    // クメール語挨拶
    var msg = '🌅 *អរុណសួស្តី ' + staffNameKh + '!*\n';
    msg += '（おはようございます、' + staffName + 'さん！）\n';
    msg += '━━━━━━━━━━━━━━━━━━\n\n';

    // 昨日の労い
    if (yesterdayWork) {
      msg += '✨ ម្សិលមិញធ្វើការ ' + yesterdayWork + '\n';
      msg += '  អរគុណច្រើន! / 昨日もお疲れ様でした！\n\n';
    }

    if (myTasks.length === 0) {
      msg += '🎉 *ថ្ងៃនេះមិនមានការងារបន្ទាន់ទេ*\n';
      msg += '  今日は急ぎの仕事はありません。\n';
      msg += '  通常の洗車業務を続けてください 💪\n';
    } else {
      msg += '🎯 *ការងារថ្ងៃនេះ / 今日のタスク*\n\n';

      var keyboard = [];
      myTasks.forEach(function(t, idx) {
        var descKh = translateToKhmer(t.descJp);
        var deadlineLabel;
        if (t.status === 'overdue') {
          deadlineLabel = '⚠️ ហួសកាលកំណត់ / 期限超過';
        } else if (t.status === 'today') {
          deadlineLabel = '📅 ថ្ងៃនេះ / 今日まで';
        } else {
          deadlineLabel = '📅 ស្អែក / 明日まで';
        }

        msg += (idx + 1) + '. ' + t.emoji + ' ' + descKh + '\n';
        msg += '   🇯🇵 ' + t.descJp + '\n';
        msg += '   ' + deadlineLabel + '\n\n';

        keyboard.push([
          { text: '✅ ' + descKh.substring(0, 20), callback_data: 'task_done:' + t.id },
          { text: '❌ មិនទាន់រួច', callback_data: 'task_notdone:' + t.id }
        ]);
      });

      msg += 'សូមចុចប៊ូតុងពេលរួចរាល់ 👇\n（完了したらボタンを押してください）';

      sendTelegramWithKeyboard(staffId, msg, { inline_keyboard: keyboard });
      Logger.log('スタッフ朝通知送信: ' + staffName + ' / ' + myTasks.length + '件');
      return;
    }

    // タスクがない場合はキーボードなしで送信
    sendTelegramTo(staffId, msg);
    Logger.log('スタッフ朝通知送信: ' + staffName + ' / 0件');
  });
}

// ════════════════════════════════════════════
//  集計ヘルパー
// ════════════════════════════════════════════

// 指定日のジョブと売上を取得
function getJobsForDate(dateStr) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];
  var lastRow = sheet.getLastRow();
  var result = { jobs: [], revenue: 0, duration: 0 };

  if (lastRow <= 1) return result;

  // 24列目（売上）まで取得
  var lastCol = sheet.getLastColumn();
  var colCount = Math.max(24, lastCol);
  var data = sheet.getRange(2, 1, lastRow - 1, colCount).getValues();

  data.forEach(function(row) {
    var regDate = row[1] ? row[1].toString() : '';
    if (regDate.indexOf(dateStr) === 0) {
      var duration = parseInt(row[14]) || 0;
      var price = parseFloat(row[23]) || 0;
      result.duration += duration;
      result.revenue += price;
      result.jobs.push({
        jobId: row[0],
        name: row[2],
        building: row[4],
        room: row[5],
        carModel: row[6],
        plate: row[7],
        plan: row[8],
        duration: duration,
        price: price
      });
    }
  });

  return result;
}

// 指定日の経費サマリー（精算ステータスも含む）
function getExpenseSummaryForDate(dateStr) {
  var result = { count: 0, totalUSD: 0, totalKHR: 0, unpaidUSD: 0 };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(EXPENSES_SHEET_NAME);
    if (!sheet) return result;
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return result;

    var data = sheet.getRange(2, 1, lastRow - 1, 13).getValues();
    data.forEach(function(row) {
      var transactionDate = row[2] ? row[2].toString().substring(0, 10) : '';
      if (transactionDate === dateStr) {
        result.count++;
        var amount = parseFloat(row[4]) || 0;
        var currency = row[5] || 'USD';
        var status = row[11] || '未精算';

        if (currency === 'KHR') {
          result.totalKHR += amount;
        } else {
          result.totalUSD += amount;
          if (status === '未精算') result.unpaidUSD += amount;
        }
      }
    });
  } catch (e) {
    Logger.log('getExpenseSummaryForDate error: ' + e.toString());
  }
  return result;
}

// 未精算の立替え経費一覧を取得
function getUnpaidExpenses() {
  var result = [];
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(EXPENSES_SHEET_NAME);
    if (!sheet) return result;
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return result;

    var data = sheet.getRange(2, 1, lastRow - 1, 13).getValues();
    data.forEach(function(row) {
      var status = row[11] || '';
      if (status === '未精算') {
        result.push({
          id: row[0],
          date: row[2] ? row[2].toString().substring(0, 10) : '',
          description: row[3],
          amount: parseFloat(row[4]) || 0,
          currency: row[5] || 'USD',
          vendor: row[6],
          registeredBy: row[8]
        });
      }
    });
  } catch (e) {
    Logger.log('getUnpaidExpenses error: ' + e.toString());
  }
  return result;
}

// 今日アクションが必要なタスク（今日・明日期限 + 期限超過）を取得
// 期限超過は1日前のものから（つまり昨日まで）
function getActionableTasks(today, tomorrow) {
  var result = { overdue: [], today: [], tomorrow: [] };
  try {
    var sheet = getTasksSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return result;

    var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
    data.forEach(function(row) {
      var status = row[6] || '';
      if (status === '完了') return;

      var deadline = row[4] ? Utilities.formatDate(new Date(row[4]), 'Asia/Phnom_Penh', 'yyyy-MM-dd') : '';
      if (!deadline) return; // 期限なしはアクション通知に出さない

      var taskInfo = {
        id: row[0],
        assignee: row[2] || '未定',
        desc: row[5] || '',
        deadline: deadline
      };

      if (deadline < today) {
        result.overdue.push(taskInfo);
      } else if (deadline === today) {
        result.today.push(taskInfo);
      } else if (deadline === tomorrow) {
        result.tomorrow.push(taskInfo);
      }
    });
  } catch (e) {
    Logger.log('getActionableTasks error: ' + e.toString());
  }
  return result;
}

// 金額フォーマット（カンマ区切り、小数2桁）
function formatMoney(amount) {
  var n = parseFloat(amount) || 0;
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// 本日の経費サマリー取得
function getTodayExpenseSummary(today) {
  var result = { count: 0, totalUSD: 0, totalKHR: 0 };

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(EXPENSES_SHEET_NAME);
    if (!sheet) return result;

    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return result;

    var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    data.forEach(function(row) {
      var regDate = row[1] ? row[1].toString() : '';
      if (regDate.indexOf(today) === 0) {
        result.count++;
        var amount = parseFloat(row[4]) || 0;
        var currency = row[5] || 'USD';
        if (currency === 'KHR') {
          result.totalKHR += amount;
        } else {
          result.totalUSD += amount;
        }
      }
    });
  } catch (e) {
    Logger.log('getTodayExpenseSummary error: ' + e.toString());
  }

  return result;
}

// 旧: getTaskSummaryForReport()
// v5.1以降は getActionableTasks(today, tomorrow) に置き換えられたため削除。

// ═══════════════════════════════════════════
//  在庫管理（v4から継承・参照用に残す）
// ═══════════════════════════════════════════

function getInventorySheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INVENTORY_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(INVENTORY_SHEET_NAME);
    var headers = [
      'Item ID', 'ឈ្មោះផលិតផល（品名）', 'ប្រភេទ（カテゴリ）',
      'ចំនួនបច្ចុប្បន្ន（現在庫数）', 'ឯកតា（単位）',
      'កម្រិតព្រមាន（発注閾値）', 'កាលបរិច្ឆេទធ្វើបច្ចុប្បន្នភាព（最終更新）'
    ];
    sheet.appendRow(headers);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#c9a84c');
    headerRange.setFontColor('#000000');
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function handleInventoryGet() {
  var sheet = getInventorySheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse({ status: 'ok', items: [] });
  }

  var dataRange = sheet.getRange(2, 1, lastRow - 1, 7);
  var values = dataRange.getValues();

  var items = values.map(function(row) {
    return {
      id: row[0], name: row[1], category: row[2],
      qty: row[3], unit: row[4], threshold: row[5], updated: row[6]
    };
  });

  return jsonResponse({ status: 'ok', items: items });
}

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
//  セットアップ・トリガー（v5）
// ═══════════════════════════════════════════

// v5トリガー一括設定
// sendDailySummary が Admin向けレポート と スタッフ向け朝タスク通知 の両方を行うため、
// トリガーは sendDailySummary だけにする（両者が同時刻に送信される）
function setupV5Triggers() {
  // 既存トリガーを全削除
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }

  // 1. 朝のレポート（Admin + スタッフ一括配信）: 毎日 JST 9:00（=カンボジア 7:00）
  //    inTimezone で Asia/Tokyo を指定し、スクリプトのタイムゾーン設定に依存しないようにする
  ScriptApp.newTrigger('sendDailySummary')
    .timeBased()
    .everyDays(1)
    .inTimezone('Asia/Tokyo')
    .atHour(9)
    .create();

  // 2. 繰返しタスク生成: 毎日 JST 9:00 に実行（レポート送信前に生成されるように）
  ScriptApp.newTrigger('generateRecurringTasks')
    .timeBased()
    .everyDays(1)
    .inTimezone('Asia/Tokyo')
    .atHour(8)
    .create();

  Logger.log('v5トリガーを設定しました:');
  Logger.log('  繰返しタスク生成: 毎日 JST 8:00');
  Logger.log('  朝のレポート（Admin+スタッフ）: 毎日 JST 9:00 / カンボジア 7:00');
}

// v5シート・初期データ一括セットアップ
function setupV5Sheets() {
  getTasksSheet();
  getExpensesSheet();
  getDailyReportsSheet();
  getAttendanceSheet();
  seedRecurringTasks();
  Logger.log('v5シートと初期データを作成しました。');
}

// Telegram Webhook設定（後方互換: Adminのみ）
function setupWebhook() {
  var gasUrl = ScriptApp.getService().getUrl();
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
  var gasUrl = ScriptApp.getService().getUrl();
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

  // 営業時間の範囲をDateで構築
  var parts = dateStr.split('-');
  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10) - 1;
  var day = parseInt(parts[2], 10);

  var dayStart = new Date(year, month, day, hourStart, 0, 0);
  var dayEnd   = new Date(year, month, day, hourEnd, 0, 0);

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
    var parts = booking.date.split('-');
    var timeParts = booking.startTime.split(':');
    var startDate = new Date(
      parseInt(parts[0], 10),
      parseInt(parts[1], 10) - 1,
      parseInt(parts[2], 10),
      parseInt(timeParts[0], 10),
      parseInt(timeParts[1], 10),
      0
    );
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
    bufferMin: config.bufferMin
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
        date: data[i][5] ? Utilities.formatDate(new Date(data[i][5]), BOOKING_TIMEZONE, 'yyyy-MM-dd') : '',
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
  for (var i = 0; i < data.length; i++) {
    var dateValue = data[i][5];
    var dateStr = dateValue ? Utilities.formatDate(new Date(dateValue), BOOKING_TIMEZONE, 'yyyy-MM-dd') : '';
    if (targetDates.indexOf(dateStr) < 0) continue;
    if (data[i][16] === 'キャンセル') continue;

    bookings.push({
      bookingId:    data[i][0],
      customerName: data[i][3],
      chatId:       data[i][4],
      date:         dateStr,
      startTime:    data[i][6],
      endTime:      data[i][7],
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
  // 既存v5シート
  getExpensesSheet();
  getTasksSheet();
  // v6で追加
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

function testDailySummary() {
  sendDailySummary();
}

function testCreateTask() {
  var taskId = createTask('ロン', '7500384947', '2026-04-15', 'テストタスク: 倉庫清掃', '', '');
  Logger.log('テストタスク作成: ' + taskId);
}

// testMorningNotification() は sendDailySummary() に統合済みのため削除
// 朝のレポート（Admin+スタッフ）の動作確認は testDailySummary() を使ってください

function testTelegram() {
  sendTelegram('🧪 テスト通知\nSamurai Motors v5 Telegram連携テストです。');
}

function testReceiptOCR() {
  Logger.log('レシートOCRテストは実際のレシート写真で /receipt コマンドを使って実行してください。');
}

// Adminグループにミニアプリメニューボタンを送信（ピン留め用）
function sendAdminMenu() {
  var botUsername = 'quickwash_kh_bot';
  var baseUrl = 'https://ec20921-debug.github.io/samurai-motors-app';

  // t.me/bot?startapp=xxx 形式でTelegram内ミニアプリとして開く
  function appLink(page) {
    return 'https://t.me/' + botUsername + '/app?startapp=' + encodeURIComponent(page);
  }

  var msg = '📱 *Admin メニュー*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '下のボタンからミニアプリを開けます。\n'
    + 'このメッセージをピン留めしておくと便利です。\n\n'
    + '📋 [タスク管理](' + baseUrl + '/task-manager.html)\n'
    + '💰 [経費管理](' + baseUrl + '/expense-entry.html)\n'
    + '🚗 [洗車登録](' + baseUrl + '/job-manager.html)\n'
    + '🕐 [勤怠打刻](' + baseUrl + '/attendance.html)\n'
    + '📝 [日報入力](' + baseUrl + '/daily-report.html)\n'
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
