/**
 * BookingDashboard.gs — 経営ダッシュボード（v7 Database のタブを生成）
 *
 * 【責務】
 *   『予約』を集計し、経営者が1画面で見るタブを作る（2026-11-01 Daisuke「引き算で必要な指標のみ」
 *   「背景黒は見にくい」「棒にその時の出来事のコメントを」で作り直し）。
 *
 * 【見せるもの】
 *   - カード4枚: 今月 / 先月 / 直近12か月の売上・台数 / 入金の確認
 *   - 月別売上の棒グラフ（サービス別の積み上げ・12か月）
 *   - 各月の棒の下に、『出来事メモ』タブの出来事（1行足すとここに出る）
 *
 * 【集計の基準】
 *   売上 = 予約!料金(K)・進行状態(L)≠キャンセル（日報・経営コックピットと同じ）。
 *   入金の確認 = 作業完了なのに清算済みでないもの（経営コックピットの未回収と同じ）。
 *   サービスは1件を1つに寄せる（磨き → ヘッドライト → ガラス → 洗車 の順に判定）。
 *
 * 【グラフが空白にならないように】
 *   集計元の『_経営キャッシュ』は隠しタブ。グラフの既定（隠れた行を飛ばす）だと棒が描かれない。
 *   hiddenDimensionStrategy: SHOW_ALL を必ず指定する（2026-11-01 原因を写しで確認）。
 *
 * 【使い方】
 *   1. `ensureBookingDashboard()` を1回実行 → タブ生成（出来事メモの中身は消さない）
 *   2. `setupBookingDashboardMenu()` を1回実行 → onOpen メニュー登録
 *   3. `setupBookingDashboardDailyTrigger()` を1回実行 → JST 7:30 自動更新
 *   4. スプレッドシートを開き直す → 📈 経営ダッシュボード メニューが出現
 *
 * 生成は Sheets API の batchUpdate 1回にまとめる（途中で失敗しても今のタブは変わらない）。
 * 列記号で予約タブを見るので、再生成の前に見出しを確かめ、ずれていたら何も書かずに止まる。
 */

const BK_DASH_SHEET  = '経営ダッシュボード';
const BK_CACHE_SHEET = '_経営キャッシュ';
const BK_MEMO_SHEET  = '出来事メモ';

const BK_COLOR = {
  white:    '#ffffff',
  gold:     '#c9a84c',
  goldDark: '#8a6d2b',
  ink:      '#1c1b17',
  sub:      '#5b584f',
  muted:    '#6b685f',
  line:     '#e1e0d9',
  goldTint: '#fbf5e3',
  blueTint: '#eaf2fc',
  tealTint: '#e6f6f0',
  goodTint: '#e6f4e6',
  badTint:  '#fbe6e6',
  noneTint: '#f1f1ee'
};

// 積み上げの順 = 色の順（色覚の検証を通した並び。入れ替えない）。
// 緑と赤は出来事カードの「うまくいった／いかなかった」専用なので、棒には使わない。その他は意図して灰色
const BK_SERVICES = [
  { name: '洗車',         color: '#2a78d6' },
  { name: '磨き',         color: '#eda100' },
  { name: 'ガラス',       color: '#6250d6' },
  { name: 'ヘッドライト', color: '#e87ba4' },
  { name: 'その他',       color: '#5b584f' }
];

const BK_MONTHS       = 12;   // 棒の本数（= 月の列 B〜M）
const BK_MEMO_SLOTS   = 3;    // 1か月の棒の下に出す出来事の数（集計タブの U〜W 列に対応。増やす時は列も足す）
const BK_FIRST_COL    = 2;    // B列
const BK_COL_WIDTH    = 110;
const BK_CHART_HEIGHT = 220;
// グラフの中の余白（maximized で左 約22px・右 約29px）の分だけ大きく置くと、棒が月の列の真ん中に来る（実物で確認）
const BK_LEFT_COL_WIDTH = 24;
const BK_CHART_OFFSET_X = 2;
const BK_CHART_WIDTH    = 1371;
const BK_MAX_ROWS     = 40;   // 白く塗る範囲
const BK_CACHE_ROWS   = 5000; // 集計タブの行数。予約タブより少ないと配列数式が溢れて売上が出なくなる

// ダッシュボードの行（1始まり）
const BK_ROW = { title: 1, rule: 2, cardLabel: 4, cardValue: 5, cardSub: 6, section: 8, chart: 9,
                 month: 10, total: 11, stem: 12, memo: 13, more: 16 };

// 『_経営キャッシュ』の列: A月 B〜F売上 G合計 H台数 I月初 J グラフの横軸（空白）/ K〜P 予約1行ごとの値 / Q〜T 出来事 / U〜Z 棒の下の文字
const BK_CACHE_COL = { memo: 'UVW' };

