/**
 * Config.gs — 設定値の一元管理
 *
 * 【責務】
 *   PropertiesService に登録された設定値を読み取り、コード全体から参照可能な
 *   定数として提供する。ハードコード禁止の原則を守る唯一の窓口。
 *
 * 【参照ルール】
 *   - 他ファイルからは `getConfig()` または `CONFIG_KEYS` 経由で取得
 *   - シート名は `SHEET_NAMES` を使用（Setup.gs の SHEETS と命名衝突回避）
 *   - 本ファイルに値をハードコードしない（PropertiesServiceに置く）
 */

// ====== PropertiesService キー一覧 ======
const CONFIG_KEYS = {
  // Telegram
  BOT_TOKEN_BOOKING:   'BOT_TOKEN_BOOKING',
  BOT_TOKEN_FIELD:     'BOT_TOKEN_FIELD',
  ADMIN_GROUP_ID:      'ADMIN_GROUP_ID',

  // Google Workspace
  SPREADSHEET_ID:      'SPREADSHEET_ID',
  BOOKING_CALENDAR_ID: 'BOOKING_CALENDAR_ID',

  // Drive フォルダ
  DRIVE_FOLDER_WASH_PHOTOS:         'DRIVE_FOLDER_WASH_PHOTOS',
  DRIVE_FOLDER_QR_CODES:            'DRIVE_FOLDER_QR_CODES',
  DRIVE_FOLDER_PAYMENT_SCREENSHOTS: 'DRIVE_FOLDER_PAYMENT_SCREENSHOTS',

  // ミニアプリ URL（Phase 3 以降で使用。未登録でもgetConfigは通るよう required から除外）
  BOOKING_MINIAPP_URL:     'BOOKING_MINIAPP_URL',
  JOB_MANAGER_MINIAPP_URL: 'JOB_MANAGER_MINIAPP_URL'
};

// ====== Bot種別識別子 ======
const BOT_TYPE = {
  BOOKING: 'booking',  // 予約Bot（顧客用）
  FIELD:   'field'     // 業務Bot（現場スタッフ用）
};

// ====== シート名（本番コード参照用） ======
// Setup.gs の SHEETS と同値だが命名衝突回避のため SHEET_NAMES とする
const SHEET_NAMES = {
  CUSTOMERS:   '顧客',
  BOOKINGS:    '予約',
  VEHICLES:    '車両',
  JOBS:        '作業記録',
  STAFF:       'スタッフ',
  CHAT_LOG:    'チャット履歴',
  QR_CODES:    'QRコード',
  PLAN_PRICES: '料金設定'
};

// ====== キュー・重複排除のキープレフィックス ======
const STORAGE_KEYS = {
  QUEUE_PREFIX:     'queue_',       // queue_{timestamp}_{update_id}
  PROCESSED_PREFIX: 'processed_',   // processed_{update_id}（24h保持）
  ADMIN_REPLY_PREFIX: 'admin_reply_', // admin_reply_{admin_chat_id}（Cache 300秒）
  POLL_OFFSET_PREFIX: 'poll_offset_'  // poll_offset_{botType} : 次回取得用 update_id（Polling方式）
};

// ====== TTL（秒） ======
const TTL = {
  PROCESSED_ID:      24 * 60 * 60,   // 24時間（ScriptProperties側で手動clean）
  ADMIN_REPLY_STATE: 300,            // 5分（CacheService）
  PLAN_PRICES_CACHE: 60,             // 1分（CacheService）
  AVAILABLE_SLOTS:   60              // 1分（CacheService）
};

