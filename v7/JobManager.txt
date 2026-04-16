/**
 * JobManager.gs — 作業管理（ジョブ開始・終了・最終送信）
 *
 * 【責務】
 *   - job-manager.html（現場ミニアプリ）からの API を処理
 *   - 作業開始/終了時の 3方向配信（顧客 / Admin / シート）
 *   - Before/After 写真を Drive 保存 ＋ Telegram アルバム送信
 *   - 予約ステータス更新
 *
 * 【action 一覧】
 *   GET:
 *     - booking_today    : 本日＋明日の予約一覧
 *   POST:
 *     - job_start        : 作業開始通知（リアルタイム）
 *     - job_end          : 作業終了通知（リアルタイム）
 *     - job              : 最終データ送信（バックアップ）
 *     - chat_history     : 顧客チャット履歴取得
 *     - chat_send        : ミニアプリからメッセージ送信
 *
 * 【写真送信フロー】
 *   顧客: 開始時 → Before写真アルバム（キャプション: 「開始しました」）
 *         終了時 → After写真アルバム（キャプション: 「終わりました」）
 *         Phase 5 で QR コードを続けて送る予定
 *   管理: トピックに開始/終了メッセージ＋写真アルバム
 *   シート: 作業記録に1行（Before写真URL/After写真URL は Drive リンク）
 */

// ====== booking_today ======

/**
 * 本日＋明日の予約一覧を返す（ダッシュボード用）
 */
function apiBookingToday() {
  try {
    var sheet = getSheet(SHEET_NAMES.BOOKINGS);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return { status: 'ok', bookings: [] };
    }
    var headers = getHeaderMap(SHEET_NAMES.BOOKINGS);
    var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

    // スプレッドシート TZ で比較（日付セルは sheet TZ の midnight として保存される）
    var tz = getSpreadsheet().getSpreadsheetTimeZone();
    var now = new Date();
    var todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    var tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    var tomorrowStr = Utilities.formatDate(tomorrow, tz, 'yyyy-MM-dd');

    var bookings = [];
    for (var i = 0; i < data.length; i++) {
      var row = data[i];

      var dateVal = row[(headers['予約日'] || 1) - 1];
      var dateStr = '';
      if (dateVal instanceof Date) {
        dateStr = Utilities.formatDate(dateVal, tz, 'yyyy-MM-dd');
      } else {
        dateStr = String(dateVal || '').substring(0, 10);
      }

      if (dateStr !== todayStr && dateStr !== tomorrowStr) continue;
      var status = String(row[(headers['進行状態'] || 1) - 1] || '');
      if (status === 'cancelled' || status === 'キャンセル') continue;

      var startRaw = row[(headers['予約時刻'] || 1) - 1];
      var startTime = '';
      if (startRaw instanceof Date) {
        startTime = Utilities.formatDate(startRaw, tz, 'HH:mm');
      } else {
        startTime = String(startRaw || '');
      }
      var durationMin = Number(row[(headers['所要時間(分)'] || 1) - 1] || 0);
      var endTime = calcEndTime(startTime, durationMin);

      // プランフル名から letter 抽出: "清 KIYOME (A)" → "A"
      var planFull = String(row[(headers['プラン'] || 1) - 1] || '');
      var letterMatch = planFull.match(/\(([A-Z])\)/);
      var planLetter = letterMatch ? letterMatch[1] : planFull;

      // 顧客氏名は顧客シートから引く
      var chatId = String(row[(headers['チャットID'] || 1) - 1] || '');
      var customerName = '';
      if (chatId) {
        var cr = findCustomerRow(chatId);
        if (cr) customerName = cr.data['氏名'] || cr.data['ユーザー名'] || '';
      }

      bookings.push({
        bookingId: String(row[(headers['予約ID'] || 1) - 1] || ''),
        date: dateStr,
        customerName: customerName,
        chatId: chatId,
        planLetter: planLetter,
        vehicleType: String(row[(headers['車種タイプ'] || 1) - 1] || ''),
        startTime: startTime,
        endTime: endTime,
        amount: Number(row[(headers['料金(USD)'] || 1) - 1] || 0),
        status: status,
        location: String(row[(headers['マップリンク'] || 1) - 1] || row[(headers['住所'] || 1) - 1] || ''),
        carModel: String(row[(headers['車種名'] || 1) - 1] || ''),
        plate: ''
      });
    }

    bookings.sort(function(a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.startTime || '') < (b.startTime || '') ? -1 : 1;
    });

    return { status: 'ok', bookings: bookings };
  } catch (err) {
    Logger.log('❌ apiBookingToday error: ' + err);
    return { status: 'error', message: String(err) };
  }
}

