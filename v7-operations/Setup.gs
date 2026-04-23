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

// ═══════════════════════════════════════════════════════
// Phase 2: タスク管理セットアップ
// ═══════════════════════════════════════════════════════

/**
 * Phase 2 初回セットアップのエントリポイント
 * 1. スタッフマスターに「タイムゾーン」「Telegram Username」列を追加
 * 2. Admin スタッフ（飯泉・鈴木・五木田）を追加
 * 3. タスクシートを新設（担当者/繰返しルールのドロップダウン付き）
 * 4. 既存スタッフ（ロン）にタイムゾーン自動設定
 * 5. 繰返しタスクテンプレートを seed
 */
function setupPhase2Tasks() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🔧 Phase 2 タスク管理セットアップ開始');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  ensureStaffMasterTzColumn(ss);
  backfillRonTimezone();
  seedAdminStaff();
  ensureTasksSheet(ss);
  applyTasksSheetValidation(ss);
  ensureTaskInputSheet(ss);
  seedRecurringTaskTemplates();

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ Phase 2 セットアップ完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('');
  Logger.log('⏭️ 次に setupTaskInputOnEditTrigger() を実行してください');
  Logger.log('   （「新規タスク入力」シートの自動転記を有効化）');
}

/**
 * 「新規タスク入力」シートを作成。
 *
 * UX: ユーザーは 4項目（担当者/期限/タスク内容/繰返し）だけ入力し、
 *     E列の☑を入れると onEdit が発火してタスクシートへ自動転記される。
 *
 * 列構成:
 *   A: 担当者          (スタッフマスター・氏名JP ドロップダウン)
 *   B: 期限            (日付ピッカー)
 *   C: タスク内容      (自由入力)
 *   D: 繰返しルール    (RECURRENCE_OPTIONS ドロップダウン・空ならなし扱い)
 *   E: 追加 (☑ で転記)  (チェックボックス)
 *   F: 結果            (処理ログ/エラーの自動出力)
 */
function ensureTaskInputSheet(ss) {
  const name = SHEET_NAMES.TASK_INPUT;
  let sheet = ss.getSheetByName(name);
  const headers = ['担当者', '期限', 'タスク内容', '繰返し', '追加', '結果'];

  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#fff3cd');
    sheet.setFrozenRows(1);
    [110, 110, 420, 100, 70, 260].forEach(function(w, i) { sheet.setColumnWidth(i + 1, w); });

    // 使い方の案内行
    sheet.getRange('A2').setNote(
      '🆕 新規タスク追加手順:\n' +
      '① A列: 担当者を選択\n' +
      '② B列: 期限を選択\n' +
      '③ C列: タスク内容を入力\n' +
      '④ D列: 繰返し設定（任意）\n' +
      '⑤ E列にチェック☑ → 自動でタスクシートに追加され、行はクリアされます'
    );

    Logger.log('✅ 「' + name + '」を新規作成');
  } else {
    Logger.log('ℹ️ 「' + name + '」は既存（スキップ）');
  }

  // Data Validation を適用（新規/既存問わず再設定）
  const staffNameRange = ss.getSheetByName(SHEET_NAMES.STAFF_MASTER).getRange('C2:C');
  const MAX = 200;

  sheet.getRange(2, 1, MAX, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(staffNameRange, true).setAllowInvalid(false).build()
  );
  sheet.getRange(2, 2, MAX, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()
  );
  sheet.getRange(2, 4, MAX, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(RECURRENCE_OPTIONS, true).setAllowInvalid(false).build()
  );
  sheet.getRange(2, 5, MAX, 1).insertCheckboxes();

  Logger.log('✅ 「' + name + '」の Data Validation を再適用');
}

/**
 * 新規タスク入力シートの onEdit トリガーを登録
 * ※ シンプル onEdit では openById 等が制限されるため、installable を使う
 */
function setupTaskInputOnEditTrigger() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);

  // 既存の同名トリガーを削除
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'handleTaskInputEdit') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('handleTaskInputEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  Logger.log('✅ handleTaskInputEdit の onEdit トリガーを登録');
}

/**
 * スタッフマスターに「タイムゾーン」「Telegram Username」列を追加
 */
