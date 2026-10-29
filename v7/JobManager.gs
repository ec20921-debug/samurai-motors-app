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
        // Menu v4 (2026-09-22): オプション(GLASS_3,HEADLIGHT 等の CSV)を現場画面へ
        options: headers['オプション'] ? String(row[headers['オプション'] - 1] || '') : '',
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
        manualCampaign: manualCampaign,
        // 2026-10-15: 専用QR（流入元）。現場アプリで「🏢 Picasso #部屋」を出す
        source: (headers['流入元'] && row[headers['流入元'] - 1] && typeof sourceStaffLabel_ === 'function')
          ? sourceStaffLabel_(String(row[headers['流入元'] - 1])) : '',
        room: headers['部屋番号'] ? String(row[headers['部屋番号'] - 1] || '') : '',
        // 2026-10-29: 予約の中身（現場アプリ）に住所の文字と場所のメモ（お客様が予約画面で書く・任意）
        address: headers['住所'] ? String(row[headers['住所'] - 1] || '') : '',
        placeNote: headers['場所補足'] ? String(row[headers['場所補足'] - 1] || '') : '',
        perk: headers['特典'] ? String(row[headers['特典'] - 1] || '') : ''
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
 * Menu v4 (2026-09-23): 作業記録シートに「サービス」列を冪等確保する。
 * 無料施工（売上計上なし）でも「何のサービスに何分かかったか」をシートに残すため。
 */
var JOBS_COL_SERVICE = 'サービス';

function ensureJobsServiceColumn_() {
  try {
    var sheet = getSheet(SHEET_NAMES.JOBS);
    var headers = getHeaderMap(SHEET_NAMES.JOBS);
    if (!headers[JOBS_COL_SERVICE]) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(JOBS_COL_SERVICE);
    }
  } catch (e) {
    Logger.log('⚠️ ensureJobsServiceColumn_ 失敗（記録は継続）: ' + e);
  }
}

/**
 * 手入力ジョブの選択サービスを CSV にする: 'WASH,GLASS_3,HEADLIGHT' / 'BODY' / ''
 * body.plan は "SAMURAI WASH (W)" 形式 → 'WASH' に正規化。オプションは manualOptionCodesCsv_（ManualSales.gs）
 */
function jobServiceCsv_(body) {
  var parts = [];
  var plan = String(body.plan || '').trim();
  if (plan) parts.push(/WASH|\(W\)/i.test(plan) ? 'WASH' : plan);
  var opts = (typeof manualOptionCodesCsv_ === 'function') ? manualOptionCodesCsv_(body) : String(body.glassOption || '');
  if (opts) parts.push(opts);
  return parts.join(',');
}

/**
 * 管理グループ通知用のサービス行（2026-09-23 Daisuke 指示: WASH の有無が一目で分かるように）
 * 例: '✨ サービス: WASH + BODY（セダン）'
 *     '✨ サービス: BODY（セダン）\n⚠️ WASH 未選択（洗車もした場合は現場に確認）'
 */
