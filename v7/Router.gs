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

    // なりすまし対策 Phase 1: 署名検証の結果を記録するだけ（ブロックしない。TelegramAuth.gs）
    if (e && e.parameter) {
      auditTelegramAuth_(action, e.parameter.chatId || '', extractInitData_(e.parameter));
      delete e.parameter._tg; // 下流（ファネルログ等）に署名データを残さない
    }

    switch (action) {
      case 'auth_audit':
        result = apiAuthAudit_(e.parameter);
        break;

      case 'ping':
        // build: deploy.cmd が生成する BUILD_VERSION（本番反映の機械確認用）
        result = {
          ok: true,
          message: 'v7 router alive',
          build: (typeof BUILD_VERSION !== 'undefined' ? BUILD_VERSION : 'dev'),
          date: new Date().toISOString()
        };
        break;

      case 'booking_init':
        result = apiBookingInit(e.parameter);
        break;

      case 'booking_slots':
        result = apiBookingSlots(e.parameter);
        break;

      // 2026-10-08: 12日分の空き枠を1回で返す（表示専用・BookingSlotsRange.gs）
      case 'booking_slots_range':
        result = apiBookingSlotsRange(e.parameter);
        break;

      // Menu v4 (2026-09-22): 業務ミニアプリ(job-manager)向けメニュー価格。ファネルログには記録しない
      case 'menu_prices':
        result = apiMenuPrices();
        break;

      // ── Phase 4: 業務ミニアプリ ──
      case 'booking_today':
        result = apiBookingToday();
        break;

      // 2026-10-22: 現場アプリの「どの提携店？」の選択肢（ShopRouting.gs）
      case 'field_partner_shops':
        result = apiFieldPartnerShops();
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

    // なりすまし対策 Phase 1: 署名検証の結果を記録するだけ（ブロックしない。TelegramAuth.gs）
    auditTelegramAuth_(action, body.chatId || '', extractInitData_(body));
    // 2026-10-08: 現場アプリ v2（client_id 付き）は送り主を署名から確定して記録する
    if (body.client_id) {
      try {
        var vAuth = verifyTelegramInitData_(extractInitData_(body));
        body._authUserId = (vAuth && vAuth.ok) ? String(vAuth.userId || '') : '';
      } catch (eAuth) { body._authUserId = ''; }
    }
    delete body._tgInitData;

    switch (action) {
      case 'booking_register_customer':
        result = apiBookingRegisterCustomer(body);
        break;

      case 'booking_create':
        result = apiBookingCreate(body);
        break;

      // ── Phase 4: 業務ミニアプリ ──
      // 2026-10-08: client_id 付き（現場アプリ v2）は二重処理対策つきの入口へ（JobIdempotency.gs）
      case 'job_start':
        result = body.client_id ? apiJobStartV2(body) : apiJobStart(body);
        break;

      case 'job_end':
        result = body.client_id ? apiJobEndV2(body) : apiJobEnd(body);
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

      case 'manual_campaign_sale':
        result = recordCampaignSale(body);
        break;

      default:
        result = { status: 'error', message: 'UNKNOWN_ACTION', action: action };
    }

    return jsonResponse(result);
  } catch (err) {
    Logger.log('❌ doPost error: ' + err + ' stack=' + (err.stack || ''));
    // 2026-10-08: 送信待ち箱が判定できるよう client_id をエコー（再送で回復しうるエラー）
    var errRes = { status: 'error', message: String(err), retryable: true };
    try {
      var b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
      if (b.client_id) { errRes.client_id = String(b.client_id); errRes.request_id = String(b.request_id || b.client_id); }
    } catch (ignore) {}
    return jsonResponse(errRes);
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
  // 2026-10-26: 予約画面が流入元を確かめ直す取り直し（recheck=1）は起動ではないので数えない
  if (typeof logFunnelEvent === 'function' && !params.recheck) {
    logFunnelEvent(chatId, 'miniapp_opened', 'booking.html', '', { params: params });
  }

  let customer = null;
  // 2026-10-08: 起動専用の軽い検索（シート1回読み。BookingFast.gs）
  const row = findCustomerForInit_(chatId);
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
  let dispatchFee = getDispatchFee();
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

  // 2026-10-26: 提携店QR経由のお客様は定価・全体キャンペーン対象外（2026-08-10 裁可⑩）。
  //   これまでは歓迎文でバナーを隠すだけで、予約画面と予約作成には全体キャンペーンが効いていた（createBooking と同じ判定）
  //   個人提携（IndividualPartner.gs）のお客様も紹介料が付くので同じく対象外（getReferralPartnerRef_ は個人提携を含む）
  let shop = false;
  try {
    if (typeof getReferralPartnerRef_ === 'function' && getReferralPartnerRef_(chatId)) {
      shop = true;
      campaign = null;
    }
  } catch (e) {
    Logger.log('⚠️ apiBookingInit: 提携店の判定エラー(無視可): ' + e);
  }

  // 2026-10-15: 専用QR（流入元）の情報。顧客の紐付けを優先し、なければ画面の ?src= を使う（SourceCampaign.gs）
  let source = null;
  try {
    if (typeof resolveBookingSource_ === 'function') {
      const srcCfg = resolveBookingSource_(chatId, params.src);
      source = sourceInitPayload_(srcCfg);
      // 2026-10-26: 「出張料なし」の流入元（Picasso 住民）は予約画面の出張料も 0（createBooking と同じ判定）
      if (typeof sourceDispatchFeeTable_ === 'function') dispatchFee = sourceDispatchFeeTable_(srcCfg);
    }
  } catch (e) {
    Logger.log('⚠️ apiBookingInit: source 取得エラー(無視可): ' + e);
  }

  return {
    status: 'ok',
    customer: customer,
    plans: plans,
    options: options,
    dispatchFee: dispatchFee,
    campaign: campaign,
    source: source,
    shop: shop        // 提携店QR経由（予約画面が取り直しを止める目印。店名などは渡さない）
  };
}

