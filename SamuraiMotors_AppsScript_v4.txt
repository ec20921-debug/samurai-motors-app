// ╔══════════════════════════════════════════════════════════════╗
// ║  Samurai Motors - 業務管理 Apps Script v4                    ║
// ║  ジョブ管理 + 在庫管理 + サマリー + Telegram通知              ║
// ╠══════════════════════════════════════════════════════════════╣
// ║                                                              ║
// ║  【v3 → v4 変更点】                                          ║
// ║  ① ヘッダー行を毎回正しい23列に自動修正                       ║
// ║  ② 所要時間（分）を開始/終了から自動計算                       ║
// ║  ③ 写真リンクをクリック可能なHYPERLINKに変換                   ║
// ║  ④ 日次サマリー関数追加（sendDailySummary）                    ║
// ║  ⑤ Telegram Bot通知機能追加                                   ║
// ║  ⑥ job_start / job_end アクション追加（写真即時送信）           ║
// ║                                                              ║
// ║  【更新手順】                                                 ║
// ║  ① Apps Script エディタで既存コードを全て削除                  ║
// ║  ② このコードを貼り付け → Ctrl+S で保存                      ║
// ║  ③ 「デプロイ」→「デプロイを管理」→ 鉛筆アイコン              ║
// ║  ④ バージョン「新しいバージョン」→「デプロイ」                 ║
// ║  ※ URLは変わりません。HTMLの変更は不要です。                    ║
// ║                                                              ║
// ║  【初回セットアップ】                                         ║
// ║  ⑤ fixHeaders() を実行 → 既存ヘッダーを修正                  ║
// ║  ⑥ setupDailyTrigger() を実行 → 毎日日本時間19:00にサマリー送信 ║
// ║                                                              ║
// ╚══════════════════════════════════════════════════════════════╝

// ═══════════════════════════════════════════
//  設定
// ═══════════════════════════════════════════

// Google Driveに写真保存用フォルダ名
var PHOTO_FOLDER_NAME = 'SamuraiMotors_Photos';

// 在庫管理シート名
var INVENTORY_SHEET_NAME = 'Inventory';

// Telegram Bot設定（ここにトークンとチャットIDを入れてください）
// @BotFather から取得したトークン
var TELEGRAM_BOT_TOKEN = '8248146123:AAEORbRSuqwLgZxcb-Pyc90DaDScH4W2j7w';
// サマリー送信先のチャットID（個人 or グループ）
var TELEGRAM_CHAT_ID = '7500384947';

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
  'ក្រោយ 4（アフター4）'
];

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
      case 'job_start':
        return handleJobStart(data);
      case 'job_end':
        return handleJobEnd(data);
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
    .createTextOutput('Samurai Motors Job Manager v4 is active.')
    .setMimeType(ContentService.MimeType.TEXT);
}

// ═══════════════════════════════════════════
//  ヘッダー修正（手動実行 or 初回自動実行）
// ═══════════════════════════════════════════

// 既存スプレッドシートのヘッダー行を正しい23列に上書き修正
function fixHeaders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0]; // ジョブ管理シート

  // 1行目を正しいヘッダーで上書き
  var headerRange = sheet.getRange(1, 1, 1, CORRECT_HEADERS.length);
  headerRange.setValues([CORRECT_HEADERS]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#c8102e');
  headerRange.setFontColor('#ffffff');
  sheet.setFrozenRows(1);

  // 列幅設定
  sheet.setColumnWidth(1, 140);  // Job ID
  for (var c = 2; c <= 14; c++) sheet.setColumnWidth(c, 160);
  sheet.setColumnWidth(15, 100); // 所要分
  for (var c = 16; c <= 23; c++) sheet.setColumnWidth(c, 200); // 写真リンク

  Logger.log('ヘッダーを23列に修正しました。');
}

// ═══════════════════════════════════════════
//  ジョブ管理
// ═══════════════════════════════════════════