function ensureStaffMasterTzColumn(ss) {
  const sheet = ss.getSheetByName(SHEET_NAMES.STAFF_MASTER);
  if (!sheet) throw new Error('❌ スタッフマスターが未作成。先に setupV7OpsInitial() を実行してください');

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const toAdd = [];
  if (headers.indexOf('タイムゾーン') < 0)         toAdd.push('タイムゾーン');
  if (headers.indexOf('Telegram Username') < 0)   toAdd.push('Telegram Username');
  if (toAdd.length === 0) {
    Logger.log('ℹ️ スタッフマスターに必要列は全て存在（スキップ）');
    return;
  }
  sheet.getRange(1, lastCol + 1, 1, toAdd.length).setValues([toAdd]);
  sheet.getRange(1, lastCol + 1, 1, toAdd.length).setFontWeight('bold').setBackground('#f1f3f4');
  Logger.log('✅ スタッフマスターに列追加: ' + toAdd.join(', '));
}

/**
 * 既存ロンのタイムゾーンを空欄なら Asia/Phnom_Penh で埋める
 */
function backfillRonTimezone() {
  const row = findRow(SHEET_NAMES.STAFF_MASTER, 'スタッフID', 'STAFF-001');
  if (!row) return;
  if (!row.data['タイムゾーン']) {
    updateRow(SHEET_NAMES.STAFF_MASTER, row.row, { 'タイムゾーン': 'Asia/Phnom_Penh' });
    Logger.log('✅ ロンのタイムゾーン=Asia/Phnom_Penh を設定');
  }
  clearStaffMasterCache();
}

/**
 * Admin スタッフ（飯泉・鈴木・五木田）を seed
 * 既に同名のスタッフが居ればスキップ。chat_id と username は空欄で登録（後日手動編集）。
 */
function seedAdminStaff() {
  const admins = [
    { id: 'STAFF-002', nameJp: '飯泉',   memo: 'Admin（日本）' },
    { id: 'STAFF-003', nameJp: '鈴木',   memo: 'Admin（日本・DRIM担当）' },
    { id: 'STAFF-004', nameJp: '五木田', memo: 'Admin（日本）' }
  ];
  const rows = getAllRows(SHEET_NAMES.STAFF_MASTER);

  admins.forEach(function(a) {
    const exists = rows.some(function(r) {
      return String(r['スタッフID']) === a.id || String(r['氏名(JP)']) === a.nameJp;
    });
    if (exists) {
      Logger.log('ℹ️ ' + a.nameJp + ' は登録済み（スキップ）');
      return;
    }
    appendRow(SHEET_NAMES.STAFF_MASTER, {
      'スタッフID':   a.id,
      'Chat ID':      '',
      '氏名(JP)':     a.nameJp,
      'Name(EN)':     '',
      '役割':         'admin',
      'タイムゾーン':    'Asia/Tokyo',
      'Telegram Username': '',
      '雇用形態':     '',
      '入社日':       '',
      '月給(USD)':    0,
      '有効':         true,
      '備考':         a.memo
    });
    Logger.log('✅ ' + a.nameJp + ' を登録');
  });
  clearStaffMasterCache();
}

/**
 * タスクシートを新設（なければ）
 *
 * 列構成:
 *   A: タスクID (TASK-YYYYMMDD-NNN)
 *   B: 作成日時
 *   C: 担当者名(JP)
 *   D: 担当 Chat ID      (field 用。admin は空)
 *   E: 担当 role
 *   F: 担当 timezone
 *   G: 期限 (yyyy-MM-dd)
 *   H: タスク内容
 *   I: ステータス (未着手/完了/未完了/繰返し中)
 *   J: 完了日時
 *   K: 未完了理由
 *   L: 繰返しルール  (RECURRENCE_OPTIONS)
 *   M: 親タスクID    (繰返し元テンプレートID)
 *   N: 関連経費ID    (立替経費との連携 / EXP-YYYYMMDD-NNN)
 */
function ensureTasksSheet(ss) {
  const name = SHEET_NAMES.TASKS;
  let sheet = ss.getSheetByName(name);
  const headers = [
    'タスクID', '作成日時', '担当者名', '担当 Chat ID', '担当 role', '担当 timezone',
    '期限', 'タスク内容', 'ステータス', '完了日時', '未完了理由', '繰返しルール', '親タスクID',
    '関連経費ID'
  ];
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f1f3f4');
    sheet.setFrozenRows(1);
    // 列幅
    [140, 140, 100, 130, 80, 130, 100, 360, 90, 140, 200, 110, 140, 150].forEach(function(w, i) {
      sheet.setColumnWidth(i + 1, w);
    });
    Logger.log('✅ タスクシートを新規作成');
    return;
  }

  // 既存シートなら不足列を追加
  const lastCol = sheet.getLastColumn();
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = headers.filter(function(h) { return existing.indexOf(h) < 0; });
  if (missing.length > 0) {
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, lastCol + 1, 1, missing.length).setFontWeight('bold').setBackground('#f1f3f4');
    Logger.log('✅ タスクシートに列追加: ' + missing.join(', '));
  } else {
    Logger.log('ℹ️ タスクシートのスキーマ完備（スキップ）');
  }
}

