/**
 * Router.gs — ミニアプリ API のルーティング（GET + POST）
 *
 * 【責務】
 *   - doGet:  ミニアプリ（booking.html / job-manager.html）からの GET API
 *   - doPost: ミニアプリからの POST API（booking_create 等）
 *
 * 【重要】
 *   Telegram の update は Webhook ではなく Polling (BotPoller.gs) で取得しているため、
 *   doPost は ミニアプリ専用 と割り切って実装する。
 *   （Telegram Webhook が誤って設定されても、action無しなら UNKNOWN_ACTION を返すだけ）
 *
 * 【action 一覧】
 *   GET:
 *     - ping                        : ヘルスチェック
 *     - booking_init                : 予約画面初期データ（顧客情報+プラン+出張料）
 *     - booking_slots               : 指定日・プラン・車種の空き枠
 *     - booking_today               : 本日＋明日の予約一覧（業務ミニアプリ用）
 *     - manual_campaign_list        : 有効＆期間内の手動特価キャンペーン一覧
 *   POST:
 *     - booking_register_customer   : 新規顧客登録
 *     - booking_create              : 予約確定
 *     - job_start                   : 作業開始通知
 *     - job_end                     : 作業終了通知
 *     - job                         : 最終データ送信（写真付き）
 *     - chat_history                : 顧客チャット履歴取得
 *     - chat_send                   : ミニアプリからメッセージ送信
 *     - manual_campaign_create      : 手動特価予約の作成（店舗/出張）
 *     - manual_campaign_settle      : 手動特価予約の清算（決済状態→清算済み）
 */

/**
 * ミニアプリ GET エンドポイント
 */
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || '';
    let result;

    switch (action) {
      case 'ping':
        result = { ok: true, message: 'v7 router alive', date: new Date().toISOString() };
        break;

      case 'booking_init':
        result = apiBookingInit(e.parameter);
        break;

      case 'booking_slots':
        result = apiBookingSlots(e.parameter);
        break;

      // ── Phase 4: 業務ミニアプリ ──
      case 'booking_today':
        result = apiBookingToday();
        break;

      // ── 手動登録の顧客リンク用（通知先の顧客を選ばせる） ──
      case 'customer_list':
        result = apiCustomerList(e.parameter);
        break;

      // ── 手動特価キャンペーン（CampaignBooking.gs） ──
      case 'manual_campaign_list':
        result = manualCampaignList();
        break;

      default:
        result = { status: 'error', message: 'UNKNOWN_ACTION', action: action };
    }

    return jsonResponse(result);
  } catch (err) {
    Logger.log('❌ doGet error: ' + err + ' stack=' + (err.stack || ''));
    return jsonResponse({ status: 'error', message: String(err) });
  }
}

/**
 * ミニアプリ POST エンドポイント
 * booking.html は Content-Type: text/plain で JSON 文字列を送ってくる
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ status: 'error', message: 'NO_BODY' });
    }

    const body = JSON.parse(e.postData.contents);
    const action = body.action || '';
    let result;

    switch (action) {
      case 'booking_register_customer':
        result = apiBookingRegisterCustomer(body);
        break;

      case 'booking_create':
        result = apiBookingCreate(body);
        break;

      // ── Phase 4: 業務ミニアプリ ──
      case 'job_start':
        result = apiJobStart(body);
        break;

      case 'job_end':
        result = apiJobEnd(body);
        break;

      case 'job':
        result = apiJobFinal(body);
        break;

      case 'chat_history':
        result = apiChatHistory(body);
        break;

      case 'chat_send':
        result = apiChatSend(body);
        break;

      // ── 手動特価キャンペーン（CampaignBooking.gs） ──
      case 'manual_campaign_create':
        result = createManualBooking(body);
        break;

      case 'manual_campaign_settle':
        result = settleManualBooking(body.bookingId || '');
        break;

      default:
        result = { status: 'error', message: 'UNKNOWN_ACTION', action: action };
    }

    return jsonResponse(result);
  } catch (err) {
    Logger.log('❌ doPost error: ' + err + ' stack=' + (err.stack || ''));
    return jsonResponse({ status: 'error', message: String(err) });
  }
}

// ====== API 実装 ======

/**
 * GET booking_init
 * Query: chatId, name, username
 * Response: { status:'ok', customer, plans, options, dispatchFee }
 *
 * Menu v2 (2026-05-06): options を追加(GLASS add-on をミニアプリに渡す)
 */