function handleJobSubmit(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0]; // 最初のシート = ジョブ管理

  // ヘッダー行が無い、またはズレている場合は修正
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

  // Job ID生成: SM-YYYYMMDD-001
  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');
  var jobId = 'SM-' + dateStr + '-' + String(sheet.getLastRow()).padStart(3, '0');

  // タイムスタンプ変換（カンボジア時間）
  var registered = data.registered ? formatCambodiaTime(new Date(data.registered)) : formatCambodiaTime(now);
  var startTime = data.startTime ? formatCambodiaTime(new Date(data.startTime)) : '';
  var endTime = data.endTime ? formatCambodiaTime(new Date(data.endTime)) : '';

  // 所要時間の計算（分）
  var duration = data.duration || 0;
  if (!duration && data.startTime && data.endTime) {
    var startMs = new Date(data.startTime).getTime();
    var endMs = new Date(data.endTime).getTime();
    duration = Math.round((endMs - startMs) / 60000);
  }

  // 写真をGoogle Driveに保存 → クリック可能リンク生成
  var beforeLinks = ['','','',''];
  var afterLinks = ['','','',''];

  try {
    if ((data.beforePhotos && data.beforePhotos.length > 0) ||
        (data.afterPhotos && data.afterPhotos.length > 0)) {

      var parentFolder = getOrCreateFolder(PHOTO_FOLDER_NAME);
      var jobFolder = parentFolder.createFolder(jobId + '_' + (data.name || 'unknown'));

      // フォルダを共有リンクで閲覧可能にする
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
    }
  } catch (photoErr) {
    Logger.log('Photo save error: ' + photoErr.toString());
  }

  // データ行を追加（23列：使用資材列は削除済み）
  var newRow = sheet.getLastRow() + 1;
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
    duration,
    '', '', '', '',  // ビフォー写真（HYPERLINKで書き込み）
    '', '', '', ''   // アフター写真（HYPERLINKで書き込み）
  ]);

  // 写真リンクをHYPERLINK関数で書き込み（クリック可能にする）
  setPhotoHyperlinks(sheet, newRow, beforeLinks, afterLinks);

  // Telegram通知（レコード保存確認のみ、写真はjob_start/job_endで送信済み）
  try {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      var msg = '📋 *Job Record Saved (កំណត់ត្រាការងារបានរក្សាទុក)*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '🆔 ' + jobId + '\n'
        + '👤 ' + (data.name || '-') + '\n'
        + '🏢 ' + (data.building || '-') + ' ' + (data.room || '') + '\n'
        + '🚘 ' + (data.carModel || '-') + ' | ' + (data.plate || '-') + '\n'
        + '📦 ' + (data.plan || '-') + '\n'
        + '⏱ ' + duration + ' min (នាទី)\n';

      sendTelegram(msg);
    }
  } catch (tgErr) {
    Logger.log('Telegram notify error: ' + tgErr.toString());
  }

  return jsonResponse({ status: 'ok', jobId: jobId });
}

// ═══════════════════════════════════════════
//  作業開始・完了ハンドラー
// ═══════════════════════════════════════════

// 作業開始時：ビフォー写真をDriveに保存し、Telegram通知を送信
function handleJobStart(data) {
  var beforeLinks = [];
  var folderUrl = '';

  try {
    var parentFolder = getOrCreateFolder(PHOTO_FOLDER_NAME);

    // フォルダ名: 日付 + 顧客名
    var now = new Date();
    var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');
    var folderName = dateStr + '_' + (data.name || 'unknown');

    var jobFolder = parentFolder.createFolder(folderName);
    jobFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    folderUrl = jobFolder.getUrl();

    // ビフォー写真を保存
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

  // Telegram通知を送信
  try {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      var startFormatted = data.startTime ? formatCambodiaTime(new Date(data.startTime)) : formatCambodiaTime(new Date());

      var msg = '🚗 *Work Started (ការងារចាប់ផ្តើម)*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '👤 ' + (data.name || '-') + '\n'
        + '🏢 ' + (data.building || '-') + ' ' + (data.room || '') + '\n'
        + '🚘 ' + (data.carModel || '-') + ' | ' + (data.plate || '-') + '\n'
        + '📦 ' + (data.plan || '-') + '\n'
        + '▶ Start (ចាប់ផ្តើម): ' + startFormatted + '\n';

      sendTelegram(msg);

      // ビフォー写真をTelegramに送信
      if (beforeLinks.length > 0) {
        sendPhotoGroupToTelegram(beforeLinks, '📸 Before Photos (រូបថតមុន)');
      }
    }
  } catch (tgErr) {
    Logger.log('handleJobStart Telegram error: ' + tgErr.toString());
  }

  return jsonResponse({
    status: 'ok',
    photoLinks: beforeLinks,
    folderUrl: folderUrl
  });
}