/**
 * タスクシートに Data Validation を適用
 * - 担当者名: スタッフマスターの 氏名(JP) 列を参照
 * - 繰返しルール: RECURRENCE_OPTIONS 固定リスト
 * - 期限: 日付ピッカー
 * - ステータス: 固定リスト
 */
function applyTasksSheetValidation(ss) {
  const sheet = ss.getSheetByName(SHEET_NAMES.TASKS);
  const staffSheet = ss.getSheetByName(SHEET_NAMES.STAFF_MASTER);
  if (!sheet || !staffSheet) return;

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const colNum = function(name) { return headers.indexOf(name) + 1; };

  const MAX_ROWS = 2000;
  const startRow = 2;

  // 担当者名: スタッフマスター C列（氏名JP）を参照
  const staffNameRange = staffSheet.getRange('C2:C');
  const staffRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(staffNameRange, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(startRow, colNum('担当者名'), MAX_ROWS, 1).setDataValidation(staffRule);

  // 期限: 日付
  const dateRule = SpreadsheetApp.newDataValidation()
    .requireDate()
    .setAllowInvalid(false)
    .build();
  sheet.getRange(startRow, colNum('期限'), MAX_ROWS, 1).setDataValidation(dateRule);

  // ステータス
  const statusRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['未着手', '完了', '未完了', '繰返し中'], true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(startRow, colNum('ステータス'), MAX_ROWS, 1).setDataValidation(statusRule);

  // 繰返しルール
  const recRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(RECURRENCE_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange(startRow, colNum('繰返しルール'), MAX_ROWS, 1).setDataValidation(recRule);

  Logger.log('✅ タスクシートに Data Validation 適用');
}

/**
 * 繰返しタスクのテンプレートを seed（3件）
 * テンプレート行は「ステータス=繰返し中」「期限=空」で Tasks シートに保存される。
 * 毎日 generateRecurringTasks() がテンプレートをスキャンし、
 * 今日のルールに合致すれば子タスク（期限=今日、ステータス=未着手）を作成する。
 */
function seedRecurringTaskTemplates() {
  const templates = [
    {
      id:     'TEMPLATE-001',
      name:   '飯泉',
      desc:   'ロンさんへ給与支払い',
      rule:   '毎月10日'
    },
    {
      id:     'TEMPLATE-002',
      name:   '飯泉',
      desc:   'オフィス賃料支払い $750-\n⚠️ 毎月1日〜5日までに支払いです（2.3条）。月末ではなく月初払いです。\n7日を過ぎると1日あたり$20のペナルティが発生するので、毎月5日までに忘れず払うようにしましょう。',
      rule:   '毎月1日'
    },
    {
      id:     'TEMPLATE-003',
      name:   '飯泉',
      desc:   '携帯電話代 $4 をロンさんへ渡す',
      rule:   '毎月10日'
    }
  ];

  const existing = getAllRows(SHEET_NAMES.TASKS);
  templates.forEach(function(t) {
    if (existing.some(function(r) { return String(r['タスクID']) === t.id; })) {
      Logger.log('ℹ️ ' + t.id + ' は登録済み（スキップ）');
      return;
    }
    const staff = findStaffByNameJp(t.name);
    if (!staff) {
      Logger.log('⚠️ ' + t.name + ' が スタッフマスターに未登録 — テンプレートを作れません');
      return;
    }
    appendRow(SHEET_NAMES.TASKS, {
      'タスクID':      t.id,
      '作成日時':      new Date(),
      '担当者名':      staff.nameJp,
      '担当 Chat ID':  staff.chatId,
      '担当 role':     staff.role,
      '担当 timezone': staff.timezone,
      '期限':          '',
      'タスク内容':    t.desc,
      'ステータス':    '繰返し中',
      '完了日時':      '',
      '未完了理由':    '',
      '繰返しルール':  t.rule,
      '親タスクID':    ''
    });
    Logger.log('✅ ' + t.id + ' を登録: ' + t.desc.substring(0, 30));
  });
}

// ═══════════════════════════════════════════════════════
// パートナープログラム セットアップ
// ═══════════════════════════════════════════════════════

/**
 * パートナープログラム 初回セットアップ
 *   1. パートナーシート作成
 *   2. 紹介履歴シート作成
 *   3. ステータスの Data Validation 適用
 *
 * ※ Google Form は手動作成。作成後 setupPartnerFormTrigger(formId) でトリガー登録。
 */
function setupPartnerProgram() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🤝 パートナープログラム セットアップ開始');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  ensurePartnerSheet_(ss);
  ensureReferralHistorySheet_(ss);
  applyPartnerValidation_(ss);
  applyReferralHistoryValidation_(ss);

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ パートナー セットアップ完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('');
  Logger.log('⏭️ 次の手順:');
  Logger.log('  1. Google Form を作成（docs/PARTNER_FORM_SETUP.md 参照）');
  Logger.log('  2. Script Properties に ADMIN_PARTNER_THREAD_ID（任意）を登録');
  Logger.log('  3. setupPartnerFormTrigger("フォームID") を実行');
}

function ensurePartnerSheet_(ss) {
  const name = SHEET_NAMES.PARTNERS;
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    const lastCol = sheet.getLastColumn();
    const existing = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
      : [];
    const missing = PARTNER_HEADERS_.filter(function(h) { return existing.indexOf(h) < 0; });
    if (missing.length === 0) {
      Logger.log('ℹ️ 「' + name + '」スキーマ完備（スキップ）');
      return;
    }
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, lastCol + 1, 1, missing.length).setFontWeight('bold').setBackground('#f1f3f4');
    Logger.log('✅ 「' + name + '」に列追加: ' + missing.join(', '));
    return;
  }

  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, PARTNER_HEADERS_.length).setValues([PARTNER_HEADERS_]);
  sheet.getRange(1, 1, 1, PARTNER_HEADERS_.length).setFontWeight('bold').setBackground('#fff4c2');
  sheet.setFrozenRows(1);

  // 列幅（目安）
  const widths = [130, 140, 140, 120,  80, 160, 120, 160, 140, 140, 130, 180, 120, 140, 130, 140, 100, 100, 110, 110, 130, 180, 260];
  widths.forEach(function(w, i) {
    if (i < PARTNER_HEADERS_.length) sheet.setColumnWidth(i + 1, w);
  });

  Logger.log('✅ 「' + name + '」を新規作成');
}