// 数式が列記号で見ている予約タブの見出し（列がずれたまま数式を作り直すと、別の列を黙って集計してしまう）
const BK_BOOKING_COLS = { F: 'プラン', G: 'オプション', H: '予約日', K: '料金(USD)', L: '進行状態',
                          T: '決済状態', U: '請求額(USD)', AD: 'キャンペーン名' };

const BK_MEMO_HEADERS = ['日付', '評価', 'ひとこと（棒の下に出す・16字くらい）',
                         'くわしく（何をして、どうなったか）', '棒の下に出さない時は ×', '出典・メモ'];
const BK_MEMO_RATINGS = ['🟢 うまくいった', '🔴 うまくいかなかった', '⚪ 出来事'];

// =====================================================
//  メインエントリ
// =====================================================

/**
 * 経営ダッシュボードを生成（初回 or 再生成）
 */
function ensureBookingDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('この GAS はスプレッドシート紐付きで実行してください（v7 は container-bound）');
  assertBkBookingColumns_(ss);

  const dash  = ss.getSheetByName(BK_DASH_SHEET)  || ss.insertSheet(BK_DASH_SHEET, 0);
  const cache = ss.getSheetByName(BK_CACHE_SHEET) || ss.insertSheet(BK_CACHE_SHEET);
  const memo  = ss.getSheetByName(BK_MEMO_SHEET)  || ss.insertSheet(BK_MEMO_SHEET, 1);
  // タブを作った直後に失敗しても、次の実行で見出しが入るように、見出しの有無で判定する
  const memoNeedsHeader = memo.getRange('A1').isBlank();
  SpreadsheetApp.flush();   // 作ったタブを確定させてから API を呼ぶ

  const requests = bkDashRequests_({
    dash: dash.getSheetId(),
    cache: cache.getSheetId(),
    memo: memo.getSheetId(),
    booking: ss.getSheetByName(SHEET_NAMES.BOOKINGS).getSheetId(),
    maxRows: dash.getMaxRows(),
    maxCols: dash.getMaxColumns(),
    cacheRows: cache.getMaxRows(),
    chartIds: dash.getCharts().map(function(c) { return c.getChartId(); }).filter(Boolean),
    ruleCount: dash.getConditionalFormatRules().length
  });
  applyBkRequests_(ss.getId(), memoNeedsHeader ? requests.concat(bkMemoRequests_(memo.getSheetId())) : requests);

  ss.setActiveSheet(dash);
  SpreadsheetApp.flush();
  Logger.log('✅ 経営ダッシュボード生成完了');
}

/**
 * Sheets API の batchUpdate を直接呼ぶ。
 * 高度なサービス（Sheets.Spreadsheets.batchUpdate）だと棒の色の指定が落ちる（2026-11-01 本番で確認）。
 * manifest の Sheets は、この API を使えるようにしておくために残している。
 */
function applyBkRequests_(spreadsheetId, requests) {
  const res = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/' + spreadsheetId + ':batchUpdate', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ requests: requests }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('経営ダッシュボードを作れませんでした（今のタブは変わっていません）: ' + res.getContentText().substring(0, 300));
  }
}

/** 予約タブの見出しが数式の前提と違えば、何も書かずに止める */
function assertBkBookingColumns_(ss) {
  const sh = ss.getSheetByName(SHEET_NAMES.BOOKINGS);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Object.keys(BK_BOOKING_COLS).forEach(function(letters) {
    const col = letters.split('').reduce(function(n, ch) { return n * 26 + ch.charCodeAt(0) - 64; }, 0);
    if (String(headers[col - 1]).trim() !== BK_BOOKING_COLS[letters]) {
      throw new Error('予約タブの ' + letters + ' 列が「' + BK_BOOKING_COLS[letters] + '」ではありません。BookingDashboard.gs の数式を直してから再生成してください');
    }
  });
}

/**
 * 手動更新（数式は開くたびに計算される。ここでは計算を確定させるだけ）
 */
function refreshBookingDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName(BK_DASH_SHEET)) { ensureBookingDashboard(); return; }
  SpreadsheetApp.flush();
  Logger.log('🔄 経営ダッシュボード更新');
}

/**
 * JST 7:30 に毎日リフレッシュ
 */
function setupBookingDashboardDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'refreshBookingDashboard') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshBookingDashboard')
    .timeBased().atHour(7).nearMinute(30).inTimezone('Asia/Tokyo')
    .everyDays(1).create();
  Logger.log('⏰ 毎朝 JST 7:30 の経営ダッシュボード更新トリガーを登録');
}

/**
 * onOpen メニュー登録（installable）
 */
function setupBookingDashboardMenu() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'bookingDashboardOnOpen_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('bookingDashboardOnOpen_')
    .forSpreadsheet(ss).onOpen().create();
  try { bookingDashboardOnOpen_(); } catch (e) { Logger.log('⚠️ onOpen 即時実行: ' + e); }
  Logger.log('✅ onOpen トリガー登録（次回オープンからメニュー表示）');
}