// 作業完了時：アフター写真をDriveに保存し、Telegram通知を送信
function handleJobEnd(data) {
  var afterLinks = [];

  try {
    var parentFolder = getOrCreateFolder(PHOTO_FOLDER_NAME);

    // 既存フォルダを日付+顧客名で検索
    var now = new Date();
    var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');
    var folderName = dateStr + '_' + (data.name || 'unknown');

    var jobFolder = null;
    var folders = parentFolder.getFoldersByName(folderName);
    if (folders.hasNext()) {
      // 既存フォルダが見つかった場合はそれを使用
      jobFolder = folders.next();
    } else {
      // 見つからない場合は新規作成
      jobFolder = parentFolder.createFolder(folderName);
      jobFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }

    // アフター写真を保存
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

  // Telegram通知を送信
  try {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      var endFormatted = data.endTime ? formatCambodiaTime(new Date(data.endTime)) : formatCambodiaTime(new Date());
      var durationMin = data.duration || 0;

      var msg = '✅ *Work Completed (ការងារបានបញ្ចប់)*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '👤 ' + (data.name || '-') + '\n'
        + '🏢 ' + (data.building || '-') + ' ' + (data.room || '') + '\n'
        + '🚘 ' + (data.carModel || '-') + ' | ' + (data.plate || '-') + '\n'
        + '📦 ' + (data.plan || '-') + '\n'
        + '⏹ End (បញ្ចប់): ' + endFormatted + '\n'
        + '⏱ Duration (រយៈពេល): ' + durationMin + ' min\n';

      sendTelegram(msg);

      // アフター写真をTelegramに送信
      if (afterLinks.length > 0) {
        sendPhotoGroupToTelegram(afterLinks, '✨ After Photos (រូបថតក្រោយ)');
      }
    }
  } catch (tgErr) {
    Logger.log('handleJobEnd Telegram error: ' + tgErr.toString());
  }

  return jsonResponse({
    status: 'ok',
    photoLinks: afterLinks
  });
}

// 写真リンクをHYPERLINK関数としてセルに書き込む
function setPhotoHyperlinks(sheet, row, beforeLinks, afterLinks) {
  // ビフォー写真（列16〜19）
  for (var i = 0; i < 4; i++) {
    if (beforeLinks[i]) {
      var cell = sheet.getRange(row, 16 + i);
      var formula = '=HYPERLINK("' + beforeLinks[i] + '","📷 Before ' + (i+1) + '")';
      cell.setFormula(formula);
    }
  }
  // アフター写真（列20〜23）
  for (var i = 0; i < 4; i++) {
    if (afterLinks[i]) {
      var cell = sheet.getRange(row, 20 + i);
      var formula = '=HYPERLINK("' + afterLinks[i] + '","📷 After ' + (i+1) + '")';
      cell.setFormula(formula);
    }
  }
}

// ═══════════════════════════════════════════
//  日次サマリー生成
// ═══════════════════════════════════════════

