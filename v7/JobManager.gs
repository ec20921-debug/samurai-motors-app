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
      // 2026-06-01: 特価予約は chatId 無しで CUSTOMERS から引けない。
      //   createManualBooking が 管理者メモ に「客名:○○｜...」で残しているので復元する。
      if (!customerName) {
        var memoForName = String(row[(headers['管理者メモ'] || 1) - 1] || '');
        var nameMatch = memoForName.match(/客名:([^｜]+)/);
        if (nameMatch) customerName = nameMatch[1].trim();
      }

      // 2026-05-31: 手動特価予約の清算ボタン表示判定用に決済状態/キャンペーン名を含める
      var campaignName = String(row[(headers['キャンペーン名'] || 1) - 1] || '');
      var paymentStatus = String(row[(headers['決済状態'] || 1) - 1] || '');
      var manualCampaign = false;
      if (campaignName && typeof isManualCampaignBooking === 'function') {
        try {
          manualCampaign = isManualCampaignBooking(campaignName);
        } catch (e) { /* キャッシュ取得失敗時は false で安全側 */ }
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
        plate: '',
        // 2026-05-20: 現場スタッフが店舗/出張を判別できるよう追加
        serviceType: String(row[(headers['サービスタイプ'] || 1) - 1] || '出張'),
        // 2026-05-31: 手動特価予約のため
        paymentStatus: paymentStatus,
        campaignName: campaignName,
        manualCampaign: manualCampaign
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
 * 作業記録（JOBS）シートに「料金(USD)」列を冪等に確保する。
 * 2026-06-01: 手動登録フローで $5/無料/通常の料金を記録するため。
 * 列が無ければ末尾に追加（既存なら何もしない）。
 */
function ensureJobsAmountColumn_() {
  try {
    var sheet = getSheet(SHEET_NAMES.JOBS);
    var headers = getHeaderMap(SHEET_NAMES.JOBS);
    if (!headers['料金(USD)']) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue('料金(USD)');
    }
  } catch (e) {
    Logger.log('⚠️ ensureJobsAmountColumn_ 失敗（記録は継続）: ' + e);
  }
}

/**
 * 料金が「記録すべき値」か（空文字/undefined/null 以外。0=無料も記録対象）
 */