function bookingDashboardOnOpen_() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📈 経営ダッシュボード')
    .addItem('🔄 更新', 'refreshBookingDashboard')
    .addItem('🧱 再生成（レイアウト再構築）', 'ensureBookingDashboard')
    .addSeparator()
    .addItem('⏰ 毎朝自動更新を設定 (JST 7:30)', 'setupBookingDashboardDailyTrigger')
    .addSeparator()
    .addItem('🗂 タブを整える（並び・色・非表示）', 'tidyDatabaseTabs')   // TabLayout.gs
    .addToUi();
}

// =====================================================
//  生成する内容（Sheets API のリクエスト）
// =====================================================

/**
 * ダッシュボードと集計タブを作り直すリクエスト一式。出来事メモの中身には触らない。
 * @param {{dash:number, cache:number, memo:number, booking:number, maxRows:number, maxCols:number,
 *          cacheRows:number, chartIds:number[], ruleCount:number}} ctx
 */
function bkDashRequests_(ctx) {
  return []
    .concat(bkResetRequests_(ctx))
    .concat(bkCacheRequests_(ctx.cache))
    .concat(bkLayoutRequests_(ctx))
    .concat(bkHeaderRequests_(ctx))
    .concat(bkCardRequests_(ctx.dash, ctx.booking))
    .concat(bkTimelineRequests_(ctx.dash, ctx.memo))
    .concat([bkChartRequest_(ctx)]);
}

function bkResetRequests_(ctx) {
  const all = bkGrid_(ctx.dash, 1, 1, ctx.maxRows, ctx.maxCols);
  const requests = (ctx.chartIds || []).map(function(id) {
    return { deleteEmbeddedObject: { objectId: id } };
  });
  // 条件付き書式は前から消すと番号が詰まるので、いつも 0 番を消す
  for (let i = 0; i < (ctx.ruleCount || 0); i++) {
    requests.push({ deleteConditionalFormatRule: { sheetId: ctx.dash, index: 0 } });
  }
  requests.push({ unmergeCells: { range: all } });
  requests.push({ setDataValidation: { range: all } });
  requests.push({ updateCells: { range: all, fields: '*' } });
  requests.push({ updateCells: { range: { sheetId: ctx.cache }, fields: '*' } });
  if (ctx.cacheRows < BK_CACHE_ROWS) {
    requests.push({ appendDimension: { sheetId: ctx.cache, dimension: 'ROWS', length: BK_CACHE_ROWS - ctx.cacheRows } });
  }
  return requests;
}

/**
 * 集計タブ（隠す）。1か月1行の表と、予約1行ごとの値、棒の下に出す文字を置く。
 * repeatCell は数式の相対参照を行・列ごとにずらしてくれるので、2行目の式だけ書く。
 */
function bkCacheRequests_(id) {
  const last = 1 + BK_MONTHS;
  const memo = BK_MEMO_SHEET + '!';
  const inMonth = '$K:$K,">="&$I2,$K:$K,"<"&EDATE($I2,1)';
  const fill = function(c1, c2, formula) { return bkRepeat_(id, 2, c1, last, c2, formula); };
  const put = function(row, col, values) {
    return { updateCells: { start: { sheetId: id, rowIndex: row - 1, columnIndex: col - 1 },
      rows: [{ values: values.map(function(v) { return v === '' ? {} : bkCell_(v); }) }], fields: 'userEnteredValue' } };
  };
  const helper = bkCacheHelperFormulas_();

  const requests = [
    { updateSheetProperties: { properties: { sheetId: id, hidden: true }, fields: 'hidden' } },
    put(1, 1, ['月'].concat(BK_SERVICES.map(function(s) { return s.name; }), ['合計', '台数', '月初', '',
      '日付', '売上', '有効', 'サービス', '未入金', '未入金額', '出来事の数（出す）', '出来事の日付', '出来事', '出来事の数（全部）',
      '出来事1', '出来事2', '出来事3', 'ほか', '月の表示', '合計の表示'])),
    fill(1, 1, '=TEXT(I2,"yyyy/M")'),
    fill(10, 10, ' '),   // グラフの横軸用（下記 bkChartRequest_）
    fill(2, 1 + BK_SERVICES.length, '=SUMIFS($L:$L,$N:$N,B$1,$M:$M,TRUE,' + inMonth + ')'),
    fill(7, 7, '=ROUND(SUM(B2:F2),1)'),
    fill(8, 8, '=COUNTIFS($M:$M,TRUE,' + inMonth + ')'),
    put(2, 9, ['=EDATE(EOMONTH(TODAY(),0)+1,-' + BK_MONTHS + ')']),
    bkRepeat_(id, 3, 9, last, 9, '=EDATE(I2,1)'),
    put(2, 11, helper.booking),
    fill(17, 17, '=COUNTIFS($R:$R,">="&$I2,$R:$R,"<"&EDATE($I2,1))'),
    put(2, 18, [helper.events]),
    fill(20, 20, '=COUNTIFS(' + memo + '$A:$A,">="&$I2,' + memo + '$A:$A,"<"&EDATE($I2,1),' + memo + '$C:$C,"<>")'),
    fill(21, 20 + BK_MEMO_SLOTS, '=IFERROR(INDEX(FILTER($S$2:$S,$R$2:$R>=$I2,$R$2:$R<EDATE($I2,1)),COLUMN()-20),"")'),
    fill(24, 24, '=IF($T2-MIN(' + BK_MEMO_SLOTS + ',$Q2)>0,"ほか "&($T2-MIN(' + BK_MEMO_SLOTS + ',$Q2))&" 件","")'),
    fill(25, 25, '=TEXT($I2,IF(OR(ROW()=2,MONTH($I2)=1),"yyyy年M月","M月"))'),
    fill(26, 26, '=IF($H2=0,"—",' + bkMoney_('$G2') + '&"・"&$H2&"台")')
  ];
  // カードで使う値（A15〜B19）
  [
    ['これからの予約', '=COUNTIFS($M:$M,TRUE,$K:$K,">"&TODAY(),$K:$K,"<"&EDATE($I13,1))'],
    ['入金の確認 件数', '=SUM(O2:O)'],
    ['入金の確認 金額', '=SUM(P2:P)'],
    ['直近12か月の売上', '=ROUND(SUM(G2:G13),1)'],
    ['直近12か月の台数', '=SUM(H2:H13)']
  ].forEach(function(pair, i) { requests.push(put(15 + i, 1, pair)); });
  return requests;
}

