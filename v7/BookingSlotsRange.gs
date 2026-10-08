/**
 * BookingSlotsRange.gs — 複数日の空き枠を1回で返す（予約画面の日付タップを即時にする）
 *
 * 2026-10-08: 日付タップごとに booking_slots（カレンダー照会＋メニュー読み）を往復していたのを、
 *   画面に出る12日分をまとめて1回で返す読み取り専用の action に置き換える。
 *   - 1日ごとの判定は findAvailableSlots（BookingLogic.gs）と同じ順番・同じ条件（終了超過→過去→重複）
 *   - カレンダーは期間全体を1回だけ読み、日ごとに重なる予定だけを選ぶ
 *   - 予約確定時の最終判断（createBooking 内の再確認）は従来どおり findAvailableSlots を使う（本ファイルは表示専用）
 *   - 応答に debug・予定タイトルは含めない（他の客の名前を出さない）
 */

var SLOTS_RANGE_MAX_DAYS_ = 14;

/**
 * GET booking_slots_range
 * Query: from=YYYY-MM-DD, days(1..14, 既定12), plan(=letter, 任意), vehicleType, options(カンマ区切り, 任意)
 * Response: { status:'ok', from, durationMin, days:[{date, closed, slots:[]}] }
 */
function apiBookingSlotsRange(params) {
  const from = String(params.from || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return { status: 'error', message: 'from (YYYY-MM-DD) required' };
  }
  let days = parseInt(params.days, 10);
  if (isNaN(days)) days = 12;
  days = Math.min(Math.max(days, 1), SLOTS_RANGE_MAX_DAYS_);

  const planLetter = String(params.plan || '');
  const vehicleType = params.vehicleType;
  const optionsCsv = [String(params.options || ''), String(params.glassOption || '')]
    .join(',').split(',').map(function(s) { return s.trim(); })
    .filter(function(s, i, arr) { return s && arr.indexOf(s) === i; })
    .join(',');

  if (!vehicleType) {
    return { status: 'error', message: 'date/vehicleType required' };
  }
  if (!planLetter && !optionsCsv) {
    return { status: 'error', message: 'plan or options required' };
  }

  const res = findAvailableSlotsRange_(from, days, planLetter, vehicleType, optionsCsv);
  if (!res.ok) return { status: 'error', message: res.error };
  return { status: 'ok', from: from, durationMin: res.durationMin, days: res.days };
}

/**
 * @return {{ok:boolean, durationMin?:number, days?:Array<{date:string, closed:boolean, slots:Array<string>}>, error?:string}}
 */
