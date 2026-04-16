/**
 * BookingLogic.gs — 予約ロジック（プラン取得・空き枠検索・予約確定）
 *
 * 【責務】
 *   - 料金設定シートからプラン一覧・出張料を取得
 *   - Google カレンダーを参照して空き枠を計算
 *   - 予約確定時に シート + カレンダー + Telegram 3方向通知
 *
 * 【設計方針】
 *   - 料金・営業時間・バッファは getBookingConfig() から取得（60秒キャッシュ）
 *   - 排他制御: createBooking 時に LockService で同時予約防止
 *   - タイムゾーン: Asia/Phnom_Penh（UTC+7）
 *
 * 【プラン名フォーマット】
 *   料金設定シート「プラン名」列: "清 KIYOME (A)" 形式
 *   parsePlanRow() で { letter:'A', jp:'清', name:'KIYOME', planFull:'清 KIYOME (A)' } に分解
 */

// ====== 定数 ======
const BOOKING_TZ = 'Asia/Phnom_Penh';
const SLOT_STEP_MIN = 30;   // 空き枠チェックの刻み幅（分）

// ====== プラン取得 ======

/**
 * 料金設定シートからプラン一覧を取得
 * 【設定】行と「出張料」行は除外
 *
 * @return {Array<Object>} [{ letter, jp, name, desc, planFull, priceSedan, priceSuv, durationSedan, durationSuv }]
 */
function getActivePlans() {
  const sheet = getSheet(SHEET_NAMES.PLAN_PRICES);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  const plans = [];

  data.forEach(function(row) {
    const planName = String(row[0] || '').trim();
    if (!planName) return;
    if (planName === '出張料') return;
    if (planName.indexOf('【設定】') === 0) return;

    const parsed = parsePlanRow(planName);
    if (!parsed) return;

    plans.push({
      letter: parsed.letter,
      jp: parsed.jp,
      name: parsed.name,
      desc: String(row[5] || ''),
      planFull: planName,
      priceSedan: Number(row[1]) || 0,
      priceSuv: Number(row[2]) || 0,
      durationSedan: Number(row[3]) || 0,
      durationSuv: Number(row[4]) || 0
    });
  });

  return plans;
}

/**
 * "清 KIYOME (A)" → { letter:'A', jp:'清', name:'KIYOME', planFull:'清 KIYOME (A)' }
 */
function parsePlanRow(planName) {
  // 末尾 (X) を抽出
  const m = planName.match(/^(\S+)\s+(\S+)\s*\(([A-Z])\)\s*$/);
  if (!m) return null;
  return {
    jp: m[1],
    name: m[2],
    letter: m[3],
    planFull: planName
  };
}

/**
 * letter（A/B/C/D）から plan オブジェクトを返す
 */
function findPlanByLetter(letter) {
  const plans = getActivePlans();
  for (let i = 0; i < plans.length; i++) {
    if (plans[i].letter === letter) return plans[i];
  }
  return null;
}

/**
 * 出張料を取得
 */
function getDispatchFee() {
  const cfg = getBookingConfig();
  return { sedan: cfg.travelFee, suv: cfg.travelFee };
}

// ====== 車種タイプ変換 ======

/**
 * ミニアプリ側の車種表記 → シート保存用の表記
 * 'セダン以下' → 'セダン', 'SUV以上' → 'SUV'
 */
function normalizeVehicleType(miniappVt) {
  if (miniappVt === 'SUV以上' || miniappVt === 'SUV') return 'SUV';
  return 'セダン';
}

/**
 * プラン+車種から所要時間(分)を取得
 */
function getDurationFor(plan, miniappVt) {
  return miniappVt === 'SUV以上' ? plan.durationSuv : plan.durationSedan;
}

/**
 * プラン+車種から料金(USD)を取得（出張料込み）
 */
function getPriceFor(plan, miniappVt) {
  const base = miniappVt === 'SUV以上' ? plan.priceSuv : plan.priceSedan;
  return base; // 初期データでは priceSedan/Suv に出張料込みの値が入っている想定
  // ⚠️ 仕様確認: 出張料を加算表示するか別枠にするかは HTML 表示に合わせる
  // 現booking.htmlは priceSedan/priceSuv をそのまま総額として表示 → そのままでOK
}

// ====== 空き枠検索 ======

/**
 * 指定日・プラン・車種で空き時間枠を返す
 *
 * @param {string} dateStr - 'YYYY-MM-DD'
 * @param {string} planLetter - 'A' | 'B' | 'C' | 'D'
 * @param {string} miniappVt - 'セダン以下' | 'SUV以上'
 * @return {{ok:boolean, slots?:Array<string>, durationMin?:number, error?:string}}
 */