function bkCacheHelperFormulas_() {
  const codes = '予約!F2:F&"|"&予約!G2:G';
  const service =
    'IF(REGEXMATCH(' + codes + ',"BODY|POLISH|REPAIR|REFRESH"),"磨き",' +
    'IF(REGEXMATCH(' + codes + ',"HEADLIGHT"),"ヘッドライト",' +
    'IF(REGEXMATCH(' + codes + ',"GLASS"),"ガラス",' +
    'IF(REGEXMATCH(' + codes + '&"|"&予約!AD2:AD,"WASH|ハーフ|5ドル"),"洗車","その他"))))';
  const memo = BK_MEMO_SHEET + '!';
  const rating = 'IF(REGEXMATCH(' + memo + 'B2:B,"いかなかった"),"🔴 ",IF(REGEXMATCH(' + memo + 'B2:B,"うまくいった"),"🟢 ",""))';
  return {
    booking: [
      '=ARRAYFORMULA(IF(予約!H2:H="","",IF(ISNUMBER(予約!H2:H),予約!H2:H,IFERROR(DATEVALUE(予約!H2:H),""))))',
      '=ARRAYFORMULA(IF(K2:K="","",IFERROR(VALUE(予約!K2:K),0)))',
      '=ARRAYFORMULA(IF(K2:K="","",予約!L2:L<>"キャンセル"))',
      '=ARRAYFORMULA(IF(K2:K="","",' + service + '))',
      '=ARRAYFORMULA(IF(K2:K="","",(予約!L2:L="作業完了")*(予約!T2:T<>"清算済み")))',
      '=ARRAYFORMULA(IF(K2:K="","",O2:O*IF(IFERROR(VALUE(予約!U2:U),0)>0,IFERROR(VALUE(予約!U2:U),0),L2:L)))'
    ],
    events: '=ARRAYFORMULA(IFERROR(SORT(FILTER({' + memo + 'A2:A,' + rating + '&' + memo + 'C2:C},' +
      'ISNUMBER(' + memo + 'A2:A),' + memo + 'C2:C<>"",' + memo + 'E2:E<>"×"),1,TRUE),""))'
  };
}

