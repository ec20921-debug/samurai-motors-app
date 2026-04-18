/**
 * PaymentManager.gs — 決済管理
 *
 * 【責務】
 *   - 作業終了時に QR コードを顧客へ自動送信（1予約1回のみ）
 *   - 顧客から届いた支払いスクショを Drive 保存 → 予約シート更新 → 管理通知
 *   - 24時間以上未払いの顧客に催促テキスト（QRは再添付しない）
 *
 * 【決済状態の遷移】
 *   未清算 → QR送信済み → 要確認（顧客がスクショ送信後、管理者の確認待ち）
 *           ↓ 24h経過 → 催促送信（決済状態は QR送信済み のまま）
 *           → 清算済み（管理者が手動で更新）
 *
 * 【設計方針】
 *   - QR画像は QRコードシートの「有効=TRUE」行から動的取得
 *   - 同一予約への二重 QR 送信防止: 「QR送信日時」列が空のときのみ送る
 *   - 24h催促は QR を再添付しない（テキストのみ）
 *   - 催促回数を予約シートに記録、管理側で過剰催促を防止できるようにする
 */

// ====== 1. QR 自動送信（作業終了時） ======

/**
 * 顧客にQRコード画像と支払い案内を送信する
 * 既に QR送信日時 が記録されている予約には送信しない（重複防止）
 *
 * @param {string} bookingId - 予約ID
 * @return {{ok: boolean, reason?: string}}
 */
function sendPaymentQR(bookingId) {
  if (!bookingId) return { ok: false, reason: 'NO_BOOKING_ID' };

  var bkRow = findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId);
  if (!bkRow) {
    Logger.log('⚠️ sendPaymentQR: 予約が見つからない bookingId=' + bookingId);
    return { ok: false, reason: 'BOOKING_NOT_FOUND' };
  }

  // 既に送信済みなら何もしない（二重送信防止）
  if (bkRow.data['QR送信日時']) {
    Logger.log('⏭️ sendPaymentQR: 既に送信済み bookingId=' + bookingId);
    return { ok: false, reason: 'ALREADY_SENT' };
  }

  var customerChatId = String(bkRow.data['チャットID'] || '');
  if (!customerChatId) {
    Logger.log('⚠️ sendPaymentQR: チャットID無し bookingId=' + bookingId);
    return { ok: false, reason: 'NO_CHAT_ID' };
  }

  var amount = Number(bkRow.data['請求額(USD)'] || bkRow.data['料金(USD)'] || 0);

  // ── 有効な QR を取得 ──
  var qr = getActiveQR();
  if (!qr) {
    Logger.log('⚠️ sendPaymentQR: 有効なQRなし');
    // 顧客にはテキストだけでも送る
    sendMessage(BOT_TYPE.BOOKING, customerChatId,
      '💰 ការទូទាត់ប្រាក់ / Payment\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      '📋 ' + bookingId + '\n' +
      '💵 $' + amount + '\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      '⚠️ QR មិនអាចបង្ហាញបាន។ សូមទាក់ទងអ្នកគ្រប់គ្រង។\n' +
      'QR not available. Please contact admin.'
    );
    return { ok: false, reason: 'NO_ACTIVE_QR' };
  }

  // ── 顧客へ QR 画像送信（キャプション付き） ──
  var caption =
    '💰 ការទូទាត់ប្រាក់ / Payment\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    '📋 ' + bookingId + '\n' +
    '💵 $' + amount + '\n' +
    '🏦 ' + (qr.bank || '-') + '\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    '📱 សូមស្កេន QR ខាងលើ ហើយផ្ញើរូបថតវិក្កយបត្រ\n' +
    '📱 Please scan QR above and send payment screenshot';

  var sendRes = sendQRImage(customerChatId, qr.imageUrl, caption);

  if (!sendRes || !sendRes.ok) {
    Logger.log('⚠️ sendPaymentQR: QR画像送信失敗 bookingId=' + bookingId + ' res=' + JSON.stringify(sendRes));
    return { ok: false, reason: 'SEND_FAILED' };
  }

  // ── 予約シート更新: QR送信日時 + 決済状態 ──
  try {
    updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, {
      'QR送信日時': new Date(),
      '決済状態':   'QR送信済み'
    });
  } catch (e) {
    Logger.log('⚠️ sendPaymentQR: 予約シート更新失敗 bookingId=' + bookingId + ' err=' + e);
  }

  // ── 管理グループへ通知（顧客トピック内に） ──
  var threadId = null;
  var custRow = findCustomerRow(customerChatId);
  if (custRow && custRow.data['トピックID']) {
    threadId = custRow.data['トピックID'];
  }
  var cfg = getConfig();
  var adminText =
    '💰 QR 送信完了\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    '🆔 ' + bookingId + '\n' +
    '💵 $' + amount + '\n' +
    '🏦 ' + (qr.bank || '-') + '\n' +
    '⏳ 顧客の支払い待ち';
  var adminOpts = threadId ? { message_thread_id: threadId } : {};
  sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminText, adminOpts);

  return { ok: true };
}