function findAvailableSlots(dateStr, planLetter, miniappVt) {
  const plan = findPlanByLetter(planLetter);
  if (!plan) return { ok: false, error: 'INVALID_PLAN' };

  const duration = getDurationFor(plan, miniappVt);
  if (!duration) return { ok: false, error: 'INVALID_VEHICLE_TYPE' };

  const cfg = getBookingConfig();
  const buffer = cfg.bufferMinutes || 30;
  const bizStart = cfg.businessHourStart || 9;
  const bizEnd = cfg.businessHourEnd || 18;

  // ── 対象日の既存予約（カレンダー）を取得 ──
  const sysCfg = getConfig();
  const calendar = CalendarApp.getCalendarById(sysCfg.bookingCalendarId);
  if (!calendar) return { ok: false, error: 'CALENDAR_NOT_FOUND' };

  const dayStart = parseDateTimePhnomPenh(dateStr, bizStart, 0);
  const dayEnd = parseDateTimePhnomPenh(dateStr, bizEnd, 0);

  const events = calendar.getEvents(dayStart, dayEnd);
  const busyRanges = events.map(function(ev) {
    return {
      start: ev.getStartTime().getTime() - buffer * 60 * 1000,
      end:   ev.getEndTime().getTime() + buffer * 60 * 1000
    };
  });

  // ── 候補時刻を 30分刻みで生成 ──
  const now = new Date().getTime();
  const slots = [];
  for (let h = bizStart; h < bizEnd; h++) {
    for (let m = 0; m < 60; m += SLOT_STEP_MIN) {
      const slotStart = parseDateTimePhnomPenh(dateStr, h, m);
      const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);

      // 営業終了時刻を超えるならスキップ
      if (slotEnd > dayEnd) continue;
      // 過去時刻スキップ
      if (slotStart.getTime() < now) continue;

      // 既存予約と重複チェック（バッファ込み）
      let conflict = false;
      for (let i = 0; i < busyRanges.length; i++) {
        const b = busyRanges[i];
        if (slotStart.getTime() < b.end && slotEnd.getTime() > b.start) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;

      slots.push(formatHHmm(h, m));
    }
  }

  return { ok: true, slots: slots, durationMin: duration };
}

// ====== 予約作成 ======

/**
 * 予約を確定する
 *
 * @param {Object} params - {chatId, name, username, customerId, vehicleType, planLetter, date, startTime, location}
 * @return {Object} {status:'ok', bookingId, endTime, amount} or {status:'error', message, slots?}
 */
function createBooking(params) {
  const lock = LockService.getScriptLock();
  const acquired = lock.tryLock(15 * 1000);
  if (!acquired) {
    return { status: 'error', message: 'システム混雑中。もう一度お試しください。' };
  }

  try {
    // ── 1. バリデーション ──
    const plan = findPlanByLetter(params.planLetter);
    if (!plan) return { status: 'error', message: 'プラン不正: ' + params.planLetter };

    const vehicleType = params.vehicleType;
    if (vehicleType !== 'セダン以下' && vehicleType !== 'SUV以上') {
      return { status: 'error', message: '車種タイプ不正' };
    }

    const duration = getDurationFor(plan, vehicleType);
    const amount = getPriceFor(plan, vehicleType);

    // ── 2. 空き枠再確認（ロック後に取り直し） ──
    const avail = findAvailableSlots(params.date, params.planLetter, vehicleType);
    if (!avail.ok) return { status: 'error', message: '空き枠取得失敗: ' + avail.error };
    if (avail.slots.indexOf(params.startTime) < 0) {
      return {
        status: 'error',
        message: 'その時間は先約が入りました。別の時刻を選択してください。',
        slots: avail.slots
      };
    }

    // ── 3. 時刻計算 ──
    const hm = params.startTime.split(':');
    const startDt = parseDateTimePhnomPenh(params.date, parseInt(hm[0], 10), parseInt(hm[1], 10));
    const endDt = new Date(startDt.getTime() + duration * 60 * 1000);
    const endPP = toPhnomPenhHM(endDt);
    const endTimeStr = formatHHmm(endPP.h, endPP.m);

    // ── 4. 位置情報をパース ──
    const loc = parseLocationString(params.location);

    // ── 5. 予約ID採番 ──
    const bookingId = generateDateSeqId('BK', SHEET_NAMES.BOOKINGS, '予約ID');

    // ── 6. カレンダー登録 ──
    const sysCfg = getConfig();
    const calendar = CalendarApp.getCalendarById(sysCfg.bookingCalendarId);
    const eventTitle = '【' + plan.letter + '】' + (params.name || 'Guest') + ' / ' + normalizeVehicleType(vehicleType);
    const event = calendar.createEvent(eventTitle, startDt, endDt, {
      description:
        '予約ID: ' + bookingId + '\n' +
        'プラン: ' + plan.planFull + '\n' +
        '車種: ' + vehicleType + '\n' +
        '顧客: ' + params.name + ' (chat_id=' + params.chatId + ')\n' +
        '場所: ' + params.location + '\n' +
        '料金: $' + amount,
      location: loc.mapsUrl || params.location
    });
    const calendarEventId = event.getId();

    // ── 7. シートへ記録 ──
    appendRow(SHEET_NAMES.BOOKINGS, {
      '予約ID':         bookingId,
      '顧客ID':         params.customerId || '',
      'チャットID':     String(params.chatId),
      '車種タイプ':     normalizeVehicleType(vehicleType),
      '車種名':         '',
      'プラン':         plan.planFull,
      'オプション':     '',
      '予約日':         params.date,
      '予約時刻':       params.startTime,
      '所要時間(分)':   duration,
      '料金(USD)':      amount,
      '進行状態':       '予約確定',
      '緯度':           loc.lat || '',
      '経度':           loc.lng || '',
      '住所':           '',
      '場所補足':       '',
      'マップリンク':   loc.mapsUrl || '',
      'カレンダーID':   calendarEventId,
      '予約登録日時':   new Date(),
      '決済状態':       '未清算',
      '請求額(USD)':    amount,
      'スクショURL':    '',
      '入金確認日時':   '',
      'QR送信日時':     '',
      '催促回数':       0,
      '最終催促日時':   '',
      '管理者メモ':     ''
    });

    // ── 8. 3方向通知 ──
    notifyBookingCreated({
      bookingId: bookingId,
      chatId: params.chatId,
      name: params.name,
      plan: plan,
      vehicleType: vehicleType,
      date: params.date,
      startTime: params.startTime,
      endTime: endTimeStr,
      duration: duration,
      amount: amount,
      mapsUrl: loc.mapsUrl || params.location
    });

    return {
      status: 'ok',
      bookingId: bookingId,
      endTime: endTimeStr,
      amount: amount
    };

  } catch (err) {
    Logger.log('❌ createBooking error: ' + err + ' stack=' + (err.stack || ''));
    return { status: 'error', message: 'システムエラー: ' + err.message };
  } finally {
    lock.releaseLock();
  }
}