function ensureReferralHistorySheet_(ss) {
  const name = SHEET_NAMES.REFERRAL_HISTORY;
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    const lastCol = sheet.getLastColumn();
    const existing = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
      : [];
    const missing = REFERRAL_HISTORY_HEADERS_.filter(function(h) { return existing.indexOf(h) < 0; });
    if (missing.length === 0) {
      Logger.log('ℹ️ 「' + name + '」スキーマ完備（スキップ）');
      return;
    }
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, lastCol + 1, 1, missing.length).setFontWeight('bold').setBackground('#f1f3f4');
    Logger.log('✅ 「' + name + '」に列追加: ' + missing.join(', '));
    return;
  }

  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, REFERRAL_HISTORY_HEADERS_.length).setValues([REFERRAL_HISTORY_HEADERS_]);
  sheet.getRange(1, 1, 1, REFERRAL_HISTORY_HEADERS_.length).setFontWeight('bold').setBackground('#d4e8ff');
  sheet.setFrozenRows(1);

  const widths = [130, 140, 130, 140, 120, 160, 130, 120, 110, 100, 110, 140, 120, 110, 100, 260];
  widths.forEach(function(w, i) {
    if (i < REFERRAL_HISTORY_HEADERS_.length) sheet.setColumnWidth(i + 1, w);
  });

  Logger.log('✅ 「' + name + '」を新規作成');
}