/** 白い下地・列幅・行の高さ */
function bkLayoutRequests_(ctx) {
  const id = ctx.dash;
  const heights = {};
  heights[BK_ROW.title] = 42; heights[BK_ROW.rule] = 3; heights[3] = 10;
  heights[BK_ROW.cardLabel] = 24; heights[BK_ROW.cardValue] = 40; heights[BK_ROW.cardSub] = 24; heights[7] = 12;
  heights[BK_ROW.section] = 28; heights[BK_ROW.chart] = BK_CHART_HEIGHT;
  heights[BK_ROW.month] = 20; heights[BK_ROW.total] = 20; heights[BK_ROW.stem] = 14;
  heights[BK_ROW.memo] = 52; heights[BK_ROW.memo + 1] = 52; heights[BK_ROW.memo + 2] = 52; heights[BK_ROW.more] = 18;

  const requests = [
    { updateSheetProperties: {
        properties: { sheetId: id, gridProperties: { hideGridlines: true }, tabColorStyle: { rgbColor: bkRgb_(BK_COLOR.gold) } },
        fields: 'gridProperties.hideGridlines,tabColorStyle' } },
    { updateDimensionProperties: { range: { sheetId: id, dimension: 'ROWS', startIndex: 0, endIndex: ctx.maxRows },
        properties: { pixelSize: 21 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 },
        properties: { pixelSize: BK_LEFT_COL_WIDTH }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: 1, endIndex: 1 + BK_MONTHS },
        properties: { pixelSize: BK_COL_WIDTH }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: id, dimension: 'COLUMNS', startIndex: 1 + BK_MONTHS, endIndex: 2 + BK_MONTHS },
        properties: { pixelSize: 16 }, fields: 'pixelSize' } },
    { repeatCell: { range: bkGrid_(id, 1, 1, BK_MAX_ROWS, 2 + BK_MONTHS),
        cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: bkRgb_(BK_COLOR.white) } } },
        fields: 'userEnteredFormat.backgroundColorStyle' } }
  ];
  Object.keys(heights).forEach(function(r) {
    requests.push({ updateDimensionProperties: {
      range: { sheetId: id, dimension: 'ROWS', startIndex: Number(r) - 1, endIndex: Number(r) },
      properties: { pixelSize: heights[r] }, fields: 'pixelSize' } });
  });
  return requests;
}

/** 題名・金の線・棒グラフの見出し */
function bkHeaderRequests_(ctx) {
  const id = ctx.dash, last = BK_FIRST_COL + BK_MONTHS - 1, split = BK_FIRST_COL + 7;
  const sectionRow = BK_ROW.section;
  return []
    .concat(bkBlock_(id, BK_ROW.title, BK_FIRST_COL, BK_ROW.title, split - 1,
      'SAMURAI MOTORS  経営ダッシュボード', { size: 18, bold: true }))
    .concat(bkBlock_(id, BK_ROW.title, split, BK_ROW.title, last,
      '="売上は予約タブの料金（キャンセル除く）｜"&TEXT(NOW(),"M/d H:mm")&" 時点"', { size: 9, color: BK_COLOR.muted, align: 'RIGHT' }))
    .concat([{ repeatCell: { range: bkGrid_(id, BK_ROW.rule, BK_FIRST_COL, BK_ROW.rule, last),
        cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: bkRgb_(BK_COLOR.gold) } } },
        fields: 'userEnteredFormat.backgroundColorStyle' } }])
    .concat(bkBlock_(id, sectionRow, BK_FIRST_COL, sectionRow, split - 1,
      '月別の売上と、その時の出来事（直近12か月）', { size: 12, bold: true }))
    .concat(bkBlock_(id, sectionRow, split, sectionRow, last,
      '=HYPERLINK("#gid=' + ctx.memo + '","＋ 出来事を足す（' + BK_MEMO_SHEET + ' タブ）")', { size: 9, color: BK_COLOR.goldDark, align: 'RIGHT' }));
}

/** カード4枚（各3列）: 今月 / 先月 / 直近12か月 / 入金の確認待ち */
function bkCardRequests_(id, bookingId) {
  const c = "'" + BK_CACHE_SHEET + "'!";
  const perCar = function(sales, count) {
    return count + '&"台"&IF(' + count + '>0,"・1台あたり "&TEXT(' + sales + '/' + count + ',"$0.0"),"")';
  };
  const cards = [
    { bg: BK_COLOR.goldTint, label: '="今月（"&' + c + 'Y13&"）"', value: '=' + bkMoney_(c + 'G13'),
      sub: '=' + perCar(c + 'G13', c + 'H13') + '&IF(' + c + 'B15>0,"（うちこれからの予約 "&' + c + 'B15&"台）","")' },
    { bg: BK_COLOR.blueTint, label: '="先月（"&' + c + 'Y12&"）"', value: '=' + bkMoney_(c + 'G12'),
      sub: '=' + perCar(c + 'G12', c + 'H12') },
    { bg: BK_COLOR.tealTint, label: '直近12か月', value: '=' + bkMoney_(c + 'B18'),
      sub: '=' + perCar(c + 'B18', c + 'B19') },
    { bg: BK_COLOR.goodTint, label: '入金の確認待ち', value: '=IF(' + c + 'B16=0,"✅ なし","⚠️ "&' + c + 'B16&"件")',
      sub: '=IF(' + c + 'B16=0,"作業完了はすべて清算済み",HYPERLINK("#gid=' + bookingId + '",' + bkMoney_(c + 'B17') + '&" 分を予約タブで確認 →"))' }
  ];

  let requests = [];
  cards.forEach(function(card, i) {
    const col = BK_FIRST_COL + i * 3, end = col + 2;
    requests = requests
      .concat(bkBlock_(id, BK_ROW.cardLabel, col, BK_ROW.cardLabel, end, card.label, { size: 10, bold: true, color: BK_COLOR.sub, bg: card.bg, indent: 8 }))
      .concat(bkBlock_(id, BK_ROW.cardValue, col, BK_ROW.cardValue, end, card.value, { size: 24, bold: true, bg: card.bg, indent: 8 }))
      .concat(bkBlock_(id, BK_ROW.cardSub, col, BK_ROW.cardSub, end, card.sub, { size: 10, color: BK_COLOR.sub, bg: card.bg, indent: 8 }));
    if (i < cards.length - 1) {
      requests.push({ updateBorders: { range: bkGrid_(id, BK_ROW.cardLabel, end, BK_ROW.cardSub, end),
        right: { style: 'SOLID_THICK', colorStyle: { rgbColor: bkRgb_(BK_COLOR.white) } } } });
    }
  });
  // 入金の確認: 残っていれば赤、なければ緑（条件付き書式は別タブを見られないので、カード自身の値を見る）
  const alertCol = BK_FIRST_COL + 9;
  const alertCell = '$' + bkA1_(BK_ROW.cardValue, alertCol).replace(/(\d+)/, '$$$1');
  requests.push(bkFormulaRule_(id, BK_ROW.cardLabel, alertCol, BK_ROW.cardSub, alertCol + 2,
    '=REGEXMATCH(' + alertCell + ',"件")', BK_COLOR.badTint));
  return requests;
}