/**
 * 設定値を取得する。必須キーが未登録の場合は例外を投げる。
 *
 * @return {Object} 全設定値を格納したオブジェクト
 */
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  // 必須キー（未登録なら例外）
  const required = [
    CONFIG_KEYS.BOT_TOKEN_BOOKING,
    CONFIG_KEYS.BOT_TOKEN_FIELD,
    CONFIG_KEYS.ADMIN_GROUP_ID,
    CONFIG_KEYS.SPREADSHEET_ID,
    CONFIG_KEYS.BOOKING_CALENDAR_ID,
    CONFIG_KEYS.DRIVE_FOLDER_WASH_PHOTOS,
    CONFIG_KEYS.DRIVE_FOLDER_QR_CODES,
    CONFIG_KEYS.DRIVE_FOLDER_PAYMENT_SCREENSHOTS
  ];
  const missing = required.filter(function(key) { return !all[key]; });
  if (missing.length > 0) {
    throw new Error('❌ PropertiesService 未登録: ' + missing.join(', '));
  }

  return {
    botTokenBooking:              all[CONFIG_KEYS.BOT_TOKEN_BOOKING],
    botTokenField:                all[CONFIG_KEYS.BOT_TOKEN_FIELD],
    adminGroupId:                 all[CONFIG_KEYS.ADMIN_GROUP_ID],
    spreadsheetId:                all[CONFIG_KEYS.SPREADSHEET_ID],
    bookingCalendarId:            all[CONFIG_KEYS.BOOKING_CALENDAR_ID],
    driveFolderWashPhotos:        all[CONFIG_KEYS.DRIVE_FOLDER_WASH_PHOTOS],
    driveFolderQrCodes:           all[CONFIG_KEYS.DRIVE_FOLDER_QR_CODES],
    driveFolderPaymentScreenshots: all[CONFIG_KEYS.DRIVE_FOLDER_PAYMENT_SCREENSHOTS],
    // オプション（未登録OK）
    bookingMiniappUrl:            all[CONFIG_KEYS.BOOKING_MINIAPP_URL] || '',
    jobManagerMiniappUrl:         all[CONFIG_KEYS.JOB_MANAGER_MINIAPP_URL] || ''
  };
}

/**
 * Bot種別からトークンを取得する
 *
 * @param {string} botType - BOT_TYPE.BOOKING or BOT_TYPE.FIELD
 * @return {string} Botトークン
 */
function getBotToken(botType) {
  const props = PropertiesService.getScriptProperties();
  if (botType === BOT_TYPE.BOOKING) {
    return props.getProperty(CONFIG_KEYS.BOT_TOKEN_BOOKING);
  } else if (botType === BOT_TYPE.FIELD) {
    return props.getProperty(CONFIG_KEYS.BOT_TOKEN_FIELD);
  }
  throw new Error('❌ 不明な botType: ' + botType);
}

/**
 * 設定確認用（Phase 1 デバッグ）
 */
function showConfig() {
  try {
    const cfg = getConfig();
    Logger.log('━━━━━━━━━━━━━━━━━━━━');
    Logger.log('📋 v7 設定値');
    Logger.log('━━━━━━━━━━━━━━━━━━━━');
    Logger.log('ADMIN_GROUP_ID: ' + cfg.adminGroupId);
    Logger.log('SPREADSHEET_ID: ' + cfg.spreadsheetId);
    Logger.log('BOOKING_CALENDAR_ID: ' + cfg.bookingCalendarId);
    Logger.log('BOT_TOKEN_BOOKING: ' + cfg.botTokenBooking.substring(0, 10) + '...（マスク）');
    Logger.log('BOT_TOKEN_FIELD: ' + cfg.botTokenField.substring(0, 10) + '...（マスク）');
    Logger.log('DRIVE_FOLDER_WASH_PHOTOS: ' + cfg.driveFolderWashPhotos);
    Logger.log('DRIVE_FOLDER_QR_CODES: ' + cfg.driveFolderQrCodes);
    Logger.log('DRIVE_FOLDER_PAYMENT_SCREENSHOTS: ' + cfg.driveFolderPaymentScreenshots);
    Logger.log('━━━━━━━━━━━━━━━━━━━━');
    Logger.log('✅ 全8キー読み取り成功');
  } catch (err) {
    Logger.log('❌ ' + err.message);
  }
}
