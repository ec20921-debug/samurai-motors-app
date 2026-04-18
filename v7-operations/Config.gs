/**
 * Config.gs — v7-operations 設定定数
 *
 * 【責務】
 *   PropertiesService に登録された設定値を読み取り、コード全体から参照可能に提供。
 *   v7（顧客系）とは別の GAS プロジェクトなので、ここで独立に管理する。
 *
 * 【v7 との違い】
 *   - Bot Token は勤務Bot 専用（BOT_TOKEN_INTERNAL）
 *   - スプレッドシートも勤務専用（OPERATIONS_SPREADSHEET_ID）
 *   - ADMIN_GROUP_ID は v7 と同値（共通の管理グループ）
 */

// ====== PropertiesService キー一覧 ======
const CONFIG_KEYS = {
  // Telegram
  BOT_TOKEN_INTERNAL:        'BOT_TOKEN_INTERNAL',
  ADMIN_GROUP_ID:            'ADMIN_GROUP_ID',
  ATTENDANCE_TOPIC_ID:       'ATTENDANCE_TOPIC_ID',   // 勤怠ログ用フォーラムトピック

  // Google Workspace
  OPERATIONS_SPREADSHEET_ID: 'OPERATIONS_SPREADSHEET_ID',

  // ミニアプリ
  INTERNAL_MINIAPP_URL:      'INTERNAL_MINIAPP_URL'   // home-internal.html の公開URL
};

// ====== Bot種別識別子 ======
// v7-ops は勤務Bot のみ。v7 の BOT_TYPE とは別名前空間。
const BOT_TYPE = {
  INTERNAL: 'internal'
};

// ====== シート名 ======
const SHEET_NAMES = {
  STAFF_MASTER:   'スタッフマスター',   // v7-ops で新設
  ATTENDANCE:     '勤怠記録',           // v5/v6 の Attendance を改名＋列拡張
  TASKS:          'タスク',             // v5 の Tasks を改名
  DAILY_REPORTS:  '日報',               // v5 の DailyReports を改名
  EXPENSES:       '経費'                // v5 の Expenses を改名
};

// ====== キャッシュ・キューのキープレフィックス ======
const STORAGE_KEYS = {
  QUEUE_PREFIX:       'queue_',
  PROCESSED_PREFIX:   'processed_',
  POLL_OFFSET_PREFIX: 'poll_offset_'
};

// ====== TTL（秒） ======
const TTL = {
  PROCESSED_ID:        24 * 60 * 60,   // 24時間
  STAFF_MASTER_CACHE:  60              // 1分（CacheService）
};

// ====== タイムゾーン ======
const OPS_TZ = 'Asia/Phnom_Penh';

/**
 * 設定値を取得する。必須キーが未登録なら例外。
 */
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  const required = [
    CONFIG_KEYS.BOT_TOKEN_INTERNAL,
    CONFIG_KEYS.ADMIN_GROUP_ID,
    CONFIG_KEYS.OPERATIONS_SPREADSHEET_ID
  ];
  const missing = required.filter(function(k) { return !all[k]; });
  if (missing.length > 0) {
    throw new Error('❌ PropertiesService 未登録: ' + missing.join(', '));
  }

  return {
    botTokenInternal:        all[CONFIG_KEYS.BOT_TOKEN_INTERNAL],
    adminGroupId:            all[CONFIG_KEYS.ADMIN_GROUP_ID],
    attendanceTopicId:       all[CONFIG_KEYS.ATTENDANCE_TOPIC_ID] || '',   // 任意
    operationsSpreadsheetId: all[CONFIG_KEYS.OPERATIONS_SPREADSHEET_ID],
    internalMiniappUrl:      all[CONFIG_KEYS.INTERNAL_MINIAPP_URL] || ''
  };
}

/**
 * Bot種別からトークンを取得する
 */
function getBotToken(botType) {
  if (botType === BOT_TYPE.INTERNAL) {
    return PropertiesService.getScriptProperties().getProperty(CONFIG_KEYS.BOT_TOKEN_INTERNAL);
  }
  throw new Error('❌ 不明な botType: ' + botType);
}

/**
 * 設定確認用（初期デバッグ）
 */
function showConfig() {
  try {
    const cfg = getConfig();
    Logger.log('━━━━━━━━━━━━━━━━━━━━');
    Logger.log('📋 v7-operations 設定値');
    Logger.log('━━━━━━━━━━━━━━━━━━━━');
    Logger.log('ADMIN_GROUP_ID: ' + cfg.adminGroupId);
    Logger.log('OPERATIONS_SPREADSHEET_ID: ' + cfg.operationsSpreadsheetId);
    Logger.log('BOT_TOKEN_INTERNAL: ' + cfg.botTokenInternal.substring(0, 10) + '...（マスク）');
    Logger.log('INTERNAL_MINIAPP_URL: ' + (cfg.internalMiniappUrl || '（未登録）'));
    Logger.log('━━━━━━━━━━━━━━━━━━━━');
    Logger.log('✅ 設定読み取り成功');
  } catch (err) {
    Logger.log('❌ ' + err.message);
  }
}