// 今日のジョブサマリーを生成（スプレッドシート & Telegram送信）
function sendDailySummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    Logger.log('データがありません');
    return;
  }

  // 今日の日付（カンボジア時間）
  var today = Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd');

  // 全データ取得
  var data = sheet.getRange(2, 1, lastRow - 1, 23).getValues();

  // 今日のジョブを抽出（登録日時の日付部分で判定）
  var todayJobs = [];
  var totalDuration = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var regDate = row[1].toString(); // 登録日時
    if (regDate.indexOf(today) === 0) {
      var duration = parseInt(row[14]) || 0; // 所要分
      totalDuration += duration;
      todayJobs.push({
        jobId: row[0],
        name: row[2],
        building: row[4],
        room: row[5],
        carModel: row[6],
        plate: row[7],
        plan: row[8],
        start: row[12],
        end: row[13],
        duration: duration
      });
    }
  }

  // サマリーシートに書き込み
  var summarySheet = ss.getSheetByName('DailySummary');
  if (!summarySheet) {
    summarySheet = ss.insertSheet('DailySummary');
    summarySheet.appendRow([
      '日付', '総ジョブ数', '総所要時間（分）', '平均所要時間（分）',
      '使用プラン内訳', '在庫アラート'
    ]);
    var hdr = summarySheet.getRange(1, 1, 1, 6);
    hdr.setFontWeight('bold');
    hdr.setBackground('#1a5276');
    hdr.setFontColor('#ffffff');
    summarySheet.setFrozenRows(1);
  }

  // プラン別集計
  var planCount = {};
  todayJobs.forEach(function(job) {
    var plan = job.plan || 'その他';
    planCount[plan] = (planCount[plan] || 0) + 1;
  });
  var planSummary = Object.keys(planCount).map(function(k) {
    return k + ': ' + planCount[k] + '件';
  }).join(' / ');

  // 在庫アラートチェック
  var alerts = checkInventoryAlerts();
  var alertText = alerts.length > 0
    ? alerts.map(function(a) { return a.name + '（残' + a.qty + '）'; }).join(', ')
    : 'なし';

  var avgDuration = todayJobs.length > 0 ? Math.round(totalDuration / todayJobs.length) : 0;

  // 既存の同日行を探す
  var summaryLastRow = summarySheet.getLastRow();
  var existingRow = -1;
  for (var r = 2; r <= summaryLastRow; r++) {
    if (summarySheet.getRange(r, 1).getValue().toString() === today) {
      existingRow = r;
      break;
    }
  }

  var summaryData = [today, todayJobs.length, totalDuration, avgDuration, planSummary, alertText];
  if (existingRow > 0) {
    summarySheet.getRange(existingRow, 1, 1, 6).setValues([summaryData]);
  } else {
    summarySheet.appendRow(summaryData);
  }

  // Telegram送信
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    var sheetUrl = ss.getUrl();

    var msg = '📊 *' + today + ' Daily Summary (សង្ខេបប្រចាំថ្ងៃ)*\n'
      + '━━━━━━━━━━━━━━━━━━\n\n'
      + '🚗 Total Jobs (ការងារសរុប): *' + todayJobs.length + '*\n'
      + '⏱ Total Time (ពេលវេលាសរុប): *' + totalDuration + ' min*\n'
      + '📐 Avg per Car (មធ្យមក្នុងមួយគ្រឿង): *' + avgDuration + ' min*\n\n';

    if (todayJobs.length > 0) {
      msg += '📋 *Job Details (ព័ត៌មានលម្អិត)*\n';
      todayJobs.forEach(function(job, idx) {
        msg += (idx + 1) + '. ' + (job.name || '-')
          + ' | ' + (job.building || '') + ' ' + (job.room || '')
          + ' | ' + (job.carModel || '-')
          + ' | ' + job.duration + ' min'
          + ' | ' + (job.plan || '-') + '\n';
      });
      msg += '\n';
    }

    msg += '📦 *Plan Breakdown (ការបែងចែកគម្រោង)*\n' + (planSummary || 'None') + '\n\n';

    if (alerts.length > 0) {
      msg += '⚠️ *Stock Alert (ការជូនដំណឹងស្តុក)*\n';
      alerts.forEach(function(a) {
        var icon = a.qty <= 0 ? '🔴' : '🟡';
        msg += icon + ' ' + a.name + ': ' + a.qty + ' left (' + a.unit + ')\n';
      });
    } else {
      msg += '✅ Stock: OK (ស្តុក: គ្មានបញ្ហា)\n';
    }

    msg += '\n📄 [Open Spreadsheet (បើកសៀវភៅបញ្ជី)](' + sheetUrl + ')';

    sendTelegram(msg);
  }

  Logger.log('日次サマリー生成完了: ' + today + ' / ' + todayJobs.length + '件');
  return todayJobs.length;
}

// 在庫アラートチェック
function checkInventoryAlerts() {
  var sheet = getInventorySheet();
  var lastRow = sheet.getLastRow();
  var alerts = [];

  if (lastRow <= 1) return alerts;

  var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (var i = 0; i < data.length; i++) {
    var qty = data[i][3];
    var threshold = data[i][5];
    if (qty <= threshold) {
      alerts.push({
        id: data[i][0],
        name: data[i][1],
        qty: qty,
        unit: data[i][4],
        threshold: threshold
      });
    }
  }
  return alerts;
}

// ═══════════════════════════════════════════
//  Telegram通知
// ═══════════════════════════════════════════

function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    Logger.log('Telegram未設定。BOT_TOKENとCHAT_IDを設定してください。');
    return;
  }

  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';

  var payload = {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(url, options);
    var result = JSON.parse(response.getContentText());
    if (!result.ok) {
      Logger.log('Telegram error: ' + response.getContentText());
    }
  } catch (err) {
    Logger.log('Telegram fetch error: ' + err.toString());
  }
}

