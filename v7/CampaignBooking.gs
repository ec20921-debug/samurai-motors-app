/**
 * CampaignBooking.gs — 手動特価キャンペーン予約
 *
 * 【責務】
 *   - 「特価キャンペーン」マスターから有効＆期間内のキャンペーン一覧を提供
 *   - 公開 createBooking() とは別経路で手動予約を作成（経路を物理的に分離）
 *   - 出張作業後の手動清算（決済状態 → 清算済み）
 *   - PaymentManager 自動 QR から手動特価をスキップさせる判定関数を提供
 *
 * 【データ駆動】
 *   キャンペーンは「特価キャンペーン」シートの行で定義。
 *   $5 はそのうちの 1 行（CAMP-5USD）にすぎず、行を増やせばキャンペーンが増える。
 *
 * 【絶対やらない】
 *   - createBooking() に分岐を足さない（経路を物理的に分離する原則）
 *   - 料金設定シートに特価を入れない（公開価格に漏れる）
 *   - 自動 QR（PaymentManager）に通さない（手動 QR オペ）
 *
 * 【関連ドキュメント】
 *   - docs/HANDOFF_ManualCampaignBooking.md
 *   - docs/SPEC_CampaignBroadcast.md §1（2 価格分離原則）
 */

// ====== 定数 ======

// シート名（Setup_CampaignBooking.gs と一致）
var MANUAL_CAMPAIGN_SHEET = '特価キャンペーン';

// isManualCampaignBooking のキャッシュ TTL（秒）
var MANUAL_CAMPAIGN_NAMES_TTL = 60;

// ====== API: manualCampaignList ======

/**
 * キャンペーンの売上を「予約」シートに1行記録する（売上計上用）。
 * 2026-06-23: 経営ダッシュボードは 予約!料金(K) を 予約日(H, Date型)・進行状態(L)≠キャンセル
 * で集計するため、完了・清算済みの1行を予約シートに作れば即売上に反映される。
 * ※予約日は必ず Date 型で書く（文字列だと日付フィルタに乗らず売上$0になる既知の不具合）。
 *
 * @param {Object} params { campaignId, amount, name, carModel, plate }
 * @return {Object}
 */
