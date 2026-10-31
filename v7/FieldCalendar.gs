/**
 * FieldCalendar.gs — 予約カレンダーに手で入れた予定を現場アプリの「今日・明日」に出す（2026-10-31 Daisuke）
 *
 * 背景: 現場アプリは予約タブだけを読むので、Daisuke がカレンダーに直接入れた予定
 *       （例: 11/1「ピカソで車を磨く予定」）が Run Kosal の画面に出なかった。
 * - 予約システムが作った予定（説明に「予約ID:」・予約タブのカレンダーID）と休業日（HOLIDAY_TAG）は除く
 * - 見るだけ。返すのはタイトル・時刻・場所だけ（説明文は返さない＝メモの個人情報を広げない）
 * - 読めない時は空で返す（予約一覧は今までどおり出す）
 */

var FIELD_CAL_MAX_ = 20;        // 1回に返す最大件数（今日＋明日）
var FIELD_CAL_TITLE_MAX_ = 100; // タイトルの最大文字数
var FIELD_CAL_PLACE_MAX_ = 200; // 場所の最大文字数

/**
 * 今日・明日の「手で入れた予定」を返す
 * @param {string} todayStr    'yyyy-MM-dd'（カンボジア時間）
 * @param {string} tomorrowStr 'yyyy-MM-dd'
 * @param {string} tz          表示に使うタイムゾーン
 * @param {Object} knownIds    予約タブにあるカレンダーID の集合（{ id: true }）
 * @return {Array<{id,date,startTime,endTime,allDay,title,location}>}
 */
function fieldCalendarNotes_(todayStr, tomorrowStr, tz, knownIds) {
  try {
    var cfg = getConfig();
    if (!cfg.bookingCalendarId) return [];
    var cal = CalendarApp.getCalendarById(cfg.bookingCalendarId);
    if (!cal) return [];
    var days = [todayStr, tomorrowStr].map(function(d) {
      var s = parseDateTimePhnomPenh(d, 0, 0);
      return { date: d, start: s, end: new Date(s.getTime() + 24 * 60 * 60 * 1000) };
    });
    var events = cal.getEvents(days[0].start, days[1].end);
    var out = [];
    events.forEach(function(ev) {
      if (!fieldCalIsManual_(ev, knownIds || {})) return;
      var allDay = false;
      try { allDay = ev.isAllDayEvent(); } catch (e) { /* 取れなければ時刻つきとして扱う */ }
      var evStart = ev.getStartTime(), evEnd = ev.getEndTime();
      days.forEach(function(d) {
        // 何日かにまたがる予定は、かかっている日ごとに1行
        if (!(evStart < d.end && evEnd > d.start)) return;
        out.push({
          id: 'CAL-' + ev.getId() + '-' + d.date,
          date: d.date,
          startTime: (!allDay && evStart >= d.start) ? Utilities.formatDate(evStart, tz, 'HH:mm') : '',
          endTime: (!allDay && evEnd <= d.end) ? Utilities.formatDate(evEnd, tz, 'HH:mm') : '',
          allDay: allDay || (evStart <= d.start && evEnd >= d.end),
          title: fieldCalText_(ev.getTitle(), FIELD_CAL_TITLE_MAX_),
          location: fieldCalText_(ev.getLocation(), FIELD_CAL_PLACE_MAX_)
        });
      });
    });
    out.sort(function(a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.startTime || '') < (b.startTime || '') ? -1 : 1;
    });
    return out.slice(0, FIELD_CAL_MAX_);
  } catch (err) {
    Logger.log('⚠️ fieldCalendarNotes_ 失敗（予約一覧は継続）: ' + err);
    return [];
  }
}

/** 手で入れた予定か（予約システム・休業日の自動予定は false） */
function fieldCalIsManual_(ev, knownIds) {
  var id = '';
  try { id = String(ev.getId() || ''); } catch (e) { return false; }
  if (!id || knownIds[id]) return false;
  var desc = '';
  try { desc = String(ev.getDescription() || ''); } catch (e) { desc = ''; }
  if (desc.indexOf('予約ID:') >= 0) return false;   // createBooking / createManualBooking が作る予定
  if (typeof HOLIDAY_TAG !== 'undefined' && desc.indexOf(HOLIDAY_TAG) >= 0) return false;
  return true;
}

/** 1行の文字にそろえる（改行・制御文字は空白・長すぎる分は切る。絵文字の途中で切らない） */
function fieldCalText_(s, max) {
  var t = String(s || '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  var chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join('') : t;
}
