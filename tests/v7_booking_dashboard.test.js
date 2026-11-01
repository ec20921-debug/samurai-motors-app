/**
 * v7: 経営ダッシュボード（BookingDashboard.gs・2026-11-01 作り直し）
 *
 * 実行: node --test "tests/*.test.js"
 *
 * 数式の計算結果は Node では出せないので、シートの写しで確かめる。ここでは作りの約束を固定する:
 *   - グラフは隠しタブが集計元でも描く（SHOW_ALL。既定だと棒が空白になる不具合の再発防止）
 *   - 黒い背景を使わない／結合が重ならない／条件付き書式が別タブを見ない（API が受け付けない）
 *   - 再生成で出来事メモの中身に触らない
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const IDS = { dash: 11, cache: 22, memo: 33, booking: 44, maxRows: 1000, maxCols: 26, chartIds: [101, 102], ruleCount: 2 };

function load(extra) {
  const ctx = Object.assign({ console, Logger: { log: () => {} } }, extra || {});
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7', 'BookingDashboard.gs'), 'utf8'), ctx, { filename: 'BookingDashboard.gs' });
  return ctx;
}

function requests(ctx) {
  ctx.__ids = IDS;
  return JSON.parse(JSON.stringify(vm.runInContext('bkDashRequests_(__ids)', ctx)));
}

function collect(node, key, out) {
  if (Array.isArray(node)) node.forEach((n) => collect(n, key, out));
  else if (node && typeof node === 'object') {
    Object.keys(node).forEach((k) => {
      if (k === key) out.push(node[k]);
      collect(node[k], key, out);
    });
  }
  return out;
}

test('グラフ: 隠しタブが集計元でも描く・サービス別の積み上げ棒', () => {
  const chart = requests(load()).find((r) => r.addChart).addChart.chart;
  assert.equal(chart.spec.hiddenDimensionStrategy, 'SHOW_ALL');
  assert.equal(chart.spec.basicChart.chartType, 'COLUMN');
  assert.equal(chart.spec.basicChart.stackedType, 'STACKED');
  assert.equal(chart.spec.basicChart.series.length, 5);
  chart.spec.basicChart.series.forEach((s) => {
    assert.equal(s.series.sourceRange.sources[0].sheetId, IDS.cache);
    assert.ok(s.colorStyle.rgbColor, '棒の色を指定する');
  });
});

test('見た目: 黒っぽい背景を使わない', () => {
  const dark = collect(requests(load()), 'backgroundColorStyle', [])
    .map((b) => b.rgbColor)
    .filter((c) => c.red < 0.3 && c.green < 0.3 && c.blue < 0.3);
  assert.deepEqual(dark, []);
});

test('見た目: 結合が重ならない', () => {
  const merges = requests(load()).filter((r) => r.mergeCells).map((r) => r.mergeCells.range);
  merges.forEach((a, i) => {
    merges.slice(i + 1).forEach((b) => {
      const overlap = a.startRowIndex < b.endRowIndex && b.startRowIndex < a.endRowIndex &&
                      a.startColumnIndex < b.endColumnIndex && b.startColumnIndex < a.endColumnIndex;
      assert.equal(overlap, false, JSON.stringify([a, b]));
    });
  });
});

test('条件付き書式は別タブを見ない（API が受け付けない）', () => {
  const formulas = requests(load()).filter((r) => r.addConditionalFormatRule)
    .map((r) => r.addConditionalFormatRule.rule.booleanRule.condition.values[0].userEnteredValue);
  assert.ok(formulas.length > 0);
  formulas.forEach((f) => assert.equal(f.includes('!'), false, f));
});

test('再生成: 前のグラフと条件付き書式を消す・出来事メモの中身に触らない', () => {
  const reqs = requests(load());
  assert.deepEqual(reqs.filter((r) => r.deleteEmbeddedObject).map((r) => r.deleteEmbeddedObject.objectId), IDS.chartIds);
  assert.equal(reqs.filter((r) => r.deleteConditionalFormatRule).length, IDS.ruleCount);
  assert.deepEqual(collect(reqs, 'sheetId', []).filter((id) => id === IDS.memo), []);
});

test('棒の下: 12か月の列に同じ式を入れる・出来事は3枠', () => {
  const reqs = requests(load());
  const rows = reqs.filter((r) => r.repeatCell && r.repeatCell.range.sheetId === IDS.dash &&
    r.repeatCell.cell.userEnteredValue && r.repeatCell.range.endColumnIndex - r.repeatCell.range.startColumnIndex === 12);
  assert.equal(rows.length, 7); // 月・合計・線・ほか N 件・出来事3枠
  const formulas = rows.map((r) => r.repeatCell.cell.userEnteredValue.formulaValue).join('\n');
  ['$U$2:$U$13', '$V$2:$V$13', '$W$2:$W$13'].forEach((col) => assert.ok(formulas.includes(col), col));
});

test('集計: 売上はキャンセル除く・サービスは1件を1つに寄せる', () => {
  const ctx = load();
  const helper = vm.runInContext('bkCacheHelperFormulas_()', ctx);
  assert.ok(helper.booking[2].includes('予約!L2:L<>"キャンセル"'));
  const service = helper.booking[3];
  ['磨き', 'ヘッドライト', 'ガラス', '洗車', 'その他'].reduce((prev, name) => {
    const at = service.indexOf('"' + name + '"');
    assert.ok(at > prev, name);
    return at;
  }, -1);
});

/** v7 Database のスタブ。sheets に無いタブは insertSheet で作る */
function fakeSpreadsheet(options) {
  const o = options || {};
  const inserted = [];
  const memoHeader = o.memoHeader === undefined ? '日付' : o.memoHeader;
  const bookingHeaders = o.bookingHeaders || (() => {
    const row = new Array(38).fill('x');
    const set = { F: 5, G: 6, H: 7, K: 10, L: 11, T: 19, U: 20, AD: 29 };
    const names = { F: 'プラン', G: 'オプション', H: '予約日', K: '料金(USD)', L: '進行状態', T: '決済状態', U: '請求額(USD)', AD: 'キャンペーン名' };
    Object.keys(set).forEach((k) => { row[set[k]] = names[k]; });
    return row;
  })();
  const sheet = (id, isMemo) => ({
    getSheetId: () => id, getMaxRows: () => 1000, getMaxColumns: () => 26, getLastColumn: () => bookingHeaders.length,
    getCharts: () => [{ getChartId: () => 101 }], getConditionalFormatRules: () => [],
    getRange: () => ({ isBlank: () => isMemo && !memoHeader, getValues: () => [bookingHeaders] })
  });
  const sheets = { '予約': sheet(44), '経営ダッシュボード': sheet(11), '_経営キャッシュ': sheet(22) };
  if (!o.noMemo) sheets['出来事メモ'] = sheet(33, true);
  return {
    inserted,
    getId: () => 'SS', setActiveSheet: () => {}, getSheetByName: (n) => sheets[n],
    insertSheet: (n) => { inserted.push(n); return sheet(33, true); }
  };
}

