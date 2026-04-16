/**
 * JobManager.gs — 作業管理（ジョブ開始・終了・最終送信）
 *
 * 【責務】
 *   - job-manager.html（現場ミニアプリ）からの API を処理
 *   - 作業開始/終了時の 3方向配信（顧客 / Admin / シート）
 *   - Before/After 写真の Drive 保存
 *   - 予約ステータス更新
 *
 * 【action 一覧】
 *   GET:
 *     - booking_today    : 本日＋明日の予約一覧
 *   POST:
 *     - job_start         : 作業開始通知（リアルタイム）
 *     - job_end           : 作業終了通知（リアルタイム）
 *     - job               : 最終データ送信（写真付き）
 *     - chat_history      : 顧客チャット履歴取得
 *     - chat_send         : ミニアプリからメッセージ送信
 */

// ====== booking_today ======

/**
 * 本日＋明日の予約一覧を返す
 * ダッシュボード表示用
 *
 * @return {Object} { status:'ok', bookings: [...] }
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

    // スプレッドシートのタイムゾーンで比較（シートに格納された Date は
    // ss.getSpreadsheetTimeZone() の midnight として扱われるため、
    // 比較用の today/tomorrow も同じ TZ で作る）
    var tz = getSpreadsheet().getSpreadsheetTimeZone();

    var now = new Date();
    var todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    var tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    var tomorrowStr = Utilities.formatDate(tomorrow, tz, 'yyyy-MM-dd');

    var bookings = [];
    for (var i = 0; i < data.length; i++) {
      var row = data[i];

      // 予約日（'yyyy-MM-dd' 文字列 or Date）
      var dateVal = row[(headers['予約日'] || 1) - 1];
      var dateStr = '';
      if (dateVal instanceof Date) {
        dateStr = Utilities.formatDate(dateVal, tz, 'yyyy-MM-dd');
      } else {
        dateStr = String(dateVal || '').substring(0, 10);
      }

      // 今日 or 明日のみ（キャンセルは除外）
      if (dateStr !== todayStr && dateStr !== tomorrowStr) continue;
      var status = String(row[(headers['進行状態'] || 1) - 1] || '');
      if (status === 'cancelled' || status === 'キャンセル') continue;

      // 予約時刻（'HH:mm' 文字列 or Date）
      var startRaw = row[(headers['予約時刻'] || 1) - 1];
      var startTime = '';
      if (startRaw instanceof Date) {
        startTime = Utilities.formatDate(startRaw, tz, 'HH:mm');
      } else {
        startTime = String(startRaw || '');
      }
      var durationMin = Number(row[(headers['所要時間(分)'] || 1) - 1] || 0);
      var endTime = calcEndTime(startTime, durationMin);

      // プランフル名から letter を抽出（例: "清 KIYOME (A)" → "A"）
      var planFull = String(row[(headers['プラン'] || 1) - 1] || '');
      var letterMatch = planFull.match(/\(([A-Z])\)/);
      var planLetter = letterMatch ? letterMatch[1] : planFull;

      // 顧客氏名は顧客シートから引く（予約シートには氏名列なし）
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

    // 時刻でソート
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
 * ミニアプリから before 写真 + 開始時刻を受信
 *
 * @param {Object} body - { bookingId, name, building, room, carModel, plate, plan, vehicleType, startTime, beforePhotos }
 * @return {Object}
 */