/**
 * QR画像を URL から取得して Telegram に送信
 * Drive URL の場合は file_id ではなく blob 取得して送信する必要あり
 */
function sendQRImage(chatId, imageUrl, caption) {
  if (!imageUrl) return { ok: false, error: 'NO_URL' };

  // Drive URL かどうか判定
  var driveMatch = imageUrl.match(/[?&]id=([a-zA-Z0-9_-]+)|\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (driveMatch) {
    var fileId = driveMatch[1] || driveMatch[2];
    try {
      var file = DriveApp.getFileById(fileId);
      var blob = file.getBlob();
      // sendPhotoBlob は JobManager.gs で定義済み
      return sendPhotoBlob(BOT_TYPE.BOOKING, chatId, blob, caption, {});
    } catch (err) {
      Logger.log('⚠️ sendQRImage: Drive 取得失敗 fileId=' + fileId + ' err=' + err);
      return { ok: false, error: String(err) };
    }
  }

  // それ以外は URL を直接送信（Telegram が外部URLを取りに行く）
  return sendPhoto(BOT_TYPE.BOOKING, chatId, imageUrl, { caption: caption });
}

/**
 * QRコードシートから「有効=TRUE」の最初の行を取得
 *
 * @return {{qrId: string, imageUrl: string, desc: string, bank: string} | null}
 */
function getActiveQR() {
  var sheet = getSheet(SHEET_NAMES.QR_CODES);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var headers = getHeaderMap(SHEET_NAMES.QR_CODES);
  var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var active = row[(headers['有効'] || 1) - 1];
    if (active === true || String(active).toUpperCase() === 'TRUE') {
      return {
        qrId:     String(row[(headers['QR ID'] || 1) - 1] || ''),
        imageUrl: String(row[(headers['画像URL'] || 1) - 1] || ''),
        desc:     String(row[(headers['説明'] || 1) - 1] || ''),
        bank:     String(row[(headers['銀行名'] || 1) - 1] || '')
      };
    }
  }
  return null;
}

// ====== 2. 顧客からの支払いスクショ受付 ======

/**
 * 顧客からの photo メッセージを「支払いスクショ」として処理する
 * 該当する未払い予約があれば真を返す（→ 通常の CustomerChat 転送はスキップ）
 *
 * 判定ロジック:
 *   - msg.photo がある
 *   - 顧客の予約に「決済状態 = QR送信済み」かつ「QR送信日時」あり、最も新しいもの1件を対象
 *
 * @param {Object} msg - Telegram message
 * @return {boolean} true なら支払いスクショとして処理した（呼び出し側は通常転送をスキップ）
 */
