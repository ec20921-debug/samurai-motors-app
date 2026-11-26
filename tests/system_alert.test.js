/**
 * システムの異常を管理グループへ知らせる部品（SystemAlert.gs・2026-11-26）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * 実ファイル（.gs）を Node の vm に読み込み、Cache・Telegram・カレンダー・シートはスタブで置き換える（本番には触れない）。
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function makeCache() {
  const m = new Map();
  return {
    m,
    get: (k) => (m.has(k) ? m.get(k) : null),
    put: (k, v) => { m.set(k, v); },
    remove: (k) => { m.delete(k); }
  };
}

function load(dir, files, extra) {
  const cache = makeCache();
  const sent = [];
  const ctx = Object.assign({
    console,
    Logger: { log: () => {} },
    CacheService: { getScriptCache: () => cache },
    BOT_TYPE: { BOOKING: 'booking', FIELD: 'field' },
    STORAGE_KEYS: { QUEUE_PREFIX: 'queue_' },
    getConfig: () => ({ adminGroupId: '-100', bookingCalendarId: 'cal@x', spreadsheetId: 'sheet1' }),
    sendMessage: (bot, chatId, text) => { sent.push({ bot, chatId, text }); return { ok: true }; }
  }, extra || {});
  vm.createContext(ctx);
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, dir, f), 'utf8'), ctx, { filename: f }));
  return { ctx, cache, sent };
}

test('v7 と v7-operations の SystemAlert.gs は同じ内容', () => {
  const a = fs.readFileSync(path.join(ROOT, 'v7', 'SystemAlert.gs'), 'utf8');
  const b = fs.readFileSync(path.join(ROOT, 'v7-operations', 'SystemAlert.gs'), 'utf8');
  assert.equal(a, b);
});

test('systemAlert_: 管理グループへ日本語で1通・同じ異常は間引く', () => {
  const { ctx, sent } = load('v7', ['SystemAlert.gs']);
  assert.equal(ctx.systemAlert_('x', 'タイトル', '中身', '対処'), true);
  assert.equal(ctx.systemAlert_('x', 'タイトル', '中身', '対処'), false);
  assert.equal(ctx.systemAlert_('y', '別の異常', '', ''), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].bot, 'booking');
  assert.equal(sent[0].chatId, '-100');
  assert.match(sent[0].text, /システムの異常を検知しました/);
  assert.match(sent[0].text, /タイトル/);
  assert.match(sent[0].text, /対処: 対処/);
});

test('systemAlert_: 送れなかった時は次の機会にもう一度送る', () => {
  let ok = false;
  const sent = [];
  const { ctx } = load('v7', ['SystemAlert.gs'], {
    sendMessage: (b, c, t) => { sent.push(t); return { ok }; }
  });
  assert.equal(ctx.systemAlert_('x', 't', 'd', ''), false);
  ok = true;
  assert.equal(ctx.systemAlert_('x', 't', 'd', ''), true);
  assert.equal(sent.length, 2);
});

test('systemAlert_: 例外を外へ出さない（設定が読めない・送信が落ちる）', () => {
  const a = load('v7', ['SystemAlert.gs'], { getConfig: () => { throw new Error('no config'); } });
  assert.equal(a.ctx.systemAlert_('x', 't', 'd', ''), false);
  const b = load('v7', ['SystemAlert.gs'], { sendMessage: () => { throw new Error('boom'); } });
  assert.equal(b.ctx.systemAlert_('x', 't', 'd', ''), false);
  const c = load('v7', ['SystemAlert.gs'], { CacheService: { getScriptCache: () => { throw new Error('cache down'); } } });
  assert.equal(c.ctx.systemAlert_('x', 't', 'd', ''), false);
});

test('Bot のトークン・合言葉は通知に出さない', () => {
  const { ctx, sent } = load('v7', ['SystemAlert.gs']);
  const token = '1234567890:AAHabcdefghijklmnopqrstuvwxyz0123456';
  ctx.systemAlertException_('doPost', 'job_end',
    new Error('Request failed for https://api.telegram.org/bot' + token + '/sendMessage?key=abc123secret returned code 500'));
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].text.includes(token));
  assert.ok(!sent[0].text.includes('AAHabcdef'));
  assert.ok(!sent[0].text.includes('abc123secret'));
  assert.match(sent[0].text, /bot\*\*\*/);
});

test('systemAlertException_: action が無い呼び出しは知らせない・画面の名前を付ける', () => {
  const { ctx, sent } = load('v7', ['SystemAlert.gs']);
  assert.equal(ctx.systemAlertException_('doPost', '', new Error('x')), false);
  assert.equal(sent.length, 0);
  ctx.systemAlertException_('doGet', 'booking_slots_range', new Error('落ちた'));
  ctx.systemAlertException_('doPost', 'job_start', new Error('落ちた'));
  ctx.systemAlertException_('doPost', 'job_start', new Error('落ちた'));   // 間引き
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /予約アプリ（お客さんの画面）でエラーが出ました/);
  assert.match(sent[0].text, /操作: booking_slots_range/);
  assert.match(sent[1].text, /現場アプリ（スタッフの画面）でエラーが出ました/);
});