function apiJobStart(body) {
  try {
    var bookingId = body.bookingId || '';
    var cfg = getConfig();

    // 予約紐付けがあればステータス更新
    if (bookingId) {
      var bkRow = findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId);
      if (bkRow) {
        updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, {
          '進行状態': 'in_progress'
        });
      }
    }

    // Before写真を Drive に保存
    var photoUrls = [];
    if (body.beforePhotos && body.beforePhotos.length > 0) {
      photoUrls = saveBase64PhotosToDrive(body.beforePhotos, bookingId || 'manual', 'before');
    }

    // ── 3方向配信: 管理グループへ通知 ──
    var adminMsg = '▶️ 作業開始\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      (bookingId ? '🆔 ' + bookingId + '\n' : '') +
      '👤 ' + (body.name || '-') + '\n' +
      '🏢 ' + (body.building || '-') + ' ' + (body.room || '') + '\n' +
      '🚗 ' + (body.carModel || '-') + ' / ' + (body.plate || '-') + '\n' +
      '✨ Plan ' + (body.plan || '-') + ' (' + (body.vehicleType || '-') + ')\n' +
      '🕐 開始: ' + formatISOtoPhnomPenh(body.startTime) + '\n' +
      '📷 Before写真: ' + (photoUrls.length > 0 ? photoUrls.length + '枚' : 'なし') + '\n' +
      '━━━━━━━━━━━━━━━━━';

    // 管理グループにトピックがあれば、そのトピックへ。なければ General
    var threadId = null;
    if (bookingId) {
      var bkRow2 = findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId);
      if (bkRow2) {
        var chatId = String(bkRow2.data['チャットID'] || '');
        if (chatId) {
          var custRow = findCustomerRow(chatId);
          if (custRow && custRow.data['トピックID']) {
            threadId = custRow.data['トピックID'];
          }
        }
      }
    }

    var adminOpts = {};
    if (threadId) adminOpts.message_thread_id = threadId;
    sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminMsg, adminOpts);

    // Before写真を管理グループにも送信
    if (photoUrls.length > 0) {
      sendPhotosToAdmin(photoUrls, cfg.adminGroupId, threadId, '📷 Before');
    }

    // ── 3方向配信: 顧客へ通知（予約紐付けがある場合） ──
    if (bookingId) {
      var bkRow3 = findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId);
      if (bkRow3) {
        var custChatId = String(bkRow3.data['チャットID'] || '');
        if (custChatId) {
          var custMsg =
            '🚗 ការលាងរថយន្តរបស់អ្នកបានចាប់ផ្តើម!\n' +
            'Your car wash has started!\n\n' +
            '✨ Plan ' + (body.plan || '-') + '\n' +
            '🕐 ' + formatISOtoPhnomPenh(body.startTime);
          sendMessage(BOT_TYPE.BOOKING, custChatId, custMsg);
        }
      }
    }

    // ── 3方向配信: 作業記録シート ──
    var jobId = generateDateSeqId('JOB', SHEET_NAMES.JOBS, '作業ID');
    appendRow(SHEET_NAMES.JOBS, {
      '作業ID': jobId,
      '予約番号': bookingId,
      '氏名': body.name || '',
      '場所': (body.building || '') + ' ' + (body.room || ''),
      '車種': body.carModel || '',
      'ナンバー': body.plate || '',
      'プラン': body.plan || '',
      '車種区分': body.vehicleType || '',
      '開始日時': body.startTime ? new Date(body.startTime) : new Date(),
      'Before写真': photoUrls.join('\n'),
      'ステータス': '作業中'
    });

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
 * @param {Object} body - { bookingId, endTime, duration, afterPhotos, ... }
 * @return {Object}
 */