function hasAmountValue_(v) {
  return v !== '' && v !== undefined && v !== null;
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
    // 手入力ジョブのQR連携コード（2026-08-28 ManualCustomerLink.gs）
    var linkToken = String(body.linkToken || '');

    // ── 1. 写真を Drive に保存 & Blob 取得 ──
    var photoResult = { urls: [], blobs: [] };
    if (body.beforePhotos && body.beforePhotos.length > 0) {
      photoResult = saveBase64PhotosToDrive(body.beforePhotos, bookingId || 'manual', 'before');
    }

    // ── 2. 作業記録シートに行追加 ──
    ensureJobsAmountColumn_();  // 「料金(USD)」列を冪等確保
    // QR連携: 列確保＋スキャン先行分（pendlink）の解決
    var linkedChatId = '';
    if (linkToken && typeof ensureJobsLinkColumns_ === 'function') {
      ensureJobsLinkColumns_();
      linkedChatId = consumePendingLink_(linkToken);
    }
    var jobId = generateDateSeqId('JOB', SHEET_NAMES.JOBS, 'ジョブID');
    var jobRowObj = {
      'ジョブID':       jobId,
      '予約ID':         bookingId,
      'スタッフID':     '',
      'スタッフ名':     '',
      '作業状態':       '作業中',
      '開始時刻':       body.startTime ? new Date(body.startTime) : new Date(),
      '完了時刻':       '',
      'Before写真URL':  photoResult.urls.join('\n'),
      'After写真URL':   '',
      '車種':           (body.carModel || '') + (body.plate ? ' / ' + body.plate : ''),
      '施工時間':       '',
      '料金(USD)':      hasAmountValue_(body.amount) ? body.amount : ''
    };
    if (linkToken) {
      jobRowObj[JOBS_COL_LINK_TOKEN] = linkToken;
      if (linkedChatId) jobRowObj[JOBS_COL_CUSTOMER_CHAT] = linkedChatId;
    }
    appendRow(SHEET_NAMES.JOBS, jobRowObj);

    // ── 3. 予約ステータス更新（ドロップダウン値に合わせる） ──
    var bkRow = bookingId ? findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId) : null;
    if (bkRow) {
      try {
        updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, {
          '進行状態': '作業中'
        });
      } catch (e) {
        Logger.log('⚠️ 予約ステータス更新失敗: ' + e);
      }
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
    // 手動ジョブ: QR連携済み顧客（スキャン先行分）がいれば送信先に採用（2026-08-28）
    if (!customerChatId && linkedChatId) {
      customerChatId = linkedChatId;
      var linkedCust = findCustomerRow(customerChatId);
      if (linkedCust && linkedCust.data['トピックID']) {
        threadId = linkedCust.data['トピックID'];
      }
    }

    // ── 4. 顧客へ: メッセージ先 → 写真（各処理を個別 try で囲む） ──
    // 有償の手動ジョブ（予約なし・料金>0）のみ費用を表示（無償は金額を出さない・2026-08-28 A案）
    var manualPaidStart = (!bookingId && Number(body.amount) > 0) ? Number(body.amount) : 0;
    if (customerChatId) {
      try {
        var custText =
          '🚗 ការលាងសម្អាតរថយន្តរបស់អ្នកចាប់ផ្តើមហើយ!\n' +
          'Your car wash has started!\n' +
          (manualPaidStart > 0 ? '\n💵 តម្លៃ / Price: ' + manualPaidStart + '$\n' : '\n') +
          '📸 រូបថតមុនពេលលាង / Before photos ↓';
        sendMessage(BOT_TYPE.BOOKING, customerChatId, custText);
      } catch (e) {
        Logger.log('⚠️ 顧客メッセージ送信失敗: ' + e);
      }
      if (photoResult.blobs.length > 0) {
        try {
          sendPhotoAlbum(BOT_TYPE.BOOKING, customerChatId, photoResult.blobs, '', {});
        } catch (e) {
          Logger.log('⚠️ 顧客写真送信失敗: ' + e);
        }
      }
    }

    // ── 5. 管理グループへ: メッセージ先 → 写真 ──
    try {
      var adminText = '▶️ 作業開始\n' +
        '━━━━━━━━━━━━━━━━━\n' +
        (bookingId ? '🆔 ' + bookingId + '\n' : '') +
        '👤 ' + (body.name || '-') + '\n' +
        '🏢 ' + (body.building || '-') + ' ' + (body.room || '') + '\n' +
        '🚗 ' + (body.carModel || '-') + ' / ' + (body.plate || '-') + '\n' +
        '✨ Plan ' + (body.plan || '-') + ' (' + (body.vehicleType || '-') + ')\n' +
        (hasAmountValue_(body.amount) ? '💵 料金: $' + body.amount + '\n' : '') +
        '🕐 開始: ' + formatISOtoPhnomPenh(body.startTime) + '\n' +
        '📷 Before ' + photoResult.urls.length + '枚';

      var adminOpts = {};
      if (threadId) adminOpts.message_thread_id = threadId;

      sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminText, adminOpts);
      if (photoResult.blobs.length > 0) {
        sendPhotoAlbum(BOT_TYPE.BOOKING, cfg.adminGroupId, photoResult.blobs, '', adminOpts);
      }
    } catch (e) {
      Logger.log('⚠️ 管理グループ通知失敗: ' + e);
    }

    // ── 6. 紹介元の店舗グループへ同報（提携店経由の顧客のみ・2026-08-10） ──
    try {
      if (customerChatId && typeof notifyShopGroupJobPhotos === 'function') {
        notifyShopGroupJobPhotos(customerChatId,
          '▶️ Job started (customer from your QR)\n' +
          '👤 ' + (body.name || '-') + '\n' +
          '🚗 ' + (body.carModel || '-') + '\n' +
          '📷 Before photos ↓',
          photoResult.blobs);
      }
    } catch (e) {
      Logger.log('⚠️ 店舗グループ同報失敗(start): ' + e);
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
    // 手入力ジョブのQR連携コード（2026-08-28 ManualCustomerLink.gs）
    var linkToken = String(body.linkToken || '');

    // ── 1. After写真を Drive 保存 & Blob 取得 ──
    var photoResult = { urls: [], blobs: [] };
    if (body.afterPhotos && body.afterPhotos.length > 0) {
      photoResult = saveBase64PhotosToDrive(body.afterPhotos, bookingId || 'manual', 'after');
    }

    // ── 2. 作業記録シート更新（同一予約IDで複数行ある場合は最新行を更新） ──
    if (bookingId) {
      // jobId が body で指定されていればそれで検索、なければ 予約ID の最新ヒット行
      var jobRow = body.jobId
        ? findRow(SHEET_NAMES.JOBS, 'ジョブID', body.jobId)
        : findLastRow(SHEET_NAMES.JOBS, '予約ID', bookingId);
      if (jobRow) {
        try {
          updateRow(SHEET_NAMES.JOBS, jobRow.rowIndex, {
            '完了時刻':       body.endTime ? new Date(body.endTime) : new Date(),
            'After写真URL':   photoResult.urls.join('\n'),
            '作業状態':       '完了',
            '施工時間':       duration + '分'
          });
        } catch (e) {
          Logger.log('⚠️ 作業記録更新失敗: ' + e);
        }
      } else {
        Logger.log('⚠️ 作業記録で該当ジョブ行が見つからない: bookingId=' + bookingId + ' jobId=' + (body.jobId || ''));
      }
    }

    // ── 3. 予約ステータス更新（ドロップダウン値に合わせる） ──
    var bkRow = bookingId ? findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId) : null;
    var customerChatId = '';
    var threadId = null;
    if (bkRow) {
      try {
        updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, {
          '進行状態': '作業完了'
        });
      } catch (e) {
        Logger.log('⚠️ 予約ステータス更新失敗: ' + e);
      }
      customerChatId = String(bkRow.data['チャットID'] || '');
      if (customerChatId) {
        var custRow = findCustomerRow(customerChatId);
        if (custRow && custRow.data['トピックID']) {
          threadId = custRow.data['トピックID'];
        }
      }
    }

    // ── 3.5. 手動ジョブ（予約なし）のQR連携解決＋作業記録更新（2026-08-28） ──
    // 従来、予約IDが無い手動ジョブは作業記録が job_end で更新されず、
    // 顧客チャットIDも無いため写真がお客さんに届かなかった。
    // QRスキャン済みなら 作業記録「顧客チャットID」から送信先を復元する。
    if (!bookingId && linkToken && typeof findJobsRowsByLinkToken_ === 'function') {
      try {
        var linkRows = findJobsRowsByLinkToken_(linkToken);
        if (linkRows.length > 0) {
          var linkJobRow = linkRows[linkRows.length - 1];
          try {
            updateRow(SHEET_NAMES.JOBS, linkJobRow.rowIndex, {
              '完了時刻':     body.endTime ? new Date(body.endTime) : new Date(),
              'After写真URL': photoResult.urls.join('\n'),
              '作業状態':     '完了',
              '施工時間':     duration + '分'
            });
          } catch (eUpd) {
            Logger.log('⚠️ 手動ジョブ作業記録更新失敗: ' + eUpd);
          }
          if (!customerChatId) {
            customerChatId = String(linkJobRow.data['顧客チャットID'] || '');
            if (customerChatId) {
              var linkedCustEnd = findCustomerRow(customerChatId);
              if (linkedCustEnd && linkedCustEnd.data['トピックID']) {
                threadId = linkedCustEnd.data['トピックID'];
              }
            }
          }
        }
      } catch (eLink) {
        Logger.log('⚠️ QR連携解決失敗(end): ' + eLink);
      }
    }

    // ── 4. 顧客へ: メッセージ先 → 写真（各処理を個別 try で囲む） ──
    // 有償の手動ジョブ（予約なし・料金>0）のみ合計表示＋支払いご案内（無償は送らない・2026-08-28 A案）
    var manualPaidEnd = (!bookingId && Number(body.amount) > 0) ? Number(body.amount) : 0;
    if (customerChatId) {
      try {
        var custText =
          '✅ ការលាងសម្អាតបញ្ចប់ហើយ!\n' +
          'Your car wash is complete!\n\n' +
          '⏱ ' + duration + ' នាទី / minutes\n' +
          (manualPaidEnd > 0 ? '💵 សរុប / Total: ' + manualPaidEnd + '$\n' : '') +
          '📸 រូបថតក្រោយពេលលាង / After photos ↓';
        sendMessage(BOT_TYPE.BOOKING, customerChatId, custText);
      } catch (e) {
        Logger.log('⚠️ 顧客メッセージ送信失敗: ' + e);
      }
      if (photoResult.blobs.length > 0) {
        try {
          sendPhotoAlbum(BOT_TYPE.BOOKING, customerChatId, photoResult.blobs, '', {});
        } catch (e) {
          Logger.log('⚠️ 顧客写真送信失敗: ' + e);
        }
      }
      // 支払いのご案内（ABA QR・案内型 = 台帳の決済状態は触らない）
      if (manualPaidEnd > 0 && typeof sendManualPaymentInfo_ === 'function') {
        try {
          sendManualPaymentInfo_(customerChatId, manualPaidEnd);
        } catch (ePay) {
          Logger.log('⚠️ 支払いご案内送信失敗: ' + ePay);
        }
      }
    }

    // ── 5. 管理グループへ: メッセージ先 → 写真 ──
    try {
      var adminText = '⏹ 作業終了\n' +
        '━━━━━━━━━━━━━━━━━\n' +
        (bookingId ? '🆔 ' + bookingId + '\n' : '') +
        '👤 ' + (body.name || '-') + '\n' +
        (hasAmountValue_(body.amount) ? '💵 料金: $' + body.amount + '\n' : '') +
        '⏱ 所要時間: ' + duration + '分\n' +
        '📷 After ' + photoResult.urls.length + '枚';

      var adminOpts = {};
      if (threadId) adminOpts.message_thread_id = threadId;

      sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminText, adminOpts);
      if (photoResult.blobs.length > 0) {
        sendPhotoAlbum(BOT_TYPE.BOOKING, cfg.adminGroupId, photoResult.blobs, '', adminOpts);
      }
    } catch (e) {
      Logger.log('⚠️ 管理グループ通知失敗: ' + e);
    }

    // ── 5.5. 紹介元の店舗グループへ同報（提携店経由の顧客のみ・2026-08-10） ──
    var shopRef = '';
    try {
      if (customerChatId && typeof notifyShopGroupJobPhotos === 'function') {
        shopRef = notifyShopGroupJobPhotos(customerChatId,
          '✅ Job finished (customer from your QR)\n' +
          '👤 ' + (body.name || '-') + '\n' +
          '⏱ ' + duration + ' min\n' +
          '📷 After photos ↓',
          photoResult.blobs);
      }
    } catch (e) {
      Logger.log('⚠️ 店舗グループ同報失敗(end): ' + e);
    }

    // ── 5.7. 手動ジョブ（予約なし・有償）は売上を予約シートへ自動計上（2026-08-24） ──
    try {
      if (typeof recordManualJobSaleIfNeeded_ === 'function') {
        recordManualJobSaleIfNeeded_(body, 'job_end');
      }
    } catch (e) {
      Logger.log('⚠️ 手動ジョブ売上 自動計上失敗(job_end): ' + e);
    }

    // ── 6. 決済QRを連続送信（Phase 5） ──
    // CLAUDE.md: 完了通知 → After写真 → QR画像 を連続送信
    // 提携店経由の顧客は「お客様→店に全額支払い」ルールのため当社の決済QRは送らない
    // （二重請求防止・2026-08-10 Daisuke裁可の精算フロー）
    if (shopRef) {
      Logger.log('ℹ️ 店経由精算(shop=' + shopRef + ')のため決済QR送信をスキップ');
    } else if (bookingId && typeof sendPaymentQR === 'function') {
      try {
        var qrRes = sendPaymentQR(bookingId);
        if (!qrRes || !qrRes.ok) {
          Logger.log('ℹ️ sendPaymentQR スキップ/失敗: ' + JSON.stringify(qrRes));
        }
      } catch (e) {
        Logger.log('⚠️ sendPaymentQR 呼び出しエラー: ' + e);
      }
    }

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
    // 手入力ジョブのQR連携コード（2026-08-28 ManualCustomerLink.gs）
    var linkToken = String(body.linkToken || '');

    // 既に作業記録がある場合は何もしない（job_end で完結済み）
    var existing = findJobRowForFinal_(bookingId, body.jobId, linkToken);
    if (existing && existing.data['作業状態'] === '完了') {
      return { status: 'ok', message: 'already completed' };
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
    // 2026-08-28: 手動ジョブ（予約ID無し）も 連携コード で既存行を見つけて更新する
    // （従来は毎回新規行が増えていた）
    var jobRow = findJobRowForFinal_(bookingId, body.jobId, linkToken);

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
      ensureJobsAmountColumn_();  // 「料金(USD)」列を冪等確保
      var linkedChatIdFinal = '';
      if (linkToken && typeof ensureJobsLinkColumns_ === 'function') {
        ensureJobsLinkColumns_();
        linkedChatIdFinal = consumePendingLink_(linkToken);
      }
      var jobId = generateDateSeqId('JOB', SHEET_NAMES.JOBS, 'ジョブID');
      var finalRowObj = {
        'ジョブID':       jobId,
        '予約ID':         bookingId,
        'スタッフID':     '',
        'スタッフ名':     '',
        '作業状態':       '完了',
        '開始時刻':       body.startTime ? new Date(body.startTime) : '',
        '完了時刻':       body.endTime ? new Date(body.endTime) : new Date(),
        'Before写真URL':  beforeUrls.join('\n'),
        'After写真URL':   afterUrls.join('\n'),
        '料金(USD)':      hasAmountValue_(body.amount) ? body.amount : ''
      };
      if (linkToken) {
        finalRowObj[JOBS_COL_LINK_TOKEN] = linkToken;
        if (linkedChatIdFinal) finalRowObj[JOBS_COL_CUSTOMER_CHAT] = linkedChatIdFinal;
      }
      appendRow(SHEET_NAMES.JOBS, finalRowObj);
    }

    // 予約ステータス（ドロップダウン値に合わせる）
    if (bookingId) {
      var bkRow = findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId);
      if (bkRow) {
        try {
          updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, {
            '進行状態': '作業完了'
          });
        } catch (e) {
          Logger.log('⚠️ 予約ステータス更新失敗: ' + e);
        }
      }
    }

    // ── 手動ジョブ売上のバックアップ計上（job_end 不達時の保険・重複キーで冪等） ──
    try {
      if (typeof recordManualJobSaleIfNeeded_ === 'function') {
        recordManualJobSaleIfNeeded_(body, 'job');
      }
    } catch (e) {
      Logger.log('⚠️ 手動ジョブ売上 自動計上失敗(job): ' + e);
    }

    // ── QR送信は apiJobEnd で実施済み。apiJobFinal では二重送信防止のため呼ばない ──
    // 2026-05-20 fix: apiJobEnd と apiJobFinal の両方が sendPaymentQR を呼ぶと、
    //   シート更新タイミングの競合で QR メッセージが顧客に2回届くケースがあった。
    //   PaymentManager.gs 側に LockService を追加済みだが、念のため呼び出し自体を
    //   停止し、apiJobEnd が失敗した場合は retryPaymentQR("BK-XXX") で手動復旧する運用に。
    // if (bookingId && typeof sendPaymentQR === 'function') {
    //   try {
    //     var qrRes = sendPaymentQR(bookingId);
    //     if (!qrRes || !qrRes.ok) {
    //       Logger.log('ℹ️ apiJobFinal sendPaymentQR 結果: ' + JSON.stringify(qrRes));
    //     }
    //   } catch (e) {
    //     Logger.log('⚠️ apiJobFinal sendPaymentQR 呼び出しエラー: ' + e);
    //   }
    // }

    return { status: 'ok' };
  } catch (err) {
    Logger.log('❌ apiJobFinal error: ' + err + ' stack=' + (err.stack || ''));
    return { status: 'error', message: String(err) };
  }
}