function findAvailableSlotsRange_(fromStr, days, planLetter, miniappVt, optionCodes) {
  // ── 所要時間（findAvailableSlots と同じ求め方。resolved.ok を見ない癖もそのまま） ──
  let baseDuration = 0;
  let optionDuration = 0;
  if (planLetter && String(planLetter).trim() !== '') {
    const plan = findPlanByLetter(planLetter);
    if (!plan) return { ok: false, error: 'INVALID_PLAN' };
    baseDuration = getDurationFor(plan, miniappVt);
  }
  if (optionCodes) {
    const resolved = resolveOptionCodes_(optionCodes);
    resolved.options.forEach(function(opt) {
      optionDuration += getOptionDurationFor(opt, miniappVt);
    });
  }
  const duration = baseDuration + optionDuration;
  if (!duration) return { ok: false, error: 'INVALID_DURATION' };

  const cfg = getBookingConfig();
  const buffer = cfg.bufferMinutes || 30;
  const bizStart = cfg.businessHourStart || 9;
  const bizEnd = cfg.businessHourEnd || 18;

  // ── 対象日の一覧（UTC 演算でスクリプトの時差設定に依存しない） ──
  const fp = fromStr.split('-');
  const y = parseInt(fp[0], 10), mo = parseInt(fp[1], 10) - 1, d0 = parseInt(fp[2], 10);
  const dayList = [];
  for (let i = 0; i < days; i++) {
    const dt = new Date(Date.UTC(y, mo, d0 + i));
    const dateStr = dt.getUTCFullYear() + '-' +
      ('0' + (dt.getUTCMonth() + 1)).slice(-2) + '-' +
      ('0' + dt.getUTCDate()).slice(-2);
    dayList.push({
      date: dateStr,
      closed: CLOSED_WEEKDAYS.indexOf(dt.getUTCDay()) >= 0,
      start: parseDateTimePhnomPenh(dateStr, bizStart, 0),
      end: parseDateTimePhnomPenh(dateStr, bizEnd, 0)
    });
  }

  // ── カレンダーを期間全体で1回だけ読む（営業日が無ければ読まない） ──
  const openDays = dayList.filter(function(x) { return !x.closed; });
  let busy = [];   // {start, end} ms（バッファ込み）
  if (openDays.length > 0) {
    const calendar = getBookingCalendar_();
    if (!calendar) return { ok: false, error: 'CALENDAR_NOT_FOUND' };
    const events = calendar.getEvents(openDays[0].start, openDays[openDays.length - 1].end);
    busy = events.map(function(ev) {
      return { s: ev.getStartTime().getTime(), e: ev.getEndTime().getTime() };
    });
  }

  const now = new Date().getTime();
  const out = dayList.map(function(day) {
    if (day.closed) return { date: day.date, closed: true, slots: [] };

    // その日の営業時間に重なる予定だけ（1日ごとの getEvents(dayStart, dayEnd) と同じ範囲）
    const ds = day.start.getTime(), de = day.end.getTime();
    const busyRanges = [];
    for (let i = 0; i < busy.length; i++) {
      if (busy[i].s < de && busy[i].e > ds) {
        busyRanges.push({ start: busy[i].s - buffer * 60 * 1000, end: busy[i].e + buffer * 60 * 1000 });
      }
    }

    // 候補時刻を 30分刻みで生成（findAvailableSlots と同じ順番: 終了超過 → 過去 → 重複）
    const slots = [];
    for (let h = bizStart; h < bizEnd; h++) {
      for (let m = 0; m < 60; m += SLOT_STEP_MIN) {
        const slotStart = parseDateTimePhnomPenh(day.date, h, m);
        const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);
        if (slotEnd > day.end) continue;
        if (slotStart.getTime() < now) continue;
        let conflict = false;
        for (let i = 0; i < busyRanges.length; i++) {
          const b = busyRanges[i];
          if (slotStart.getTime() < b.end && slotEnd.getTime() > b.start) { conflict = true; break; }
        }
        if (conflict) continue;
        slots.push(formatHHmm(h, m));
      }
    }
    return { date: day.date, closed: false, slots: slots };
  });

  return { ok: true, durationMin: duration, days: out };
}

/**
 * 検証用（エディタから手動実行・読み取りのみ）: 1日ずつ計算した枠とまとめて計算した枠が一致するか
 * 一致しない組み合わせがあればログに出す。本番 push 後に1回実行して確認し、問題なければ残しておいてよい（軽量）。
 */
function debugCompareSlotsRange_() {
  const today = Utilities.formatDate(new Date(), BOOKING_TZ, 'yyyy-MM-dd');
  const combos = [
    ['W', 'セダン以下', ''], ['W', 'SUV以上', ''],
    ['', 'セダン以下', 'GLASS_3'], ['', 'SUV以上', 'HEADLIGHT'],
    ['W', 'セダン以下', 'GLASS_3,HEADLIGHT_MAGIC'], ['', 'セダン以下', 'GLASS_ALL,HEADLIGHT']
  ];
  let mismatch = 0;
  combos.forEach(function(c) {
    const range = findAvailableSlotsRange_(today, 12, c[0], c[1], c[2]);
    if (!range.ok) { Logger.log('range error ' + JSON.stringify(c) + ' ' + range.error); mismatch++; return; }
    range.days.forEach(function(day) {
      const single = findAvailableSlots(day.date, c[0], c[1], c[2]);
      const a = JSON.stringify(single.ok ? single.slots : 'ERR:' + single.error);
      const b = JSON.stringify(day.slots);
      if (a !== b || (single.ok && single.durationMin !== range.durationMin)) {
        mismatch++;
        Logger.log('❌ mismatch ' + JSON.stringify(c) + ' ' + day.date + ' single=' + a + ' range=' + b);
      }
    });
  });
  Logger.log(mismatch === 0 ? '✅ debugCompareSlotsRange_: 全一致' : ('❌ debugCompareSlotsRange_: 不一致 ' + mismatch + '件'));
}
