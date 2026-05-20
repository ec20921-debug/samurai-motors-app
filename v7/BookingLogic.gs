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

// ミニアプリ(英語表示)用のプラン説明
// Menu v2 (2026-05-06): 旧4プラン(A/B/C/D)廃止、SAMURAI WASH (W) 1本に集約
// GLASS は OPTIONS シート側で別管理(getActiveOptions 参照)
const PLAN_DESC_EN = {
  'W': 'Waterless body wash + Tire wax (Required base service)'
};

// 旧プラン letter (legacy) — 履歴表示時のラベル変換のみ使用、新規予約には使わない
const LEGACY_PLAN_DESC = {
  'A': 'Legacy: KIYOME (Waterless wash + Tire shine)',
  'B': 'Legacy: KAGAMI (A + Front 3 windows water-repellent)',
  'C': 'Legacy: TAKUMI (A + All windows water-repellent)',
  'D': 'Legacy: SHOGUN (A + Oil film removal + All windows water-repellent)'
};

// ====== プラン取得 ======

/**
 * プラン(WASH 系)一覧を取得
 *
 * Menu v3 (2026-05-19): 「メニュー」シート(統合シート)が存在すればそちらを優先、
 * なければ旧「料金設定」シートにフォールバックする dual-read 方式。
 *
 * 戻り値の形は従来どおり: { letter, jp, name, desc, descEn, planFull, priceSedan, ... }
 * booking.html / Router.gs は変更不要。
 *
 * @return {Array<Object>}
 */
function getActivePlans() {
  // ── Menu v3: 統合シート優先 ──
  const fromMenu = readPlansFromMenuSheet_();
  if (fromMenu !== null) return fromMenu;

  // ── レガシー(料金設定 シート)フォールバック ──
  return readPlansFromLegacyPlanPrices_();
}

/**
 * 「メニュー」統合シートから WASH 行を読む(種別=WASH のみ抽出)
 * シートが存在しない場合は null を返し、呼び出し側がフォールバックする
 */
function readPlansFromMenuSheet_() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.MENU);
  if (!sheet) return null;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // メニューシート列構造 (Setup_MenuV3.gs MENU_HEADERS と同期):
  // A:コード B:種別 C:名称(英) D:名称(クメール) E:名称(日)
  // F:セダン価格 G:SUV価格 H:セダン所要 I:SUV所要 J:有効 K:備考
  const data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const plans = [];

  data.forEach(function(row) {
    const code = String(row[0] || '').trim();
    if (!code) return;
    const kind = String(row[1] || '').trim();
    if (kind !== 'WASH') return; // GLASS は getActiveOptions 側で扱う
    const active = row[9];
    const isActive = (active === true || String(active).toUpperCase() === 'TRUE');
    if (!isActive) return;

    // 旧コード互換: コード 'WASH' → letter='W' に変換(booking.html が letter='W' を送ってくるため)
    const letter = (code.toUpperCase() === 'WASH') ? 'W' : code;
    const nameEn = String(row[2] || '');
    plans.push({
      letter: letter,
      jp: String(row[4] || ''),                          // 名称(日)
      name: nameEn,
      desc: String(row[10] || ''),                       // 備考(管理用)
      descEn: String(row[10] || '') || nameEn,           // 顧客向け説明
      planFull: nameEn + ' (' + letter + ')',
      priceSedan: Number(row[5]) || 0,
      priceSuv: Number(row[6]) || 0,
      durationSedan: Number(row[7]) || 0,
      durationSuv: Number(row[8]) || 0
    });
  });

  return plans;
}

/**
 * 旧「料金設定」シートから WASH プランを読む(Menu v3 移行前の動作)
 * 「メニュー」シート不在時のフォールバック
 */