function apiJobEnd(body) {
  try {
    var bookingId = body.bookingId || '';
    var cfg = getConfig();
    var duration = body.duration || 0;

    // After写真を Drive に保存
    var photoUrls = [];
    if (body.afterPhotos && body.afterPhotos.length > 0) {
      photoUrls = saveBase64PhotosToDrive(body.afterPhotos, bookingId || 'manual', 'after');
    }

    // ── 管理グループへ通知 ──
    var adminMsg = '⏹ 作業終了\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      (bookingId ? '🆔 ' + bookingId + '\n' : '') +
      '👤 ' + (body.name || '-') + '\n' +
      '⏱ 所要時間: ' + duration + '分\n' +
      '📷 After写真: ' + (photoUrls.length > 0 ? photoUrls.length + '枚' : 'なし') + '\n' +
      '━━━━━━━━━━━━━━━━━';

    var threadId = null;
    if (bookingId) {
      var bkRow = findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId);
      if (bkRow) {
        var chatId = String(bkRow.data['チャットID'] || '');
        if (chatId) {
          var custRow = findCustomerRow(chatId);
          if (custRow && custRow.data['トピックID']) {
            threadId = custRow.data['トピックID'];
          }
        }
      }
    }

    var adminOpts = {};
    if (threadId) adminOpts.message_thread_id = threadId;
    sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminMsg, adminOpts);

    // After写真を管理グループにも送信
    if (photoUrls.length > 0) {
      sendPhotosToAdmin(photoUrls, cfg.adminGroupId, threadId, '📷 After');
    }

    // ── 顧客へ通知 ──
    if (bookingId) {
      var bkRow2 = findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId);
      if (bkRow2) {
        var custChatId = String(bkRow2.data['チャットID'] || '');
        if (custChatId) {
          var custMsg =
            '✅ ការលាងរថយន្តរបស់អ្នកបានបញ្ចប់!\n' +
            'Your car wash is complete!\n\n' +
            '⏱ ' + duration + ' នាទី / minutes';
          sendMessage(BOT_TYPE.BOOKING, custChatId, custMsg);

          // After写真を顧客にも送信
          if (photoUrls.length > 0) {
            sendPhotoUrlsToChat(BOT_TYPE.BOOKING, custChatId, photoUrls);
          }
        }
      }
    }

    return { status: 'ok' };
  } catch (err) {
    Logger.log('❌ apiJobEnd error: ' + err + ' stack=' + (err.stack || ''));
    return { status: 'error', message: String(err) };
  }
}

// ====== job（最終送信） ======

/**
 * 全データの最終送信（写真・時刻・顧客情報すべて含む）
 * job_start / job_end のリアルタイム通知が失敗しても、これで完結する
 *
 * @param {Object} body - 全フィールド
 * @return {Object}
 */
