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
  BOT_TOKEN_INTERNAL:          'BOT_TOKEN_INTERNAL',
  ADMIN_GROUP_ID:              'ADMIN_GROUP_ID',
  ATTENDANCE_TOPIC_ID:         'ATTENDANCE_TOPIC_ID',           // 勤怠ログトピック
  ADMIN_TASK_THREAD_ID:        'ADMIN_TASK_THREAD_ID',          // タスクトピック（154）
  ADMIN_DAILY_REPORT_THREAD_ID:'ADMIN_DAILY_REPORT_THREAD_ID',  // 日報トピック（157）
  ADMIN_EXPENSE_THREAD_ID:     'ADMIN_EXPENSE_THREAD_ID',       // 経費トピック（任意、未設定なら日報トピックへ）
  ADMIN_PARTNER_THREAD_ID:     'ADMIN_PARTNER_THREAD_ID',       // パートナートピック（紹介・承認）

  // Google Workspace
  OPERATIONS_SPREADSHEET_ID: 'OPERATIONS_SPREADSHEET_ID',
  V7_SPREADSHEET_ID:         'V7_SPREADSHEET_ID',                // 顧客系スプレッドシート（日報で売上参照）
  RECEIPT_FOLDER_ID:         'RECEIPT_FOLDER_ID',                // レシート保存先 Drive フォルダ（任意、未設定なら自動作成）

  // ミニアプリ
  INTERNAL_MINIAPP_URL:      'INTERNAL_MINIAPP_URL',  // home-internal.html の公開URL

  // パートナープログラム
  PARTNER_WELCOME_KIT_URL:   'PARTNER_WELCOME_KIT_URL',   // Welcome Kit PDF/ページURL（任意）
  PARTNER_TRIAL_VOUCHER_PREFIX: 'PARTNER_TRIAL_VOUCHER_PREFIX' // 体験コードのプレフィックス（既定: SMTRY）
};

// ====== Bot種別識別子 ======
// v7-ops は勤務Bot のみ。v7 の BOT_TYPE とは別名前空間。
const BOT_TYPE = {
  INTERNAL: 'internal'
};

// ====== シート名 ======
const SHEET_NAMES = {
  STAFF_MASTER:      'スタッフマスター',
  ATTENDANCE:        '勤怠記録',
  TASKS:             'タスク',
  TASK_INPUT:        '新規タスク入力',
  DAILY_REPORTS:     '日報',
  EXPENSES:          '経費',
  PARTNERS:          'パートナー',
  REFERRAL_HISTORY:  '紹介履歴'
};

// ====== 繰返しルール（新規タスク入力・Tasks シートで使う候補値） ======
const RECURRENCE_OPTIONS = ['なし', '毎日', '毎週月曜', '毎週金曜', '毎月1日', '毎月10日', '毎月末'];

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
    botTokenInternal:         all[CONFIG_KEYS.BOT_TOKEN_INTERNAL],
    adminGroupId:             all[CONFIG_KEYS.ADMIN_GROUP_ID],
    attendanceTopicId:        all[CONFIG_KEYS.ATTENDANCE_TOPIC_ID] || '',
    adminTaskThreadId:        all[CONFIG_KEYS.ADMIN_TASK_THREAD_ID] || '',
    adminDailyReportThreadId: all[CONFIG_KEYS.ADMIN_DAILY_REPORT_THREAD_ID] || '',
    adminExpenseThreadId:     all[CONFIG_KEYS.ADMIN_EXPENSE_THREAD_ID] || '',
    adminPartnerThreadId:     all[CONFIG_KEYS.ADMIN_PARTNER_THREAD_ID] || '',
    operationsSpreadsheetId:  all[CONFIG_KEYS.OPERATIONS_SPREADSHEET_ID],
    v7SpreadsheetId:          all[CONFIG_KEYS.V7_SPREADSHEET_ID] || '',
    receiptFolderId:          all[CONFIG_KEYS.RECEIPT_FOLDER_ID] || '',
    internalMiniappUrl:       all[CONFIG_KEYS.INTERNAL_MINIAPP_URL] || '',
    partnerWelcomeKitUrl:     all[CONFIG_KEYS.PARTNER_WELCOME_KIT_URL] || '',
    partnerTrialVoucherPrefix: all[CONFIG_KEYS.PARTNER_TRIAL_VOUCHER_PREFIX] || 'SMTRY'
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