function recordCampaignSale(params) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15 * 1000)) {
    return { status: 'error', message: 'システム混雑中。もう一度お試しください。' };
  }
  try {
    var campaignId = String(params.campaignId || '');
    var amount = Number(params.amount);
    var name = String(params.name || '').trim();
    var carModel = String(params.carModel || '').trim();
    var plate = String(params.plate || '').trim();

    if (!campaignId) return { status: 'error', message: 'キャンペーンを選択してください' };
    if (!(amount > 0)) return { status: 'error', message: '入金額を選択してください' };
    if (!name) return { status: 'error', message: '顧客名を入力してください' };

    // キャンペーン名（日本語）をマスターから解決
    var campNameJp = campaignId;
    var listRes = manualCampaignList();
    if (listRes.status === 'ok') {
      for (var i = 0; i < listRes.campaigns.length; i++) {
        if (listRes.campaigns[i].campaignId === campaignId) {
          campNameJp = listRes.campaigns[i].nameJp || campaignId;
          break;
        }
      }
    }

    var ss = getSpreadsheet();
    var tz = ss.getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
    var now = new Date();
    // 予約日は Date 型で（文字列だと売上集計の日付フィルタに乗らない）
    var todayDate = Utilities.parseDate(Utilities.formatDate(now, tz, 'yyyy-MM-dd'), tz, 'yyyy-MM-dd');
    var startTime = Utilities.formatDate(now, tz, 'HH:mm');

    var bookingId = generateDateSeqId('BK', SHEET_NAMES.BOOKINGS, '予約ID');

    appendRow(SHEET_NAMES.BOOKINGS, {
      '予約ID':         bookingId,
      '顧客ID':         '',
      'チャットID':     '',
      '車種タイプ':     '',
      '車種名':         carModel,
      'プラン':         '',
      'オプション':     '',
      '予約日':         todayDate,            // Date型（売上計上に乗る）
      '予約時刻':       startTime,
      '所要時間(分)':   0,
      '料金(USD)':      amount,
      '進行状態':       '作業完了',
      '緯度':           '',
      '経度':           '',
      '住所':           '',
      '場所補足':       '',
      'マップリンク':   '',
      'カレンダーID':   '',
      '予約登録日時':   now,
      '決済状態':       '清算済み',
      '請求額(USD)':    amount,
      'スクショURL':    '',
      '入金確認日時':   now,
      'QR送信日時':     '',
      '催促回数':       0,
      '最終催促日時':   '',
      '管理者メモ':     '客名:' + name + '｜キャンペーン売上' +
                       (plate ? '｜No.' + plate : '') + (carModel ? '｜車:' + carModel : ''),
      '割引前金額(USD)': amount,
      '割引額(USD)':    0,
      'キャンペーン名': campNameJp,
      'サービスタイプ': '店舗'
    });

    // 管理者通知（best-effort）
    try {
      var cfg = getConfig();
      var text = '💰 キャンペーン売上 記録\n' +
        '━━━━━━━━━━━━━━━━━\n' +
        '🆔 ' + bookingId + '\n' +
        '🎟 ' + campNameJp + '\n' +
        '💵 $' + amount + '（清算済み）\n' +
        '👤 ' + name + (carModel ? ' / ' + carModel : '') + (plate ? ' / ' + plate : '');
      sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, text, {});
    } catch (e) {
      Logger.log('⚠️ recordCampaignSale 通知失敗（記録は成功）: ' + e);
    }

    return { status: 'ok', bookingId: bookingId, amount: amount, campaignNameJp: campNameJp };
  } catch (err) {
    Logger.log('❌ recordCampaignSale error: ' + err + ' stack=' + (err.stack || ''));
    return { status: 'error', message: 'システムエラー: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 有効＆期間内の手動特価キャンペーン一覧を返す
 * ミニアプリのドロップダウン用
 *
 * @return {{status: 'ok'|'error', campaigns?: Array, message?: string}}
 */
function manualCampaignList() {
  try {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName(MANUAL_CAMPAIGN_SHEET);
    if (!sheet) {
      return { status: 'ok', campaigns: [] };
    }
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return { status: 'ok', campaigns: [] };

    var headers = getHeaderMap(MANUAL_CAMPAIGN_SHEET);
    var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
    var tz = ss.getSpreadsheetTimeZone();
    var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

    var list = [];
    for (var i = 0; i < data.length; i++) {
      var row = data[i];
      var active = row[(headers['有効'] || 1) - 1];
      var isActive = (active === true || String(active).toUpperCase() === 'TRUE');
      if (!isActive) continue;

      var startVal = row[(headers['期間開始'] || 1) - 1];
      var endVal = row[(headers['期間終了'] || 1) - 1];
      var startStr = (startVal instanceof Date)
        ? Utilities.formatDate(startVal, tz, 'yyyy-MM-dd')
        : (startVal ? String(startVal).substring(0, 10) : '');
      var endStr = (endVal instanceof Date)
        ? Utilities.formatDate(endVal, tz, 'yyyy-MM-dd')
        : (endVal ? String(endVal).substring(0, 10) : '');
      if (startStr && todayStr < startStr) continue;
      if (endStr && todayStr > endStr) continue;

      list.push({
        no:                String(headers['番号'] ? (row[headers['番号'] - 1] || '') : ''),
        campaignId:        String(row[(headers['キャンペーンID'] || 1) - 1] || ''),
        nameKm:            String(row[(headers['名前(クメール)'] || 1) - 1] || ''),
        nameJp:            String(row[(headers['名前(日本語)'] || 1) - 1] || ''),
        priceUsd:          Number(row[(headers['特価(USD)'] || 1) - 1] || 0),
        targetServiceType: String(row[(headers['対象サービスタイプ'] || 1) - 1] || '両方'),
        memo:              String(row[(headers['メモ'] || 1) - 1] || '')
      });
    }
    return { status: 'ok', campaigns: list };
  } catch (err) {
    Logger.log('❌ manualCampaignList error: ' + err);
    return { status: 'error', message: String(err) };
  }
}

// ====== Helper: isManualCampaignBooking ======

/**
 * 予約のキャンペーン名（BOOKINGS.キャンペーン名）が手動特価マスター由来か判定する
 * PaymentManager.sendPaymentQR から呼ばれ、自動 QR をスキップする決め手になる
 *
 * @param {string} campaignName - BOOKINGS の キャンペーン名 セル値
 * @return {boolean}
 */
function isManualCampaignBooking(campaignName) {
  if (!campaignName) return false;
  try {
    var cache = CacheService.getScriptCache();
    var cached = cache.get('manual_campaign_names');
    var names = null;
    if (cached) {
      try { names = JSON.parse(cached); } catch (e) { /* 破損キャッシュは無視 */ }
    }
    if (!names) {
      var ss = getSpreadsheet();
      var sheet = ss.getSheetByName(MANUAL_CAMPAIGN_SHEET);
      if (!sheet) {
        names = [];
      } else {
        var lastRow = sheet.getLastRow();
        if (lastRow < 2) {
          names = [];
        } else {
          var headers = getHeaderMap(MANUAL_CAMPAIGN_SHEET);
          var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
          names = [];
          for (var i = 0; i < data.length; i++) {
            var nm = String(data[i][(headers['名前(日本語)'] || 1) - 1] || '');
            if (nm) names.push(nm);
          }
        }
      }
      cache.put('manual_campaign_names', JSON.stringify(names), MANUAL_CAMPAIGN_NAMES_TTL);
    }
    return names.indexOf(String(campaignName)) >= 0;
  } catch (err) {
    Logger.log('⚠️ isManualCampaignBooking error: ' + err);
    return false; // 判定失敗時は通常 QR 動作（運用上、誤検知のほうが安全）
  }
}

// ====== API: createManualBooking ======

/**
 * 手動特価予約を作成する
 *
 * @param {Object} params
 *   - campaignId   {string}        マスターの キャンペーンID（必須）
 *   - serviceType  {'店舗'|'出張'} （必須）
 *   - name         {string}        顧客名（必須）
 *   - vehicleType  {string}        'セダン以下' or 'SUV以上'（任意）
 *   - chatId       {string}        顧客のチャットID（任意、出張時に通知ルーティングに使う）
 *   - customerId   {string}        顧客ID（任意）
 *   - date         {string}        'YYYY-MM-DD'（出張のみ必須）
 *   - startTime    {string}        'HH:mm'（出張のみ必須）
 *   - duration     {number}        分（任意、デフォ 60）
 *   - location     {string}        場所文字列 or Google Maps URL（出張のみ必須）
 *   - staff        {string}        スタッフ名（任意、管理者通知に表示）
 * @return {Object} {status, bookingId, priceUsd, serviceType, ...}
 */
function createManualBooking(params) {
  var lock = LockService.getScriptLock();
  var acquired = lock.tryLock(15 * 1000);
  if (!acquired) {
    return { status: 'error', message: 'システム混雑中。もう一度お試しください。' };
  }

  try {
    var campaignId  = String(params.campaignId || '');
    var serviceType = String(params.serviceType || '');
    var name        = String(params.name || '');

    if (!campaignId) return { status: 'error', message: 'キャンペーンID必須' };
    if (serviceType !== '店舗' && serviceType !== '出張') {
      return { status: 'error', message: 'サービスタイプ不正（店舗 or 出張）' };
    }
    if (!name) return { status: 'error', message: '顧客名必須' };

    // ── マスター取得 ──
    var listRes = manualCampaignList();
    if (listRes.status !== 'ok') return { status: 'error', message: 'マスター取得失敗' };
    var camp = null;
    for (var i = 0; i < listRes.campaigns.length; i++) {
      if (listRes.campaigns[i].campaignId === campaignId) { camp = listRes.campaigns[i]; break; }
    }
    if (!camp) return { status: 'error', message: 'キャンペーン無効 or 期間外: ' + campaignId };

    if (camp.targetServiceType !== '両方' && camp.targetServiceType !== serviceType) {
      return { status: 'error', message: 'このキャンペーンは ' + camp.targetServiceType + ' 限定です' };
    }

    var vehicleType =
      (params.vehicleType === 'SUV以上' || params.vehicleType === 'セダン以下')
        ? params.vehicleType
        : '';

    var bookingId = generateDateSeqId('BK', SHEET_NAMES.BOOKINGS, '予約ID');
    var sysCfg = getConfig();
    var ss = getSpreadsheet();
    var tz = ss.getSpreadsheetTimeZone();
    var now = new Date();

    // ── 分岐: 店舗（即完結） / 出張（カレンダー登録あり） ──
    var calendarEventId = '';
    var dateStr = '';
    var startTime = '';
    var duration = 0;
    var location = '';
    var mapsUrl = '';
    var lat = '';
    var lng = '';
    var progressStatus, paymentStatus;

    if (serviceType === '店舗') {
      // 2026-06-01: 店舗も出張と同じ作業フロー（Before/After写真→3方向配信）に乗せる。
      // そのため「作業完了/清算済み」ではなく「予約確定/未清算」で作る。
      // → ダッシュボードに作業前で出る → 作業開始/終了で写真記録 → 💵清算で清算済み。
      // 店舗はカレンダー登録は不要（当日その場対応）。予約日時は「今」。
      progressStatus = '予約確定';
      paymentStatus  = '未清算';
      dateStr  = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
      startTime = Utilities.formatDate(now, tz, 'HH:mm');
      duration = Number(params.duration) > 0 ? Number(params.duration) : 60;
    } else {
      progressStatus = '予約確定';
      paymentStatus  = '未清算';

      var dateInput  = String(params.date || '');
      var startInput = String(params.startTime || '');
      var locInput   = String(params.location || '');
      if (!dateInput || !startInput || !locInput) {
        return { status: 'error', message: '出張は日付・時刻・場所が必須' };
      }
      duration = Number(params.duration) > 0 ? Number(params.duration) : 60;

      var hm = startInput.split(':');
      var startDt = parseDateTimePhnomPenh(dateInput, parseInt(hm[0], 10), parseInt(hm[1], 10));
      var endDt = new Date(startDt.getTime() + duration * 60 * 1000);

      var loc = parseLocationString(locInput);
      lat = loc.lat || '';
      lng = loc.lng || '';
      mapsUrl = loc.mapsUrl || '';
      location = locInput;

      var calendar = CalendarApp.getCalendarById(sysCfg.bookingCalendarId);
      var eventTitle = '【特価】' + (camp.nameJp || camp.campaignId) +
                       ' / ' + name +
                       (vehicleType ? ' / ' + vehicleType : '');
      var desc = '予約ID: ' + bookingId + '\n' +
                 'キャンペーン: ' + (camp.nameJp || camp.campaignId) + '\n' +
                 '料金: $' + camp.priceUsd + '（手動特価・固定）\n' +
                 (vehicleType ? '車種: ' + vehicleType + '\n' : '') +
                 '顧客: ' + name + (params.chatId ? ' (chat_id=' + params.chatId + ')' : '') + '\n' +
                 '場所: ' + location;
      var event = calendar.createEvent(eventTitle, startDt, endDt, {
        description: desc,
        location: mapsUrl || location
      });
      calendarEventId = event.getId();
      dateStr   = dateInput;
      startTime = startInput;
    }

    // ── BOOKINGS へ 1 行追加 ──
    appendRow(SHEET_NAMES.BOOKINGS, {
      '予約ID':         bookingId,
      '顧客ID':         params.customerId || '',
      'チャットID':     params.chatId ? String(params.chatId) : '',
      '車種タイプ':     vehicleType,
      '車種名':         '',
      'プラン':         '',
      'オプション':     '',
      '予約日':         ymdToSheetDate_(dateStr),  // 文字列でなく日付値で記録（ダッシュボード $0 集計バグ対策）
      '予約時刻':       startTime,
      '所要時間(分)':   duration,
      '料金(USD)':      camp.priceUsd,
      '進行状態':       progressStatus,
      '緯度':           lat,
      '経度':           lng,
      '住所':           '',
      '場所補足':       '',
      'マップリンク':   mapsUrl,
      'カレンダーID':   calendarEventId,
      '予約登録日時':   new Date(),
      '決済状態':       paymentStatus,
      '請求額(USD)':    camp.priceUsd,
      'スクショURL':    '',
      '入金確認日時':   '',   // 作成時は未清算（店舗/出張とも作業後に💵清算で記録）
      'QR送信日時':     '',
      '催促回数':       0,
      '最終催促日時':   '',
      // 客名: を先頭に入れる（特価予約は chatId 無しで CUSTOMERS から名前を引けないため、
      //        apiBookingToday がここから顧客名を復元してダッシュボードに表示する）
      '管理者メモ':     '客名:' + name + '｜手動特価（' + (camp.nameJp || camp.campaignId) + '）' +
                       (params.staff ? ' by ' + params.staff : ''),
      '割引前金額(USD)': camp.priceUsd,  // 固定額のため割引前=特価
      '割引額(USD)':    0,
      'キャンペーン名': camp.nameJp || '',
      'サービスタイプ': serviceType
    });

    // ── 管理者通知（顧客トピックがあればそこへ、なければグループ直下へ） ──
    try {
      var threadId = null;
      if (params.chatId) {
        var custRow = findCustomerRow(String(params.chatId));
        if (custRow && custRow.data['トピックID']) {
          threadId = custRow.data['トピックID'];
        }
      }
      var adminText = '🎫 特価予約 作成\n' +
        '━━━━━━━━━━━━━━━━━\n' +
        '🆔 ' + bookingId + '\n' +
        '🎟 ' + (camp.nameJp || camp.campaignId) + ' / $' + camp.priceUsd + '\n' +
        '🏢 ' + serviceType + '\n' +
        '👤 ' + name + (vehicleType ? ' / ' + vehicleType : '') + '\n' +
        ((serviceType === '出張')
          ? '📅 ' + dateStr + ' ' + startTime + '（' + duration + '分）\n📍 ' + location + '\n'
          : '🏪 来店・作業待ち（ミニアプリで作業開始してください）\n') +
        '⏳ 未清算（作業後に💵清算）\n' +
        (params.staff ? '👷 ' + params.staff + '\n' : '');
      var adminOpts = threadId ? { message_thread_id: threadId } : {};
      sendMessage(BOT_TYPE.BOOKING, sysCfg.adminGroupId, adminText, adminOpts);
    } catch (e) {
      Logger.log('⚠️ createManualBooking 管理者通知失敗（業務は継続）: ' + e);
    }

    return {
      status: 'ok',
      bookingId:      bookingId,
      priceUsd:       camp.priceUsd,
      serviceType:    serviceType,
      progressStatus: progressStatus,
      paymentStatus:  paymentStatus,
      campaignNameJp: camp.nameJp
    };
  } catch (err) {
    Logger.log('❌ createManualBooking error: ' + err + ' stack=' + (err.stack || ''));
    return { status: 'error', message: 'システムエラー: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

// ====== API: settleManualBooking ======

/**
 * 手動特価予約を清算済みにする（出張の作業後にロン君が押す）
 *
 * @param {string} bookingId
 * @return {Object}
 */
function settleManualBooking(bookingId) {
  try {
    if (!bookingId) return { status: 'error', message: 'bookingId required' };

    var bkRow = findRow(SHEET_NAMES.BOOKINGS, '予約ID', bookingId);
    if (!bkRow) return { status: 'error', message: '予約が見つかりません: ' + bookingId };

    if (!isManualCampaignBooking(bkRow.data['キャンペーン名'])) {
      return { status: 'error', message: 'この予約は手動特価ではありません' };
    }
    if (String(bkRow.data['決済状態']) === '清算済み') {
      return { status: 'ok', bookingId: bookingId, message: '既に清算済み', alreadySettled: true };
    }

    updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, {
      '決済状態':     '清算済み',
      '入金確認日時': new Date()
    });

    // 管理者通知
    try {
      var cfg = getConfig();
      var threadId = null;
      var chatId = String(bkRow.data['チャットID'] || '');
      if (chatId) {
        var custRow = findCustomerRow(chatId);
        if (custRow && custRow.data['トピックID']) {
          threadId = custRow.data['トピックID'];
        }
      }
      var text = '💵 特価予約 清算済み\n' +
        '━━━━━━━━━━━━━━━━━\n' +
        '🆔 ' + bookingId + '\n' +
        '🎟 ' + (bkRow.data['キャンペーン名'] || '-') +
        ' / $' + (bkRow.data['料金(USD)'] || '-');
      var adminOpts = threadId ? { message_thread_id: threadId } : {};
      sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, text, adminOpts);
    } catch (e) {
      Logger.log('⚠️ settleManualBooking 通知失敗: ' + e);
    }

    return { status: 'ok', bookingId: bookingId };
  } catch (err) {
    Logger.log('❌ settleManualBooking error: ' + err);
    return { status: 'error', message: String(err) };
  }
}
