/**
 * v7: カレンダーに手で入れた予定を現場アプリの今日・明日に出す（2026-10-31）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * v7 の実ファイル（.gs）を Node の vm に読み込み、カレンダー・シートはスタブで置き換える（本番には触れない）。
 *   - fieldCalendarNotes_: 手で入れた予定だけ返す（予約が作った予定・休業日は除く）・時刻・終日・日またぎ・文字の整理
 *   - apiBookingToday: 予約タブのカレンダーID を渡し、calendar を返す（部品が無い・読めない時は空）
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');
const pad = (n) => String(n).padStart(2, '0');

function load(files, extra) {
  const ctx = Object.assign({ console, Logger: { log: () => {} } }, extra || {});
  vm.createContext(ctx);
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(V7, f), 'utf8'), ctx, { filename: f }));
  return ctx;
}

// カンボジア時間（UTC+7）で書式化する Utilities.formatDate の代わり
const Utilities = {
  formatDate: (d, tz, fmt) => {
    const p = new Date(d.getTime() + (tz === 'Asia/Tokyo' ? 9 : 7) * 3600e3);
    if (fmt === 'HH:mm') return pad(p.getUTCHours()) + ':' + pad(p.getUTCMinutes());
    return p.getUTCFullYear() + '-' + pad(p.getUTCMonth() + 1) + '-' + pad(p.getUTCDate());
  }
};
// 'YYYY-MM-DD HH:mm'（カンボジア時間）→ Date
const pp = (s) => { const [d, t] = s.split(' '); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = (t || '0:0').split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, dd, h - 7, mi)); };

function ev(o) {
  return {
    getId: () => o.id, getTitle: () => o.title || '', getLocation: () => o.location || '',
    getDescription: () => o.desc || '', getStartTime: () => pp(o.start), getEndTime: () => pp(o.end),
    isAllDayEvent: () => !!o.allDay,
    getAllDayStartDate: () => (o.adStart ? new Date(o.adStart) : pp(o.start)),
    getAllDayEndDate: () => (o.adEnd ? new Date(o.adEnd) : pp(o.end))
  };
}
function loadCal(events, opts) {
  opts = opts || {};
  const calendar = {
    getEvents: (s, e) => {
      if (opts.throws) throw new Error('Calendar down');
      return events.filter((x) => x.getStartTime() < e && x.getEndTime() > s);
    }
  };
  return load(['BookingLogic.gs', 'FieldCalendar.gs'], {
    Utilities,
    Session: opts.scriptTz ? { getScriptTimeZone: () => opts.scriptTz } : undefined,
    HOLIDAY_TAG: '[SAMURAI_HOLIDAY]',
    getConfig: () => ({ bookingCalendarId: opts.noId ? '' : 'cal@x' }),
    CalendarApp: { getCalendarById: () => (opts.noCal ? null : calendar) }
  });
}
const TODAY = '2026-11-01', TOM = '2026-11-02';

test('手で入れた予定: 明日 9:30〜17:30 の予定が時刻つきで出る', () => {
  const ctx = loadCal([ev({ id: 'm1', title: 'ピカソで車を磨く予定があります、', start: '2026-11-02 09:30', end: '2026-11-02 17:30' })]);
  const out = ctx.fieldCalendarNotes_(TODAY, TOM, 'Asia/Phnom_Penh', {});
  assert.equal(out.length, 1);
  assert.equal(out[0].date, TOM);
  assert.equal(out[0].startTime, '09:30');
  assert.equal(out[0].endTime, '17:30');
  assert.equal(out[0].allDay, false);
  assert.equal(out[0].title, 'ピカソで車を磨く予定があります、');
  assert.equal(out[0].id, 'CAL-m1-' + TOM);
  assert.equal('description' in out[0], false, '説明文は返さない');
});

test('手で入れた予定: 予約が作った予定・予約タブにある予定・休業日は出さない', () => {
  const ctx = loadCal([
    ev({ id: 'b1', title: 'WASH / Test', desc: '予約ID: BK-20261101-001\n料金: $12', start: '2026-11-01 10:00', end: '2026-11-01 11:00' }),
    ev({ id: 'b2', title: '【特価】x', desc: '（説明を手で消した予約の予定）', start: '2026-11-01 12:00', end: '2026-11-01 13:00' }),
    ev({ id: 'h1', title: '🚫 休業（Water Festival）', desc: '[SAMURAI_HOLIDAY] 自動作成', allDay: true, start: '2026-11-02 00:00', end: '2026-11-03 00:00' }),
    ev({ id: 'm1', title: '手入れ', start: '2026-11-01 15:00', end: '2026-11-01 16:00' })
  ]);
  const out = ctx.fieldCalendarNotes_(TODAY, TOM, 'Asia/Phnom_Penh', { b2: true });
  assert.deepEqual(Array.from(out, (n) => n.title), ['手入れ']);
});

test('手で入れた予定: 終日の予定は時刻なし・allDay', () => {
  const ctx = loadCal([ev({ id: 'a1', title: 'Picasso 終日', allDay: true, start: '2026-11-01 00:00', end: '2026-11-02 00:00' })]);
  const out = ctx.fieldCalendarNotes_(TODAY, TOM, 'Asia/Phnom_Penh', {});
  assert.equal(out.length, 1);
  assert.equal(out[0].date, TODAY);
  assert.equal(out[0].allDay, true);
  assert.equal(out[0].startTime, '');
  assert.equal(out[0].endTime, '');
});

test('手で入れた予定: 終日の予定の開始が日本時間 0:00 で返っても前の日に出ない（スクリプトは日本時間）', () => {
  // 11/2 の終日予定。開始 = 日本の 11/2 0:00（= カンボジアの 11/1 22:00）、終了 = 日本の 11/3 0:00
  const ctx = loadCal([ev({ id: 'j1', title: '終日（日本時間）', allDay: true, start: '2026-11-01 22:00', end: '2026-11-02 22:00',
    adStart: Date.UTC(2026, 10, 1, 15), adEnd: Date.UTC(2026, 10, 2, 15) })], { scriptTz: 'Asia/Tokyo' });
  const out = ctx.fieldCalendarNotes_(TODAY, TOM, 'Asia/Phnom_Penh', {});
  assert.deepEqual(Array.from(out, (n) => n.date), [TOM]);
  assert.equal(out[0].allDay, true);
});

test('手で入れた予定: 非公開の予定は出さない', () => {
  const ctx = loadCal([ev({ id: 'p1', title: '私用', start: '2026-11-01 10:00', end: '2026-11-01 11:00' })]);
  ctx.CalendarApp.Visibility = { PRIVATE: 'PRIVATE' };
  const evs = [ev({ id: 'p1', title: '私用', start: '2026-11-01 10:00', end: '2026-11-01 11:00' }), ev({ id: 'p2', title: '公開', start: '2026-11-01 12:00', end: '2026-11-01 13:00' })];
  evs[0].getVisibility = () => 'PRIVATE';
  evs[1].getVisibility = () => 'DEFAULT';
  ctx.CalendarApp.getCalendarById = () => ({ getEvents: () => evs });
  assert.deepEqual(Array.from(ctx.fieldCalendarNotes_(TODAY, TOM, 'Asia/Phnom_Penh', {}), (n) => n.title), ['公開']);
});

test('手で入れた予定: 日をまたぐ予定は今日・明日それぞれに出る（始まり・終わりの時刻はその日だけ）', () => {
  const ctx = loadCal([ev({ id: 'x1', title: '2日がかり', start: '2026-11-01 14:00', end: '2026-11-02 11:00' })]);
  const out = ctx.fieldCalendarNotes_(TODAY, TOM, 'Asia/Phnom_Penh', {});
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].date, out[0].startTime, out[0].endTime], [TODAY, '14:00', '']);
  assert.deepEqual([out[1].date, out[1].startTime, out[1].endTime], [TOM, '', '11:00']);
  assert.notEqual(out[0].id, out[1].id, '行ごとに別の id');
});

test('手で入れた予定: 時刻順・今日が先', () => {
  const ctx = loadCal([
    ev({ id: 'c', title: 'C', start: '2026-11-02 08:00', end: '2026-11-02 09:00' }),
    ev({ id: 'b', title: 'B', start: '2026-11-01 16:00', end: '2026-11-01 17:00' }),
    ev({ id: 'a', title: 'A', start: '2026-11-01 09:00', end: '2026-11-01 10:00' })
  ]);
  assert.deepEqual(Array.from(ctx.fieldCalendarNotes_(TODAY, TOM, 'Asia/Phnom_Penh', {}), (n) => n.title), ['A', 'B', 'C']);
});

test('手で入れた予定: タイトル・場所は1行にそろえて長さを切る（絵文字の途中で切らない）', () => {
  const ctx = loadCal([ev({ id: 't', title: '1行目\n2行目\t\u202e右から', location: '🚗'.repeat(250), start: '2026-11-01 09:00', end: '2026-11-01 10:00' }),
    ev({ id: 'u', title: 'x'.repeat(300), start: '2026-11-01 11:00', end: '2026-11-01 12:00' })]);
  const out = ctx.fieldCalendarNotes_(TODAY, TOM, 'Asia/Phnom_Penh', {});
  assert.equal(out[0].title, '1行目 2行目 右から');
  assert.equal(Array.from(out[0].location).length, 200);
  assert.ok(!/[\ud800-\udbff]$/.test(out[0].location));
  assert.equal(out[1].title.length, 100);
});

test('手で入れた予定: カレンダーが読めない・設定が無い時は空（落ちない）', () => {
  assert.deepEqual(Array.from(loadCal([], { throws: true }).fieldCalendarNotes_(TODAY, TOM, 'Asia/Phnom_Penh', {})), []);
  assert.deepEqual(Array.from(loadCal([], { noCal: true }).fieldCalendarNotes_(TODAY, TOM, 'Asia/Phnom_Penh', {})), []);
  assert.deepEqual(Array.from(loadCal([], { noId: true }).fieldCalendarNotes_(TODAY, TOM, 'Asia/Phnom_Penh', {})), []);
});

// ── apiBookingToday との結合 ──
function loadJobs(headers, rows, extra) {
  const map = {}; headers.forEach((h, i) => { map[h] = i + 1; });
  const sheet = { getLastRow: () => rows.length + 1, getLastColumn: () => headers.length,
    getRange: () => ({ getValues: () => rows.map((r) => headers.map((h) => (h in r ? r[h] : ''))) }) };
  return load(['JobManager.gs'], Object.assign({
    SHEET_NAMES: { BOOKINGS: '予約', JOBS: '作業記録' },
    getSheet: () => sheet,
    getHeaderMap: () => map,
    getSpreadsheet: () => ({ getSpreadsheetTimeZone: () => 'Asia/Phnom_Penh' }),
    Utilities,
    findCustomerRow: () => ({ data: { '氏名': 'Test Customer' } }),
    calcEndTime: () => '11:30'
  }, extra || {}));
}
const todayPP = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const HEAD = ['予約ID', 'チャットID', '予約日', '予約時刻', '進行状態', 'カレンダーID'];

test('予約一覧: 予約タブのカレンダーID（キャンセル・他の日も）を渡し、calendar を返す', () => {
  let got = null;
  const ctx = loadJobs(HEAD, [
    { '予約ID': 'BK-1', 'チャットID': '1', '予約日': todayPP(), '予約時刻': '10:00', '進行状態': '予約確定', 'カレンダーID': 'ev-today@google.com' },
    { '予約ID': 'BK-0', 'チャットID': '1', '予約日': '2026-01-01', '予約時刻': '10:00', '進行状態': 'キャンセル', 'カレンダーID': 'ev-old@google.com' }
  ], { fieldCalendarNotes_: (a, b, tz, ids) => { got = ids; return [{ id: 'CAL-x', date: a, title: 'メモ' }]; } });
  const res = ctx.apiBookingToday();
  assert.equal(res.status, 'ok');
  assert.equal(res.bookings.length, 1);
  assert.deepEqual(Object.keys(got).sort(), ['ev-old@google.com', 'ev-today@google.com']);
  assert.equal(res.calendar.length, 1);
  assert.equal(res.calendar[0].title, 'メモ');
});

test('予約一覧: カレンダーの部品が無い（古い本番）時も calendar は空で予約は返る', () => {
  const ctx = loadJobs(HEAD, [{ '予約ID': 'BK-1', 'チャットID': '1', '予約日': todayPP(), '予約時刻': '10:00', '進行状態': '予約確定' }]);
  const res = ctx.apiBookingToday();
  assert.equal(res.status, 'ok');
  assert.equal(res.bookings.length, 1);
  assert.deepEqual(Array.from(res.calendar), []);
});
