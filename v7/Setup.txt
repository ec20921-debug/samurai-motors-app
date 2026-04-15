/**
 * Samurai Motors v7 — 初期セットアップスクリプト（日本語版）
 *
 * 使い方：
 *   1. GASエディタ（Samurai Motors v7）にこのファイルを貼り付け
 *   2. 保存（Ctrl+S）
 *   3. 関数選択プルダウンで `setupV7Initial` を選んで ▶ 実行
 *   4. 初回実行時は権限リクエスト画面が出るので「許可」
 *
 * このスクリプトは冪等（何度実行してもOK）。既存シートは上書きせず、列ヘッダーのみ再設定します。
 */

// ====== シート名定数（コード参照用） ======
const SHEETS = {
  CUSTOMERS:  '顧客',
  BOOKINGS:   '予約',
  VEHICLES:   '車両',
  JOBS:       '作業記録',
  STAFF:      'スタッフ',
  CHAT_LOG:   'チャット履歴',
  QR_CODES:   'QRコード',
  PLAN_PRICES:'料金設定'
};

// ====== シートヘッダー定義（日本語） ======
const SHEET_DEFINITIONS = {
  '顧客': [
    '顧客ID', 'チャットID', 'ユーザー名', '氏名', '電話番号',
    '言語', 'トピックID', '登録日時', '最終連絡日時'
  ],
  '予約': [
    '予約ID', '顧客ID', 'チャットID', '車種タイプ', '車種名',
    'プラン', 'オプション', '予約日', '予約時刻', '所要時間(分)',
    '料金(USD)', '進行状態', '緯度', '経度', '住所',
    '場所補足', 'マップリンク', 'カレンダーID', '予約登録日時',
    '決済状態', '請求額(USD)', 'スクショURL', '入金確認日時',
    'QR送信日時', '催促回数', '最終催促日時', '管理者メモ'
  ],
  '車両': [
    '顧客ID', '車種タイプ', '車種名', 'ナンバー', '車両写真URL'
  ],
  '作業記録': [
    'ジョブID', '予約ID', 'スタッフID', 'スタッフ名', '作業状態',
    '開始時刻', '完了時刻', 'Before写真URL', 'After写真URL'
  ],
  'スタッフ': [
    'スタッフID', 'クメール語名', '日本語名', '有効'
  ],
  'チャット履歴': [
    '日時', '方向', 'チャットID', 'トピックID',
    'メッセージ種別', '内容', '管理者ID'
  ],
  'QRコード': [
    'QR ID', '画像URL', '説明', '銀行名',
    '有効', '登録日', '無効化日'
  ],
  '料金設定': [
    'プラン名', 'セダン価格(USD)', 'SUV価格(USD)',
    'セダン所要時間(分)', 'SUV所要時間(分)', '備考'
  ]
};

// ====== 初期データ ======
const PLAN_PRICES_INITIAL_DATA = [
  ['清 KIYOME (A)',           12, 15, 30, 45, '無水洗車＋タイヤワックス＋エアチェック'],
  ['鏡 KAGAMI (B)',           17, 20, 40, 55, 'A+前3面ガラス撥水（簡易）'],
  ['匠 TAKUMI (C)',           20, 23, 50, 65, 'A+全面ガラス撥水（簡易）'],
  ['将軍 SHOGUN (D)',         32, 35, 80, 95, 'A+全面油膜落とし+全面ガラス撥水'],
  ['出張料',                   2,  2, '', '', '全プラン共通で加算（キャンペーン時はここを変更）'],
  ['【設定】移動バッファ(分)', 30, '', '', '', '洗車と洗車の間の移動時間'],
  ['【設定】営業開始時刻',      9, '', '', '', '例: 9 = 9:00'],
  ['【設定】営業終了時刻',     18, '', '', '', '例: 18 = 18:00']
];

const STAFF_INITIAL_DATA = [
  ['', '', 'ロン', true]   // スタッフID, クメール語名 は後で追記
];

// ====== プルダウン選択肢（日本語） ======
const DROPDOWNS = {
  BOOKING_STATUS:         ['予約確定', '作業中', '作業完了', 'キャンセル'],
  BOOKING_PAYMENT_STATUS: ['未清算', 'QR送信済み', '清算済み', '要確認'],
  VEHICLE_TYPE:           ['セダン', 'SUV'],
  BOOKING_PLAN:           ['清 KIYOME (A)', '鏡 KAGAMI (B)', '匠 TAKUMI (C)', '将軍 SHOGUN (D)'],
  JOB_STATUS:             ['割当済', '作業中', '完了'],
  LANGUAGE:               ['クメール語', '英語'],
  CHAT_DIRECTION:         ['顧客→管理', '管理→顧客'],
  MESSAGE_TYPE:           ['テキスト', '写真', '動画', '位置情報', 'ドキュメント']
};