function jobServiceLine_(body) {
  var csv = jobServiceCsv_(body);
  var names = csv ? csv.split(',') : [];
  var label = {
    'WASH': 'WASH', 'GLASS_3': 'GLASS 3面', 'GLASS_ALL': 'GLASS 全面',
    'HEADLIGHT': 'HEADLIGHT', 'HEADLIGHT_MAGIC': 'HEADLIGHT MAGIC', 'BODY': 'BODY'
  };
  var shown = names.map(function(n) { return label[n] || n; });
  var line = '✨ サービス: ' + (shown.length ? shown.join(' + ') : '未選択') +
             '（' + (body.vehicleType || '-') + '）\n';
  if (shown.length && names.indexOf('WASH') < 0) {
    line += '⚠️ WASH 未選択（洗車もした場合は現場に確認）\n';
  }
  return line;
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
function apiJobStart(body, opts) {
  // opts（2026-10-08 v2）: { rowIndex, jobId } … JobIdempotency.gs が先に書いた行を使う
  opts = opts || {};
  var adminDelivered = false;
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
    ensureJobsServiceColumn_(); // 「サービス」列を冪等確保（Menu v4）
    // QR連携: 列確保＋スキャン先行分（pendlink）の解決
    var linkedChatId = '';
    if (linkToken && typeof ensureJobsLinkColumns_ === 'function') {
      ensureJobsLinkColumns_();
      linkedChatId = consumePendingLink_(linkToken);
    }
    var jobId = opts.rowIndex ? opts.jobId : generateDateSeqId('JOB', SHEET_NAMES.JOBS, 'ジョブID');
    // 予約行（作業記録の流入元・予約ステータス・トピック ID に使う）
    // 失敗しても作業記録は必ず残す（従来はこの検索が記録の後だった）
    var bkRow = null;
    try {
      bkRow = bookingId ? findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId) : null;
    } catch (e) {
      Logger.log('⚠️ apiJobStart: 予約行の検索失敗（作業記録は続行）: ' + e);
    }
    var jobSource = (bkRow && bkRow.data['流入元']) ? String(bkRow.data['流入元']) : '';
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
    jobRowObj[JOBS_COL_SERVICE] = jobServiceCsv_(body);   // 無料施工でもサービス内容を残す
    if (jobSource) jobRowObj['流入元'] = jobSource;          // 2026-10-15 専用QR（流入元）
    if (linkToken) {
      jobRowObj[JOBS_COL_LINK_TOKEN] = linkToken;
      if (linkedChatId) jobRowObj[JOBS_COL_CUSTOMER_CHAT] = linkedChatId;
    }
    if (opts.rowIndex) {
      // v2: 行は二重処理対策の入口で作成済み。送り直しで QR 連携を消費済みなら行の値を使う。
      // 作業状態・完了時刻・After写真・施工時間は書かない（終了が先に届いた行を「作業中」に戻さない）
      var existingRow = readRow(SHEET_NAMES.JOBS, opts.rowIndex);
      if (!linkedChatId && existingRow[JOBS_COL_CUSTOMER_CHAT]) linkedChatId = String(existingRow[JOBS_COL_CUSTOMER_CHAT]);
      var v2StartUpdates = {
        'Before写真URL': jobRowObj['Before写真URL'],
        '車種':          jobRowObj['車種']
      };
      if (hasAmountValue_(body.amount)) v2StartUpdates['料金(USD)'] = body.amount;
      v2StartUpdates[JOBS_COL_SERVICE] = jobRowObj[JOBS_COL_SERVICE];
      if (jobSource) v2StartUpdates['流入元'] = jobSource;
      if (linkToken) v2StartUpdates[JOBS_COL_LINK_TOKEN] = linkToken;
      if (linkedChatId) v2StartUpdates[JOBS_COL_CUSTOMER_CHAT] = linkedChatId;
      updateRow(SHEET_NAMES.JOBS, opts.rowIndex, v2StartUpdates);
    } else {
      appendRow(SHEET_NAMES.JOBS, jobRowObj);
    }

    // ── 3. 予約ステータス更新（ドロップダウン値に合わせる） ──
    // v2: 予約がすでに「作業完了」なら巻き戻さない（開始の遅延到着）
    if (bkRow && !(opts.rowIndex && String(bkRow.data['進行状態'] || '') === '作業完了')) {
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
    if (customerChatId && !(typeof jobCustSent_ === 'function' && jobCustSent_(opts, 'start'))) {
      if (typeof jobMarkCustSent_ === 'function') jobMarkCustSent_(opts, 'start');   // v2: 再送で顧客に重複させない
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
        (typeof sourceAdminLineForJob_ === 'function' && bkRow ? sourceAdminLineForJob_(bkRow.data) : '') +
        (opts.fieldShopId ? '🏪 提携店: ' + ((typeof getShopNameById_ === 'function' && getShopNameById_(opts.fieldShopId)) || opts.fieldShopId) + '\n' : '') +
        '👤 ' + (body.name || '-') + '\n' +
        '🏢 ' + (body.building || '-') + ' ' + (body.room || '') + '\n' +
        '🚗 ' + (body.carModel || '-') + ' / ' + (body.plate || '-') + '\n' +
        jobServiceLine_(body) +
        (hasAmountValue_(body.amount) ? '💵 料金: $' + body.amount + '\n' : '') +
        '🕐 開始: ' + formatISOtoPhnomPenh(body.startTime) + '\n' +
        '📷 Before ' + photoResult.urls.length + '枚';

      var adminOpts = {};
      if (threadId) adminOpts.message_thread_id = threadId;

      var adminRes = sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminText, adminOpts);
      if (opts.rowIndex && !(adminRes && adminRes.ok) && adminOpts.message_thread_id) {
        adminOpts = {};   // v2: トピックが消えている等 → 一般スレッドに送る
        adminRes = sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminText, adminOpts);
      }
      adminDelivered = !!(adminRes && adminRes.ok);
      if (photoResult.blobs.length > 0) {
        var albumRes = sendPhotoAlbum(BOT_TYPE.BOOKING, cfg.adminGroupId, photoResult.blobs, '', adminOpts);
        if (!(albumRes && albumRes.ok)) adminDelivered = false;
      }
    } catch (e) {
      Logger.log('⚠️ 管理グループ通知失敗: ' + e);
    }

    // ── 6. 紹介元の店舗グループへ同報（提携店経由の顧客のみ・2026-08-10） ──
    var startShopSent = '';
    try {
      if (customerChatId && typeof notifyShopGroupJobPhotos === 'function') {
        // 店マスター「グループへの通知の言語」の順（PartnerLang.gs・2026-10-26）
        startShopSent = notifyShopGroupJobPhotos(customerChatId, function(sid) {
          return shopGroupJobText_(shopGroupLangs_(sid), { phase: 'start', who: 'qr', name: body.name || '', car: body.carModel || '', photos: 'before' });
        }, photoResult.blobs, bkRow ? bkRow.data : null);   // 予約の紹介元を優先（2026-10-27 紹介の期限）
      }
    } catch (e) {
      Logger.log('⚠️ 店舗グループ同報失敗(start): ' + e);
    }
    // 流入元（レジデンス等）の提携先グループへ開始と Before 写真（2026-10-26 SourceGroupNotify.gs）
    // 「共有されます」を伝えた予約だけ。提携店 QR のお客様（グループ未連携の店も含む＝終了側の shopRef と同じ判定）には送らない
    var startSrcSent = '';
    var startIsShopCust = !!startShopSent;
    if (!startIsShopCust && customerChatId && typeof getValidShopRef_ === 'function') {
      try { startIsShopCust = !!getValidShopRef_(customerChatId); } catch (e) { Logger.log('⚠️ 提携店判定失敗(start): ' + e); }
    }
    if (bookingId && !startIsShopCust && typeof notifySourceGroupJob_ === 'function') {
      startSrcSent = notifySourceGroupJob_('start', {
        bookingId: bookingId, carModel: body.carModel, blobs: photoResult.blobs, opts: opts
      });
    }
    // 現場アプリで作業開始の前に選んだ店（店の車など・2026-10-25）: その店のグループへ開始と Before 写真を送る
    // shop_id は apiJobStartV2 が確かめた値（opts）だけを使う。同じ送信の再実行では送り直さない
    var startFieldShop = String(opts.fieldShopId || '');
    if (startFieldShop && startFieldShop !== startShopSent && startFieldShop !== startSrcSent) {
      try {
        if (!jobCustSent_(opts, 'startshop:' + startFieldShop) && typeof notifyShopGroupByShopId_ === 'function') {
          jobMarkCustSent_(opts, 'startshop:' + startFieldShop);
          var fieldShopSent = notifyShopGroupByShopId_(startFieldShop,
            shopGroupJobText_(shopGroupLangs_(startFieldShop), { phase: 'start', who: 'shop',
              car: [body.carModel, body.plate].filter(Boolean).join(' / ') || body.name || '', photos: 'before' }),
            photoResult.blobs);
          // 作業前からあった傷・へこみを文章で（2026-10-28 FieldShopMode.gs。SHOP_DAMAGE_NOTE=on の時だけ）
          if (fieldShopSent && typeof notifyShopDamage_ === 'function') notifyShopDamage_(startFieldShop, body);
        }
      } catch (e) {
        Logger.log('⚠️ 選んだ提携店への同報失敗(start): ' + e);
      }
    }

    // v2: 管理通知が届かない／写真を1枚も保存できない場合は「配信済み」にしない（送り直しで再配信）
    if (opts.rowIndex) {
      var startPhotosExpected = (body.beforePhotos || []).length;
      if (!adminDelivered || (startPhotosExpected > 0 && photoResult.urls.length === 0)) {
        // 上限回数に達したら配信済みとして進め、要確認の印だけ返す
        if (opts.lastChance) return { status: 'ok', jobId: jobId, warning: 'DELIVERY_PARTIAL',
                 adminSent: adminDelivered, photosSaved: photoResult.urls.length, photosExpected: startPhotosExpected };
        return { status: 'error', error: 'DELIVERY_FAILED', retryable: true, jobId: jobId,
                 adminSent: adminDelivered, photosSaved: photoResult.urls.length, photosExpected: startPhotosExpected };
      }
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
function apiJobEnd(body, opts) {
  // opts（2026-10-08 v2）: { rowIndex, jobId, rowData } … JobIdempotency.gs が特定した行
  opts = opts || {};
  var adminDelivered = false;
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
    if (opts.rowIndex) {
      // v2: client_id で特定済みの行を更新（予約IDの最新行に頼らない＝他端末の行を取り違えない）
      try {
        var v2Updates = {
          '完了時刻':     body.endTime ? new Date(body.endTime) : new Date(),
          'After写真URL': photoResult.urls.join('\n'),
          '作業状態':     '完了',
          '施工時間':     duration + '分'
        };
        var svcV2 = jobServiceCsv_(body);
        if (svcV2) v2Updates[JOBS_COL_SERVICE] = svcV2;
        if (hasAmountValue_(body.amount)) v2Updates['料金(USD)'] = body.amount;
        updateRow(SHEET_NAMES.JOBS, opts.rowIndex, v2Updates);
      } catch (e) {
        Logger.log('⚠️ 作業記録更新失敗(v2): ' + e);
      }
    } else if (bookingId) {
      // jobId が body で指定されていればそれで検索、なければ 予約ID の最新ヒット行
      var jobRow = body.jobId
        ? findRow(SHEET_NAMES.JOBS, 'ジョブID', body.jobId)
        : findLastRow(SHEET_NAMES.JOBS, '予約ID', bookingId);
      if (jobRow) {
        try {
          var endUpdates = {
            '完了時刻':       body.endTime ? new Date(body.endTime) : new Date(),
            'After写真URL':   photoResult.urls.join('\n'),
            '作業状態':       '完了',
            '施工時間':       duration + '分'
          };
          var svcEnd = jobServiceCsv_(body);
          if (svcEnd) { ensureJobsServiceColumn_(); endUpdates[JOBS_COL_SERVICE] = svcEnd; }
          updateRow(SHEET_NAMES.JOBS, jobRow.rowIndex, endUpdates);
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
    if (opts.rowIndex && !customerChatId && opts.rowData && opts.rowData['顧客チャットID']) {
      // v2 の手動ジョブ: 作業開始時に QR 連携できていれば、その顧客に送る
      customerChatId = String(opts.rowData['顧客チャットID']);
      var v2Cust = findCustomerRow(customerChatId);
      if (v2Cust && v2Cust.data['トピックID']) threadId = v2Cust.data['トピックID'];
    }
    if (!opts.rowIndex && !bookingId && linkToken && typeof findJobsRowsByLinkToken_ === 'function') {
      try {
        var linkRows = findJobsRowsByLinkToken_(linkToken);
        if (linkRows.length > 0) {
          var linkJobRow = linkRows[linkRows.length - 1];
          try {
            var linkUpdates = {
              '完了時刻':     body.endTime ? new Date(body.endTime) : new Date(),
              'After写真URL': photoResult.urls.join('\n'),
              '作業状態':     '完了',
              '施工時間':     duration + '分'
            };
            var svcLink = jobServiceCsv_(body);
            if (svcLink) { ensureJobsServiceColumn_(); linkUpdates[JOBS_COL_SERVICE] = svcLink; }
            updateRow(SHEET_NAMES.JOBS, linkJobRow.rowIndex, linkUpdates);
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
    // 2026-10-25: 支払区分（FieldPayment.gs）。提携店の仕事はお客様が店に払うので、当社の取り分（合計）は見せない
    var ptEnd = (typeof fieldPayType_ === 'function') ? fieldPayType_(body) : String(body.paymentType || (body.v2 && body.v2.payment_type) || '');
    var ptEndShop = (typeof fieldPayIsShop_ === 'function') ? fieldPayIsShop_(ptEnd) : ptEnd === 'shop';
    var fieldShopNameEnd = opts.fieldShopId ? ((typeof getShopNameById_ === 'function' && getShopNameById_(String(opts.fieldShopId))) || String(opts.fieldShopId)) : '';
    var manualPaidEnd = (!bookingId && Number(body.amount) > 0 && !ptEndShop) ? Number(body.amount) : 0;
    if (customerChatId && !(typeof jobCustSent_ === 'function' && jobCustSent_(opts, 'end'))) {
      if (typeof jobMarkCustSent_ === 'function') jobMarkCustSent_(opts, 'end');   // v2: 再送で顧客に重複させない
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
      // 提携店払い（支払区分 shop・店QR経由の客）には送らない判定は sendManualPaymentInfo_ 側（2026-10-20）
      if (manualPaidEnd > 0 && typeof sendManualPaymentInfo_ === 'function') {
        try {
          sendManualPaymentInfo_(customerChatId, manualPaidEnd,
            String(body.paymentType || (body.v2 && body.v2.payment_type) || ''));
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
        (typeof sourceAdminLineForJob_ === 'function' && bkRow ? sourceAdminLineForJob_(bkRow.data) : '') +
        '👤 ' + (body.name || '-') + '\n' +
        jobServiceLine_(body) +
        (hasAmountValue_(body.amount) ? (ptEndShop ? '💵 当社分: $' : '💵 料金: $') + body.amount + '\n' : '') +
        (typeof fieldPayAdminLine_ === 'function' ? fieldPayAdminLine_(ptEnd, fieldShopNameEnd, body, opts.fieldShopId || '') : '') +
        '⏱ 所要時間: ' + duration + '分\n' +
        '📷 After ' + photoResult.urls.length + '枚';

      var adminOpts = {};
      if (threadId) adminOpts.message_thread_id = threadId;

      var adminResEnd = sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminText, adminOpts);
      if (opts.rowIndex && !(adminResEnd && adminResEnd.ok) && adminOpts.message_thread_id) {
        adminOpts = {};   // v2: トピックが消えている等 → 一般スレッドに送る
        adminResEnd = sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminText, adminOpts);
      }
      adminDelivered = !!(adminResEnd && adminResEnd.ok);
      if (photoResult.blobs.length > 0) {
        var albumResEnd = sendPhotoAlbum(BOT_TYPE.BOOKING, cfg.adminGroupId, photoResult.blobs, '', adminOpts);
        if (!(albumResEnd && albumResEnd.ok)) adminDelivered = false;
      }
    } catch (e) {
      Logger.log('⚠️ 管理グループ通知失敗: ' + e);
    }

    // v2: 管理通知が届かない／写真を1枚も保存できない場合は売上計上・QR の前に止めて再送を待つ
    var endPartial = null;
    if (opts.rowIndex) {
      var endPhotosExpected = (body.afterPhotos || []).length;
      if (!adminDelivered || (endPhotosExpected > 0 && photoResult.urls.length === 0)) {
        // 上限回数に達したら売上計上・QR へ進め、要確認の印だけ返す
        if (opts.lastChance) endPartial = { warning: 'DELIVERY_PARTIAL', adminSent: adminDelivered,
                 photosSaved: photoResult.urls.length, photosExpected: endPhotosExpected };
        else return { status: 'error', error: 'DELIVERY_FAILED', retryable: true,
                 adminSent: adminDelivered, photosSaved: photoResult.urls.length, photosExpected: endPhotosExpected };
      }
    }

    // ── 5.5. 紹介元の店舗グループへ同報（提携店経由の顧客のみ・2026-08-10） ──
    var shopRef = '';
    try {
      if (customerChatId && typeof notifyShopGroupJobPhotos === 'function') {
        shopRef = notifyShopGroupJobPhotos(customerChatId, function(sid) {
          return shopGroupJobText_(shopGroupLangs_(sid), { phase: 'end', who: 'qr', name: body.name || '', duration: duration, photos: 'after' });
        }, photoResult.blobs, bkRow ? bkRow.data : null);   // 予約の紹介元を優先（2026-10-27 紹介の期限）
      }
    } catch (e) {
      Logger.log('⚠️ 店舗グループ同報失敗(end): ' + e);
    }
    // 店舗グループ未連携の店でも、QR経由の顧客なら店集金として扱う（2026-10-20）
    // 2026-10-26: 予約に紹介元（予約した時の店QR）が記録されていれば、それで判定する（個人提携は当社集金。
    //   予約のあとで別の提携先のQRを読んでも、店集金⇄当社集金を取り違えない・IndividualPartner.gs）
    var bkReferral = bkRow ? String(bkRow.data['紹介元shop_id'] || '').trim() : '';
    if (bkReferral && typeof getValidShopRefForBooking_ === 'function') {
      try { shopRef = getValidShopRefForBooking_(bkRow.data, customerChatId); } catch (e) { Logger.log('⚠️ 提携店判定失敗(予約の紹介元): ' + e); }
    } else if (!shopRef && customerChatId && typeof getValidShopRef_ === 'function') {
      try { shopRef = getValidShopRef_(customerChatId); } catch (e) { Logger.log('⚠️ 提携店判定失敗: ' + e); }
    }
    // 流入元（レジデンス等）の提携先グループへ完了と After 写真（「共有されます」を伝えた予約だけ・提携店 QR のお客様でないときだけ・2026-10-26 SourceGroupNotify.gs）
    // 通知だけ。shopRef（店集金の判定）には入れない
    var endSrcSent = '';
    if (bookingId && !shopRef && typeof notifySourceGroupJob_ === 'function') {
      endSrcSent = notifySourceGroupJob_('end', {
        bookingId: bookingId, carModel: body.carModel, duration: duration, blobs: photoResult.blobs, opts: opts
      });
    }
    var payTypeShop = String(body.paymentType || (body.v2 && body.v2.payment_type) || '');
    // 現場アプリで提携店を選んだ作業（在庫車・ボイス依頼など・2026-10-22）: その店のグループへ完了と写真を送る。
    // shop_id は apiJobEndV2 が確かめた値（opts）だけを使う。同じ送信の再実行では送り直さない
    var fieldShopId = String(opts.fieldShopId || '');
    // 作業開始の前に選んだ店（2026-10-25・apiJobEndV2 が確かめた値）。終了で店を選ばなくても、その店へ After を送る（売上・請求には使わない）
    var startShopId = String(opts.startShopId || '');
    var photoShopId = fieldShopId || startShopId;
    var shopFromField = false;
    if (photoShopId && photoShopId !== shopRef) {
      var fieldPhase = 'endshop:' + photoShopId;
      try {
        // 流入元の通知で同じグループへ送った時は送らない（下の店集金の判定は止めない）
        if (photoShopId !== endSrcSent && !jobCustSent_(opts, fieldPhase) && typeof notifyShopGroupByShopId_ === 'function') {
          jobMarkCustSent_(opts, fieldPhase);
          var finishLangs = shopGroupLangs_(photoShopId);   // 店マスター「グループへの通知の言語」の順（PartnerLang.gs・2026-10-26）
          var finishText = shopGroupJobText_(finishLangs, { phase: 'end', who: 'shop', car: body.carModel || body.name || '', duration: duration }) + '\n';
          // 作業開始で Before を送っていない店（終了で初めて選んだ店）には、Before も送る（After とは別のアルバム）
          var beforeBlobs = (photoShopId !== startShopId && opts.rowData && typeof driveUrlsToBlobs_ === 'function')
            ? driveUrlsToBlobs_(String(opts.rowData['Before写真URL'] || '').split('\n').filter(String)) : [];
          if (beforeBlobs.length > 0) {
            notifyShopGroupByShopId_(photoShopId, finishText + shopGroupPhotosLine_(finishLangs, 'before'), beforeBlobs);
            notifyShopGroupByShopId_(photoShopId, shopGroupPhotosLine_(finishLangs, 'after'), photoResult.blobs);
          } else {
            notifyShopGroupByShopId_(photoShopId, finishText + shopGroupPhotosLine_(finishLangs, 'after'), photoResult.blobs);
          }
        }
      } catch (e) {
        Logger.log('⚠️ 選んだ提携店への同報失敗: ' + e);
      }
      // 予約なしで提携店の仕事（店の車 shop・紹介客 shopref）の時は店集金として扱う（終了で選んだ店だけ）
      if (!shopRef && !bookingId && ptEndShop && fieldShopId) { shopRef = fieldShopId; shopFromField = true; }
    }
    var adminShopOpts = threadId ? { message_thread_id: threadId } : {};
    // 予約なしの手動ジョブで現場が現金・ABA を明示した時は当社集金（ご案内も送っている）ので「提携店経由」と出さない
    var directOnShopRef = !!(shopRef && bookingId && (ptEnd === 'aba' || ptEnd === 'free' || ptEnd === 'cash'));
    if (directOnShopRef) {
      try {
        sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
          '⚠️ 店QR経由のお客様（' + ((typeof getShopNameById_ === 'function' && getShopNameById_(shopRef)) || shopRef) + '）ですが、現場は「' +
          (ptEnd === 'free' ? '無料' : 'ABA QR で受け取った') + '」を選びました。' + (ptEnd === 'free' ? '無料にしています。' : 'お客様から直接受け取っています。') + 'お店との二重請求にならないか確認してください', adminShopOpts);
      } catch (e) {
        Logger.log('⚠️ 店QR客の直接受け取りの管理通知失敗: ' + e);
      }
    } else if (shopRef && (bookingId || (payTypeShop !== 'cash' && payTypeShop !== 'aba'))) {
      try {
        var shopNameEnd = (typeof getShopNameById_ === 'function' && getShopNameById_(shopRef)) || shopRef;
        sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, shopFromField
          ? '🏪 提携店の作業（' + (payTypeShop === 'shopref' ? '紹介のお客さん' : 'お店の車') + '）: ' + shopNameEnd + '\n' +
            '当社分 $' + (Number(body.amount) || 0) + ' はお店のグループへの請求（ABA QR）でその場で払ってもらう。売上は清算済みで計上。お客様へ当社の決済QRは送っていません'
          : '🏪 提携店経由: ' + shopNameEnd + '\n' +
            'お客様は店に定価を支払い → 当社分は店から QR で受け取る。お客様へ当社の決済QRは送っていません', adminShopOpts);
      } catch (e) {
        Logger.log('⚠️ 提携店経由の管理通知失敗: ' + e);
      }
    } else if (ptEndShop) {
      // 「提携店が払う」なのに店が分からない／予約のお客様が店QR経由でない → 取りこぼし・二重請求にならないよう知らせる
      try {
        sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, bookingId
          ? '⚠️ 現場は提携店の仕事（' + (payTypeShop === 'shopref' ? '紹介のお客さん' : 'お店の車') + '）を選びましたが、このお客様は店のQR経由ではありません。現場の記録（お店から受け取る）に合わせて予約を清算済みにします。お店とお客様の二重請求にならないか確認してください'
          : '⚠️ 提携店の仕事ですが、どのお店か選ばれていません。お店を確認して記録してください', adminShopOpts);
      } catch (e) {
        Logger.log('⚠️ 店払いの確認通知失敗: ' + e);
      }
    }

    // 開始と終了で別の店を選んだ: 開始の店には Before だけが届いている（完了は届かない）ので知らせる（2026-10-25）
    if (fieldShopId && startShopId && fieldShopId !== startShopId) {
      try {
        sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
          '⚠️ 作業開始と終了で別の提携店が選ばれました: 開始 ' + ((typeof getShopNameById_ === 'function' && getShopNameById_(startShopId)) || startShopId) +
          ' → 終了 ' + ((typeof getShopNameById_ === 'function' && getShopNameById_(fieldShopId)) || fieldShopId) +
          '。開始の店のグループには Before だけが届いています。必要ならお店に連絡してください', adminShopOpts);
      } catch (e) {
        Logger.log('⚠️ 店の変更の管理通知失敗: ' + e);
      }
    }

    // この作業の提携店（売上行と請求で同じ店を使う）: 予約なしで提携店の仕事なら現場で選んだ店、それ以外はお客様の店QR
    // 予約ありでも現場で店を選んだ店の仕事なら、その店に請求する（2026-10-25 検証の指摘）
    var saleShopId = (ptEndShop && fieldShopId) ? fieldShopId : shopRef;

    // ── 5.7. 手動ジョブ（予約なし・有償）は売上を予約シートへ自動計上（2026-08-24） ──
    var manualSaleId = null;
    try {
      // 2026-10-08 D4: 支払区分による可否は recordManualJobSaleIfNeeded_ の入口で判定
      // 2026-10-23: 提携店払いはその店を売上行に書く（現場で選んだ店を優先＝作業記録の 提携店ID・毎時シンクと揃える）
      if (typeof recordManualJobSaleIfNeeded_ === 'function') {
        manualSaleId = recordManualJobSaleIfNeeded_(body, 'job_end', {
          shopId: saleShopId,
          jobId: opts.jobId || ''
        });
      }
    } catch (e) {
      Logger.log('⚠️ 手動ジョブ売上 自動計上失敗(job_end): ' + e);
    }

    // ── 5.8. 提携店の仕事（店の車・紹介のお客さん）は、その店のグループへ当社分の請求＋ABA QR（2026-10-25 ShopInvoice.gs） ──
    // 店は売上行と同じ saleShopId。送れない時（店が分からない・未連携・定価なし等）は ShopInvoice.gs が管理グループへ理由を出す
    if (ptEndShop && typeof sendShopInvoiceForJob_ === 'function') {
      sendShopInvoiceForJob_(body, opts, {
        shopId:    saleShopId,
        pt:        ptEnd,
        refId:     bookingId || manualSaleId || opts.jobId || '',
        adminOpts: adminShopOpts
      });
    }

    // ── 6. 決済QRを連続送信（Phase 5） ──
    // CLAUDE.md: 完了通知 → After写真 → QR画像 を連続送信
    // 提携店経由の顧客は「お客様→店に全額支払い」ルールのため当社の決済QRは送らない
    // （二重請求防止・2026-08-10 Daisuke裁可の精算フロー）
    var paidOnSiteDone = false;
    if (bookingId && typeof fieldPaidOnSite_ === 'function' && fieldPaidOnSite_(ptEnd) && typeof markBookingPaidOnSite_ === 'function') {
      // 2026-10-25 Daisuke: 予約客がその場で払った時（ABA QR・店・無料）は予約を清算済みにして決済QRと催促を送らない
      var paidShopName = fieldShopNameEnd || (shopRef && typeof getShopNameById_ === 'function' ? getShopNameById_(shopRef) : '');
      paidOnSiteDone = markBookingPaidOnSite_(bkRow, body, ptEnd, paidShopName, String(opts.fieldShopId || '') || saleShopId);
      if (paidOnSiteDone) {
        Logger.log('ℹ️ 予約 ' + bookingId + ' は現場で受け取り済み（' + ptEnd + '）のため決済QR送信をスキップ');
      } else {
        try {
          sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, '⚠️ 予約 ' + bookingId + ' は現場で「受け取り済み」を選びましたが、金額（$' + (body.amount === undefined ? '-' : body.amount) +
            '）が使えないため清算済みにしていません。決済QRは通常どおりの扱いです。金額を確認してください', adminShopOpts);
        } catch (e) { Logger.log('⚠️ その場払いの確認通知失敗: ' + e); }
      }
    }
    if (paidOnSiteDone) {
      // 何もしない（上で清算済み）
    } else if (bookingId && shopRef) {
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

    if (endPartial) { endPartial.status = 'ok'; return endPartial; }
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
      var svcFinal = jobServiceCsv_(body);
      if (svcFinal && !jobRow.data[JOBS_COL_SERVICE]) { ensureJobsServiceColumn_(); updates[JOBS_COL_SERVICE] = svcFinal; }
      updateRow(SHEET_NAMES.JOBS, jobRow.rowIndex, updates);
    } else {
      // job_start が届かなかったケース
      ensureJobsAmountColumn_();  // 「料金(USD)」列を冪等確保
      ensureJobsServiceColumn_(); // 「サービス」列を冪等確保（Menu v4）
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
      finalRowObj[JOBS_COL_SERVICE] = jobServiceCsv_(body);
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
    // 端数がちょうど1枚（11・21枚…）だと sendMediaGroup が失敗して黙って欠けるので、その1枚は sendPhoto で送る（2026-10-25）
    if (batch.length === 1) {
      lastRes = sendPhotoBlob(botType, chatId, batch[0], '', opts);
      if (lastRes && lastRes.ok) anySuccess = true;
      continue;
    }
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