// ====== 3方向通知 ======

/**
 * 予約確定通知（顧客 + 管理グループ）
 */
function notifyBookingCreated(info) {
  const cfg = getConfig();

  // ── 顧客へ（クメール語 + 英語） ──
  const customerText =
    '✅ ការកក់ទទួលបានជោគជ័យ! / Booking confirmed!\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '📋 ' + info.bookingId + '\n' +
    '📦 Plan: ' + info.plan.jp + ' ' + info.plan.name + ' (' + info.plan.letter + ')\n' +
    '📅 ' + info.date + ' ' + info.startTime + ' - ' + info.endTime + '\n' +
    '💰 $' + info.amount + '\n' +
    '━━━━━━━━━━━━━━━━\n' +
    'សូមអរគុណ! / Thank you!';
  sendMessage(BOT_TYPE.BOOKING, info.chatId, customerText);

  // ── 管理グループへ（顧客トピック内） ──
  const customer = findCustomerRow(info.chatId);
  const threadId = (customer && customer.data['トピックID']) ? Number(customer.data['トピックID']) : null;

  const adminText =
    '🆕 新規予約\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '予約番号: ' + info.bookingId + '\n' +
    '顧客: ' + (info.name || 'Guest') + ' (chat_id=' + info.chatId + ')\n' +
    'プラン: ' + info.plan.planFull + '\n' +
    '車種: ' + info.vehicleType + '\n' +
    '日時: ' + info.date + ' ' + info.startTime + '〜' + info.endTime + ' (' + info.duration + '分)\n' +
    '料金: $' + info.amount + '\n' +
    '場所: ' + info.mapsUrl + '\n' +
    '━━━━━━━━━━━━━━━━';

  const options = threadId ? { message_thread_id: threadId } : {};
  sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminText, options);
}

// ====== ヘルパー ======

/**
 * 'YYYY-MM-DD' + h + m を Asia/Phnom_Penh の Date に変換
 * カンボジア(UTC+7) には DST がないので固定オフセットで計算
 */
function parseDateTimePhnomPenh(dateStr, h, m) {
  // dateStr="2026-04-20" h=9 m=0 → UTC 02:00 のDateを作る
  const parts = dateStr.split('-');
  const y = parseInt(parts[0], 10);
  const mo = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  // Phnom Penh = UTC+7, so local h:m = UTC (h-7):m
  return new Date(Date.UTC(y, mo, d, h - 7, m, 0));
}

/**
 * UTC の Date オブジェクトから カンボジア時間（UTC+7）の時・分を取得
 * GASサーバーのローカルTZに依存しない安全な変換
 */
function toPhnomPenhHM(date) {
  var h = date.getUTCHours() + 7;
  if (h >= 24) h -= 24;
  return { h: h, m: date.getUTCMinutes() };
}

/**
 * h:m を 'HH:mm' 形式に
 */
function formatHHmm(h, m) {
  return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
}

/**
 * "📍 https://www.google.com/maps?q=11.55,104.92" から緯度経度を抽出
 */
function parseLocationString(locStr) {
  const result = { lat: '', lng: '', mapsUrl: '' };
  if (!locStr) return result;
  const s = String(locStr);

  // URL抽出
  const urlMatch = s.match(/https?:\/\/[^\s]+/);
  if (urlMatch) result.mapsUrl = urlMatch[0];

  // ?q=lat,lng 形式
  const q = s.match(/[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
  if (q) {
    result.lat = q[1];
    result.lng = q[2];
  }
  return result;
}