/**
 * 開始時刻 + 所要時間 → 終了時刻 'HH:mm'
 */
function calcEndTime(startHHmm, durationMin) {
  if (!startHHmm || !durationMin) return '';
  var parts = String(startHHmm).split(':');
  if (parts.length < 2) return '';
  var totalMin = Number(parts[0]) * 60 + Number(parts[1]) + durationMin;
  var h = Math.floor(totalMin / 60) % 24;
  var m = totalMin % 60;
  return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
}

// ====== job_start ======

/**
 * 作業開始処理（リアルタイム通知）
 *
 * フロー:
 *   1. Before写真を Drive 保存 + Blob化
 *   2. 作業記録シートに行追加（これを最初にやって、通知失敗してもデータ残す）
 *   3. 予約ステータス更新
 *   4. 顧客へ: Before写真アルバム（キャプション: 「開始しました」）
 *   5. 管理グループへ: Before写真アルバム（キャプション: 「▶️ 作業開始」詳細付き）
 */
function apiJobStart(body) {
  try {
    var bookingId = body.bookingId || '';
    var cfg = getConfig();

    // ── 1. 写真を Drive に保存 & Blob 取得 ──
    var photoResult = { urls: [], blobs: [] };
    if (body.beforePhotos && body.beforePhotos.length > 0) {
      photoResult = saveBase64PhotosToDrive(body.beforePhotos, bookingId || 'manual', 'before');
    }

    // ── 2. 作業記録シートに行追加 ──
    var jobId = generateDateSeqId('JOB', SHEET_NAMES.JOBS, 'ジョブID');
    appendRow(SHEET_NAMES.JOBS, {
      'ジョブID':       jobId,
      '予約ID':         bookingId,
      'スタッフID':     '',
      'スタッフ名':     '',
      '作業状態':       '作業中',
      '開始時刻':       body.startTime ? new Date(body.startTime) : new Date(),
      '完了時刻':       '',
      'Before写真URL':  photoResult.urls.join('\n'),
      'After写真URL':   ''
    });

    // ── 3. 予約ステータス更新 ──
    var bkRow = bookingId ? findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId) : null;
    if (bkRow) {
      updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, {
        '進行状態': 'in_progress'
      });
    }

    // トピック ID を取得
    var threadId = null;
    var customerChatId = '';
    if (bkRow) {
      customerChatId = String(bkRow.data['チャットID'] || '');
      if (customerChatId) {
        var custRow = findCustomerRow(customerChatId);
        if (custRow && custRow.data['トピックID']) {
          threadId = custRow.data['トピックID'];
        }
      }
    }

    // ── 4. 顧客へ: メッセージ + Before写真アルバム ──
    if (customerChatId && photoResult.blobs.length > 0) {
      var custCaption =
        '🚗 ការលាងសម្អាតរថយន្តរបស់អ្នកចាប់ផ្តើមហើយ!\n' +
        'Your car wash has started!\n\n' +
        '📸 រូបថតមុនពេលលាង / Before photos';
      sendPhotoAlbum(BOT_TYPE.BOOKING, customerChatId, photoResult.blobs, custCaption, {});
    } else if (customerChatId) {
      // 写真がない場合はテキストのみ
      sendMessage(BOT_TYPE.BOOKING, customerChatId,
        '🚗 ការលាងសម្អាតរថយន្តរបស់អ្នកចាប់ផ្តើមហើយ!\nYour car wash has started!');
    }

    // ── 5. 管理グループへ: メッセージ + Before写真アルバム ──
    var adminCaption = '▶️ 作業開始\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      (bookingId ? '🆔 ' + bookingId + '\n' : '') +
      '👤 ' + (body.name || '-') + '\n' +
      '🏢 ' + (body.building || '-') + ' ' + (body.room || '') + '\n' +
      '🚗 ' + (body.carModel || '-') + ' / ' + (body.plate || '-') + '\n' +
      '✨ Plan ' + (body.plan || '-') + ' (' + (body.vehicleType || '-') + ')\n' +
      '🕐 開始: ' + formatISOtoPhnomPenh(body.startTime) + '\n' +
      '📷 Before ' + photoResult.urls.length + '枚';

    var adminOpts = {};
    if (threadId) adminOpts.message_thread_id = threadId;

    if (photoResult.blobs.length > 0) {
      sendPhotoAlbum(BOT_TYPE.BOOKING, cfg.adminGroupId, photoResult.blobs, adminCaption, adminOpts);
    } else {
      sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminCaption, adminOpts);
    }

    return { status: 'ok', jobId: jobId };
  } catch (err) {
    Logger.log('❌ apiJobStart error: ' + err + ' stack=' + (err.stack || ''));
    return { status: 'error', message: String(err) };
  }
}