function tryHandlePaymentScreenshot(msg) {
  if (!msg || !msg.photo || msg.photo.length === 0) return false;
  if (!msg.chat || msg.chat.type !== 'private') return false;

  var chatId = String(msg.chat.id);

  // 該当する「QR送信済み」予約を探す
  var bk = findLatestUnpaidBooking(chatId);
  if (!bk) return false; // 通常の写真転送に流す

  Logger.log('💳 tryHandlePaymentScreenshot: 支払いスクショ判定 chatId=' + chatId + ' bookingId=' + bk.data['予約ID']);

  var bookingId = String(bk.data['予約ID']);

  // ── 写真を Drive 保存 ──
  var driveUrl = '';
  try {
    var best = msg.photo[msg.photo.length - 1]; // 最大解像度
    var fileRes = fetchTelegramFile(BOT_TYPE.BOOKING, best.file_id);
    if (fileRes && fileRes.ok && fileRes.blob) {
      var cfg = getConfig();
      var folder = DriveApp.getFolderById(cfg.driveFolderPaymentScreenshots);
      var ts = Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyyMMdd_HHmmss');
      var filename = bookingId + '_payment_' + ts + '.jpg';
      var file = folder.createFile(fileRes.blob.setName(filename));
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      driveUrl = file.getUrl();
    }
  } catch (err) {
    Logger.log('⚠️ tryHandlePaymentScreenshot: Drive保存失敗 err=' + err);
  }

  // ── 予約シート更新: スクショURL + 決済状態=要確認 ──
  try {
    updateRow(SHEET_NAMES.BOOKINGS, bk.rowIndex, {
      'スクショURL': driveUrl,
      '決済状態':    '要確認'
    });
  } catch (e) {
    Logger.log('⚠️ tryHandlePaymentScreenshot: 予約シート更新失敗 err=' + e);
  }

  // ── 管理グループへ通知（顧客トピック内に） ──
  var threadId = null;
  var custRow = findCustomerRow(chatId);
  if (custRow && custRow.data['トピックID']) {
    threadId = custRow.data['トピックID'];
  }
  var cfgN = getConfig();
  var adminText =
    '💳 支払いスクショ受信\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    '🆔 ' + bookingId + '\n' +
    '💵 $' + (bk.data['請求額(USD)'] || bk.data['料金(USD)'] || '-') + '\n' +
    '📂 ' + (driveUrl || '(Drive保存失敗)') + '\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    '✅ 入金確認後、予約シートの 決済状態 を「清算済み」に変更してください';
  var adminOpts = threadId ? { message_thread_id: threadId } : {};

  // 管理グループにも実物の写真を転送（確認しやすく）
  try {
    var best2 = msg.photo[msg.photo.length - 1];
    sendPhoto(BOT_TYPE.BOOKING, cfgN.adminGroupId, best2.file_id, Object.assign({
      caption: adminText
    }, adminOpts));
  } catch (err) {
    Logger.log('⚠️ 管理グループへ写真送信失敗、テキストのみ送信: ' + err);
    sendMessage(BOT_TYPE.BOOKING, cfgN.adminGroupId, adminText, adminOpts);
  }

  // ── 顧客へ受領メッセージ ──
  sendMessage(BOT_TYPE.BOOKING, chatId,
    '✅ ទទួលបានរូបថតវិក្កយបត្រ! / Screenshot received!\n' +
    'យើងនឹងផ្ទៀងផ្ទាត់ការទូទាត់របស់អ្នកឆាប់ៗ។\n' +
    'We will verify your payment shortly.\n' +
    '🙏 សូមអរគុណ! / Thank you!'
  );

  // チャット履歴ログ
  logChat({
    direction: '顧客→管理',
    chatId: chatId,
    threadId: threadId || '',
    messageType: '写真',
    content: '支払いスクショ: ' + bookingId,
    adminId: ''
  });

  return true;
}

/**
 * 該当顧客の最新「支払い待ち」予約を返す
 * 同じ顧客に複数の未払いがある場合、QR送信日時が新しいものを採用
 *
 * 【判定条件】（誤爆防止のため厳格化 2026-04-19）
 *   - 決済状態 = 'QR送信済み'
 *   - 進行状態 = '作業完了' （作業前の駐車写真を支払い扱いしないため必須）
 *   - QR送信日時 が 48時間以内 （古いテスト予約に吸収されないため）
 *
 * @param {string} chatId
 * @return {{rowIndex: number, data: Object} | null}
 */
function findLatestUnpaidBooking(chatId) {
  var sheet = getSheet(SHEET_NAMES.BOOKINGS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var headers = getHeaderMap(SHEET_NAMES.BOOKINGS);
  var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  var latest = null;
  var latestTs = 0;
  var WINDOW_MS = 48 * 60 * 60 * 1000; // 48時間以内
  var now = Date.now();

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (String(row[(headers['チャットID'] || 1) - 1]) !== String(chatId)) continue;

    var pStatus = String(row[(headers['決済状態'] || 1) - 1] || '');
    if (pStatus !== 'QR送信済み') continue;

    // ★ 進行状態チェック: 作業完了済みの予約のみを支払い待ちとみなす
    //   （予約確定・作業中の時点ではまだ支払いフェーズではない）
    var jStatus = String(row[(headers['進行状態'] || 1) - 1] || '');
    if (jStatus !== '作業完了') continue;

    var qrSent = row[(headers['QR送信日時'] || 1) - 1];
    var ts = (qrSent instanceof Date) ? qrSent.getTime() : 0;
    // ★ QR送信から48h以内のもののみ対象
    if (!ts || (now - ts) > WINDOW_MS) continue;

    if (ts > latestTs) {
      latestTs = ts;
      latest = { rowIndex: i + 2, data: readRow(SHEET_NAMES.BOOKINGS, i + 2) };
    }
  }
  return latest;
}

// ====== 3. 24時間催促 ======

/**
 * QR送信から24時間経過した「QR送信済み」予約に催促を送る
 * トリガー: 1時間間隔
 *
 * 【催促ルール】
 *   - 決済状態 = QR送信済み（要確認・清算済みは対象外）
 *   - QR送信日時から24時間以上経過
 *   - 最終催促日時 から24時間以上経過（連続催促を防止）
 *   - 催促回数 < 5（5回まで）
 *   - 催促はテキストのみ。QR は再添付しない
 */
