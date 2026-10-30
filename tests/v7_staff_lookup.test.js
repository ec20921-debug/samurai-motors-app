/**
 * v7: 作業記録の スタッフID・スタッフ名 を送り主から埋める（2026-10-31 StaffLookup.gs）
 *
 * 実行: node --test "tests/*.test.js"
 *
 * .gs を Node の vm に読み込み、シート・キャッシュはスタブで置き換える（本番には触れない）。
 *   - 署名・専用リンクで確かめた送り主（body._authUserId）を、スタッフマスター（有効な行）で スタッフID・氏名(JP) に引き直す
 *   - 特定できない（送り主なし・無効・未登録）時は何も書かない（空欄を上書きしない）
 *   - 一度読めていれば、シートが読めなくなっても6時間はその一覧を使う。最初から読めなければ空
 *   - 既存行の更新では、スタッフIDが入っている行を上書きしない
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');

function makeCtx(opts) {
  opts = Object.assign({ sheetThrow: false, noSheetId: false, cacheThrow: false, opens: 0 }, opts || {});
  const cache = new Map();
  const ctx = {
    console,
    Logger: { log: () => {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'OPERATIONS_SPREADSHEET_ID' && !opts.noSheetId ? 'ops-sheet' : null) }) },
    CacheService: { getScriptCache: () => {
      if (opts.cacheThrow) throw new Error('cache quota');
      return { get: (k) => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v), remove: (k) => cache.delete(k) };
    } },
    SpreadsheetApp: {
      openById: () => {
        opts.opens++;
        if (opts.sheetThrow) throw new Error('sheet unavailable');
        return {
          getSheetByName: (name) => (name !== 'スタッフマスター' ? null : {
            getDataRange: () => ({
              getValues: () => [
                ['スタッフID', 'Chat ID', '氏名(JP)', 'Name(EN)', '役割', '有効'],
                ['STAFF-001', '7500384947', 'Run Kosal', 'Run Kosal', 'staff', true],
                ['STAFF-002', '1110111', '', 'Dara', 'staff', 'TRUE'],
                ['STAFF-009', '4440444', '退職', 'Old', 'staff', false]
              ]
            })
          })
        };
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(V7, 'StaffLookup.gs'), 'utf8'), ctx, { filename: 'StaffLookup.gs' });
  return { ctx, cache, opts, plain: (v) => JSON.parse(JSON.stringify(v)) };
}

test('送り主をスタッフID・氏名(JP) に引き直す（氏名(JP) が空なら Name(EN)）。StaffGate が確かめたスタッフ（_staffUserId）を優先', () => {
  const { ctx, plain } = makeCtx();
  assert.deepEqual(plain(ctx.jobStaffColumns_({ _authUserId: '7500384947' })), { 'スタッフID': 'STAFF-001', 'スタッフ名': 'Run Kosal' });
  assert.deepEqual(plain(ctx.jobStaffColumns_({ _authUserId: '1110111' })), { 'スタッフID': 'STAFF-002', 'スタッフ名': 'Dara' });
  assert.deepEqual(plain(ctx.jobStaffColumns_({ _staffUserId: '1110111', _authUserId: '' })), { 'スタッフID': 'STAFF-002', 'スタッフ名': 'Dara' });
  assert.deepEqual(plain(ctx.jobStaffColumns_({ _staffUserId: '1110111', _authUserId: '7500384947' })), { 'スタッフID': 'STAFF-002', 'スタッフ名': 'Dara' });
});

test('キャッシュやプロパティが例外を投げても、作業記録の保存を巻き込まない（{} を返す）', () => {
  const t = makeCtx({ cacheThrow: true });
  assert.deepEqual(t.plain(t.ctx.jobStaffColumns_({ _authUserId: '7500384947' })), {});
  assert.deepEqual(t.plain(t.ctx.jobStaffFill_({ '作業状態': '完了' }, null, { _authUserId: '7500384947' })), { '作業状態': '完了' });
});

test('読めなかった直後の2分は、他のスプレッドシートを開きに行かない（作業の保存を待たせない）', () => {
  const t = makeCtx({ sheetThrow: true });
  t.ctx.jobStaffColumns_({ _authUserId: '7500384947' });
  t.ctx.jobStaffColumns_({ _authUserId: '7500384947' });
  t.ctx.jobStaffColumns_({ _authUserId: '7500384947' });
  assert.equal(t.opts.opens, 1);
});

test('特定できない時は何も書かない: 送り主なし・無効の行・未登録', () => {
  const { ctx, plain } = makeCtx();
  assert.deepEqual(plain(ctx.jobStaffColumns_({})), {});
  assert.deepEqual(plain(ctx.jobStaffColumns_({ _authUserId: '' })), {});
  assert.deepEqual(plain(ctx.jobStaffColumns_({ _authUserId: '4440444' })), {});   // 有効=false
  assert.deepEqual(plain(ctx.jobStaffColumns_({ _authUserId: '9999' })), {});
  assert.deepEqual(plain(ctx.jobStaffColumns_({ _authUserId: 'constructor' })), {});   // 名前の衝突で拾わない
});

test('既存行の更新: スタッフIDが空の行だけ埋める・入っている行は上書きしない', () => {
  const { ctx, plain } = makeCtx();
  const body = { _authUserId: '7500384947' };
  assert.deepEqual(plain(ctx.jobStaffFill_({ '作業状態': '完了' }, { 'スタッフID': '' }, body)),
    { '作業状態': '完了', 'スタッフID': 'STAFF-001', 'スタッフ名': 'Run Kosal' });
  assert.deepEqual(plain(ctx.jobStaffFill_({ '作業状態': '完了' }, null, body)),
    { '作業状態': '完了', 'スタッフID': 'STAFF-001', 'スタッフ名': 'Run Kosal' });
  assert.deepEqual(plain(ctx.jobStaffFill_({ '作業状態': '完了' }, { 'スタッフID': 'STAFF-002', 'スタッフ名': 'Dara' }, body)),
    { '作業状態': '完了' });
});

test('シートが読めない時: 一度読めていれば6時間はその一覧・最初から読めなければ空のまま', () => {
  const t = makeCtx();
  assert.equal(t.ctx.jobStaffColumns_({ _authUserId: '7500384947' })['スタッフID'], 'STAFF-001');
  t.cache.delete('staff_lookup_v1');   // 10分のキャッシュが切れた
  t.opts.sheetThrow = true;            // シートが一時的に読めない
  assert.equal(t.ctx.jobStaffColumns_({ _authUserId: '7500384947' })['スタッフID'], 'STAFF-001');

  const cold = makeCtx({ sheetThrow: true });
  assert.deepEqual(cold.plain(cold.ctx.jobStaffColumns_({ _authUserId: '7500384947' })), {});
  const noId = makeCtx({ noSheetId: true });
  assert.deepEqual(noId.plain(noId.ctx.jobStaffColumns_({ _authUserId: '7500384947' })), {});
});