// ====== job_end ======

/**
 * 作業終了処理（リアルタイム通知）
 *
 * フロー:
 *   1. After写真を Drive 保存 + Blob化
 *   2. 作業記録シート更新（完了時刻・After写真URL・作業状態）
 *   3. 予約ステータス更新
 *   4. 顧客へ: After写真アルバム（キャプション: 「終わりました」）
 *   5. 管理グループへ: After写真アルバム（キャプション: 「⏹ 作業終了」詳細付き）
 *   [Phase 5: 続けて QR コード送信]
 */
function apiJobEnd(body) {
  try {
    var bookingId = body.bookingId || '';
    var cfg = getConfig();
    var duration = body.duration || 0;

    // ── 1. After写真を Drive 保存 & Blob 取得 ──
    var photoResult = { urls: [], blobs: [] };
    if (body.afterPhotos && body.afterPhotos.length > 0) {
      photoResult = saveBase64PhotosToDrive(body.afterPhotos, bookingId || 'manual', 'after');
    }

    // ── 2. 作業記録シート更新 ──
    if (bookingId) {
      var jobRow = findRow(SHEET_NAMES.JOBS, '予約ID', bookingId);
      if (jobRow) {
        updateRow(SHEET_NAMES.JOBS, jobRow.rowIndex, {
          '完了時刻':       body.endTime ? new Date(body.endTime) : new Date(),
          'After写真URL':   photoResult.urls.join('\n'),
          '作業状態':       '完了'
        });
      }
    }

    // ── 3. 予約ステータス更新 ──
    var bkRow = bookingId ? findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId) : null;
    var customerChatId = '';
    var threadId = null;
    if (bkRow) {
      updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, {
        '進行状態': 'completed'
      });
      customerChatId = String(bkRow.data['チャットID'] || '');
      if (customerChatId) {
        var custRow = findCustomerRow(customerChatId);
        if (custRow && custRow.data['トピックID']) {
          threadId = custRow.data['トピックID'];
        }
      }
    }

    // ── 4. 顧客へ: メッセージ + After写真アルバム ──
    if (customerChatId && photoResult.blobs.length > 0) {
      var custCaption =
        '✅ ការលាងសម្អាតបញ្ចប់ហើយ!\n' +
        'Your car wash is complete!\n\n' +
        '⏱ ' + duration + ' នាទី / minutes\n' +
        '📸 រូបថតក្រោយពេលលាង / After photos';
      sendPhotoAlbum(BOT_TYPE.BOOKING, customerChatId, photoResult.blobs, custCaption, {});
    } else if (customerChatId) {
      sendMessage(BOT_TYPE.BOOKING, customerChatId,
        '✅ ការលាងសម្អាតបញ្ចប់ហើយ!\nYour car wash is complete!\n⏱ ' + duration + ' minutes');
    }

    // ── 5. 管理グループへ: メッセージ + After写真アルバム ──
    var adminCaption = '⏹ 作業終了\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      (bookingId ? '🆔 ' + bookingId + '\n' : '') +
      '👤 ' + (body.name || '-') + '\n' +
      '⏱ 所要時間: ' + duration + '分\n' +
      '📷 After ' + photoResult.urls.length + '枚';

    var adminOpts = {};
    if (threadId) adminOpts.message_thread_id = threadId;

    if (photoResult.blobs.length > 0) {
      sendPhotoAlbum(BOT_TYPE.BOOKING, cfg.adminGroupId, photoResult.blobs, adminCaption, adminOpts);
    } else {
      sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminCaption, adminOpts);
    }

    // [Phase 5] ここで sendPaymentQR(customerChatId, bookingId) を呼ぶ予定

    return { status: 'ok' };
  } catch (err) {
    Logger.log('❌ apiJobEnd error: ' + err + ' stack=' + (err.stack || ''));
    return { status: 'error', message: String(err) };
  }
}

