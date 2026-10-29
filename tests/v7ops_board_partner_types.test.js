/**
 * v7-operations: 営業ボード「📘 提携の型」タブ（2026-10-29 ScoutBoardPartnerTypes.gs）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *   Daisuke「GSS にわかりやすく型もわかりやすく把握できるようにいれといて」「このGSSにいれてほしい」
 *   - 初めての時は 🔗 タブのすぐ右に作る・中身を変えた時（版を上げた時）だけ書き直す
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function fakeBoard(existing) {
  const sheets = existing.map((n, i) => ({ name: n, index: i + 1 }));
  const log = { inserted: [], values: null, cleared: 0 };
  const range = () => new Proxy({}, { get: (t, k) => (k === 'setValues' ? (v) => { log.values = v; return range(); } : () => range()) });
  const sheetObj = (s) => ({ getIndex: () => s.index, getFilter: () => null, clear: () => { log.cleared++; },
    getRange: range, setColumnWidth: () => {}, setFrozenRows: () => {} });
  return { log, board: {
    getSheetByName: (n) => { const s = sheets.find((x) => x.name === n); return s ? sheetObj(s) : null; },
    insertSheet: (n, idx) => { log.inserted.push([n, idx]); const s = { name: n, index: (idx || sheets.length) + 1 }; sheets.push(s); return sheetObj(s); }
  } };
}

function load(props) {
  const ctx = { console, Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    SpreadsheetApp: { WrapStrategy: { WRAP: 'WRAP', OVERFLOW: 'OVERFLOW', CLIP: 'CLIP' } } };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(ROOT, 'v7-operations', 'ScoutBoard.gs'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'ScoutBoard.gs' });
  vm.runInContext("var SCOUT_LINKS_TAB_KEY = 'links';", ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7-operations', 'ScoutBoardPartnerTypes.gs'), 'utf8'), ctx, { filename: 'ScoutBoardPartnerTypes.gs' });
  return ctx;
}

test('初めて: 🔗 タブのすぐ右に「📘 提携の型」を作り、型の選び方・違い・共通を書く', () => {
  const props = {};
  const ctx = load(props);
  const { board, log } = fakeBoard(['📅 今日', '🔗 提携店QR・グループ連携', '🙋 個人提携']);
  ctx.scoutBoardWritePartnerTypes_(board);
  assert.deepEqual(log.inserted, [['📘 提携の型', 2]]);
  const text = log.values.map((r) => r.join('|')).join('\n');
  assert.ok(log.values.every((r) => r.length === 5));
  ['① 型の選び方', '② 4つの型の違い', '③ どの型でも共通', 'motors-restaurant-partner', 'お客様が払う先', 'City Golf'].forEach((w) => assert.ok(text.includes(w), w));
  assert.ok(!/\b\d{6}\b/.test(text));   // 6桁の連携コードを書かない
  assert.equal(props.SCOUT_BOARD_TYPES_VERSION, vm.runInContext('SCOUT_TYPES_VERSION', ctx));
});

test('2回目から: 版が同じなら書き直さない（毎時の更新を重くしない）・版が変われば書き直す', () => {
  const props = {};
  const ctx = load(props);
  const { board, log } = fakeBoard(['🔗 提携店QR・グループ連携']);
  ctx.scoutBoardWritePartnerTypes_(board);
  assert.equal(log.cleared, 1);
  ctx.scoutBoardWritePartnerTypes_(board);
  assert.equal(log.cleared, 1);
  props.SCOUT_BOARD_TYPES_VERSION = 'old';
  ctx.scoutBoardWritePartnerTypes_(board);
  assert.equal(log.cleared, 2);
  assert.equal(log.inserted.length, 1);
});