// Drive写真をTelegramに送信（ビフォー/アフターをグループで送る）
function sendPhotoGroupToTelegram(links, caption) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;

  // 有効なリンクだけ抽出
  var validLinks = links.filter(function(l) { return l && l.length > 0; });
  if (validLinks.length === 0) return false;

  // 各写真のDriveファイルIDを取得して直接ダウンロードURLに変換
  var fileIds = validLinks.map(function(link) {
    var match = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    match = link.match(/id=([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    return null;
  }).filter(function(id) { return id !== null; });

  if (fileIds.length === 0) return false;

  // 1枚の場合: sendPhoto
  if (fileIds.length === 1) {
    try {
      var file = DriveApp.getFileById(fileIds[0]);
      var blob = file.getBlob();
      var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendPhoto';
      var formData = {
        'chat_id': TELEGRAM_CHAT_ID,
        'caption': caption,
        'photo': blob
      };
      UrlFetchApp.fetch(url, {
        method: 'post',
        payload: formData,
        muteHttpExceptions: true
      });
      return true;
    } catch (err) {
      Logger.log('sendPhoto error: ' + err.toString());
      return false;
    }
  }

  // 複数枚の場合: sendMediaGroup
  try {
    var blobs = [];
    var media = [];
    for (var i = 0; i < fileIds.length; i++) {
      var file = DriveApp.getFileById(fileIds[i]);
      var blob = file.getBlob().setName('photo_' + i + '.jpg');
      blobs.push(blob);
      var mediaItem = {
        type: 'photo',
        media: 'attach://photo_' + i
      };
      if (i === 0) mediaItem.caption = caption;
      media.push(mediaItem);
    }

    var formData = {
      'chat_id': TELEGRAM_CHAT_ID,
      'media': JSON.stringify(media)
    };
    // 各写真をフォームデータに添付
    for (var i = 0; i < blobs.length; i++) {
      formData['photo_' + i] = blobs[i];
    }

    var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMediaGroup';
    UrlFetchApp.fetch(url, {
      method: 'post',
      payload: formData,
      muteHttpExceptions: true
    });
    return true;
  } catch (err) {
    Logger.log('sendMediaGroup error: ' + err.toString());
    return false;
  }
}

// 毎日19:00（日本時間）にサマリーを送信するトリガー設定
function setupDailyTrigger() {
  // 既存トリガーを削除（重複防止）
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendDailySummary') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // 毎日19:00（日本時間 JST = UTC+9 → GASはUTCベースなので10:00 UTC）
  ScriptApp.newTrigger('sendDailySummary')
    .timeBased()
    .everyDays(1)
    .atHour(10)  // UTC 10:00 = 日本時間 19:00 = カンボジア時間 17:00
    .create();

  Logger.log('日次サマリートリガーを設定しました（毎日日本時間19:00 / カンボジア時間17:00）');
}

// ═══════════════════════════════════════════
//  在庫管理（v3から変更なし）
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

      // 閾値チェック → Telegram通知
      var threshold = sheet.getRange(r, 6).getValue();
      var itemName = sheet.getRange(r, 2).getValue();
      var alert = null;
      if (newQty <= 0) {
        alert = 'out_of_stock';
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
          sendTelegram('🔴 *在庫切れ警報*\n' + itemName + ' の在庫が 0 になりました！');
        }
      } else if (newQty <= threshold) {
        alert = 'low_stock';
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
          sendTelegram('🟡 *在庫残少*\n' + itemName + ' の在庫が ' + newQty + ' まで減りました（閾値: ' + threshold + '）');
        }
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

        // 閾値チェック → Telegram通知
        var threshold = sheet.getRange(r, 6).getValue();
        var itemName = sheet.getRange(r, 2).getValue();
        if (newQty <= 0 && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
          sendTelegram('🔴 *在庫切れ*\n' + itemName + ' がジョブ使用により在庫 0 になりました');
        } else if (newQty <= threshold && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
          sendTelegram('🟡 *在庫残少*\n' + itemName + ': 残 ' + newQty + '（閾値: ' + threshold + '）');
        }

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

function testFixHeaders() {
  fixHeaders();
}

function testDailySummary() {
  sendDailySummary();
}

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
    afterPhotos: []
  };

  var e = { postData: { contents: JSON.stringify(testData) } };
  var result = doPost(e);
  Logger.log(result.getContent());
}

function testTelegram() {
  sendTelegram('🧪 テスト通知\nSamurai Motors v4 Telegram連携テストです。');
}
