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
 *   POST:
 *     - booking_register_customer   : 新規顧客登録
 *     - booking_create              : 予約確定
 *     - job_start                   : 作業開始通知
 *     - job_end                     : 作業終了通知
 *     - job                         : 最終データ送信（写真付き）
 *     - chat_history                : 顧客チャット履歴取得
 *     - chat_send                   : ミニアプリからメッセージ送信
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
 * Response: { status:'ok', customer, plans, dispatchFee }
 */
function apiBookingInit(params) {
  const chatId = String(params.chatId || '');
  if (!chatId) return { status: 'error', message: 'chatId required' };

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
  const dispatchFee = getDispatchFee();

  return {
    status: 'ok',
    customer: customer,
    plans: plans,
    dispatchFee: dispatchFee
  };
}

/**
 * GET booking_slots
 * Query: date, plan(=letter), vehicleType
 */
function apiBookingSlots(params) {
  const date = params.date;
  const planLetter = params.plan;
  const vehicleType = params.vehicleType;

  if (!date || !planLetter || !vehicleType) {
    return { status: 'error', message: 'date/plan/vehicleType required' };
  }

  const res = findAvailableSlots(date, planLetter, vehicleType);
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
    '最終連絡日時': new Date()
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