/**
 * apiJobFinal 用: 対象の作業記録行を探す
 * 予約経由は 予約ID/ジョブID、手動ジョブは 連携コード（2026-08-28）で解決
 *
 * @return {{rowIndex: number, data: Object} | null}
 */
function findJobRowForFinal_(bookingId, jobId, linkToken) {
  try {
    if (bookingId) {
      return jobId
        ? findRow(SHEET_NAMES.JOBS, 'ジョブID', jobId)
        : findLastRow(SHEET_NAMES.JOBS, '予約ID', bookingId);
    }
    if (linkToken && typeof findJobsRowsByLinkToken_ === 'function') {
      var rows = findJobsRowsByLinkToken_(linkToken);
      return rows.length > 0 ? rows[rows.length - 1] : null;
    }
  } catch (e) {
    Logger.log('⚠️ findJobRowForFinal_: ' + e);
  }
  return null;
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
  var anySuccess = false;

  for (var offset = 0; offset < blobs.length; offset += maxBatch) {
    var batch = blobs.slice(offset, offset + maxBatch);
    var payload = { chat_id: String(chatId) };
    if (opts && opts.message_thread_id) {
      payload.message_thread_id = String(opts.message_thread_id);
    }

    var media = [];
    for (var i = 0; i < batch.length; i++) {
      var item = { type: 'photo', media: 'attach://photo' + i };
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
      if (lastRes.ok) {
        anySuccess = true;
      } else {
        Logger.log('⚠️ sendMediaGroup failed (chatId=' + chatId + '): ' + body);
      }
    } catch (err) {
      Logger.log('❌ sendPhotoAlbum error (chatId=' + chatId + '): ' + err);
      lastRes = { ok: false, error: String(err) };
    }
  }

  // アルバムが失敗したら1枚ずつ個別送信でフォールバック
  if (!anySuccess) {
    Logger.log('⚠️ アルバム送信失敗 → 1枚ずつフォールバック (chatId=' + chatId + ')');
    return sendPhotosIndividually(botType, chatId, blobs, caption, opts);
  }
  return lastRes || { ok: false };
}

/**
 * フォールバック: 1枚ずつ sendPhoto で送信
 */
function sendPhotosIndividually(botType, chatId, blobs, caption, opts) {
  var okCount = 0;
  for (var i = 0; i < blobs.length; i++) {
    var cap = (i === 0 && caption) ? caption : '';
    var res = sendPhotoBlob(botType, chatId, blobs[i], cap, opts);
    if (res && res.ok) okCount++;
  }
  return { ok: okCount > 0, sent: okCount, total: blobs.length };
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
