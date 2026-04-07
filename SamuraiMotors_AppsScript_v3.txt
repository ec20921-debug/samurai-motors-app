// ╔══════════════════════════════════════════════════════════════╗
// ║  Samurai Motors - 業務管理 Apps Script v3                    ║
// ║  ジョブ管理 + 在庫管理 統合版                                  ║
// ╠══════════════════════════════════════════════════════════════╣
// ║                                                              ║
// ║  【更新手順】                                                 ║
// ║  ① Apps Script エディタで既存コードを全て削除                  ║
// ║  ② このコードを貼り付け → Ctrl+S で保存                      ║
// ║  ③ 「デプロイ」→「デプロイを管理」→ 鉛筆アイコン              ║
// ║  ④ バージョン「新しいバージョン」→「デプロイ」                 ║
// ║  ※ URLは変わりません。HTMLの変更は不要です。                    ║
// ║                                                              ║
// ╚══════════════════════════════════════════════════════════════╝

// Google Driveに写真保存用フォルダ名
var PHOTO_FOLDER_NAME = 'SamuraiMotors_Photos';

// 在庫管理シート名
var INVENTORY_SHEET_NAME = 'Inventory';

// ═══════════════════════════════════════════
//  メインルーター：action で処理を振り分け
// ═══════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action || 'job';

    switch (action) {
      case 'job':
        return handleJobSubmit(data);
      case 'inventory_get':
        return handleInventoryGet();
      case 'inventory_update':
        return handleInventoryUpdate(data);
      case 'inventory_add':
        return handleInventoryAdd(data);
      case 'inventory_delete':
        return handleInventoryDelete(data);
      default:
        return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });
    }
  } catch (error) {
    Logger.log('doPost error: ' + error.toString());
    return jsonResponse({ status: 'error', message: error.toString() });
  }
}

// GETリクエスト：在庫一覧を返す（読み取り用）
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'status';

  if (action === 'inventory') {
    return handleInventoryGet();
  }

  return ContentService
    .createTextOutput('Samurai Motors Job Manager v3 is active.')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ═══════════════════════════════════════════
//  ジョブ管理（既存v2からの移行）
// ═══════════════════════════════════════════

function handleJobSubmit(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0]; // 最初のシート = ジョブ管理

  // ヘッダー行が無ければ作成
  if (sheet.getLastRow() === 0) {
    var headers = [
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
      'ប្រើប្រាស់សម្ភារៈ（使用資材）'
    ];
    sheet.appendRow(headers);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#c8102e');
    headerRange.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 100);
    for (var c = 2; c <= 15; c++) sheet.setColumnWidth(c, 140);
    for (var c = 16; c <= 24; c++) sheet.setColumnWidth(c, 180);
  }

  // Job ID生成: SM-YYYYMMDD-001
  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');
  var jobId = 'SM-' + dateStr + '-' + String(sheet.getLastRow()).padStart(3, '0');

  // タイムスタンプ変換（カンボジア時間）
  var registered = data.registered ? formatCambodiaTime(new Date(data.registered)) : '';
  var startTime = data.startTime ? formatCambodiaTime(new Date(data.startTime)) : '';
  var endTime = data.endTime ? formatCambodiaTime(new Date(data.endTime)) : '';

  // 写真をGoogle Driveに保存
  var beforeLinks = ['','','',''];
  var afterLinks = ['','','',''];

  try {
    if ((data.beforePhotos && data.beforePhotos.length > 0) ||
        (data.afterPhotos && data.afterPhotos.length > 0)) {

      var parentFolder = getOrCreateFolder(PHOTO_FOLDER_NAME);
      var jobFolder = parentFolder.createFolder(jobId + '_' + (data.name || 'unknown'));

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
    }
  } catch (photoErr) {
    Logger.log('Photo save error: ' + photoErr.toString());
  }

  // 使用資材の文字列化
  var usedMaterials = '';
  if (data.usedMaterials && data.usedMaterials.length > 0) {
    usedMaterials = data.usedMaterials.map(function(m) {
      return m.name + ' x' + m.qty;
    }).join(', ');
  }

  // データ行を追加
  sheet.appendRow([
    jobId,
    registered,
    data.name || '',
    data.phone || '',
    data.building || '',
    data.room || '',
    data.carModel || '',
    data.plate || '',
    data.plan || '',
    data.mapUrl || '',
    data.notes || '',
    data.scheduled || '',
    startTime,
    endTime,
    data.duration || '',
    beforeLinks[0],
    beforeLinks[1],
    beforeLinks[2],
    beforeLinks[3],
    afterLinks[0],
    afterLinks[1],
    afterLinks[2],
    afterLinks[3],
    usedMaterials
  ]);

  // 使用資材があれば在庫を減算
  if (data.usedMaterials && data.usedMaterials.length > 0) {
    try {
      deductInventory(data.usedMaterials);
    } catch (invErr) {
      Logger.log('Inventory deduct error: ' + invErr.toString());
    }
  }

  return jsonResponse({ status: 'ok', jobId: jobId });
}

