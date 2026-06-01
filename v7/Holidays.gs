/**
 * Holidays.gs — 休業日カレンダーブロック
 *
 * 【責務】
 *   「休業日」シートに書いた日付を、予約カレンダー（BOOKING_CALENDAR_ID）に
 *   終日イベントとして登録し、その日を予約ミニアプリ上で「予約不可」にする。
 *   スタッフ休み・臨時休業・貸切などをシート1か所で管理（カレンダーアプリ不要）。
 *
 * 【現場フロー】
 *   1. 「休業日」シートに 日付 / 理由 を書く（有効=☑）
 *   2. メニュー「🏖 休業日」→「カレンダーに反映」
 *   3. その日が予約アプリでブロックされる（既存の終日イベント判定を利用）
 *
 * 【仕組み】
 *   予約ロジック(findAvailableSlots)は BOOKING_CALENDAR_ID の終日イベントを
 *   その日の予約不可として扱う。本機能は同カレンダーに終日イベントを作るだけ。
 *
 * 【冪等性】
 *   既に同名タグ付きイベントがある日はスキップ（重複作成しない）。
 *   有効=FALSE / 行削除した日は、次回反映時にイベントを削除（同期）。
 *
 * 【識別タグ】
 *   作成イベントの説明文に HOLIDAY_TAG を埋め、本機能が作ったものだけを
 *   管理対象にする（手動で入れた他イベントは触らない）。
 */

const HOLIDAY_SHEET = '休業日';
const HOLIDAY_TAG = '[SAMURAI_HOLIDAY]'; // この機能が作ったイベントの目印（説明文に埋める）

const HOLIDAY_COL = {
  DATE:   1,  // 日付 YYYY-MM-DD
  REASON: 2,  // 理由（タイトルに使う）
  ENABLED:3,  // 有効（チェックボックス）
  STATUS: 4   // 状態（反映済み/未反映/エラー）— 自動更新
};

// =====================================================
//  セットアップ
// =====================================================

/**
 * 休業日機能のセットアップ（1回だけ実行）
 *   - 「休業日」シート生成
 *   - onOpen メニュー登録
 */
function setupHolidays() {
  ensureHolidaySheet_();
  setupHolidayMenu_();
  Logger.log('✅ 休業日機能 セットアップ完了');
  Logger.log('  - 「' + HOLIDAY_SHEET + '」シート 準備OK');
  Logger.log('  - メニュー「🏖 休業日」登録（シートを開き直してください）');
}

function setupHolidayMenu_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'holidayOnOpen_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('holidayOnOpen_').forSpreadsheet(ss).onOpen().create();
  try { holidayOnOpen_(); } catch (e) { Logger.log('⚠️ onOpen 即時実行: ' + e); }
}

function holidayOnOpen_() {
  SpreadsheetApp.getUi().createMenu('🏖 休業日')
    .addItem('📅 カレンダーに反映（予約をブロック）', 'syncHolidaysToCalendar')
    .addItem('👁 反映状況を確認', 'checkHolidayStatus')
    .addSeparator()
    .addItem('🔧 シート再生成（壊した時の復旧）', 'setupHolidays')
    .addToUi();
}

/**
 * 「休業日」シートを用意（冪等・ヘッダーとチェックボックス）
 */
function ensureHolidaySheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(HOLIDAY_SHEET);
  if (sh) { applyHolidayValidations_(sh); return sh; }

  sh = ss.insertSheet(HOLIDAY_SHEET);
  const headers = ['日付(YYYY-MM-DD)', '理由', '有効', '状態'];
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  sh.getRange('A2').setValue('（休業日を1行ずつ。日付・理由を書き、有効=☑。メニュー「🏖 休業日→カレンダーに反映」で予約ブロック）')
    .setFontColor('#999').setFontStyle('italic');
  const widths = [160, 280, 60, 200];
  widths.forEach(function(w, i) { sh.setColumnWidth(i + 1, w); });
  applyHolidayValidations_(sh);
  return sh;
}