function apiJobFinal(body) {
  try {
    var bookingId = body.bookingId || '';
    var duration = body.duration || 0;

    // 写真保存
    var beforeUrls = [];
    var afterUrls = [];
    if (body.beforePhotos && body.beforePhotos.length > 0) {
      beforeUrls = saveBase64PhotosToDrive(body.beforePhotos, bookingId || 'manual', 'before');
    }
    if (body.afterPhotos && body.afterPhotos.length > 0) {
      afterUrls = saveBase64PhotosToDrive(body.afterPhotos, bookingId || 'manual', 'after');
    }

    // 作業記録シートを更新（job_start で作成済みなら更新、なければ新規）
    var jobRow = null;
    if (bookingId) {
      jobRow = findRow(SHEET_NAMES.JOBS, '予約番号', bookingId);
    }

    if (jobRow) {
      // 既存行を更新
      updateRow(SHEET_NAMES.JOBS, jobRow.rowIndex, {
        '終了日時': body.endTime ? new Date(body.endTime) : new Date(),
        '所要時間': duration,
        'After写真': afterUrls.join('\n'),
        'Before写真': beforeUrls.length > 0 ? beforeUrls.join('\n') : jobRow.data['Before写真'],
        'ステータス': '完了',
        '備考': body.notes || ''
      });
    } else {
      // 新規作成（job_start が届かなかったケース）
      var jobId = generateDateSeqId('JOB', SHEET_NAMES.JOBS, '作業ID');
      appendRow(SHEET_NAMES.JOBS, {
        '作業ID': jobId,
        '予約番号': bookingId,
        '氏名': body.name || '',
        '場所': (body.building || '') + ' ' + (body.room || ''),
        '車種': body.carModel || '',
        'ナンバー': body.plate || '',
        'プラン': body.plan || '',
        '車種区分': body.vehicleType || '',
        '開始日時': body.startTime ? new Date(body.startTime) : '',
        '終了日時': body.endTime ? new Date(body.endTime) : new Date(),
        '所要時間': duration,
        'Before写真': beforeUrls.join('\n'),
        'After写真': afterUrls.join('\n'),
        'ステータス': '完了',
        '備考': body.notes || ''
      });
    }

    // 予約ステータスを「completed」に更新
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
 *
 * @param {Object} body - { chatId }
 * @return {Object} { status:'ok', messages: [...] }
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

    var messages = [];
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var rowChatId = String(row[(headers['チャットID'] || 1) - 1] || '');
      if (rowChatId !== chatId) continue;

      var direction = String(row[(headers['方向'] || 1) - 1] || '');
      var dateTime = row[(headers['日時'] || 1) - 1];
      var dateTimeStr = '';
      if (dateTime instanceof Date) {
        dateTimeStr = Utilities.formatDate(dateTime, 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss');
      } else {
        dateTimeStr = String(dateTime || '');
      }

      messages.push({
        direction: direction === '管理→顧客' ? 'staff' : 'customer',
        senderName: direction === '管理→顧客' ? 'Admin' : 'Customer',
        message: String(row[(headers['内容'] || 1) - 1] || ''),
        messageType: String(row[(headers['メッセージ種別'] || 1) - 1] || ''),
        dateTime: dateTimeStr
      });
    }

    // 最新50件に制限
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
 *
 * @param {Object} body - { chatId, message, senderName }
 * @return {Object}
 */
function apiChatSend(body) {
  try {
    var chatId = String(body.chatId || '');
    var message = body.message || '';
    if (!chatId || !message) {
      return { status: 'error', message: 'chatId and message required' };
    }

    // 顧客にメッセージ送信
    sendMessage(BOT_TYPE.BOOKING, chatId, message);

    // チャット履歴に記録
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

// ====== 写真保存ヘルパー ======

/**
 * Base64 写真配列を Drive に保存し、URL 配列を返す
 *
 * @param {Array<string>} base64Photos - data:image/jpeg;base64,... の配列
 * @param {string} refId - 予約番号など
 * @param {string} prefix - 'before' or 'after'
 * @return {Array<string>} Drive 上のファイル URL 配列
 */
function saveBase64PhotosToDrive(base64Photos, refId, prefix) {
  var cfg = getConfig();
  var folderId = cfg.driveFolderWashPhotos;
  var folder = DriveApp.getFolderById(folderId);
  var urls = [];

  for (var i = 0; i < base64Photos.length; i++) {
    try {
      var dataUri = base64Photos[i];
      if (!dataUri) continue;

      // data:image/jpeg;base64,... → Blob
      var parts = dataUri.split(',');
      var contentType = 'image/jpeg';
      if (parts[0] && parts[0].indexOf('image/png') >= 0) {
        contentType = 'image/png';
      }
      var decoded = Utilities.base64Decode(parts[1] || parts[0]);
      var blob = Utilities.newBlob(decoded, contentType,
        refId + '_' + prefix + '_' + (i + 1) + '.' + (contentType === 'image/png' ? 'png' : 'jpg'));

      var file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      urls.push(file.getUrl());
    } catch (photoErr) {
      Logger.log('⚠️ 写真保存エラー(' + prefix + ' #' + (i + 1) + '): ' + photoErr);
    }
  }
  return urls;
}

/**
 * 写真URLリストを管理グループに送信
 */
function sendPhotosToAdmin(urls, adminGroupId, threadId, label) {
  if (!urls || urls.length === 0) return;

  var text = label + ' (' + urls.length + '枚)\n';
  for (var i = 0; i < urls.length; i++) {
    text += (i + 1) + '. ' + urls[i] + '\n';
  }
  var opts = {};
  if (threadId) opts.message_thread_id = threadId;
  sendMessage(BOT_TYPE.BOOKING, adminGroupId, text, opts);
}

/**
 * 写真URLリストを顧客チャットに送信（リンク形式）
 */
function sendPhotoUrlsToChat(botType, chatId, urls) {
  if (!urls || urls.length === 0) return;
  // URLリストとして送信（Base64から保存されたDriveリンク）
  var text = '📸 Photos:\n';
  for (var i = 0; i < urls.length; i++) {
    text += urls[i] + '\n';
  }
  sendMessage(botType, chatId, text);
}

// ====== 時刻フォーマット ======

/**
 * ISO文字列をカンボジア時間の HH:mm に変換
 */
function formatISOtoPhnomPenh(isoStr) {
  if (!isoStr) return '-';
  try {
    var dt = new Date(isoStr);
    return Utilities.formatDate(dt, 'Asia/Phnom_Penh', 'HH:mm');
  } catch (e) {
    return String(isoStr).substring(11, 16) || '-';
  }
}