// ====== job（最終送信：バックアップ） ======

/**
 * 全データの最終送信（job_start / job_end が失敗した場合のバックアップ）
 */
function apiJobFinal(body) {
  try {
    var bookingId = body.bookingId || '';
    var duration = body.duration || 0;

    // 既に作業記録がある場合は何もしない（job_end で完結済み）
    if (bookingId) {
      var existing = findRow(SHEET_NAMES.JOBS, '予約ID', bookingId);
      if (existing && existing.data['作業状態'] === '完了') {
        return { status: 'ok', message: 'already completed' };
      }
    }

    // 写真保存（まだ保存されていない場合）
    var beforeUrls = [];
    var afterUrls = [];
    if (body.beforePhotos && body.beforePhotos.length > 0) {
      var br = saveBase64PhotosToDrive(body.beforePhotos, bookingId || 'manual', 'before');
      beforeUrls = br.urls;
    }
    if (body.afterPhotos && body.afterPhotos.length > 0) {
      var ar = saveBase64PhotosToDrive(body.afterPhotos, bookingId || 'manual', 'after');
      afterUrls = ar.urls;
    }

    // 作業記録（既存更新 or 新規作成）
    var jobRow = bookingId ? findRow(SHEET_NAMES.JOBS, '予約ID', bookingId) : null;

    if (jobRow) {
      var updates = {
        '完了時刻': body.endTime ? new Date(body.endTime) : new Date(),
        '作業状態': '完了'
      };
      if (afterUrls.length > 0) updates['After写真URL'] = afterUrls.join('\n');
      if (beforeUrls.length > 0 && !jobRow.data['Before写真URL']) {
        updates['Before写真URL'] = beforeUrls.join('\n');
      }
      updateRow(SHEET_NAMES.JOBS, jobRow.rowIndex, updates);
    } else {
      // job_start が届かなかったケース
      var jobId = generateDateSeqId('JOB', SHEET_NAMES.JOBS, 'ジョブID');
      appendRow(SHEET_NAMES.JOBS, {
        'ジョブID':       jobId,
        '予約ID':         bookingId,
        'スタッフID':     '',
        'スタッフ名':     '',
        '作業状態':       '完了',
        '開始時刻':       body.startTime ? new Date(body.startTime) : '',
        '完了時刻':       body.endTime ? new Date(body.endTime) : new Date(),
        'Before写真URL':  beforeUrls.join('\n'),
        'After写真URL':   afterUrls.join('\n')
      });
    }

    // 予約ステータス
    if (bookingId) {
      var bkRow = findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId);
      if (bkRow) {
        updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, {
          '進行状態': 'completed'
        });
      }
    }

    return { status: 'ok' };
  } catch (err) {
    Logger.log('❌ apiJobFinal error: ' + err + ' stack=' + (err.stack || ''));
    return { status: 'error', message: String(err) };
  }
}