/** 棒の真下: 月・合計 → 細い線 → 出来事カード → ほか N 件。どの列も同じ式で、列の位置から月を引く */
function bkTimelineRequests_(id, memoId) {
  const c = "'" + BK_CACHE_SHEET + "'!";
  const lastCol = BK_FIRST_COL + BK_MONTHS - 1;
  const pick = function(col) { return '=INDEX(' + c + '$' + col + '$2:$' + col + '$' + (1 + BK_MONTHS) + ',COLUMN()-' + (BK_FIRST_COL - 1) + ')'; };
  const row = function(r, formula, fmt) { return bkRepeat_(id, r, BK_FIRST_COL, r, lastCol, formula, fmt); };
  const firstMemo = bkA1_(BK_ROW.memo, BK_FIRST_COL);

  const requests = [
    row(BK_ROW.month, pick('Y'), { size: 10, bold: true, align: 'CENTER' }),
    row(BK_ROW.total, pick('Z'), { size: 10, align: 'CENTER' }),
    row(BK_ROW.stem, '=IF(' + firstMemo + '<>"","│","")', { size: 8, align: 'CENTER', color: BK_COLOR.muted }),
    row(BK_ROW.more, '=IF(' + pick('X').substring(1) + '="","",HYPERLINK("#gid=' + memoId + '",' + pick('X').substring(1) + '))',
      { size: 9, align: 'CENTER', color: BK_COLOR.muted }),
    // 今月の列は金色で目印
    { repeatCell: { range: bkGrid_(id, BK_ROW.month, lastCol, BK_ROW.month, lastCol),
        cell: { userEnteredFormat: { textFormat: { fontSize: 10, bold: true, foregroundColorStyle: { rgbColor: bkRgb_(BK_COLOR.goldDark) } } } },
        fields: 'userEnteredFormat.textFormat' } }
  ];
  for (let k = 0; k < BK_MEMO_SLOTS; k++) {
    requests.push(row(BK_ROW.memo + k, pick(BK_CACHE_COL.memo.charAt(k)), { size: 10, wrap: true, valign: 'TOP', indent: 3 }));
  }

  // カードの白いすき間（縦・横）
  requests.push({ updateBorders: { range: bkGrid_(id, BK_ROW.memo, BK_FIRST_COL, BK_ROW.memo + BK_MEMO_SLOTS - 1, lastCol),
    innerVertical: { style: 'SOLID_THICK', colorStyle: { rgbColor: bkRgb_(BK_COLOR.white) } },
    innerHorizontal: { style: 'SOLID_THICK', colorStyle: { rgbColor: bkRgb_(BK_COLOR.white) } } } });

  // 評価でカードに色を付ける（色＋絵文字で、色だけに頼らない）
  [['"^🟢"', BK_COLOR.goodTint], ['"^🔴"', BK_COLOR.badTint]].forEach(function(rule) {
    requests.push(bkFormulaRule_(id, BK_ROW.memo, BK_FIRST_COL, BK_ROW.memo + BK_MEMO_SLOTS - 1, lastCol,
      '=REGEXMATCH(' + firstMemo + ',' + rule[0] + ')', rule[1]));
  });
  // 印のない出来事は灰色
  requests.push(bkFormulaRule_(id, BK_ROW.memo, BK_FIRST_COL, BK_ROW.memo + BK_MEMO_SLOTS - 1, lastCol,
    '=AND(' + firstMemo + '<>"",NOT(REGEXMATCH(' + firstMemo + ',"^(🟢|🔴)")))', BK_COLOR.noneTint));
  return requests;
}