function applyPartnerValidation_(ss) {
  const sheet = ss.getSheetByName(SHEET_NAMES.PARTNERS);
  if (!sheet) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const col = function(name) { return headers.indexOf(name) + 1; };
  const MAX = 1000;
  const startRow = 2;

  // ステータス
  const statusCol = col('ステータス');
  if (statusCol > 0) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['承認待ち', '承認済み', '却下', '停止'], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(startRow, statusCol, MAX, 1).setDataValidation(rule);
  }

  // 国籍（参考候補）
  const natCol = col('国籍');
  if (natCol > 0) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['日本', 'カンボジア', '中国', '韓国', 'その他'], true)
      .setAllowInvalid(true)
      .build();
    sheet.getRange(startRow, natCol, MAX, 1).setDataValidation(rule);
  }

  // 日付列に書式を適用（Date オブジェクトを appendRow するため）
  const regCol = col('登録日時');
  if (regCol > 0) sheet.getRange(startRow, regCol, MAX, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  const startDateCol = col('契約開始日');
  if (startDateCol > 0) sheet.getRange(startRow, startDateCol, MAX, 1).setNumberFormat('yyyy-mm-dd');
  const endDateCol = col('契約終了日');
  if (endDateCol > 0) sheet.getRange(startRow, endDateCol, MAX, 1).setNumberFormat('yyyy-mm-dd');

  Logger.log('✅ パートナーシートに Data Validation 適用');
}

function applyReferralHistoryValidation_(ss) {
  const sheet = ss.getSheetByName(SHEET_NAMES.REFERRAL_HISTORY);
  if (!sheet) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const col = function(name) { return headers.indexOf(name) + 1; };
  const MAX = 2000;
  const startRow = 2;

  // 支払ステータス
  const payCol = col('支払ステータス');
  if (payCol > 0) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['未払い', '支払済み', '保留'], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(startRow, payCol, MAX, 1).setDataValidation(rule);
  }

  // 支払方法
  const methodCol = col('支払方法');
  if (methodCol > 0) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['ABA', '現金', 'Wing', 'その他'], true)
      .setAllowInvalid(true)
      .build();
    sheet.getRange(startRow, methodCol, MAX, 1).setDataValidation(rule);
  }

  Logger.log('✅ 紹介履歴シートに Data Validation 適用');
}

/**
 * Google Form の onFormSubmit トリガーを登録
 * @param {string} formId Google Form の ID（URL の /d/{ここ}/edit の部分）
 *
 * 使い方:
 *   1. Form を作成（docs/PARTNER_FORM_SETUP.md 参照）
 *   2. Form 編集画面の URL から ID をコピー
 *   3. GAS エディタで setupPartnerFormTrigger('FORM_ID') を実行
 */
function setupPartnerFormTrigger(formId) {
  if (!formId) throw new Error('❌ formId が必要です');

  // 既存トリガーを削除
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'handlePartnerFormSubmit') ScriptApp.deleteTrigger(t);
  });

  const form = FormApp.openById(formId);
  ScriptApp.newTrigger('handlePartnerFormSubmit')
    .forForm(form)
    .onFormSubmit()
    .create();

  Logger.log('✅ handlePartnerFormSubmit の onFormSubmit トリガーを登録 (form=' + formId + ')');
}

function removePartnerFormTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'handlePartnerFormSubmit') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log('🧹 handlePartnerFormSubmit トリガー削除: ' + removed + '件');
}

/**
 * Google Form「Samurai Motors パートナー申請」を自動生成し、onFormSubmit トリガー登録まで一括実行。
 *
 * 【実行方法】 GAS エディタで本関数を選択 → ▶ 実行（1度だけ）
 *
 * 【処理内容】
 *   1. FormApp.create() で新規フォーム作成
 *   2. 15個の質問を PARTNER_FORM_FIELDS_ と完全一致で追加（タイポ防止）
 *   3. 契約条件セクションヘッダー挿入（カンボジアE-Commerce Law準拠）
 *   4. 収集設定（メール収集ON、編集不可、確認メッセージ、進捗バー）
 *   5. onFormSubmit トリガーを自動登録
 *   6. 編集URL・公開URL・フォームIDを Logger に出力
 *
 * ⚠️ 繰り返し実行すると同名のフォームが複製される。1度だけ実行し、再作成が必要な場合は
 *    古いフォームを Drive のゴミ箱に移動してから再実行すること。
 *
 * @returns {Object} { formId, editUrl, publishedUrl, shortUrl }
 */