function loadWith(ss, calls, status) {
  return load({
    SHEET_NAMES: { BOOKINGS: '予約' },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, flush: () => {} },
    ScriptApp: { getOAuthToken: () => 'TOKEN' },
    UrlFetchApp: {
      fetch: (url, options) => {
        calls.push({ id: url.match(/spreadsheets\/(.+):batchUpdate/)[1], body: JSON.parse(options.payload) });
        return { getResponseCode: () => status || 200, getContentText: () => 'ng' };
      }
    }
  });
}

test('ensureBookingDashboard: batchUpdate は1回・出来事メモに見出しがあれば触らない', () => {
  const calls = [];
  vm.runInContext('ensureBookingDashboard()', loadWith(fakeSpreadsheet(), calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'SS');
  assert.deepEqual(collect(JSON.parse(JSON.stringify(calls[0].body)), 'sheetId', []).filter((id) => id === 33), []);
});

test('ensureBookingDashboard: 出来事メモが無ければ作って見出しを書く', () => {
  const calls = [];
  const ss = fakeSpreadsheet({ noMemo: true, memoHeader: '' });
  vm.runInContext('ensureBookingDashboard()', loadWith(ss, calls));
  assert.deepEqual(ss.inserted, ['出来事メモ']);
  assert.ok(collect(JSON.parse(JSON.stringify(calls[0].body)), 'sheetId', []).includes(33));
});

test('ensureBookingDashboard: 前回タブだけ作って失敗していても、見出しが空なら書く', () => {
  const calls = [];
  vm.runInContext('ensureBookingDashboard()', loadWith(fakeSpreadsheet({ memoHeader: '' }), calls));
  assert.ok(collect(JSON.parse(JSON.stringify(calls[0].body)), 'sheetId', []).includes(33));
});

test('ensureBookingDashboard: API が失敗したら止まって知らせる', () => {
  const calls = [];
  const ctx = loadWith(fakeSpreadsheet(), calls, 403);
  assert.throws(() => vm.runInContext('ensureBookingDashboard()', ctx), /作れませんでした/);
});

test('ensureBookingDashboard: 予約タブの列がずれていたら何も書かずに止まる', () => {
  const calls = [];
  const headers = new Array(38).fill('x');
  const ctx = loadWith(fakeSpreadsheet({ bookingHeaders: headers }), calls);
  assert.throws(() => vm.runInContext('ensureBookingDashboard()', ctx), /予約タブの/);
  assert.equal(calls.length, 0);
});

test('集計タブ: 足りなければ行を足す（配列数式が溢れないように）', () => {
  const reqs = requests(load());
  assert.equal(reqs.filter((r) => r.appendDimension).length, 0); // cacheRows 指定なしなら足さない
  const ctx = load();
  ctx.__ids = Object.assign({}, IDS, { cacheRows: 1000 });
  const added = JSON.parse(JSON.stringify(vm.runInContext('bkDashRequests_(__ids)', ctx))).filter((r) => r.appendDimension);
  assert.equal(added[0].appendDimension.length, 4000);
  assert.equal(added[0].appendDimension.sheetId, IDS.cache);
});

test('棒の下の式が見ている集計タブの列は、見出しどおり', () => {
  const reqs = requests(load());
  const header = reqs.find((r) => r.updateCells && r.updateCells.start && r.updateCells.start.sheetId === IDS.cache && r.updateCells.start.rowIndex === 0);
  const names = header.updateCells.rows[0].values.map((v) => (v.userEnteredValue || {}).stringValue);
  const nameOf = (letter) => names[letter.charCodeAt(0) - 65];
  assert.equal(nameOf('U'), '出来事1');
  assert.equal(nameOf('W'), '出来事3');
  assert.equal(nameOf('X'), 'ほか');
  assert.equal(nameOf('Y'), '月の表示');
  assert.equal(nameOf('Z'), '合計の表示');
  assert.equal(nameOf('G'), '合計');
  assert.equal(nameOf('H'), '台数');
  const chart = reqs.find((r) => r.addChart).addChart.chart.spec.basicChart;
  assert.deepEqual(chart.series.map((s) => names[s.series.sourceRange.sources[0].startColumnIndex]), ['洗車', '磨き', 'ガラス', 'ヘッドライト', 'その他']);
});

test('金額の表示: 整数は .0 を付けない・出来事の灰色カードに印を付けない', () => {
  const ctx = load();
  const money = vm.runInContext("bkMoney_('A1')", ctx);
  assert.equal(money, 'TEXT(A1,IF(A1=INT(A1),"$#,##0","$#,##0.0"))');
  assert.equal(vm.runInContext('bkCacheHelperFormulas_().events', ctx).includes('⚪'), false);
});

test('入金カードから予約タブへ飛べる', () => {
  const formulas = collect(requests(load()), 'formulaValue', []);
  assert.ok(formulas.some((f) => f.includes('HYPERLINK("#gid=44"') && f.includes('予約タブで確認')));
});

test('グラフの幅: 月の列の合計＋グラフの中の余白（棒が列の真ん中に来る）', () => {
  const pos = requests(load()).find((r) => r.addChart).addChart.chart.position.overlayPosition;
  const ctx = load();
  const colWidth = vm.runInContext('BK_COL_WIDTH', ctx);
  assert.equal(pos.widthPixels, colWidth * 12 + 51);
});

test('refreshBookingDashboard: タブがあれば作り直さない（毎朝のトリガーの入口）', () => {
  const calls = [];
  vm.runInContext('refreshBookingDashboard()', loadWith(fakeSpreadsheet(), calls));
  assert.equal(calls.length, 0);
});