// ═══════════════════════════════════════════
//  在庫管理
// ═══════════════════════════════════════════

// 在庫シートを取得（なければ作成）
function getInventorySheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INVENTORY_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(INVENTORY_SHEET_NAME);
    var headers = [
      'Item ID',
      'ឈ្មោះផលិតផល（品名）',
      'ប្រភេទ（カテゴリ）',
      'ចំនួនបច្ចុប្បន្ន（現在庫数）',
      'ឯកតា（単位）',
      'កម្រិតព្រមាន（発注閾値）',
      'កាលបរិច្ឆេទធ្វើបច្ចុប្បន្នភាព（最終更新）'
    ];
    sheet.appendRow(headers);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#c9a84c');
    headerRange.setFontColor('#000000');
    sheet.setFrozenRows(1);

    // 初期データ投入
    var initialData = [
      ['INV-001', 'សាប៊ូលាងឡាន（洗車シャンプー）', 'រាវ（液体）', 8, 'ដប（本）', 3, ''],
      ['INV-002', 'ទឹកថ្នាំកូត（コーティング剤）', 'រាវ（液体）', 5, 'ដប（本）', 2, ''],
      ['INV-003', 'ទឹកថ្នាំបង្ហូរទឹក（撥水スプレー）', 'រាវ（液体）', 2, 'ដប（本）', 3, ''],
      ['INV-004', 'កន្សែងម៉ៃក្រូហ្វាយប័រ（マイクロファイバータオル）', 'ក្រណាត់（布）', 15, 'សន្លឹក（枚）', 5, ''],
      ['INV-005', 'អេប៉ុង（洗車スポンジ）', 'ឧបករណ៍（道具）', 6, 'ដុំ（個）', 3, '']
    ];

    initialData.forEach(function(row) {
      row[6] = formatCambodiaTime(new Date());
      sheet.appendRow(row);
    });
  }

  return sheet;
}

// 在庫一覧を取得
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
      id: row[0],
      name: row[1],
      category: row[2],
      qty: row[3],
      unit: row[4],
      threshold: row[5],
      updated: row[6]
    };
  });

  return jsonResponse({ status: 'ok', items: items });
}

// 在庫数量を更新（+/-）
function handleInventoryUpdate(data) {
  var sheet = getInventorySheet();
  var itemId = data.itemId;
  var delta = data.delta || 0;

  var lastRow = sheet.getLastRow();
  for (var r = 2; r <= lastRow; r++) {
    if (sheet.getRange(r, 1).getValue() === itemId) {
      var currentQty = sheet.getRange(r, 4).getValue();
      var newQty = Math.max(0, currentQty + delta);
      sheet.getRange(r, 4).setValue(newQty);
      sheet.getRange(r, 7).setValue(formatCambodiaTime(new Date()));

      // 閾値チェック
      var threshold = sheet.getRange(r, 6).getValue();
      var alert = null;
      if (newQty <= 0) {
        alert = 'out_of_stock';
      } else if (newQty <= threshold) {
        alert = 'low_stock';
      }

      return jsonResponse({
        status: 'ok',
        itemId: itemId,
        newQty: newQty,
        alert: alert
      });
    }
  }

  return jsonResponse({ status: 'error', message: 'Item not found: ' + itemId });
}