function createPartnerApplicationForm() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📝 パートナー申請フォーム自動生成開始');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  const form = FormApp.create('Samurai Motors パートナー申請');

  form.setDescription(
    'Samurai Motors 出張洗車サービスのパートナー（紹介制度）にご関心をお寄せいただきありがとうございます。\n\n' +
    '本フォームにご記入いただいた内容をもとに、管理者が内容を確認のうえ承認いたします。\n' +
    '承認完了後、Telegram にて紹介コード・無料体験コード・Welcome Kit をお送りします。\n\n' +
    'ℹ️ 所要時間：約5分\n' +
    'ℹ️ ご質問は管理者までお気軽にお問い合わせください。'
  );

  form.setCollectEmail(true);
  form.setAllowResponseEdits(false);
  form.setShowLinkToRespondAgain(false);
  form.setProgressBar(true);
  form.setConfirmationMessage(
    '✅ 申請を受け付けました。\n' +
    '管理者が内容を確認のうえ、1〜3営業日以内にご連絡いたします。\n\n' +
    'Thank you for your application! We will review and respond within 1-3 business days.'
  );

  // ── セクション1: 基本情報 ───────────────────
  form.addSectionHeaderItem()
    .setTitle('① 基本情報 / Basic Information');

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.NAME)
    .setHelpText('パスポート・IDカード記載の正式なフルネーム')
    .setRequired(true);

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.DISPLAY_NAME)
    .setHelpText('紹介時に呼ばれたい名前（空欄の場合は本名を使用）')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle(PARTNER_FORM_FIELDS_.NATIONALITY)
    .setChoiceValues(['日本', 'カンボジア', '中国', '韓国', 'その他'])
    .setRequired(true);

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.COMPANY)
    .setRequired(false);

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.TITLE)
    .setHelpText('例: CEO / 代表 / 店長 / フリーランス')
    .setRequired(false);

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.COMMUNITY)
    .setHelpText('例: カンボジア日本人会、JETRO、ロータリー、カンボジア華僑連合会 など')
    .setRequired(false);

  // ── セクション2: 連絡先 ───────────────────
  form.addSectionHeaderItem()
    .setTitle('② 連絡先 / Contact Information');

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.PHONE)
    .setHelpText('国番号付き推奨。例: +855 12 345 678')
    .setRequired(true);

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.TELEGRAM)
    .setHelpText('@ は不要（例: yamadataro）。承認後の DM 連絡に使用します。')
    .setRequired(true);

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.EMAIL)
    .setRequired(false);

  // ── セクション3: 送金先（ABA） ───────────────────
  form.addSectionHeaderItem()
    .setTitle('③ コミッション送金先 / Payout (ABA Bank)')
    .setHelpText('毎月のコミッションは ABA 銀行口座へ送金します。');

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.ABA_ACCOUNT)
    .setRequired(true);

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.ABA_NAME)
    .setHelpText('パスポート記載どおり（半角英大文字推奨。例: YAMADA TARO）')
    .setRequired(true);

  // ── セクション4: 紹介コード希望 ───────────────────
  form.addSectionHeaderItem()
    .setTitle('④ 紹介コード希望 / Referral Code Preference');

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.CODE_HINT)
    .setHelpText('4〜12文字の英数字。例: YAMADA → SM-YAMADA となります。空欄の場合は自動生成。')
    .setRequired(false);

  form.addTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.REFERRER_SOURCE)
    .setHelpText('集客施策の分析に使わせていただきます')
    .setRequired(false);

  // ── セクション5: 契約条件（必読） ───────────────────
  form.addSectionHeaderItem()
    .setTitle('⑤ 契約条件 / Terms & Conditions')
    .setHelpText(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      'Samurai Motors パートナー契約条件\n' +
      'Samurai Motors Partner Terms\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      '1. 役割\n' +
      'パートナーは Samurai Motors の出張洗車サービスを知人・顧客に紹介します。\n\n' +
      '2. コミッション\n' +
      '紹介コード経由で成約した売上の 30% を、月末締め・翌月 ABA 送金します。\n\n' +
      '3. 帰属判定\n' +
      'お客さまが予約時に紹介コードを伝えた時点でパートナー実績として記録されます。複数パートナーが関与した場合は、最初にコードを伝えたパートナーが対象となります。\n\n' +
      '4. 初回限定\n' +
      'コミッション対象はお客さまの「初回ご利用分のみ」です。\n\n' +
      '5. 支払\n' +
      '翌月10日までに ABA 口座へ送金。金額 $10未満の場合は翌月繰越とします。\n\n' +
      '6. 対象外\n' +
      'Samurai Motors の既存顧客（過去利用あり）の再紹介は対象外です。\n\n' +
      '7. 契約期間\n' +
      '承認日から 6ヶ月（以降、両者同意により自動更新）。\n\n' +
      '8. 税金\n' +
      '受け取るコミッションに係る税金はパートナー自身の責任で処理してください。\n\n' +
      '9. 守秘義務\n' +
      '受け取った顧客情報は第三者に開示しません。\n\n' +
      '10. 解約\n' +
      '両者は 30日前の通知で解約できます。Samurai Motors は違反時に即時解約できます。\n\n' +
      '11. 改訂\n' +
      '条件変更時は1ヶ月前に通知します。\n\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      'ℹ️ カンボジア E-Commerce Law 2019 第48条により、本フォームでの同意は電子契約として有効です。'
    );

  form.addCheckboxItem()
    .setTitle(PARTNER_FORM_FIELDS_.TERMS_AGREE)
    .setChoiceValues(['同意します / I agree'])
    .setRequired(true);

  // ── セクション6: その他 ───────────────────
  form.addSectionHeaderItem()
    .setTitle('⑥ その他 / Additional Notes');

  form.addParagraphTextItem()
    .setTitle(PARTNER_FORM_FIELDS_.NOTES)
    .setHelpText('質問・ご要望などご自由にご記入ください。')
    .setRequired(false);

  // フォーム情報を取得
  const formId = form.getId();
  const editUrl = form.getEditUrl();
  const publishedUrl = form.getPublishedUrl();
  let shortUrl = publishedUrl;
  try {
    shortUrl = form.shortenFormUrl(publishedUrl);
  } catch (err) {
    Logger.log('⚠️ 短縮URL生成失敗（無視可）: ' + err);
  }

  // onFormSubmit トリガーを自動登録
  try {
    setupPartnerFormTrigger(formId);
  } catch (err) {
    Logger.log('⚠️ トリガー登録に失敗: ' + err);
    Logger.log('   → 手動で setupPartnerFormTrigger("' + formId + '") を実行してください');
  }

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ フォーム自動生成完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('フォームID:     ' + formId);
  Logger.log('編集URL:        ' + editUrl);
  Logger.log('公開URL(長):    ' + publishedUrl);
  Logger.log('公開URL(短):    ' + shortUrl);
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('次のステップ:');
  Logger.log('  1. 編集URL を開いて見た目を確認');
  Logger.log('  2. debugMockPartnerFormSubmit() でテスト送信（任意）');
  Logger.log('  3. 公開URL(短) を候補者に配布');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  return {
    formId: formId,
    editUrl: editUrl,
    publishedUrl: publishedUrl,
    shortUrl: shortUrl
  };
}