// ====== Drive フォルダ名 ======
const DRIVE_FOLDERS = [
  '洗車写真',
  'QRコード画像',
  '決済スクショ'
];

// ====== メイン関数 ======
function setupV7Initial() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Logger.log('🚀 Samurai Motors v7 初期セットアップ開始');
  Logger.log('📊 スプレッドシート: ' + ss.getName());

  createOrUpdateAllSheets(ss);
  seedPlanPrices(ss);
  seedStaff(ss);
  setupDataValidations(ss);
  setupConditionalFormatting(ss);
  deleteDefaultSheet1(ss);
  const folders = createDriveFolders();

  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ セットアップ完了');
  Logger.log('📁 Drive フォルダ:');
  folders.forEach(function(f) { Logger.log('   - ' + f.name + ' (' + f.url + ')'); });
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📋 次のステップ:');
  Logger.log('   1. スプレッドシートのタブを確認（8シート揃っているか）');
  Logger.log('   2. 料金設定に初期データが入っているか確認');
  Logger.log('   3. Drive に 3 つのフォルダが作成されたか確認');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ====== シート作成 ======
function createOrUpdateAllSheets(ss) {
  Object.keys(SHEET_DEFINITIONS).forEach(function(sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      Logger.log('✨ シート作成: ' + sheetName);
    } else {
      Logger.log('♻️ 既存シート: ' + sheetName);
    }

    var headers = SHEET_DEFINITIONS[sheetName];

    // ヘッダーを常に上書き
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

    // ヘッダー装飾
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground('#1e3a8a');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
    headerRange.setHorizontalAlignment('center');

    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, headers.length);
  });
}

// ====== 料金設定 初期データ ======
function seedPlanPrices(ss) {
  var sheet = ss.getSheetByName(SHEETS.PLAN_PRICES);
  if (sheet.getLastRow() >= 2) {
    Logger.log('♻️ 料金設定は既にデータあり、スキップ');
    return;
  }
  sheet.getRange(2, 1, PLAN_PRICES_INITIAL_DATA.length, PLAN_PRICES_INITIAL_DATA[0].length)
    .setValues(PLAN_PRICES_INITIAL_DATA);
  Logger.log('💰 料金設定 初期データ投入: ' + PLAN_PRICES_INITIAL_DATA.length + '行');
}

// ====== スタッフ 初期データ ======
function seedStaff(ss) {
  var sheet = ss.getSheetByName(SHEETS.STAFF);
  if (sheet.getLastRow() >= 2) {
    Logger.log('♻️ スタッフは既にデータあり、スキップ');
    return;
  }
  sheet.getRange(2, 1, STAFF_INITIAL_DATA.length, STAFF_INITIAL_DATA[0].length)
    .setValues(STAFF_INITIAL_DATA);
  Logger.log('👷 スタッフ 初期データ投入: ロン');
}

// ====== プルダウン（データ検証）設定 ======
function setupDataValidations(ss) {
  // 予約シート
  applyDropdown(ss, SHEETS.BOOKINGS, 12, DROPDOWNS.BOOKING_STATUS);          // L列: 進行状態
  applyDropdown(ss, SHEETS.BOOKINGS, 20, DROPDOWNS.BOOKING_PAYMENT_STATUS);  // T列: 決済状態
  applyDropdown(ss, SHEETS.BOOKINGS,  4, DROPDOWNS.VEHICLE_TYPE);            // D列: 車種タイプ
  applyDropdown(ss, SHEETS.BOOKINGS,  6, DROPDOWNS.BOOKING_PLAN);            // F列: プラン

  // 車両シート
  applyDropdown(ss, SHEETS.VEHICLES,  2, DROPDOWNS.VEHICLE_TYPE);            // B列: 車種タイプ

  // 作業記録シート
  applyDropdown(ss, SHEETS.JOBS,      5, DROPDOWNS.JOB_STATUS);              // E列: 作業状態

  // スタッフシート
  applyCheckbox(ss, SHEETS.STAFF,     4);                                    // D列: 有効

  // QRコードシート
  applyCheckbox(ss, SHEETS.QR_CODES,  5);                                    // E列: 有効

  // 顧客シート
  applyDropdown(ss, SHEETS.CUSTOMERS, 6, DROPDOWNS.LANGUAGE);                // F列: 言語

  // チャット履歴シート
  applyDropdown(ss, SHEETS.CHAT_LOG,  2, DROPDOWNS.CHAT_DIRECTION);          // B列: 方向
  applyDropdown(ss, SHEETS.CHAT_LOG,  5, DROPDOWNS.MESSAGE_TYPE);            // E列: メッセージ種別

  Logger.log('✅ プルダウン設定完了');
}

