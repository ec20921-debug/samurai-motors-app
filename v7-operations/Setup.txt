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