function apiBookingInit(params) {
  const chatId = String(params.chatId || '');
  if (!chatId) return { status: 'error', message: 'chatId required' };

  // ファネル計測: ミニアプリ起動を記録(失敗しても無視)
  if (typeof logFunnelEvent === 'function') {
    logFunnelEvent(chatId, 'miniapp_opened', 'booking.html', '', { params: params });
  }

  let customer = null;
  const row = findCustomerRow(chatId);
  if (row) {
    customer = {
      customerId: row.data['顧客ID'],
      chatId: String(row.data['チャットID']),
      name: row.data['氏名'] || row.data['ユーザー名'] || '',
      phone: row.data['電話番号'] || '',
      username: row.data['ユーザー名'] || ''
    };
  }

  const plans = getActivePlans();
  const options = (typeof getActiveOptions === 'function') ? getActiveOptions() : [];
  const dispatchFee = getDispatchFee();
  // Menu v2 (2026-05-06): キャンペーン情報をミニアプリに返す
  let campaign = null;
  try {
    const cfg = getBookingConfig();
    if (cfg.campaign && cfg.campaign.active && cfg.campaign.percent > 0) {
      campaign = {
        active: true,
        percent: cfg.campaign.percent,
        nameEn: cfg.campaign.nameEn || '',
        nameKm: cfg.campaign.nameKm || ''
      };
    }
  } catch (e) {
    // キャンペーン取得失敗でも予約フローを止めない
    Logger.log('⚠️ apiBookingInit: campaign 取得エラー(無視可): ' + e);
  }

  return {
    status: 'ok',
    customer: customer,
    plans: plans,
    options: options,
    dispatchFee: dispatchFee,
    campaign: campaign
  };
}

/**
 * GET booking_slots
 * Query: date, plan(=letter), vehicleType
 */
function apiBookingSlots(params) {
  // Menu v2.1: plan が optional 化、glassOption も受ける
  const date = params.date;
  const planLetter = String(params.plan || '');
  const vehicleType = params.vehicleType;
  const glassOption = String(params.glassOption || '');

  if (!date || !vehicleType) {
    return { status: 'error', message: 'date/vehicleType required' };
  }
  if (!planLetter && !glassOption) {
    return { status: 'error', message: 'plan or glassOption required' };
  }

  const res = findAvailableSlots(date, planLetter, vehicleType, glassOption);
  if (!res.ok) {
    return { status: 'error', message: res.error };
  }
  return {
    status: 'ok',
    slots: res.slots,
    durationMin: res.durationMin,
    debug: res.debug || ''
  };
}

/**
 * POST booking_register_customer
 * Body: { chatId, name, username }
 */
function apiBookingRegisterCustomer(body) {
  const chatId = String(body.chatId || '');
  if (!chatId) return { status: 'error', message: 'chatId required' };

  // 既存チェック
  const existing = findCustomerRow(chatId);
  if (existing) {
    return {
      status: 'ok',
      customer: {
        customerId: existing.data['顧客ID'],
        chatId: String(existing.data['チャットID']),
        name: existing.data['氏名'] || '',
        username: existing.data['ユーザー名'] || ''
      }
    };
  }

  // 新規登録（ミニアプリ経由なのでトピックはまだ作らない＝/start または最初のDMで作られる）
  const customerId = generateDateSeqId('CUST', SHEET_NAMES.CUSTOMERS, '顧客ID');
  appendRow(SHEET_NAMES.CUSTOMERS, {
    '顧客ID':       customerId,
    'チャットID':   chatId,
    'ユーザー名':   body.username || '',
    '氏名':         body.name || '',
    '電話番号':     '',
    '言語':         'クメール語',
    'トピックID':   '',
    '登録日時':     new Date(),
    '最終連絡日時': new Date(),
    '配信対象':     true   // 新規は配信対象ON（翌日以降のキャンペーンに自動で入る）。
                          // ただし「当日登録」はスケジュール配信から除外され即時配信は飛ばない。
  });

  return {
    status: 'ok',
    customer: {
      customerId: customerId,
      chatId: chatId,
      name: body.name || '',
      username: body.username || ''
    }
  };
}

/**
 * POST booking_create
 * BookingLogic.createBooking にそのまま委譲
 */
function apiBookingCreate(body) {
  return createBooking(body);
}

// ====== ヘルパー ======

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