function applyDropdown(ss, sheetName, col, values) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  var range = sheet.getRange(2, col, 1000, 1);
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(false)
    .build();
  range.setDataValidation(rule);
}

function applyCheckbox(ss, sheetName, col) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return;
  var range = sheet.getRange(2, col, 1000, 1);
  var rule = SpreadsheetApp.newDataValidation()
    .requireCheckbox()
    .build();
  range.setDataValidation(rule);
}

// ====== 条件付き書式（色分け） ======
function setupConditionalFormatting(ss) {
  var sheet = ss.getSheetByName(SHEETS.BOOKINGS);
  if (!sheet) return;
  sheet.clearConditionalFormatRules();

  var paymentStatusRange = sheet.getRange('T2:T1000');
  var statusRange = sheet.getRange('L2:L1000');

  var rules = [
    // ─ 決済状態（T列） ─
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('未清算').setBackground('#fecaca')
      .setRanges([paymentStatusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('QR送信済み').setBackground('#fef3c7')
      .setRanges([paymentStatusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('清算済み').setBackground('#bbf7d0')
      .setRanges([paymentStatusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('要確認').setBackground('#fed7aa')
      .setFontColor('#9a3412').setBold(true)
      .setRanges([paymentStatusRange]).build(),

    // ─ 進行状態（L列） ─
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('キャンセル').setBackground('#e5e7eb').setFontColor('#6b7280')
      .setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('作業中').setBackground('#dbeafe')
      .setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo('作業完了').setBackground('#d1fae5')
      .setRanges([statusRange]).build()
  ];

  sheet.setConditionalFormatRules(rules);
  Logger.log('🎨 条件付き書式設定完了');
}

// ====== デフォルトシート「シート1」削除 ======
function deleteDefaultSheet1(ss) {
  var sheet = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (sheet && ss.getSheets().length > 1) {
    ss.deleteSheet(sheet);
    Logger.log('🗑️ デフォルトシート「シート1」を削除');
  }
}

// ====== Drive フォルダ作成 ======
// ====== 旧 Plan_Prices シートから 料金設定 へデータ移行 ======
function migratePlanPrices() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var oldSheet = ss.getSheetByName('Plan_Prices');
  var newSheet = ss.getSheetByName(SHEETS.PLAN_PRICES);

  if (!oldSheet) {
    Logger.log('⚠️ 旧 Plan_Prices シートが見つかりません');
    return;
  }
  if (!newSheet) {
    Logger.log('⚠️ 料金設定 シートが見つかりません。先に setupV7Initial を実行してください');
    return;
  }

  // 旧シートの2行目以降のデータを取得
  var lastRow = oldSheet.getLastRow();
  var lastCol = oldSheet.getLastColumn();
  if (lastRow < 2) {
    Logger.log('⚠️ 旧 Plan_Prices にデータがありません');
    return;
  }

  var data = oldSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  Logger.log('📥 旧 Plan_Prices から ' + data.length + '行取得');

  // 新シートに転記（2行目から）
  newSheet.getRange(2, 1, data.length, data[0].length).setValues(data);
  Logger.log('📤 料金設定 へ転記完了');

  // 旧シートを削除
  ss.deleteSheet(oldSheet);
  Logger.log('🗑️ 旧 Plan_Prices シートを削除');

  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ 料金データ移行完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

function createDriveFolders() {
  var results = [];
  DRIVE_FOLDERS.forEach(function(name) {
    var folders = DriveApp.getFoldersByName(name);
    var folder;
    if (folders.hasNext()) {
      folder = folders.next();
      Logger.log('♻️ 既存フォルダ: ' + name);
    } else {
      folder = DriveApp.createFolder(name);
      Logger.log('📁 フォルダ作成: ' + name);
    }
    results.push({ name: name, url: folder.getUrl() });
  });
  return results;
}
