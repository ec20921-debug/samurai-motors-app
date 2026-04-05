// ╔══════════════════════════════════════════════════════════════╗
// ║  Samurai Motors - ジョブ管理 Apps Script v2                  ║
// ║  写真はGoogle Driveに保存、リンクをSheetsに記録               ║
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

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var data = JSON.parse(e.postData.contents);

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
        'ក្រោយ 4（アフター4）'
      ];
      sheet.appendRow(headers);
      var headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setFontWeight('bold');
      headerRange.setBackground('#c8102e');
      headerRange.setFontColor('#ffffff');
      sheet.setFrozenRows(1);
      // 列幅調整
      sheet.setColumnWidth(1, 100);  // Job ID
      for (var c = 2; c <= 15; c++) sheet.setColumnWidth(c, 140);
      for (var c = 16; c <= 23; c++) sheet.setColumnWidth(c, 180);
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

        // Before photos
        if (data.beforePhotos) {
          for (var i = 0; i < data.beforePhotos.length && i < 4; i++) {
            if (data.beforePhotos[i]) {
              var link = saveBase64Image(jobFolder, data.beforePhotos[i], 'before_' + (i+1));
              beforeLinks[i] = link;
            }
          }
        }

        // After photos
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
      // 写真保存に失敗しても、他のデータは記録する
      Logger.log('Photo save error: ' + photoErr.toString());
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
      afterLinks[3]
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok', jobId: jobId }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log('doPost error: ' + error.toString());
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: error.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
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
  // "data:image/jpeg;base64,xxxx" → "xxxx" を抽出
  var parts = base64Data.split(',');
  var mimeMatch = parts[0].match(/:(.*?);/);
  var mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  var raw = parts.length > 1 ? parts[1] : parts[0];

  var blob = Utilities.newBlob(Utilities.base64Decode(raw), mimeType, filename + '.jpg');
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return file.getUrl();
}

// GETリクエスト（動作確認用）
function doGet() {
  return ContentService
    .createTextOutput('Samurai Motors Job Manager v2 is active.')
    .setMimeType(ContentService.MimeType.TEXT);
}

// テスト関数（写真なし・メタデータのみ）
function testDoPost() {
  var testData = {
    postData: {
      contents: JSON.stringify({
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
        afterPhotos: []
      })
    }
  };

  var result = doPost(testData);
  Logger.log(result.getContent());
}
