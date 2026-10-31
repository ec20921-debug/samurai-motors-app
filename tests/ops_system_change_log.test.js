/**
 * v7-operations: 日報の「🛠 本日のシステム変更」（SystemChangeLog.gs・2026-10-31）
 *
 * 実行: node --test "tests/*.test.js"
 *
 *   - 「システム変更」タブの当日分だけを時刻順に、絵文字＋ひとこと（対象）で出す
 *   - 日付・時刻は Date でも文字でも読める（シートが自動で日付に変えても同じ結果）
 *   - 最大行数を超えたら「…他N件」。ゼロ件・読めない時は空文字（日報は止めない）
 *   - タブが無ければヘッダー付きで作る
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPS = path.join(__dirname, '..', 'v7-operations');

function pad(n) { return (n < 10 ? '0' : '') + n; }

function makeCtx(opts) {
  opts = Object.assign({ rows: [], noSheet: false, sheetThrow: false }, opts || {});
  const created = [];
  const sheet = { getDataRange: () => ({ getValues: () => { if (opts.sheetThrow) throw new Error('unavailable'); return [['日付', '時刻', '絵文字', 'ひとこと', '対象', '記録者', '補足（内部）']].concat(opts.rows); } }) };
  const ctx = {
    console,
    Logger: { log: () => {} },
    OPS_TZ: 'Asia/Phnom_Penh',
    // Date は UTC 扱いのまま yyyy-MM-dd / HH:mm に（テスト用の簡略版）
    Utilities: { formatDate: (d, tz, fmt) => (fmt === 'HH:mm' ? pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) : d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate())) },
    getOpsSs_: () => ({ getSheetByName: (name) => (name === 'システム変更' && !opts.noSheet ? sheet : null) }),
    createHeaderedSheet_: (ss, name, headers) => { created.push({ name, headers }); return sheet; },
    readSheetObjects_: (sh) => {
      const all = sh.getDataRange().getValues();
      const headers = all[0];
      return all.slice(1).map((row, i) => { const obj = {}; headers.forEach((h, j) => { obj[h] = row[j]; }); return { row: i + 2, obj }; });
    },
    escapeHtml_: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(OPS, 'SystemChangeLog.gs'), 'utf8'), ctx, { filename: 'SystemChangeLog.gs' });
  return { ctx, created };
}

const D = '2026-10-31';

test('当日分だけを時刻順に、絵文字＋ひとこと（対象）で出す。前日・翌日は出さない', () => {
  const { ctx } = makeCtx({ rows: [
    [D, '17:40', '🌙', '日報の在庫の通知を止めました', '日報', 'Claude', 'ops'],
    ['2026-10-30', '10:00', '🧾', '前日の変更', '', 'Claude', ''],
    [D, '08:13', '🧾', '作業記録に名前が入ります', '現場アプリ', 'Claude', 'v7 @106'],
    ['2026-11-01', '09:00', '📅', '翌日の変更', '', 'Claude', ''],
    [D, '12:00', '', '', '', '', ''] // ひとことが空の行は無視
  ] });
  assert.equal(ctx.buildSystemChangesSection_(D),
    '🛠 <b>本日のシステム変更</b>（2件）\n　🧾 作業記録に名前が入ります（現場アプリ）\n　🌙 日報の在庫の通知を止めました（日報）');
});

test('日付・時刻が Date（シートが自動で変えた）でも同じに読める。絵文字が空なら「・」', () => {
  const { ctx } = makeCtx({ rows: [
    [new Date(Date.UTC(2026, 9, 31)), new Date(Date.UTC(1899, 11, 30, 9, 5)), '', 'Date のまま入った行 <b>', '', '', '']
  ] });
  assert.equal(ctx.buildSystemChangesSection_(D), '🛠 <b>本日のシステム変更</b>（1件）\n　・ Date のまま入った行 &lt;b&gt;');
  assert.equal(ctx.readSystemChangesForDate_(D)[0].time, '09:05');
});

test('最大行数を超えたら「…他N件」', () => {
  const rows = [];
  for (let i = 0; i < 11; i++) rows.push([D, '10:' + pad(i), '🔧', '変更 ' + i, '', 'Claude', '']);
  const { ctx } = makeCtx({ rows });
  const out = ctx.buildSystemChangesSection_(D);
  assert.match(out, /（11件）/);
  assert.equal(out.split('\n').length, 1 + 8 + 1);
  assert.match(out, /…他 3 件（シート「システム変更」）$/);
});

test('ゼロ件・読めない時は空文字（日報は止めない）', () => {
  assert.equal(makeCtx().ctx.buildSystemChangesSection_(D), '');
  assert.equal(makeCtx({ sheetThrow: true }).ctx.buildSystemChangesSection_(D), '');
  assert.throws(() => makeCtx({ sheetThrow: true }).ctx.readSystemChangesForDate_(D)); // 更新判定は読めない＝送る側に倒す
});

test('タブが無ければヘッダー付きで作る', () => {
  const { ctx, created } = makeCtx({ noSheet: true });
  ctx.getSystemChangeSheet_();
  assert.deepEqual(JSON.parse(JSON.stringify(created)), [{ name: 'システム変更', headers: ['日付', '時刻', '絵文字', 'ひとこと', '対象', '記録者', '補足（内部）'] }]);
});