// ====== chat_history ======

/**
 * 指定顧客のチャット履歴を返す
 */
function apiChatHistory(body) {
  try {
    var chatId = String(body.chatId || '');
    if (!chatId) return { status: 'error', message: 'chatId required' };

    var sheet = getSheet(SHEET_NAMES.CHAT_LOG);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return { status: 'ok', messages: [] };
    }

    var headers = getHeaderMap(SHEET_NAMES.CHAT_LOG);
    var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    var tz = getSpreadsheet().getSpreadsheetTimeZone();

    var messages = [];
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rowChatId = String(row[(headers['チャットID'] || 1) - 1] || '');
      if (rowChatId !== chatId) continue;

      var direction = String(row[(headers['方向'] || 1) - 1] || '');
      var dateTime = row[(headers['日時'] || 1) - 1];
      var dateTimeStr = dateTime instanceof Date
        ? Utilities.formatDate(dateTime, tz, 'yyyy-MM-dd HH:mm:ss')
        : String(dateTime || '');

      messages.push({
        direction: direction === '管理→顧客' ? 'staff' : 'customer',
        senderName: direction === '管理→顧客' ? 'Admin' : 'Customer',
        message: String(row[(headers['内容'] || 1) - 1] || ''),
        messageType: String(row[(headers['メッセージ種別'] || 1) - 1] || ''),
        dateTime: dateTimeStr
      });
    }

    if (messages.length > 50) {
      messages = messages.slice(messages.length - 50);
    }

    return { status: 'ok', messages: messages };
  } catch (err) {
    Logger.log('❌ apiChatHistory error: ' + err);
    return { status: 'error', message: String(err) };
  }
}

// ====== chat_send ======

/**
 * ミニアプリから顧客へメッセージを送信
 */
function apiChatSend(body) {
  try {
    var chatId = String(body.chatId || '');
    var message = body.message || '';
    if (!chatId || !message) {
      return { status: 'error', message: 'chatId and message required' };
    }

    sendMessage(BOT_TYPE.BOOKING, chatId, message);

    logChat({
      direction: '管理→顧客',
      chatId: chatId,
      threadId: '',
      messageType: 'テキスト',
      content: truncate(message, 200),
      adminId: body.senderName || 'App'
    });

    return { status: 'ok' };
  } catch (err) {
    Logger.log('❌ apiChatSend error: ' + err);
    return { status: 'error', message: String(err) };
  }
}

// ====== 写真ヘルパー ======

/**
 * Base64 写真配列を Drive に保存し、URL 配列 + Blob 配列を返す
 *
 * @param {Array<string>} base64Photos - "data:image/jpeg;base64,..." の配列
 * @param {string} refId   - 予約番号など
 * @param {string} prefix  - 'before' or 'after'
 * @return {{urls: Array<string>, blobs: Array<Blob>}}
 */
function saveBase64PhotosToDrive(base64Photos, refId, prefix) {
  var cfg = getConfig();
  var folder = DriveApp.getFolderById(cfg.driveFolderWashPhotos);
  var urls = [];
  var blobs = [];

  for (var i = 0; i < base64Photos.length; i++) {
    var dataUri = base64Photos[i];
    if (!dataUri) continue;
    try {
      var parts = dataUri.split(',');
      var contentType = (parts[0] && parts[0].indexOf('image/png') >= 0) ? 'image/png' : 'image/jpeg';
      var ext = contentType === 'image/png' ? 'png' : 'jpg';
      var decoded = Utilities.base64Decode(parts[1] || parts[0]);
      var filename = refId + '_' + prefix + '_' + (i + 1) + '.' + ext;

      // Drive 保存
      var file = folder.createFile(Utilities.newBlob(decoded, contentType, filename));
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      urls.push(file.getUrl());

      // 送信用 Blob（別インスタンス）
      blobs.push(Utilities.newBlob(decoded, contentType, filename));
    } catch (photoErr) {
      Logger.log('⚠️ 写真処理エラー (' + prefix + ' #' + (i + 1) + '): ' + photoErr);
    }
  }
  return { urls: urls, blobs: blobs };
}