/**
 * GET menu_prices
 * Response: { status:'ok', plans, options, dispatchFee }
 * job-manager.html の価格ラベル・参考合計用(メニューシート連動。実行内でメニューを1回だけ読む)
 */
function apiMenuPrices() {
  return {
    status: 'ok',
    plans: getActivePlans(),
    options: (typeof getActiveOptions === 'function') ? getActiveOptions() : [],
    dispatchFee: getDispatchFee()
  };
}

/**
 * GET booking_slots
 * Query: date, plan(=letter), vehicleType
 */
function apiBookingSlots(params) {
  // Menu v2.1: plan が optional 化、glassOption も受ける
  // Menu v4 (2026-09-22): options(カンマ区切り: GLASS_3,HEADLIGHT 等)を正とし、glassOption は互換
  const date = params.date;
  const planLetter = String(params.plan || '');
  const vehicleType = params.vehicleType;
  const glassOption = String(params.glassOption || '');
  const optionsCsv = [String(params.options || ''), glassOption]
    .join(',').split(',').map(function(s) { return s.trim(); })
    .filter(function(s, i, arr) { return s && arr.indexOf(s) === i; })
    .join(',');

  if (!date || !vehicleType) {
    return { status: 'error', message: 'date/vehicleType required' };
  }
  if (!planLetter && !optionsCsv) {
    return { status: 'error', message: 'plan or options required' };
  }

  // 2026-10-15: 専用QRの流入元で「期間中の日曜営業」なら定休日も枠を出す
  const srcCfg = (typeof resolveBookingSource_ === 'function') ? resolveBookingSource_(params.chatId, params.src) : null;
  const res = findAvailableSlots(date, planLetter, vehicleType, optionsCsv,
    { openClosedDay: !!(srcCfg && sourceOpensClosedDay_(srcCfg, date)) });
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
    // 専用QR（英語メインの流入元）から来た新規は英語（2026-10-15）
    '言語':         (typeof getSourceConfig_ === 'function' && getSourceConfig_(body.src) &&
                     getSourceConfig_(body.src).lang === 'en-ja') ? '英語' : 'クメール語',
    'トピックID':   '',
    '登録日時':     new Date(),
    '最終連絡日時': new Date(),
    '配信対象':     true   // 新規は配信対象ON（翌日以降のキャンペーンに自動で入る）。
                          // ただし「当日登録」はスケジュール配信から除外され即時配信は飛ばない。
  });
  // 追加した行の配信対象セルをチェックボックス化（TRUE 文字表示を防ぐ）
  if (typeof applyBroadcastCheckboxToRow_ === 'function') {
    applyBroadcastCheckboxToRow_(getSheet(SHEET_NAMES.CUSTOMERS).getLastRow());
  }

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