/**
 * 月別売上の積み上げ棒。棒の真下に各月の列が来るように置く。
 * maximized だと横軸のラベルが棒に重なるので、横軸は空白の列（J）にして、月はセルに出す。
 */
function bkChartRequest_(ctx) {
  const series = BK_SERVICES.map(function(s, i) {
    return {
      series: { sourceRange: { sources: [bkGrid_(ctx.cache, 1, 2 + i, 1 + BK_MONTHS, 2 + i)] } },
      targetAxis: 'LEFT_AXIS',
      colorStyle: { rgbColor: bkRgb_(s.color) }
    };
  });
  return { addChart: { chart: {
    spec: {
      hiddenDimensionStrategy: 'SHOW_ALL',   // 集計元が隠しタブでも描く（既定だと空白になる）
      fontName: 'Arial',
      maximized: true,
      backgroundColorStyle: { rgbColor: bkRgb_(BK_COLOR.white) },
      basicChart: {
        chartType: 'COLUMN',
        stackedType: 'STACKED',
        legendPosition: 'TOP_LEGEND',
        headerCount: 1,
        axis: [{ position: 'BOTTOM_AXIS' }, { position: 'LEFT_AXIS' }],
        domains: [{ domain: { sourceRange: { sources: [bkGrid_(ctx.cache, 1, 10, 1 + BK_MONTHS, 10)] } } }],
        series: series
      }
    },
    border: { colorStyle: { rgbColor: bkRgb_(BK_COLOR.white) } },
    position: { overlayPosition: {
      anchorCell: { sheetId: ctx.dash, rowIndex: BK_ROW.chart - 1, columnIndex: 0 },
      offsetXPixels: BK_CHART_OFFSET_X,
      widthPixels: BK_CHART_WIDTH,
      heightPixels: BK_CHART_HEIGHT
    } }
  } } };
}

/** 出来事メモの見出し（タブを新しく作る時だけ。中身は書かない） */
function bkMemoRequests_(memoId) {
  const widths = [90, 175, 250, 520, 110, 280];
  const requests = [
    { updateSheetProperties: {
        properties: { sheetId: memoId, gridProperties: { frozenRowCount: 1 }, tabColorStyle: { rgbColor: bkRgb_(BK_COLOR.gold) } },
        fields: 'gridProperties.frozenRowCount,tabColorStyle' } },
    { updateCells: { start: { sheetId: memoId, rowIndex: 0, columnIndex: 0 },
        rows: [{ values: BK_MEMO_HEADERS.map(function(h) {
          return bkCell_(h, { size: 10, bold: true, bg: BK_COLOR.goldTint, wrap: true });
        }) }],
        fields: 'userEnteredValue,userEnteredFormat' } },
    { repeatCell: { range: bkGrid_(memoId, 2, 1, 1000, 1),
        cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy/mm/dd' } } },
        fields: 'userEnteredFormat.numberFormat' } },
    { repeatCell: { range: bkGrid_(memoId, 2, 1, 1000, 6),
        cell: { userEnteredFormat: { verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat.verticalAlignment' } },
    { repeatCell: { range: bkGrid_(memoId, 2, 4, 1000, 4),
        cell: { userEnteredFormat: { wrapStrategy: 'WRAP' } }, fields: 'userEnteredFormat.wrapStrategy' } },
    { setDataValidation: { range: bkGrid_(memoId, 2, 1, 1000, 1), rule: {
        condition: { type: 'DATE_IS_VALID' }, strict: false } } },
    { setDataValidation: { range: bkGrid_(memoId, 2, 2, 1000, 2), rule: {
        condition: { type: 'ONE_OF_LIST', values: BK_MEMO_RATINGS.map(function(v) { return { userEnteredValue: v }; }) },
        showCustomUi: true, strict: false } } },
    { setDataValidation: { range: bkGrid_(memoId, 2, 5, 1000, 5), rule: {
        condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: '×' }] },
        showCustomUi: true, strict: false } } }
  ];
  widths.forEach(function(w, i) {
    requests.push({ updateDimensionProperties: { range: { sheetId: memoId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { pixelSize: w }, fields: 'pixelSize' } });
  });
  return requests;
}

// =====================================================
//  共通ヘルパー
// =====================================================

/** 結合（複数セルの時）＋ 左上のセルに値と見た目を入れる */
function bkBlock_(id, r1, c1, r2, c2, value, fmt) {
  const requests = [];
  if (r1 !== r2 || c1 !== c2) {
    requests.push({ mergeCells: { range: bkGrid_(id, r1, c1, r2, c2), mergeType: 'MERGE_ALL' } });
  }
  requests.push({ updateCells: { start: { sheetId: id, rowIndex: r1 - 1, columnIndex: c1 - 1 },
    rows: [{ values: [bkCell_(value, fmt)] }], fields: 'userEnteredValue,userEnteredFormat' } });
  if (fmt && fmt.bg && c1 !== c2) {
    requests.push({ repeatCell: { range: bkGrid_(id, r1, c1, r2, c2),
      cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: bkRgb_(fmt.bg) } } },
      fields: 'userEnteredFormat.backgroundColorStyle' } });
  }
  return requests;
}