// ============================================================
//  撥水コーティング無料モニター施策 セットアップ
// ============================================================

/**
 * 撥水モニター施策の初回セットアップ
 *
 *   1. 「撥水モニター」シート作成
 *   2. Data Validation 適用
 *   3. 申込フォーム自動生成（onFormSubmit トリガー含む）
 *   4. アンケートフォーム自動生成（onFormSubmit トリガー含む）
 *   5. 雨季フォローアップの週次トリガー登録
 *
 * 【実行方法】 GAS エディタで本関数を選択 → ▶ 実行（1度だけ）
 *
 * @returns {Object} { sheet, monitorForm, surveyForm }
 */
function setupWaterRepellentSystem() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('💧 撥水モニター施策 セットアップ開始');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  // 1. シート
  ensureWaterRepellentSheet_(ss);
  applyWaterRepellentValidation_(ss);

  // 2. 申込フォーム
  Logger.log('');
  Logger.log('📝 ステップ1: 申込フォーム生成');
  const monitorForm = createWaterRepellentMonitorForm();

  // 3. アンケートフォーム
  Logger.log('');
  Logger.log('📋 ステップ2: アンケートフォーム生成');
  const surveyForm = createWaterRepellentSurveyForm();

  // 4. 雨季フォローアップ週次トリガー
  Logger.log('');
  Logger.log('⏰ ステップ3: 週次フォローアップトリガー登録');
  setupWaterRepellentFollowUpTrigger();

  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ 撥水モニター施策 セットアップ完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('');
  Logger.log('⏭️ 次の手順:');
  Logger.log('  1. 申込URL を Telegram / Email でターゲットに配布');
  Logger.log('     → ' + monitorForm.shortUrl);
  Logger.log('  2. アンケートURL は雨季中に自動配信されるため共有不要');
  Logger.log('     → ' + surveyForm.shortUrl);
  Logger.log('  3. 撥水トピック ID を ADMIN_WATER_REPELLENT_THREAD_ID に登録（任意）');
  Logger.log('  4. debugMockWaterRepellentFormSubmit() でテスト送信');

  return { monitorForm: monitorForm, surveyForm: surveyForm };
}