test('v7-operations では勤務Bot で送る', () => {
  const { ctx, sent } = load('v7-operations', ['SystemAlert.gs'], { BOT_TYPE: { INTERNAL: 'internal' } });
  ctx.systemAlertException_('doPost', 'punch_in', new Error('落ちた'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].bot, 'internal');
  assert.match(sent[0].text, /社内業務/);
});

test('sysHealthQueue_: 件数といちばん古いものの待ち時間', () => {
  const { ctx } = load('v7', ['SystemAlert.gs']);
  const now = 1800000000000;
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.sysHealthQueue_(['other', 'processed_ids_v1'], now))),
    { count: 0, oldestMin: 0, stuck: false });
  const fresh = ctx.sysHealthQueue_(['queue_' + (now - 60000) + '_1'], now);
  assert.equal(fresh.count, 1);
  assert.equal(fresh.stuck, false);
  const old = ctx.sysHealthQueue_(['queue_' + (now - 60000) + '_1', 'queue_' + (now - 15 * 60000) + '_2'], now);
  assert.equal(old.count, 2);
  assert.equal(old.oldestMin, 15);
  assert.equal(old.stuck, true);
});

function healthEnv(state) {
  return {
    CalendarApp: { getCalendarById: () => (state.calendar ? {} : null) },
    SpreadsheetApp: { openById: () => { if (!state.sheet) throw new Error('Service Spreadsheets failed'); return { getId: () => 'sheet1' }; } },
    PropertiesService: { getScriptProperties: () => ({ getKeys: () => state.keys }) },
    ScriptApp: { getProjectTriggers: () => state.triggers.map((n) => ({ getHandlerFunction: () => n })) }
  };
}
const ALL_TRIGGERS = ['pollTelegramUpdates', 'processTelegramQueue', 'checkUnpaidReminders', 'cleanupOldProcessedIds'];

test('見回り: 全部正常なら何も送らない・5分に1回だけ動く', () => {
  const state = { calendar: true, sheet: true, keys: [], triggers: ALL_TRIGGERS };
  const { ctx, sent } = load('v7', ['SystemAlert.gs'], healthEnv(state));
  const r = ctx.systemHealthWatch_();
  assert.equal(Array.from(r, (x) => x.code + ':' + x.ok).join(' '), 'calendar:true sheet:true queue:true triggers:true');
  assert.equal(ctx.systemHealthWatch_(), null);
  assert.equal(sent.length, 0);
});

test('見回り: カレンダーが見つからない → 知らせる → 戻ったら「復旧しました」', () => {
  const state = { calendar: false, sheet: true, keys: [], triggers: ALL_TRIGGERS };
  const { ctx, sent, cache } = load('v7', ['SystemAlert.gs'], healthEnv(state));
  ctx.systemHealthWatch_();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /予約カレンダーが見つかりません/);
  assert.match(sent[0].text, /cal@x/);

  cache.remove('sys_health_at');
  ctx.systemHealthWatch_();            // まだ直っていない → 間引く
  assert.equal(sent.length, 1);

  state.calendar = true;
  cache.remove('sys_health_at');
  ctx.systemHealthWatch_();
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /復旧しました/);
  assert.match(sent[1].text, /予約カレンダーが見えるようになりました/);

  cache.remove('sys_health_at');
  ctx.systemHealthWatch_();            // 復旧の知らせは1回だけ
  assert.equal(sent.length, 2);
});

test('見回り: スプレッドシートは2回続いた時だけ知らせる', () => {
  const state = { calendar: true, sheet: false, keys: [], triggers: ALL_TRIGGERS };
  const { ctx, sent, cache } = load('v7', ['SystemAlert.gs'], healthEnv(state));
  ctx.systemHealthWatch_();
  assert.equal(sent.length, 0);
  cache.remove('sys_health_at');
  ctx.systemHealthWatch_();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /スプレッドシート（v7 Database）が開けません/);
  state.sheet = true;
  cache.remove('sys_health_at');
  ctx.systemHealthWatch_();
  assert.match(sent[1].text, /復旧しました/);
});

test('見回り: キューの滞留とトリガーの欠け', () => {
  const state = {
    calendar: true, sheet: true,
    keys: ['queue_' + (Date.now() - 20 * 60000) + '_9'],
    triggers: ['pollTelegramUpdates', 'processTelegramQueue']
  };
  const { ctx, sent } = load('v7', ['SystemAlert.gs'], healthEnv(state));
  ctx.systemHealthWatch_();
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Bot の返事が止まっています/);
  assert.match(sent[0].text, /1 件/);
  assert.match(sent[1].text, /定期実行（トリガー）が消えています/);
  assert.match(sent[1].text, /checkUnpaidReminders, cleanupOldProcessedIds/);
});

test('予約アプリ: カレンダーが見つからない時、その場で知らせる（BookingLogic.gs getBookingCalendar_）', () => {
  let found = null;
  const { ctx, sent } = load('v7', ['BookingLogic.gs', 'SystemAlert.gs'], {
    CalendarApp: { getCalendarById: () => found }
  });
  assert.equal(ctx.getBookingCalendar_(), null);
  assert.equal(ctx.getBookingCalendar_(), null);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /予約カレンダーが見つかりません/);
  found = { id: 1 };
  assert.deepEqual(ctx.getBookingCalendar_(), { id: 1 });
});