function checkUnpaidReminders() {
  var sheet = getSheet(SHEET_NAMES.BOOKINGS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var headers = getHeaderMap(SHEET_NAMES.BOOKINGS);
  var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  var now = new Date();
  var DAY_MS = 24 * 60 * 60 * 1000;
  var sent = 0;
  var skipped = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var pStatus = String(row[(headers['決済状態'] || 1) - 1] || '');
    if (pStatus !== 'QR送信済み') continue;

    var qrSent = row[(headers['QR送信日時'] || 1) - 1];
    if (!(qrSent instanceof Date)) continue;
    if (now.getTime() - qrSent.getTime() < DAY_MS) continue;

    // 直近の催促から24h経過しているか
    var lastReminder = row[(headers['最終催促日時'] || 1) - 1];
    if (lastReminder instanceof Date && now.getTime() - lastReminder.getTime() < DAY_MS) {
      skipped++;
      continue;
    }

    // 催促回数上限チェック
    var reminderCount = Number(row[(headers['催促回数'] || 1) - 1] || 0);
    if (reminderCount >= 5) {
      skipped++;
      continue;
    }

    var bookingId = String(row[(headers['予約ID'] || 1) - 1] || '');
    var chatId = String(row[(headers['チャットID'] || 1) - 1] || '');
    var amount = Number(row[(headers['請求額(USD)'] || 1) - 1] || row[(headers['料金(USD)'] || 1) - 1] || 0);
    if (!chatId) continue;

    // ── 催促テキスト送信（QR画像は再添付しない） ──
    var hoursPassed = Math.floor((now.getTime() - qrSent.getTime()) / (60 * 60 * 1000));
    var text =
      '⏰ ការរំលឹកការទូទាត់ / Payment Reminder\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      '📋 ' + bookingId + '\n' +
      '💵 $' + amount + '\n' +
      '⏱ ' + hoursPassed + ' ម៉ោងមុន / hours ago\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      '🙏 សូមផ្ញើរូបថតវិក្កយបត្រ ប្រសិនបើបានទូទាត់ហើយ\n' +
      '🙏 If you have paid, please send the receipt screenshot.\n' +
      '❓ បើមានសំណួរ សូមផ្ញើសារនៅទីនេះ\n' +
      '❓ If you have questions, just reply here.';

    try {
      var res = sendMessage(BOT_TYPE.BOOKING, chatId, text);
      if (res && res.ok) {
        // 予約シート更新
        updateRow(SHEET_NAMES.BOOKINGS, i + 2, {
          '催促回数':     reminderCount + 1,
          '最終催促日時': now
        });
        sent++;

        // 管理グループへ通知
        var custRow = findCustomerRow(chatId);
        var threadId = (custRow && custRow.data['トピックID']) ? custRow.data['トピックID'] : null;
        var cfg = getConfig();
        var adminOpts = threadId ? { message_thread_id: threadId } : {};
        sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
          '⏰ 催促送信 (' + (reminderCount + 1) + '回目)\n' +
          '🆔 ' + bookingId + ' / $' + amount + ' / ' + hoursPassed + 'h経過',
          adminOpts
        );
      }
    } catch (err) {
      Logger.log('⚠️ checkUnpaidReminders 送信失敗 bookingId=' + bookingId + ' err=' + err);
    }
  }

  if (sent > 0 || skipped > 0) {
    Logger.log('⏰ checkUnpaidReminders: 送信=' + sent + ' スキップ=' + skipped);
  }
}

// ====== 4. トリガー登録（Phase 5 追加） ======

/**
 * 催促トリガーを 1時間間隔で登録
 * 既存の同名トリガーを削除してから作る（冪等）
 */
function setupPaymentTriggers() {
  var existing = ScriptApp.getProjectTriggers();
  var removed = 0;
  existing.forEach(function(t) {
    if (t.getHandlerFunction() === 'checkUnpaidReminders') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log('🗑️ 既存 checkUnpaidReminders トリガー削除: ' + removed + '件');

  ScriptApp.newTrigger('checkUnpaidReminders')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('⏰ checkUnpaidReminders: 1時間間隔で登録完了');
}

// ====== 5. デバッグ ======

/**
 * QRコードシートの状態を確認
 */
function dumpActiveQR() {
  var qr = getActiveQR();
  if (!qr) {
    Logger.log('⚠️ 有効なQRが見つかりません。QRコードシートに行を追加して 有効=TRUE にしてください');
    return;
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('💳 アクティブな QR');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('QR ID: ' + qr.qrId);
  Logger.log('銀行: ' + qr.bank);
  Logger.log('説明: ' + qr.desc);
  Logger.log('画像URL: ' + qr.imageUrl);
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 指定予約に手動でQRを送る（テスト用）
 */
function testSendPaymentQR(bookingId) {
  if (!bookingId) {
    Logger.log('使い方: testSendPaymentQR("BK-20260416-001")');
    return;
  }
  var res = sendPaymentQR(bookingId);
  Logger.log('結果: ' + JSON.stringify(res));
}