function applyHolidayValidations_(sh) {
  const n = 500 - 3 + 1;
  sh.getRange(3, HOLIDAY_COL.ENABLED, n, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
}

// =====================================================
//  同期（シート → カレンダー）
// =====================================================

/**
 * 「休業日」シートの内容を予約カレンダーに反映する（メニューから実行）
 *   - 有効=☑ の日 → 終日イベントが無ければ作成
 *   - 有効=☐ / 行から消えた日 → 本機能が作った終日イベントを削除
 */
function syncHolidaysToCalendar() {
  const ui = SpreadsheetApp.getUi();
  const cfg = getConfig();
  const calId = cfg.bookingCalendarId;
  if (!calId) { ui.alert('❌ BOOKING_CALENDAR_ID 未設定'); return; }
  const calendar = CalendarApp.getCalendarById(calId);
  if (!calendar) {
    ui.alert('❌ 予約カレンダーにアクセスできません',
      'カレンダーID: ' + calId + '\nGAS実行アカウントに編集権限があるか確認してください。', ui.ButtonSet.OK);
    return;
  }

  const sh = ensureHolidaySheet_();
  const lastRow = sh.getLastRow();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';

  // シートから「有効な休業日」を集める
  const wanted = {}; // dateStr -> reason
  if (lastRow >= 3) {
    const data = sh.getRange(3, 1, lastRow - 2, HOLIDAY_COL.STATUS).getValues();
    for (let i = 0; i < data.length; i++) {
      const dateStr = holidayNormalizeDate_(data[i][HOLIDAY_COL.DATE - 1], tz);
      if (!dateStr) continue;
      const enabled = (data[i][HOLIDAY_COL.ENABLED - 1] === true ||
                       String(data[i][HOLIDAY_COL.ENABLED - 1]).toUpperCase() === 'TRUE');
      if (!enabled) continue;
      wanted[dateStr] = String(data[i][HOLIDAY_COL.REASON - 1] || '休業');
    }
  }

  let created = 0, deleted = 0, kept = 0;

  // ── 1. 有効な日 → イベントが無ければ作成 ──
  Object.keys(wanted).forEach(function(dateStr) {
    if (hasHolidayEvent_(calendar, dateStr, tz)) { kept++; return; }
    const day = holidayParseDate_(dateStr, tz);
    const title = '🚫 休業（' + wanted[dateStr] + '）';
    const ev = calendar.createAllDayEvent(title, day);
    ev.setDescription(HOLIDAY_TAG + ' 自動作成。Samurai Motors 休業日。理由: ' + wanted[dateStr]);
    created++;
  });

  // ── 2. 本機能が過去に作ったイベントのうち、もう wanted に無い日 → 削除 ──
  //    （有効を外した / 行を消した 休業日を取り消す）。範囲は今日〜90日先。
  const today = new Date();
  const horizon = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
  const evs = calendar.getEvents(today, horizon);
  evs.forEach(function(ev) {
    let desc = '';
    try { desc = ev.getDescription() || ''; } catch (e) {}
    if (desc.indexOf(HOLIDAY_TAG) < 0) return; // 本機能が作ったものだけ対象
    let evDate = '';
    try { evDate = Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd'); } catch (e) { return; }
    if (!wanted[evDate]) {
      try { ev.deleteEvent(); deleted++; } catch (e) { Logger.log('⚠️ 削除失敗 ' + evDate + ': ' + e); }
    }
  });

  // ── 3. シートの状態列を更新 ──
  if (lastRow >= 3) {
    const data = sh.getRange(3, 1, lastRow - 2, HOLIDAY_COL.STATUS).getValues();
    for (let i = 0; i < data.length; i++) {
      const dateStr = holidayNormalizeDate_(data[i][HOLIDAY_COL.DATE - 1], tz);
      if (!dateStr) continue;
      const enabled = (data[i][HOLIDAY_COL.ENABLED - 1] === true ||
                       String(data[i][HOLIDAY_COL.ENABLED - 1]).toUpperCase() === 'TRUE');
      sh.getRange(i + 3, HOLIDAY_COL.STATUS).setValue(enabled ? '✅ 反映済み（予約ブロック中）' : '⏸ 無効');
    }
  }

  ui.alert('🏖 休業日 反映完了',
    '✅ 新規ブロック: ' + created + ' 日\n' +
    '🔄 既存維持: ' + kept + ' 日\n' +
    '🗑 ブロック解除: ' + deleted + ' 日\n\n' +
    '予約ミニアプリで該当日が「予約不可」になります。',
    ui.ButtonSet.OK);
}

/**
 * 反映状況を確認（カレンダー側の実態を読む）
 */
function checkHolidayStatus() {
  const ui = SpreadsheetApp.getUi();
  const cfg = getConfig();
  const calendar = CalendarApp.getCalendarById(cfg.bookingCalendarId);
  if (!calendar) { ui.alert('❌ 予約カレンダーにアクセスできません'); return; }
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
  const today = new Date();
  const horizon = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
  const evs = calendar.getEvents(today, horizon);
  const list = [];
  evs.forEach(function(ev) {
    let desc = '';
    try { desc = ev.getDescription() || ''; } catch (e) {}
    if (desc.indexOf(HOLIDAY_TAG) < 0) return;
    try {
      list.push(Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd') + ' ' + ev.getTitle());
    } catch (e) {}
  });
  list.sort();
  ui.alert('🏖 現在ブロック中の休業日（今日〜90日）',
    list.length ? list.join('\n') : '（ブロック中の休業日はありません）',
    ui.ButtonSet.OK);
}

// =====================================================
//  ヘルパー
// =====================================================

/** 指定日に本機能の終日休業イベントが既にあるか */
function hasHolidayEvent_(calendar, dateStr, tz) {
  const day = holidayParseDate_(dateStr, tz);
  const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  const evs = calendar.getEvents(day, next);
  for (let i = 0; i < evs.length; i++) {
    let desc = '';
    try { desc = evs[i].getDescription() || ''; } catch (e) {}
    if (desc.indexOf(HOLIDAY_TAG) >= 0) {
      // 同じ日付の終日イベントか確認
      try {
        if (Utilities.formatDate(evs[i].getAllDayStartDate(), tz, 'yyyy-MM-dd') === dateStr) return true;
      } catch (e) {}
    }
  }
  return false;
}

/** 'yyyy-MM-dd' を Phnom Penh ローカルの Date(終日用・00:00)に変換 */
function holidayParseDate_(dateStr, tz) {
  // createAllDayEvent は Date を見て日付部分のみ使うため、TZ ずれ防止に正午で作る
  return new Date(dateStr + 'T12:00:00+07:00');
}

/** 日付セルを 'yyyy-MM-dd' に正規化（Date型・文字列の両対応）。失敗時 '' */
function holidayNormalizeDate_(v, tz) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return '';
  const mo = m[2].length === 1 ? '0' + m[2] : m[2];
  const d = m[3].length === 1 ? '0' + m[3] : m[3];
  return m[1] + '-' + mo + '-' + d;
}