/** 同じ式・同じ見た目を範囲に入れる（式の相対参照は行・列ごとにずれる） */
function bkRepeat_(id, r1, c1, r2, c2, value, fmt) {
  return { repeatCell: { range: bkGrid_(id, r1, c1, r2, c2), cell: bkCell_(value, fmt),
    fields: fmt ? 'userEnteredValue,userEnteredFormat' : 'userEnteredValue' } };
}

/** $126 / $191.5（整数の時は .0 を付けない）。ref はセル参照 */
function bkMoney_(ref) {
  return 'TEXT(' + ref + ',IF(' + ref + '=INT(' + ref + '),"$#,##0","$#,##0.0"))';
}

function bkCell_(value, fmt) {
  const cell = {};
  if (typeof value === 'number') cell.userEnteredValue = { numberValue: value };
  else if (String(value).charAt(0) === '=') cell.userEnteredValue = { formulaValue: value };
  else cell.userEnteredValue = { stringValue: String(value) };
  if (fmt) cell.userEnteredFormat = bkFormat_(fmt);
  return cell;
}

function bkFormat_(f) {
  const out = {
    horizontalAlignment: f.align || 'LEFT',
    verticalAlignment: f.valign || 'MIDDLE',
    wrapStrategy: f.wrap ? 'WRAP' : 'CLIP',
    textFormat: { fontSize: f.size || 10, bold: !!f.bold, foregroundColorStyle: { rgbColor: bkRgb_(f.color || BK_COLOR.ink) } }
  };
  if (f.bg) out.backgroundColorStyle = { rgbColor: bkRgb_(f.bg) };
  if (f.pattern) out.numberFormat = { type: 'NUMBER', pattern: f.pattern };
  if (f.indent) out.padding = { left: f.indent, right: f.indent };
  return out;
}

function bkFormulaRule_(id, r1, c1, r2, c2, formula, bg) {
  return { addConditionalFormatRule: { index: 0, rule: {
    ranges: [bkGrid_(id, r1, c1, r2, c2)],
    booleanRule: {
      condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: formula }] },
      format: { backgroundColorStyle: { rgbColor: bkRgb_(bg) } }
    }
  } } };
}

/** 1始まり・両端を含む行列 → Sheets API の範囲 */
function bkGrid_(id, r1, c1, r2, c2) {
  return { sheetId: id, startRowIndex: r1 - 1, endRowIndex: r2, startColumnIndex: c1 - 1, endColumnIndex: c2 };
}

function bkA1_(row, col) {
  return String.fromCharCode(64 + col) + row;
}

function bkRgb_(hex) {
  const part = function(from) { return Math.round(parseInt(hex.substring(from, from + 2), 16) / 255 * 1000) / 1000; };
  return { red: part(1), green: part(3), blue: part(5) };
}

// =====================================================
//  デバッグ用
// =====================================================
function debugBookingDashboardPreview() {
  ensureBookingDashboard();
}

// =====================================================
//  予約日(H列) 文字列→日付 一括変換 ＋ ダッシュボード再生成
//  他の集計（日報など）の日付フィルタが効くように、シートの値を日付にそろえる。
//  （ダッシュボードの数式は文字列の日付も読める）
//  ※ 何度実行しても安全（すでに日付値の行はスキップ）
// =====================================================
function fixBookingDatesAndRebuild() {
  const ss = getSpreadsheet();
  const tz = ss.getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
  const sh = ss.getSheetByName(SHEET_NAMES.BOOKINGS); // '予約'
  let converted = 0;

  if (sh && sh.getLastRow() >= 2) {
    const n = sh.getLastRow() - 1;
    const rng = sh.getRange(2, 8, n, 1); // H列 = 予約日（8列目）
    const vals = rng.getValues();
    let changed = false;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i][0];
      // "yyyy-MM-dd" 形式の文字列だけを日付化（既に Date のものは触らない）
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
        vals[i][0] = Utilities.parseDate(v.trim(), tz, 'yyyy-MM-dd');
        converted++;
        changed = true;
      }
    }
    if (changed) {
      rng.setNumberFormat('yyyy-MM-dd'); // 表示を日付に
      // 日付にしなかったセルも書き戻すので、読み戻した文字列（' が外れている）が数式にならないように
      rng.setValues(vals.map(function(r) { return [sheetSafeValue_(r[0])]; }));
    }
  }

  Logger.log('🔧 予約日 文字列→日付 変換: ' + converted + '件');
  ensureBookingDashboard(); // 修正後の予約日でダッシュボードを再構築
  const msg = '予約日を ' + converted + ' 件 日付化 → 経営ダッシュボード再生成 完了';
  Logger.log('✅ ' + msg);
  return msg;
}