// 在庫品目を追加
function handleInventoryAdd(data) {
  var sheet = getInventorySheet();

  // 次のIDを生成
  var lastRow = sheet.getLastRow();
  var nextNum = 1;
  if (lastRow >= 2) {
    var lastId = sheet.getRange(lastRow, 1).getValue();
    var match = lastId.toString().match(/INV-(\d+)/);
    if (match) nextNum = parseInt(match[1]) + 1;
  }
  var newId = 'INV-' + String(nextNum).padStart(3, '0');

  sheet.appendRow([
    newId,
    data.name || '',
    data.category || '',
    data.qty || 0,
    data.unit || '',
    data.threshold || 3,
    formatCambodiaTime(new Date())
  ]);

  return jsonResponse({ status: 'ok', itemId: newId });
}

// 在庫品目を削除
function handleInventoryDelete(data) {
  var sheet = getInventorySheet();
  var itemId = data.itemId;
  var lastRow = sheet.getLastRow();

  for (var r = 2; r <= lastRow; r++) {
    if (sheet.getRange(r, 1).getValue() === itemId) {
      sheet.deleteRow(r);
      return jsonResponse({ status: 'ok', deleted: itemId });
    }
  }

  return jsonResponse({ status: 'error', message: 'Item not found: ' + itemId });
}

// ジョブ完了時に在庫を減算
function deductInventory(usedMaterials) {
  var sheet = getInventorySheet();
  var lastRow = sheet.getLastRow();

  usedMaterials.forEach(function(material) {
    for (var r = 2; r <= lastRow; r++) {
      if (sheet.getRange(r, 1).getValue() === material.id) {
        var currentQty = sheet.getRange(r, 4).getValue();
        var newQty = Math.max(0, currentQty - material.qty);
        sheet.getRange(r, 4).setValue(newQty);
        sheet.getRange(r, 7).setValue(formatCambodiaTime(new Date()));
        break;
      }
    }
  });
}

// ═══════════════════════════════════════════
//  ユーティリティ
// ═══════════════════════════════════════════

// JSONレスポンスを返す
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// カンボジア時間にフォーマット
function formatCambodiaTime(date) {
  return Utilities.formatDate(date, 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss');
}

// Google Driveフォルダの取得 or 作成
function getOrCreateFolder(folderName) {
  var folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}

// Base64画像をDriveに保存してリンクを返す
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
//  テスト関数
// ═══════════════════════════════════════════

function testInventoryGet() {
  var result = handleInventoryGet();
  Logger.log(result.getContent());
}

function testJobSubmit() {
  var testData = {
    action: 'job',
    registered: new Date().toISOString(),
    name: 'Test Customer',
    phone: '012 345 678',
    building: 'Time Square 3 (TS3)',
    room: '12F',
    carModel: 'Toyota Camry',
    plate: '2A-1234',
    plan: '鏡 KAGAMI ($17/$20)',
    mapUrl: 'https://www.google.com/maps?q=11.5564,104.9282',
    notes: 'テスト',
    scheduled: '2026-04-07 10:00',
    startTime: new Date().toISOString(),
    endTime: new Date(Date.now() + 3600000).toISOString(),
    duration: 60,
    beforePhotos: [],
    afterPhotos: [],
    usedMaterials: [
      { id: 'INV-001', name: 'សាប៊ូលាងឡាន（洗車シャンプー）', qty: 1 },
      { id: 'INV-004', name: 'កន្សែងម៉ៃក្រូហ្វាយប័រ（マイクロファイバータオル）', qty: 2 }
    ]
  };

  var e = { postData: { contents: JSON.stringify(testData) } };
  var result = doPost(e);
  Logger.log(result.getContent());
}