/**
 * 写真アルバムを送信（sendMediaGroup をマルチパートで）
 * 1枚なら sendPhoto、2〜10枚なら sendMediaGroup
 *
 * @param {string} botType   - BOT_TYPE.BOOKING 等
 * @param {string|number} chatId
 * @param {Array<Blob>} blobs
 * @param {string} caption   - 最初の写真に付けるキャプション
 * @param {Object} opts      - { message_thread_id? }
 */
function sendPhotoAlbum(botType, chatId, blobs, caption, opts) {
  if (!blobs || blobs.length === 0) return { ok: false, error: 'NO_BLOBS' };

  var token = getBotToken(botType);
  if (!token) return { ok: false, error: 'NO_TOKEN' };

  // 1枚の場合は sendPhoto（sendMediaGroup は2枚以上必須）
  if (blobs.length === 1) {
    return sendPhotoBlob(botType, chatId, blobs[0], caption, opts);
  }

  // 2枚以上: sendMediaGroup（最大10枚）
  var maxBatch = 10;
  var lastRes = null;
  for (var offset = 0; offset < blobs.length; offset += maxBatch) {
    var batch = blobs.slice(offset, offset + maxBatch);
    var payload = { chat_id: String(chatId) };
    if (opts && opts.message_thread_id) {
      payload.message_thread_id = String(opts.message_thread_id);
    }

    var media = [];
    for (var i = 0; i < batch.length; i++) {
      var item = { type: 'photo', media: 'attach://photo' + i };
      // 最初のバッチの最初の写真にキャプション
      if (offset === 0 && i === 0 && caption) item.caption = caption;
      media.push(item);
      payload['photo' + i] = batch[i];
    }
    payload.media = JSON.stringify(media);

    var url = 'https://api.telegram.org/bot' + token + '/sendMediaGroup';
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post',
        payload: payload,
        muteHttpExceptions: true
      });
      var body = res.getContentText();
      lastRes = JSON.parse(body);
      if (!lastRes.ok) {
        Logger.log('⚠️ sendMediaGroup failed: ' + body);
      }
    } catch (err) {
      Logger.log('❌ sendPhotoAlbum error: ' + err);
      return { ok: false, error: String(err) };
    }
  }
  return lastRes || { ok: false };
}

/**
 * 1枚写真送信（Blob）
 */
function sendPhotoBlob(botType, chatId, blob, caption, opts) {
  var token = getBotToken(botType);
  if (!token) return { ok: false, error: 'NO_TOKEN' };

  var payload = {
    chat_id: String(chatId),
    photo: blob
  };
  if (caption) payload.caption = caption;
  if (opts && opts.message_thread_id) {
    payload.message_thread_id = String(opts.message_thread_id);
  }

  var url = 'https://api.telegram.org/bot' + token + '/sendPhoto';
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true
    });
    var body = res.getContentText();
    var data = JSON.parse(body);
    if (!data.ok) Logger.log('⚠️ sendPhoto failed: ' + body);
    return data;
  } catch (err) {
    Logger.log('❌ sendPhotoBlob error: ' + err);
    return { ok: false, error: String(err) };
  }
}

// ====== 時刻フォーマット ======

function formatISOtoPhnomPenh(isoStr) {
  if (!isoStr) return '-';
  try {
    var dt = new Date(isoStr);
    return Utilities.formatDate(dt, 'Asia/Phnom_Penh', 'HH:mm');
  } catch (e) {
    return String(isoStr).substring(11, 16) || '-';
  }
}