function ensureWaterRepellentSheet_(ss) {
  const name = SHEET_NAMES.WATER_REPELLENT;
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    const lastCol = sheet.getLastColumn();
    const existing = lastCol > 0
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
      : [];
    const missing = WATER_REPELLENT_HEADERS_.filter(function(h) { return existing.indexOf(h) < 0; });
    if (missing.length === 0) {
      Logger.log('ℹ️ 「' + name + '」スキーマ完備（スキップ）');
      return;
    }
    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, lastCol + 1, 1, missing.length).setFontWeight('bold').setBackground('#cfe9ff');
    Logger.log('✅ 「' + name + '」に列追加: ' + missing.join(', '));
    return;
  }

  sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, WATER_REPELLENT_HEADERS_.length).setValues([WATER_REPELLENT_HEADERS_]);
  sheet.getRange(1, 1, 1, WATER_REPELLENT_HEADERS_.length).setFontWeight('bold').setBackground('#cfe9ff');
  sheet.setFrozenRows(1);

  // 列幅（目安）
  const widths = [
    130, 140,            // モニターID, 申込日時
    160, 130, 180,       // 会社名, 経営者氏名, 経営者連絡先
    130, 160,            // ドライバー氏名, ドライバー連絡先
    180, 140,            // 車種・色, ナンバープレート
    110, 110, 180,       // 希望日, 第2希望日, 希望時間帯
    110, 140, 140, 110,  // ステータス, 予約確定日時, 施工日時, 施工担当
    140, 140,            // アンケート送付日, アンケート回答日
    100, 130, 130,       // 視界改善評価, リピート意向, 紹介意向
    260,                 // 経営者の反応
    160, 110, 260        // 紹介元, パートナー化候補, 備考
  ];
  widths.forEach(function(w, i) {
    if (i < WATER_REPELLENT_HEADERS_.length) sheet.setColumnWidth(i + 1, w);
  });

  Logger.log('✅ 「' + name + '」を新規作成');
}

function applyWaterRepellentValidation_(ss) {
  const sheet = ss.getSheetByName(SHEET_NAMES.WATER_REPELLENT);
  if (!sheet) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const col = function(name) { return headers.indexOf(name) + 1; };
  const MAX = 1000;
  const startRow = 2;

  // ステータス
  const statusCol = col('ステータス');
  if (statusCol > 0) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['申込', '予約確定', '施工完了', 'フォロー済み', 'キャンセル', '匿名アンケート'], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(startRow, statusCol, MAX, 1).setDataValidation(rule);
  }

  // 希望時間帯
  const slotCol = col('希望時間帯');
  if (slotCol > 0) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList([
        '午前 10:00〜12:00 / Morning',
        '午後 13:00〜16:00 / Afternoon',
        'どちらでも可 / Either is fine'
      ], true)
      .setAllowInvalid(true)
      .build();
    sheet.getRange(startRow, slotCol, MAX, 1).setDataValidation(rule);
  }

  // リピート/紹介意向
  ['リピート意向', '紹介意向'].forEach(function(h) {
    const c = col(h);
    if (c > 0) {
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInList(['ぜひ', 'たぶん', '不要', '未回答'], true)
        .setAllowInvalid(true)
        .build();
      sheet.getRange(startRow, c, MAX, 1).setDataValidation(rule);
    }
  });

  // 視界改善評価
  const visCol = col('視界改善評価');
  if (visCol > 0) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['1', '2', '3', '4', '5'], true)
      .setAllowInvalid(true)
      .build();
    sheet.getRange(startRow, visCol, MAX, 1).setDataValidation(rule);
  }

  // パートナー化候補（チェックボックス）
  const candCol = col('パートナー化候補');
  if (candCol > 0) {
    const rule = SpreadsheetApp.newDataValidation()
      .requireCheckbox()
      .build();
    sheet.getRange(startRow, candCol, MAX, 1).setDataValidation(rule);
  }

  // 日付列の書式
  ['申込日時', '予約確定日時', '施工日時', 'アンケート送付日', 'アンケート回答日'].forEach(function(h) {
    const c = col(h);
    if (c > 0) sheet.getRange(startRow, c, MAX, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  });

  Logger.log('✅ 撥水モニターシートに Data Validation 適用');
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