function readPlansFromLegacyPlanPrices_() {
  // Menu v3: 設定/料金設定 どちらの名前でも動くようヘルパー経由
  const sheet = getPlanPricesSheet_();
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
      descEn: PLAN_DESC_EN[parsed.letter] || parsed.name,
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
 * プラン名行をパースして letter / jp / name に分解
 *
 * 対応フォーマット:
 *   - 旧形式: "清 KIYOME (A)"        → { jp:'清', name:'KIYOME', letter:'A' }
 *   - 新形式: "SAMURAI WASH (W)"     → { jp:'',  name:'SAMURAI WASH', letter:'W' }
 *   - 新形式: "Samurai Wash (W)"     → { jp:'',  name:'Samurai Wash', letter:'W' }
 *
 * 新規予約は Menu v2 (W) のみ生成。A/B/C/D はパースのみ対応(履歴表示用)。
 */
function parsePlanRow(planName) {
  // (X) の letter を抽出
  const letterMatch = planName.match(/^(.+?)\s*\(([A-Z]+)\)\s*$/);
  if (!letterMatch) return null;
  const fullName = letterMatch[1].trim();
  const letter = letterMatch[2];

  // 旧形式判定: 先頭が漢字1〜2文字 + 半角スペース + 英字単語
  // 例: "清 KIYOME" / "鏡 KAGAMI"
  const oldFormatMatch = fullName.match(/^([一-龥]{1,3})\s+(\S+)$/);
  if (oldFormatMatch) {
    return {
      jp: oldFormatMatch[1],
      name: oldFormatMatch[2],
      letter: letter,
      planFull: planName
    };
  }

  // 新形式: 英字メイン(複数語可)、JP は空
  return {
    jp: '',
    name: fullName,
    letter: letter,
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

// ====== オプション取得 (Menu v2: GLASS add-on) ======

/**
 * GLASS 等の追加サービス一覧を取得(顧客フローでは WASH と並列扱い)
 *
 * Menu v3 (2026-05-19): 「メニュー」シート優先、なければ旧「オプション」シートにフォールバック
 *
 * 注: 関数名/戻り値の形は後方互換のため維持(booking.html / Router.gs 変更不要)。
 * 概念整理(Daisuke 指示 2026-05-19): GLASS は「オプション(add-on)」ではなく
 * 「WASH と同列の選択肢」。シート上は同じ場所(メニュー)で管理する。
 *
 * @return {Array<Object>} [{code, nameEn, nameKm, nameJp, priceSedan, priceSuv,
 *                            durationSedan, durationSuv, requiresPlan, description}]
 */
function getActiveOptions() {
  // ── Menu v3: 統合シート優先 ──
  const fromMenu = readGlassFromMenuSheet_();
  if (fromMenu !== null) return fromMenu;

  // ── レガシー(オプション シート)フォールバック ──
  return readGlassFromLegacyOptions_();
}

/**
 * 「メニュー」統合シートから GLASS 行を読む(種別=GLASS のみ抽出)
 */
function readGlassFromMenuSheet_() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.MENU);
  if (!sheet) return null;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const out = [];

  data.forEach(function(row) {
    const code = String(row[0] || '').trim();
    if (!code) return;
    const kind = String(row[1] || '').trim();
    if (kind !== 'GLASS') return; // WASH は getActivePlans 側
    const active = row[9];
    const isActive = (active === true || String(active).toUpperCase() === 'TRUE');
    if (!isActive) return;

    out.push({
      code:           code,
      nameEn:         String(row[2] || ''),
      nameKm:         String(row[3] || ''),
      nameJp:         String(row[4] || ''),
      priceSedan:     Number(row[5]) || 0,
      priceSuv:       Number(row[6]) || 0,
      durationSedan:  Number(row[7]) || 0,
      durationSuv:    Number(row[8]) || 0,
      requiresPlan:   '',                        // Menu v2.1 以降 GLASS は WASH 不要
      description:    String(row[10] || '')
    });
  });

  return out;
}

/**
 * 旧「オプション」シートから GLASS を読む(Menu v3 移行前の動作)
 */
function readGlassFromLegacyOptions_() {
  let sheet;
  try {
    sheet = getSheet(SHEET_NAMES.OPTIONS);
  } catch (e) {
    Logger.log('⚠️ getActiveOptions: ' + SHEET_NAMES.OPTIONS + ' シート未作成。migrateMenuV2() か migrateMenuV3_createUnifiedMenu() を実行してください');
    return [];
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const lastCol = Math.max(11, sheet.getLastColumn());
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const options = [];

  data.forEach(function(row) {
    const code = String(row[0] || '').trim();
    if (!code) return;
    const active = row[9];
    if (active !== true && String(active).toUpperCase() !== 'TRUE') return;

    options.push({
      code:           code,
      nameEn:         String(row[1] || ''),
      nameKm:         String(row[2] || ''),
      nameJp:         String(row[3] || ''),
      priceSedan:     Number(row[4]) || 0,
      priceSuv:       Number(row[5]) || 0,
      durationSedan:  Number(row[6]) || 0,
      durationSuv:    Number(row[7]) || 0,
      requiresPlan:   String(row[8] || '').trim(),
      description:    String(row[10] || '')
    });
  });

  return options;
}

/**
 * コード('GLASS_3' 等)からオプションを検索
 */
function findOptionByCode(code) {
  if (!code) return null;
  const options = getActiveOptions();
  for (let i = 0; i < options.length; i++) {
    if (options[i].code === code) return options[i];
  }
  return null;
}

/**
 * オプション+車種から追加料金(USD)を取得
 */
function getOptionPriceFor(option, miniappVt) {
  if (!option) return 0;
  return miniappVt === 'SUV以上' ? option.priceSuv : option.priceSedan;
}

/**
 * オプション+車種から追加所要時間(分)を取得
 */
function getOptionDurationFor(option, miniappVt) {
  if (!option) return 0;
  return miniappVt === 'SUV以上' ? option.durationSuv : option.durationSedan;
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
 * プラン+車種から基本料金(USD)を取得（出張料を含まない）
 */
function getBasePriceFor(plan, miniappVt) {
  return miniappVt === 'SUV以上' ? plan.priceSuv : plan.priceSedan;
}

/**
 * プラン+車種から出張料(USD)を取得（料金設定シート「出張料」行から動的取得）
 * 【重要】$2 などの金額はコード内にハードコードしない。
 *         料金設定シートの「出張料」行（セダン/SUV列）の値のみを使う。
 *         シートを書き換えるだけで全フロー（ミニアプリ表示・顧客通知・請求額）に反映される。
 */
function getDispatchFeeFor(miniappVt) {
  const fees = getDispatchFee(); // { sedan, suv } from getBookingConfig().travelFee
  return miniappVt === 'SUV以上' ? (fees.suv || 0) : (fees.sedan || 0);
}

/**
 * プラン+車種から総額(USD)を取得（基本料金 + 出張料）
 * シートの「出張料」値を動的加算するため、将来の料金改定はシート更新のみでOK。
 */
function getPriceFor(plan, miniappVt) {
  return getBasePriceFor(plan, miniappVt) + getDispatchFeeFor(miniappVt);
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
// 定休日 (0=日, 1=月, ..., 6=土)  ※日曜休業
const CLOSED_WEEKDAYS = [0];

/**
 * カンボジアの祝日（YYYY-MM-DD 形式）
 * 【重要】移動祝日（仏教・水祭り等）は毎年少しずれるため、年度ごとに見直すこと。
 *         公式発表: https://www.mlvt.gov.kh/ / プラカート
 * 下記は 2026 年公式リスト（固定祝日＋概算の移動祝日）。
 */
const CAMBODIA_HOLIDAYS = [
  // 2026
  '2026-01-01', // International New Year Day
  '2026-01-07', // Victory over Genocide Day
  '2026-03-08', // International Women's Day
  '2026-04-14', // Khmer New Year
  '2026-04-15', // Khmer New Year
  '2026-04-16', // Khmer New Year
  '2026-05-01', // International Labour Day
  '2026-05-01', // Visak Bochea Day（移動・要確認）
  '2026-05-08', // Royal Ploughing Ceremony（移動・要確認）
  '2026-05-13', // King Sihamoni's Birthday
  '2026-05-14', // King Sihamoni's Birthday
  '2026-05-15', // King Sihamoni's Birthday
  '2026-06-18', // Queen Mother's Birthday
  '2026-09-24', // Constitution Day
  '2026-10-10', // Pchum Ben Holiday（移動・要確認）
  '2026-10-11', // Pchum Ben Day（移動・要確認）
  '2026-10-12', // Pchum Ben Holiday（移動・要確認）
  '2026-10-15', // King Father Commemoration Day
  '2026-10-29', // King's Coronation Day
  '2026-10-31', // King Father Sihanouk's Birthday
  '2026-11-09', // Independence Day
  '2026-11-23', // Water Festival（移動・要確認）
  '2026-11-24', // Water Festival
  '2026-11-25', // Water Festival
  // 2027 固定祝日（他年分は別途追加）
  '2027-01-01',
  '2027-01-07',
  '2027-03-08'
];

function findAvailableSlots(dateStr, planLetter, miniappVt, glassCode) {
  // Menu v2.1 (2026-05-08): GLASS 単体予約に対応するため、plan/glass それぞれを optional 化
  // plan または glass の少なくとも一方は必要、両方なし = エラー
  let baseDuration = 0;
  let glassDuration = 0;

  if (planLetter && String(planLetter).trim() !== '') {
    const plan = findPlanByLetter(planLetter);
    if (!plan) return { ok: false, error: 'INVALID_PLAN' };
    baseDuration = getDurationFor(plan, miniappVt);
  }

  if (glassCode) {
    const glassOpt = (typeof findOptionByCode === 'function') ? findOptionByCode(glassCode) : null;
    if (glassOpt) {
      glassDuration = getOptionDurationFor(glassOpt, miniappVt);
    }
  }

  const duration = baseDuration + glassDuration;
  if (!duration) return { ok: false, error: 'INVALID_DURATION' };

  // ── 定休日チェック（日曜）──
  // 'YYYY-MM-DD' からローカル日付の曜日を算出（カンボジア時間）
  const dp = dateStr.split('-');
  const weekday = new Date(Date.UTC(
    parseInt(dp[0], 10),
    parseInt(dp[1], 10) - 1,
    parseInt(dp[2], 10)
  )).getUTCDay(); // 0..6
  if (CLOSED_WEEKDAYS.indexOf(weekday) >= 0) {
    return {
      ok: true,
      slots: [],
      durationMin: duration,
      debug: 'closed_day: Closed (Sunday)'
    };
  }

  // ── カンボジア祝日: 営業可(2026-05-06 Daisuke 判断: 日曜だけ休み、祝日は通常営業) ──
  // 旧: ブロックしていた / 新: 祝日でもスロット生成、UI 側はラベルのみ表示

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
  // 診断用: ブロック元のイベント情報を残す
  const evDiag = events.map(function(ev) {
    try {
      var title = ev.getTitle();
      var s = ev.getStartTime();
      var e = ev.getEndTime();
      var allDay = (typeof ev.isAllDayEvent === 'function' && ev.isAllDayEvent());
      var fmt = function(d) {
        return Utilities.formatDate(d, 'Asia/Phnom_Penh', 'MM/dd HH:mm');
      };
      return (allDay ? '[ALL-DAY]' : '') + title + ' ' + fmt(s) + '-' + fmt(e);
    } catch (err) {
      return '(evt-parse-err)';
    }
  });
  const busyRanges = events.map(function(ev) {
    return {
      start: ev.getStartTime().getTime() - buffer * 60 * 1000,
      end:   ev.getEndTime().getTime() + buffer * 60 * 1000
    };
  });

  Logger.log('🔎 findAvailableSlots date=' + dateStr + ' weekday=' + weekday +
    ' events=' + events.length + ' buffer=' + buffer +
    ' biz=' + bizStart + '-' + bizEnd + ' duration=' + duration +
    (evDiag.length ? ' evts=[' + evDiag.join(' | ') + ']' : ''));

  // ── 候補時刻を 30分刻みで生成 ──
  const now = new Date().getTime();
  const slots = [];
  let skipPast = 0, skipConflict = 0, skipOverflow = 0;
  for (let h = bizStart; h < bizEnd; h++) {
    for (let m = 0; m < 60; m += SLOT_STEP_MIN) {
      const slotStart = parseDateTimePhnomPenh(dateStr, h, m);
      const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);

      // 営業終了時刻を超えるならスキップ
      if (slotEnd > dayEnd) { skipOverflow++; continue; }
      // 過去時刻スキップ
      if (slotStart.getTime() < now) { skipPast++; continue; }

      // 既存予約と重複チェック（バッファ込み）
      let conflict = false;
      for (let i = 0; i < busyRanges.length; i++) {
        const b = busyRanges[i];
        if (slotStart.getTime() < b.end && slotEnd.getTime() > b.start) {
          conflict = true;
          break;
        }
      }
      if (conflict) { skipConflict++; continue; }

      slots.push(formatHHmm(h, m));
    }
  }

  // フロントに診断情報を返す（空のときにユーザーに何が原因か見せるため）
  let debug = 'events=' + events.length +
    ' past=' + skipPast + ' conflict=' + skipConflict + ' overflow=' + skipOverflow;
  if (evDiag.length) debug += ' blockedBy=[' + evDiag.join(' | ') + ']';

  return { ok: true, slots: slots, durationMin: duration, debug: debug };
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
    // ── 1. バリデーション (Menu v2.1: 2026-05-08 GLASS 単体予約も可) ──
    // planLetter は optional化、ただし plan/glassOption の少なくとも一方は必須
    const vehicleType = params.vehicleType;
    if (vehicleType !== 'セダン以下' && vehicleType !== 'SUV以上') {
      return { status: 'error', message: '車種タイプ不正' };
    }

    // plan は optional (empty string も null として扱う)
    let plan = null;
    if (params.planLetter && String(params.planLetter).trim() !== '') {
      plan = findPlanByLetter(params.planLetter);
      if (!plan) return { status: 'error', message: 'プラン不正: ' + params.planLetter };
    }

    // ── 1-b. GLASS オプション(Menu v2)の解決 ──
    let glassOpt = null;
    if (params.glassOption) {
      glassOpt = findOptionByCode(params.glassOption);
      if (!glassOpt) {
        return { status: 'error', message: 'オプション不正: ' + params.glassOption };
      }
      // ⚠️ 2026-05-08: requiresPlan の厳格チェックは緩和(GLASS 単体注文を許容するため)
      // GLASS は WASH 推奨だが必須ではない、運用上の整合性は管理側で確認
    }

    // ── 1-b'. 「最低 1 つ」のバリデーション ──
    if (!plan && !glassOpt) {
      return {
        status: 'error',
        message: 'SAMURAI WASH か SAMURAI GLASS のどちらか1つは選択してください。'
      };
    }

    // ── 1-b''. サービスタイプ判定 (2026-05-20: 店舗作業オプション追加) ──
    // '店舗' = 顧客が店舗に来店してサービスを受ける → 出張料 $0
    // '出張' = 既存通り、顧客指定場所へ出向く → 出張料あり
    // デフォルトは '出張'（既存予約との互換性維持）
    const serviceType = (params.serviceType === '店舗') ? '店舗' : '出張';

    // ── 1-c. 料金・所要時間の合算 ──
    const baseDuration = plan ? getDurationFor(plan, vehicleType) : 0;
    const glassDuration = getOptionDurationFor(glassOpt, vehicleType);
    const duration = baseDuration + glassDuration;

    const baseAmount = plan ? getBasePriceFor(plan, vehicleType) : 0;
    const glassAmount = getOptionPriceFor(glassOpt, vehicleType);
    // 店舗作業は出張料ゼロ、出張作業のみ料金設定シートの「出張料」を加算
    const dispatchFeeAmount = (serviceType === '店舗') ? 0 : getDispatchFeeFor(vehicleType);
    const serviceSubtotal = baseAmount + glassAmount;            // 割引対象(WASH+GLASS)
    const subtotal = serviceSubtotal + dispatchFeeAmount;        // 表示上の合計(出張料含む、割引前)

    // ── 1-d. キャンペーン割引(Menu v2 / 2026-05-06: GRAND OPENING -30%) ──
    // 採用: 案a — サービス料金(WASH+GLASS)のみに -X%。出張料は通常価格(透明性)。
    const cfg = getBookingConfig();
    const camp = cfg.campaign || { active: false, percent: 0 };
    let discountAmount = 0;
    if (camp.active && camp.percent > 0) {
      discountAmount = Math.round(serviceSubtotal * camp.percent) / 100;
    }
    const amount = Math.max(0, subtotal - discountAmount); // 請求総額(WASH+GLASS×(1-%) + Delivery)

    // ── 2. 空き枠再確認(ロック後に取り直し) ──
    // plan が無い(GLASS-only)場合は findAvailableSlots が無効。簡易検証のみ実施。
    // 注: GLASS-only の race condition リスクは低ボリュームのため運用上許容、将来拡張。
    if (plan) {
      const avail = findAvailableSlots(params.date, params.planLetter, vehicleType);
      if (!avail.ok) return { status: 'error', message: '空き枠取得失敗: ' + avail.error };
      if (avail.slots.indexOf(params.startTime) < 0) {
        return {
          status: 'error',
          message: 'その時間は先約が入りました。別の時刻を選択してください。',
          slots: avail.slots
        };
      }
    }

    // ── 3. 時刻計算 ──
    // ⚠️ タイムゾーン注意: GAS実行環境のロケールに依存しないよう、
    //   終了時刻は Utilities.formatDate + Asia/Phnom_Penh で確実にPP時刻に整形する。
    //   （以前 toPhnomPenhHM() を使っていたがUTC計算が混入し誤表示した経緯あり）
    const hm = params.startTime.split(':');
    const startDt = parseDateTimePhnomPenh(params.date, parseInt(hm[0], 10), parseInt(hm[1], 10));
    const endDt = new Date(startDt.getTime() + duration * 60 * 1000);
    const endTimeStr = Utilities.formatDate(endDt, BOOKING_TZ, 'HH:mm');
    Logger.log('🕒 createBooking time calc: start=' + params.startTime +
      ' duration=' + duration + 'min end=' + endTimeStr +
      ' (startDt=' + startDt.toISOString() + ' endDt=' + endDt.toISOString() + ')');

    // ── 4. 位置情報をパース ──
    const loc = parseLocationString(params.location);

    // ── 5. 予約ID採番 ──
    const bookingId = generateDateSeqId('BK', SHEET_NAMES.BOOKINGS, '予約ID');

    // ── 6. カレンダー登録 ──
    const sysCfg = getConfig();
    const calendar = CalendarApp.getCalendarById(sysCfg.bookingCalendarId);
    // タイトル / ラベル: plan / glassOpt の有無で分岐(GLASS-only も対応)
    const planCodeForTitle = plan ? plan.letter : (glassOpt ? glassOpt.code : '');
    const titleParts = [];
    if (plan) titleParts.push(plan.letter);
    if (glassOpt) titleParts.push(glassOpt.code);
    const eventTitle = '【' + titleParts.join('+') + '】' +
                       (params.name || 'Guest') + ' / ' + normalizeVehicleType(vehicleType);

    const planDescLine = plan ? ('プラン: ' + plan.planFull + '\n') : '';
    const calendarDesc =
      '予約ID: ' + bookingId + '\n' +
      planDescLine +
      (glassOpt ? 'オプション: ' + glassOpt.nameEn + ' (' + glassOpt.code + ')\n' : '') +
      '車種: ' + vehicleType + '\n' +
      '顧客: ' + params.name + ' (chat_id=' + params.chatId + ')\n' +
      '場所: ' + params.location + '\n' +
      '料金: ' + (plan ? '$' + baseAmount : '') +
      (glassOpt ? (plan ? ' + ' : '') + 'GLASS $' + glassAmount : '') +
      ' + 出張料 $' + dispatchFeeAmount +
      ' = 合計 $' + amount;
    const event = calendar.createEvent(eventTitle, startDt, endDt, {
      description: calendarDesc,
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
      'プラン':         plan ? plan.planFull : '',
      'オプション':     glassOpt ? glassOpt.code : '',
      '予約日':         params.date,
      '予約時刻':       params.startTime,
      '所要時間(分)':   duration,
      '料金(USD)':      amount,                                    // 割引後の最終請求額
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
      '管理者メモ':     '',
      // ── キャンペーン分析用 3 列 (Menu v2: 2026-05-06) ──
      '割引前金額(USD)': subtotal,                                  // WASH+GLASS+Delivery の合計(割引前)
      '割引額(USD)':    discountAmount,                            // 割引で引かれた額(0 = キャンペーンなし)
      'キャンペーン名': (camp && camp.active && discountAmount > 0) ? (camp.nameEn || '') : '',
      // ── サービスタイプ (2026-05-20: 店舗/出張区分) ──
      'サービスタイプ': serviceType                                 // '店舗' or '出張'
    });

    // ── 7-b. ファネル計測ログ(失敗してもメイン処理は継続) ──
    // 2026-05-20 fix: GLASS 単体予約時 plan が null になるため、null ガードを追加
    if (typeof logFunnelEvent === 'function') {
      logFunnelEvent(params.chatId, 'booking_completed', 'booking.html', bookingId, {
        plan: plan ? plan.letter : null,
        glass: glassOpt ? glassOpt.code : null,
        amount: amount,
        vehicleType: vehicleType,
        serviceType: serviceType
      });
    }

    // ── 8. 3方向通知 ──
    notifyBookingCreated({
      bookingId: bookingId,
      chatId: params.chatId,
      name: params.name,
      plan: plan,
      glassOption: glassOpt,
      glassAmount: glassAmount,
      vehicleType: vehicleType,
      date: params.date,
      startTime: params.startTime,
      endTime: endTimeStr,
      duration: duration,
      baseAmount: baseAmount,
      dispatchFee: dispatchFeeAmount,
      subtotal: subtotal,
      discountAmount: discountAmount,
      campaign: (camp && camp.active && camp.percent > 0) ? camp : null,
      amount: amount,
      mapsUrl: loc.mapsUrl || params.location,
      serviceType: serviceType                       // '店舗' or '出張' (2026-05-20)
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

  // ── サービスタイプ (2026-05-20: 店舗/出張区分) ──
  // 互換性のためデフォルトは '出張'。'店舗' のときは出張料を表示しない。
  const serviceType = info.serviceType || '出張';
  const isInStore = (serviceType === '店舗');

  // ── 顧客へ(英語メイン + クメール語サブ / Menu v2 / 2026-05-06)──
  // Menu v2.1 (2026-05-08): plan が null の場合(GLASS 単体予約)もハンドル
  const baseAmt = (typeof info.baseAmount === 'number') ? info.baseAmount : 0;
  const feeAmt  = (typeof info.dispatchFee === 'number') ? info.dispatchFee : 0;
  const glassAmt = (typeof info.glassAmount === 'number') ? info.glassAmount : 0;
  const subtotal = (typeof info.subtotal === 'number') ? info.subtotal : (baseAmt + glassAmt + feeAmt);
  const discount = (typeof info.discountAmount === 'number') ? info.discountAmount : 0;
  const camp = info.campaign || null;
  const glassOpt = info.glassOption || null;
  // plan が null の場合は GLASS 単体予約
  const hasPlan = !!(info.plan);
  const planDisplayName = hasPlan
    ? ((info.plan.jp ? info.plan.jp + ' ' : '') + info.plan.name)
    : (glassOpt ? 'SAMURAI GLASS (' + glassOpt.nameEn + ')' : 'SAMURAI Service');

  // 案a: サービス料金のみ -30%、Delivery は通常価格
  const serviceSubtotal = baseAmt + glassAmt;
  const serviceAfterDiscount = serviceSubtotal - discount;

  let customerText =
    '✅ Booking confirmed! / ការកក់ទទួលបានជោគជ័យ!\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '📋 ' + info.bookingId + '\n' +
    '📦 Service: ' + planDisplayName + '\n';
  if (glassOpt && hasPlan) {
    customerText += '✨ Add-on: ' + glassOpt.nameEn + '\n';
  }
  customerText +=
    '📅 ' + info.date + ' ' + info.startTime + ' - ' + info.endTime + '\n' +
    '━━━━━━━━━━━━━━━━\n';
  // WASH 行(plan ありの時だけ)
  if (hasPlan) {
    customerText += '💰 ' + (info.plan.name || 'WASH') + ':   $' + baseAmt + '\n';
  }
  // GLASS 行(glassOpt ありの時だけ)
  if (glassOpt) {
    customerText += '✨ GLASS (' + glassOpt.nameEn + '):  $' + glassAmt + '\n';
  }
  if (camp && discount > 0) {
    customerText +=
      '─────────────────\n' +
      '📊 Service subtotal:        $' + serviceSubtotal.toFixed(2) + '\n' +
      '🎌 ' + (camp.nameEn || 'Campaign') + ' (-' + camp.percent + '%):  -$' + discount.toFixed(2) + '\n' +
      '✓ Service (after discount): $' + serviceAfterDiscount.toFixed(2) + '\n';
  }
  // サービスタイプによってデリバリー費の表示を分岐
  if (isInStore) {
    customerText += '🏪 In-store service / សេវានៅហាង:  $0.00\n';
  } else {
    customerText += '🚚 Delivery fee / ថ្លៃដឹកជញ្ជូន:  $' + feeAmt + '\n';
  }
  customerText +=
    '─────────────────\n' +
    '💵 Total / សរុប:                  $' + (typeof info.amount === 'number' ? info.amount.toFixed(2) : info.amount) + '\n' +
    '━━━━━━━━━━━━━━━━\n';

  // ── 店舗作業: 来店案内 / 出張作業: 通常フロー ──
  if (isInStore) {
    customerText +=
      '🏪 Please come to our office\n' +
      '   សូមអញ្ជើញមកការិយាល័យ\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '📍 Samurai Motors Office\n' +
      '   https://maps.app.goo.gl/wEHuqw2fry4QJQ5y6\n' +
      '\n' +
      '⏰ Please arrive at ' + info.startTime + '\n' +
      '   សូមមកដល់នៅម៉ោង ' + info.startTime + '\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '👤 Your specialist: Run Kosal\n' +
      '   (Field-trained · Premium care)\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '📋 What happens next:\n' +
      '⏰ 1h before: Reminder + map link\n' +
      '🏪 On arrival: We greet you at the office\n' +
      '📷 Service: Before photos via Telegram\n' +
      '✨ After: After photos + QR for payment\n' +
      '🙏 24h later: Feedback request\n' +
      '━━━━━━━━━━━━━━━━\n';
  } else {
    customerText +=
      '👤 Your specialist: Run Kosal\n' +
      '   (Field-trained · Premium care)\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '📋 What happens next:\n' +
      '⏰ 1h before: Reminder + map link\n' +
      '📷 Service: Before photos via Telegram\n' +
      '✨ After: After photos + QR for payment\n' +
      '🙏 24h later: Feedback request\n' +
      '━━━━━━━━━━━━━━━━\n';
  }

  customerText +=
    '💳 Payment / ការបង់ប្រាក់\n' +
    'After service completion, we will send you a QR code via Telegram.\n' +
    'Please make payment using that QR code.\n' +
    '\n' +
    'បន្ទាប់ពីលាងសម្អាតរួច យើងនឹងផ្ញើ QR Code\n' +
    'តាម Telegram។ សូមបង់ប្រាក់តាម QR Code នោះ។\n' +
    '━━━━━━━━━━━━━━━━\n' +
    'Thank you! / សូមអរគុណ!';
  sendMessage(BOT_TYPE.BOOKING, info.chatId, customerText);

  // ── 駐車場所のヒアリング（出張作業のみ、店舗作業は不要） ──
  // 出張: カンボジアはビル駐車場で階が多いため、車両前面の写真と階数を聞く
  // 店舗: 顧客が車を持って来るので、階数等は不要
  if (!isInStore) {
    const parkingInfoText =
      '📍 សូមផ្ញើបន្ថែម / Please also send:\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '1️⃣ 📸 រូបថតពីខាងមុខរថយន្តនៅកន្លែងចត\n' +
      '    Front photo of your car (at parking spot)\n' +
      '2️⃣ 🏢 ជាន់ទីប៉ុន្មាន?\n' +
      '    Which floor is your car parked on?\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '🙏 ដើម្បីឱ្យក្រុមការងាររបស់យើងរកឃើញរថយន្តរបស់អ្នកបានឆាប់\n' +
      '🙏 So our team can locate your car quickly.';
    sendMessage(BOT_TYPE.BOOKING, info.chatId, parkingInfoText);
  }

  // ── 管理グループへ（顧客トピック内） ──
  // stale thread_id が残っている（例: 管理グループのチャットログを消してトピック削除した）ケースに備え、
  // getOrCreateTopic + 自動再作成フォールバック付きの sendToCustomerTopicWithRecovery を使う
  const custRow = findCustomerRow(info.chatId);
  const customerObj = (custRow && custRow.data) ? {
    chatId:    info.chatId,
    firstName: (custRow.data['氏名'] || info.name || '').toString(),
    lastName:  '',
    username:  custRow.data['ユーザー名'] || ''
  } : {
    chatId:    info.chatId,
    firstName: info.name || '',
    lastName:  '',
    username:  ''
  };

  const serviceTypeTag = isInStore ? '🏪 店舗作業' : '🚗 出張作業';

  let adminText =
    '🆕 新規予約 [' + serviceTypeTag + ']\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '予約番号: ' + info.bookingId + '\n' +
    '顧客: ' + (info.name || 'Guest') + ' (chat_id=' + info.chatId + ')\n';
  if (hasPlan) {
    adminText += 'プラン: ' + info.plan.planFull + '\n';
  } else {
    adminText += '⚠️ プラン: なし (GLASS 単体予約)\n';
  }
  if (glassOpt) {
    adminText += 'オプション: ' + glassOpt.nameEn + ' (' + glassOpt.code + ')\n';
  }
  adminText +=
    '車種: ' + info.vehicleType + '\n' +
    '日時: ' + info.date + ' ' + info.startTime + '〜' + info.endTime + ' (' + info.duration + '分)\n';
  // 料金内訳: hasPlan / glassOpt の有無で組み立て
  const priceParts = [];
  if (hasPlan) priceParts.push('WASH $' + baseAmt);
  if (glassOpt) priceParts.push('GLASS $' + glassAmt);
  const priceJoin = priceParts.join(' + ');

  // サービスタイプによって料金内訳の表示を分岐
  const feeLabel = isInStore ? '店舗作業(出張料なし)' : ('出張料 $' + feeAmt);
  if (camp && discount > 0) {
    adminText +=
      '料金: ' + priceJoin + ' = サービス計 $' + serviceSubtotal.toFixed(2) +
      '\n🎌 キャンペーン (' + (camp.nameEn || '') + ' -' + camp.percent + '%): -$' + discount.toFixed(2) +
      '\n→ サービス計(割引後): $' + serviceAfterDiscount.toFixed(2) +
      (isInStore ? '\n🏪 店舗作業のため出張料なし' : ('\n+ 出張料: $' + feeAmt)) +
      '\n→ 請求額: $' + (typeof info.amount === 'number' ? info.amount.toFixed(2) : info.amount);
  } else {
    adminText +=
      '料金: ' + priceJoin + ' + ' + feeLabel + ' = 合計 $' + info.amount;
  }
  adminText +=
    '\n場所: ' + (isInStore ? '🏪 店舗 (Samurai Motors 事務所)' : info.mapsUrl) + '\n' +
    '━━━━━━━━━━━━━━━━';

  try {
    const sendRes = sendToCustomerTopicWithRecovery(customerObj, adminText);
    if (!sendRes.ok) {
      Logger.log('⚠️ notifyBookingCreated: 管理グループ通知失敗（トピック送信が最終的に失敗）');
      // 最終フォールバック: General（thread 指定なし）に投げて消失を防ぐ
      sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
        '⚠️ トピック送信失敗のため General へ投稿\n' + adminText);
    } else if (sendRes.recreated) {
      Logger.log('♻️ notifyBookingCreated: 古いトピック検出 → 再作成して通知成功');
    }
  } catch (err) {
    Logger.log('❌ notifyBookingCreated: sendToCustomerTopicWithRecovery 例外: ' + err);
    // 例外でも最低限 General に投げて予約通知を失わない
    sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, adminText);
  }
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
