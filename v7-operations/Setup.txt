/**
 * Setup.gs — 初回シートセットアップ（v7-operations）
 *
 * 【責務】
 *   - 「スタッフマスター」シート新設（存在しなければ作成、既存なら触らない）
 *   - 「勤怠記録」シートに GPS 用列を追加（既存列は触らない）
 *   - 初期スタッフ（ロン）を 1行投入
 *
 * 【運用ルール（CLAUDE.md 準拠）】
 *   - Setup は **初回1回だけ** 実行。完了後は本番GASから削除してよい。
 *   - ローカル＆GitHub には残す。再セットアップが必要なら貼り直す。
 */

/**
 * 初回セットアップのエントリポイント
 * 1. スタッフマスター作成（なければ）
 * 2. 勤怠記録シートに GPS 列追加（足りなければ）
 * 3. 初期スタッフ（ロン）投入（まだなら）
 */
function setupV7OpsInitial() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🔧 v7-operations 初回セットアップ開始');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  ensureStaffMasterSheet(ss);
  ensureAttendanceSchema(ss);
  seedInitialStaff();

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ セットアップ完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 「スタッフマスター」シートを作成（なければ）
 *
 * 列構成:
 *   A: スタッフID        STAFF-001 形式
 *   B: Chat ID           Telegram chat_id
 *   C: 氏名(JP)          例: ロン
 *   D: Name(EN)          例: Ron
 *   E: 役割              field / admin / manager 等
 *   F: 雇用形態          full_time / part_time / contract
 *   G: 入社日            yyyy-MM-dd
 *   H: 月給(USD)         数値
 *   I: 有効              TRUE/FALSE
 *   J: 備考              自由記述
 */
function ensureStaffMasterSheet(ss) {
  const name = SHEET_NAMES.STAFF_MASTER;
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    Logger.log('ℹ️ 「' + name + '」は既に存在します（スキップ）');
    return;
  }

  sheet = ss.insertSheet(name);
  const headers = [
    'スタッフID', 'Chat ID', '氏名(JP)', 'Name(EN)', '役割',
    '雇用形態', '入社日', '月給(USD)', '有効', '備考'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);

  // 列幅調整
  sheet.setColumnWidth(1, 100);  // スタッフID
  sheet.setColumnWidth(2, 130);  // Chat ID
  sheet.setColumnWidth(3, 100);  // 氏名(JP)
  sheet.setColumnWidth(4, 100);  // Name(EN)
  sheet.setColumnWidth(5, 80);   // 役割
  sheet.setColumnWidth(6, 100);  // 雇用形態
  sheet.setColumnWidth(7, 100);  // 入社日
  sheet.setColumnWidth(8, 100);  // 月給(USD)
  sheet.setColumnWidth(9, 60);   // 有効
  sheet.setColumnWidth(10, 200); // 備考

  Logger.log('✅ 「' + name + '」を新規作成しました');
}

/**
 * 「勤怠記録」シートに AttendanceManager が要求する全列を追加
 *
 * 必須列:
 *   日付 / スタッフID / 氏名(JP) / Chat ID /
 *   出勤時刻 / 退勤時刻 / 勤務分数 /
 *   出勤緯度 / 出勤経度 / 出勤マップリンク /
 *   退勤緯度 / 退勤経度 / 退勤マップリンク /
 *   位置精度(m) / メモ
 *
 * 既存列は尊重し、足りないものだけ末尾に追加する。
 * シートが存在しなければ新規作成。
 */
function ensureAttendanceSchema(ss) {
  const name = SHEET_NAMES.ATTENDANCE;
  let sheet = ss.getSheetByName(name);
  const needed = [
    '日付', 'スタッフID', '氏名(JP)', 'Chat ID',
    '出勤時刻', '退勤時刻', '勤務分数',
    '出勤緯度', '出勤経度', '出勤マップリンク',
    '退勤緯度', '退勤経度', '退勤マップリンク',
    '位置精度(m)', 'メモ'
  ];

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, needed.length).setValues([needed]);
    sheet.getRange(1, 1, 1, needed.length).setFontWeight('bold').setBackground('#f1f3f4');
    sheet.setFrozenRows(1);
    Logger.log('✅ 「' + name + '」を新規作成しました（' + needed.length + '列）');
    return;
  }

  const lastCol = sheet.getLastColumn();
  const existingHeaders = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) { return String(h); })
    : [];

  const toAdd = needed.filter(function(h) { return existingHeaders.indexOf(h) < 0; });
  if (toAdd.length === 0) {
    Logger.log('ℹ️ 「' + name + '」のスキーマ完備（スキップ）');
    return;
  }

  const startCol = lastCol + 1;
  sheet.getRange(1, startCol, 1, toAdd.length).setValues([toAdd]);
  sheet.getRange(1, startCol, 1, toAdd.length).setFontWeight('bold').setBackground('#f1f3f4');
  Logger.log('✅ 「' + name + '」に列を追加: ' + toAdd.join(', '));
}

/**
 * 初期スタッフ（ロン）投入
 * 既に同じ Chat ID / スタッフID がいればスキップ
 */
function seedInitialStaff() {
  const rows = getAllRows(SHEET_NAMES.STAFF_MASTER);
  const exists = rows.some(function(r) {
    return String(r['スタッフID']) === 'STAFF-001' ||
           String(r['氏名(JP)']) === 'ロン';
  });
  if (exists) {
    Logger.log('ℹ️ 初期スタッフ（ロン）は登録済み（スキップ）');
    return;
  }

  appendRow(SHEET_NAMES.STAFF_MASTER, {
    'スタッフID':   'STAFF-001',
    'Chat ID':      '7500384947',        // v5 STAFF_REGISTRY より
    '氏名(JP)':     'ロン',
    'Name(EN)':     'Ron',
    '役割':         'field',
    '雇用形態':     'full_time',
    '入社日':       '',                  // 手動入力
    '月給(USD)':    0,                   // 手動入力
    '有効':         true,
    '備考':         '現場スタッフ（初期登録）'
  });

  Logger.log('✅ 初期スタッフ「ロン」を登録しました');
  clearStaffMasterCache();
}

/**
 * デバッグ用: 現在のスタッフ一覧を Logger に出力
 */
function debugShowStaff() {
  const staff = getActiveStaff();
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('👥 有効スタッフ一覧 (' + staff.length + '名)');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  staff.forEach(function(s) {
    Logger.log(s.staffId + ' | ' + s.nameJp + ' (' + s.nameEn + ') | chat=' + s.chatId + ' | ' + s.role);
  });
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
