/**
 * BookingDashboard.gs — 経営ダッシュボード（Phase 5 顧客側）
 *
 * 【責務】
 *   v7 の『予約』『顧客』シートを集計し、経営者向けの
 *   数字による経営管理ダッシュボードをスプレッドシート上に生成する。
 *
 * 【特徴】
 *   - ダーク×ゴールドの統一テーマ
 *   - 期間セレクタ（今月/先月/今年/昨年/過去12ヶ月）
 *   - 円グラフ（プラン別売上/決済状態/新規vsリピート）
 *   - 月次売上トレンド（折れ線）＋当月日別（棒グラフ）
 *   - KPI カード6枚、ランキング表、顧客LTV トップ10
 *
 * 【使い方】
 *   1. `ensureBookingDashboard()` を1回実行 → 『経営ダッシュボード』シート生成
 *   2. `setupBookingDashboardMenu()` を1回実行 → onOpen メニュー登録
 *   3. `setupBookingDashboardDailyTrigger()` を1回実行 → JST 7:30 自動更新
 *   4. スプレッドシートを開き直す → 📈 経営ダッシュボード メニューが出現
 */

const BK_DASH_SHEET  = '経営ダッシュボード';
const BK_CACHE_SHEET = '_経営キャッシュ';

const BK_COLOR = {
  bgDark:   '#0f0f0f',
  bgCard:   '#1a1a1a',
  bgSub:    '#2a2a2a',
  gold:     '#c9a84c',
  goldSoft: '#e8d5a3',
  text:     '#e8e8e8',
  textDim:  '#8a8a8a',
  green:    '#43a047',
  red:      '#c62828',
  blue:     '#1e88e5',
  purple:   '#8e24aa',
  orange:   '#f57c00'
};

// =====================================================
//  メインエントリ
// =====================================================

/**
 * 経営ダッシュボードを生成（初回 or 再生成）
 */
function ensureBookingDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('この GAS はスプレッドシート紐付きで実行してください（v7 は container-bound）');

  let sh = ss.getSheetByName(BK_DASH_SHEET);
  if (sh) {
    // 既存チャート削除
    sh.getCharts().forEach(function(c) { sh.removeChart(c); });
    sh.clear();
    sh.clearConditionalFormatRules();
  } else {
    sh = ss.insertSheet(BK_DASH_SHEET);
  }

  // キャッシュシート
  ensureBkCacheSheet_(ss);

  // 基本スタイル
  sh.setHiddenGridlines(true);
  sh.setTabColor(BK_COLOR.gold);
  for (let c = 1; c <= 14; c++) sh.setColumnWidth(c, 110);
  sh.setColumnWidth(1, 30);  // 左マージン
  sh.setColumnWidth(14, 30); // 右マージン
  sh.getRange(1, 1, 200, 14).setBackground(BK_COLOR.bgDark).setFontColor(BK_COLOR.text);

  // セクション描画
  let row = 1;
  row = buildBkBanner_(sh, row);
  row = buildBkPeriodSelector_(sh, row);
  row = buildBkKpiCards_(sh, row);
  row = buildBkMonthlyTrend_(sh, row, ss);
  row = buildBkPieCharts_(sh, row, ss);
  row = buildBkDailyBar_(sh, row, ss);
  row = buildBkRankings_(sh, row, ss);
  row = buildBkLtvTop10_(sh, row, ss);
  row = buildBkAlerts_(sh, row);

  ss.setActiveSheet(sh);
  sh.setActiveRange(sh.getRange('B2'));
  SpreadsheetApp.flush();
  Logger.log('✅ 経営ダッシュボード生成完了');
}

/**
 * 手動更新（タイムスタンプ + キャッシュ再計算）
 */
function refreshBookingDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(BK_DASH_SHEET);
  if (!sh) { ensureBookingDashboard(); return; }

  ensureBkCacheSheet_(ss); // キャッシュ更新
  const tz = ss.getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
  const ts = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm');
  sh.getRange('B2').setValue('🔄 最終更新: ' + ts);
  SpreadsheetApp.flush();
  Logger.log('🔄 経営ダッシュボード更新: ' + ts);
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
    .addToUi();
}

// =====================================================
//  セクション: バナー
// =====================================================
function buildBkBanner_(sh, row) {
  const r = sh.getRange(row, 2, 1, 12).merge()
    .setValue('🏯 SAMURAI MOTORS — 経営ダッシュボード')
    .setBackground(BK_COLOR.bgCard).setFontColor(BK_COLOR.gold)
    .setFontSize(20).setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.setRowHeight(row, 50);

  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
  sh.getRange(row + 1, 2, 1, 12).merge()
    .setValue('🔄 最終更新: ' + Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm'))
    .setBackground(BK_COLOR.bgDark).setFontColor(BK_COLOR.textDim)
    .setFontSize(10).setHorizontalAlignment('center');
  return row + 3;
}

// =====================================================
//  セクション: 期間セレクタ
// =====================================================
function buildBkPeriodSelector_(sh, row) {
  sh.getRange(row, 2).setValue('📅 対象期間').setFontWeight('bold').setFontColor(BK_COLOR.gold);

  const sel = sh.getRange(row, 3);
  sel.setValue('今月')
    .setBackground(BK_COLOR.bgSub).setFontColor(BK_COLOR.goldSoft)
    .setFontWeight('bold').setFontSize(12).setHorizontalAlignment('center');
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['今月', '先月', '今年', '昨年', '過去12ヶ月'], true)
    .setAllowInvalid(false).build();
  sel.setDataValidation(rule);

  // 期間開始・終了セル（式で計算）
  // D=開始, E=終了（両方 yyyy-MM-dd 形式）
  sh.getRange(row, 4).setValue('開始').setFontColor(BK_COLOR.textDim).setFontSize(10);
  sh.getRange(row, 5).setValue('終了').setFontColor(BK_COLOR.textDim).setFontSize(10);

  sh.getRange(row + 1, 4).setFormula(
    '=IFS(' +
      'C' + row + '="今月", EOMONTH(TODAY(),-1)+1, ' +
      'C' + row + '="先月", EOMONTH(TODAY(),-2)+1, ' +
      'C' + row + '="今年", DATE(YEAR(TODAY()),1,1), ' +
      'C' + row + '="昨年", DATE(YEAR(TODAY())-1,1,1), ' +
      'C' + row + '="過去12ヶ月", EDATE(TODAY(),-12)' +
    ')'
  ).setNumberFormat('yyyy-MM-dd').setFontColor(BK_COLOR.text);
  sh.getRange(row + 1, 5).setFormula(
    '=IFS(' +
      'C' + row + '="今月", EOMONTH(TODAY(),0), ' +
      'C' + row + '="先月", EOMONTH(TODAY(),-1), ' +
      'C' + row + '="今年", DATE(YEAR(TODAY()),12,31), ' +
      'C' + row + '="昨年", DATE(YEAR(TODAY())-1,12,31), ' +
      'C' + row + '="過去12ヶ月", TODAY()' +
    ')'
  ).setNumberFormat('yyyy-MM-dd').setFontColor(BK_COLOR.text);

  // 期間ラベル
  sh.getRange(row + 1, 2, 1, 2).merge()
    .setFormula('=TEXT(D' + (row + 1) + ',"yyyy/M/d")&" 〜 "&TEXT(E' + (row + 1) + ',"yyyy/M/d")')
    .setFontColor(BK_COLOR.goldSoft).setFontWeight('bold').setHorizontalAlignment('center');

  return row + 3;
}

// =====================================================
//  セクション: KPI カード6枚
// =====================================================
function buildBkKpiCards_(sh, row) {
  const startR = row + 4 + 1; // 期間開始: row+1
  const endR   = row + 4 + 1; // dummy
  // 期間セレクタは row-3, row-2 に入ってる
  // 実際の期間開始/終了セルは：行番号を変数化する
  const pStart = 'D' + (row - 1);
  const pEnd   = 'E' + (row - 1);

  // プラン別ステータスフィルタ: 「キャンセル」除外
  // 売上は「料金(USD)」列K、日付は「予約日」列H
  // 決済済みベースにするか全予約ベースにするかは、ここでは「予約確定＋作業完了」を売上計上対象とする
  const salesFormula = '=IFERROR(SUMIFS(予約!K:K, 予約!H:H, ">="&' + pStart + ', 予約!H:H, "<="&' + pEnd +
    ', 予約!L:L, "<>キャンセル"),0)';
  const countFormula = '=IFERROR(COUNTIFS(予約!H:H, ">="&' + pStart + ', 予約!H:H, "<="&' + pEnd +
    ', 予約!L:L, "<>キャンセル"),0)';
  const avgFormula   = '=IFERROR(IF(' + countFormula.substring(1) + '=0,0,' +
    salesFormula.substring(1) + '/' + countFormula.substring(1) + '),0)';
  const uniqCustomers = '=IFERROR(SUMPRODUCT((予約!H2:H10000>=' + pStart + ')*(予約!H2:H10000<=' + pEnd +
    ')*(予約!L2:L10000<>"キャンセル")*(予約!B2:B10000<>"")/COUNTIFS(予約!B2:B10000,予約!B2:B10000,予約!H2:H10000,">="&' + pStart +
    ',予約!H2:H10000,"<="&' + pEnd + ',予約!L2:L10000,"<>キャンセル")),0)';
  const cancelRate = '=IFERROR(COUNTIFS(予約!H:H,">="&' + pStart + ',予約!H:H,"<="&' + pEnd +
    ',予約!L:L,"キャンセル")/COUNTIFS(予約!H:H,">="&' + pStart + ',予約!H:H,"<="&' + pEnd + '),0)';
  // リピート率: 期間内で 2回以上予約した顧客の割合（ユニーク顧客のうち）
  const repeatRate = '=IFERROR(' +
    'SUMPRODUCT((COUNTIFS(予約!B2:B10000,予約!B2:B10000,予約!H2:H10000,">="&' + pStart + ',予約!H2:H10000,"<="&' + pEnd +
       ',予約!L2:L10000,"<>キャンセル")>1)*(予約!H2:H10000>=' + pStart + ')*(予約!H2:H10000<=' + pEnd +
       ')*(予約!L2:L10000<>"キャンセル")/COUNTIFS(予約!B2:B10000,予約!B2:B10000,予約!H2:H10000,">="&' + pStart +
       ',予約!H2:H10000,"<="&' + pEnd + ',予約!L2:L10000,"<>キャンセル"))' +
    '/' + uniqCustomers.substring(1) + ',0)';

  const cards = [
    { label: '💴 期間売上', formula: salesFormula, fmt: '"$"#,##0', color: BK_COLOR.gold },
    { label: '🧾 予約件数', formula: countFormula, fmt: '#,##0"件"', color: BK_COLOR.blue },
    { label: '👥 客数',     formula: uniqCustomers, fmt: '#,##0"名"', color: BK_COLOR.green },
    { label: '💰 客単価',   formula: avgFormula, fmt: '"$"#,##0.0', color: BK_COLOR.orange },
    { label: '🔁 リピート率', formula: repeatRate, fmt: '0.0%', color: BK_COLOR.purple },
    { label: '🚫 キャンセル率', formula: cancelRate, fmt: '0.0%', color: BK_COLOR.red }
  ];

  const cardW = 2; // 2列幅
  let col = 2;
  for (let i = 0; i < cards.length; i++) {
    drawBkCard_(sh, row, col, cards[i]);
    col += cardW;
  }
  sh.setRowHeight(row, 30);
  sh.setRowHeight(row + 1, 46);
  return row + 3;
}

function drawBkCard_(sh, row, col, card) {
  sh.getRange(row, col, 1, 2).merge()
    .setValue(card.label)
    .setBackground(BK_COLOR.bgCard).setFontColor(BK_COLOR.textDim)
    .setFontSize(11).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange(row + 1, col, 1, 2).merge()
    .setFormula(card.formula)
    .setBackground(BK_COLOR.bgCard).setFontColor(card.color)
    .setFontSize(18).setFontWeight('bold')
    .setNumberFormat(card.fmt)
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange(row, col, 2, 2).setBorder(true, true, true, true, false, false,
    BK_COLOR.bgSub, SpreadsheetApp.BorderStyle.SOLID);
}

// =====================================================
//  セクション: 月次売上トレンド（直近12ヶ月、折れ線）
// =====================================================
function buildBkMonthlyTrend_(sh, row, ss) {
  drawBkSectionHeader_(sh, row, '📈 月次売上トレンド（直近12ヶ月）');
  row += 2;

  // キャッシュシートに集計、そこから折れ線グラフ
  const cache = ss.getSheetByName(BK_CACHE_SHEET);
  // A列: 月ラベル, B列: 売上
  cache.getRange('A1:B1').setValues([['月', '売上(USD)']]);
  const header = cache.getRange('A1:B1');
  header.setFontWeight('bold').setBackground(BK_COLOR.bgSub).setFontColor(BK_COLOR.gold);
  for (let i = 0; i < 12; i++) {
    const r = i + 2;
    cache.getRange('A' + r).setFormula('=TEXT(EDATE(TODAY(),-' + (11 - i) + '),"yyyy/M")');
    cache.getRange('B' + r).setFormula(
      '=IFERROR(SUMIFS(予約!K:K,' +
        '予約!H:H,">="&EOMONTH(EDATE(TODAY(),-' + (12 - i) + '),0)+1,' +
        '予約!H:H,"<="&EOMONTH(EDATE(TODAY(),-' + (11 - i) + '),0),' +
        '予約!L:L,"<>キャンセル"),0)'
    );
  }

  // チャート配置
  const chart = sh.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(cache.getRange('A1:B13'))
    .setPosition(row, 2, 0, 0)
    .setOption('title', '')
    .setOption('backgroundColor', BK_COLOR.bgCard)
    .setOption('legend', { position: 'none' })
    .setOption('colors', [BK_COLOR.gold])
    .setOption('hAxis', { textStyle: { color: BK_COLOR.text }, gridlines: { color: BK_COLOR.bgSub } })
    .setOption('vAxis', { textStyle: { color: BK_COLOR.text }, gridlines: { color: BK_COLOR.bgSub }, format: '$#,###' })
    .setOption('chartArea', { left: 60, top: 20, width: '85%', height: '75%' })
    .setOption('width',  720)
    .setOption('height', 260)
    .build();
  sh.insertChart(chart);

  // チャート分の行確保
  for (let i = 0; i < 13; i++) sh.setRowHeight(row + i, 20);
  return row + 14;
}

// =====================================================
//  セクション: 円グラフ 3種
// =====================================================
function buildBkPieCharts_(sh, row, ss) {
  drawBkSectionHeader_(sh, row, '🥧 売上構成・顧客構成（期間内）');
  row += 2;

  const cache = ss.getSheetByName(BK_CACHE_SHEET);
  const pStart = "'" + BK_DASH_SHEET + "'!D7"; // 期間セレクタの row+1=7
  const pEnd   = "'" + BK_DASH_SHEET + "'!E7";

  // --- プラン別売上（D1:E6） ---
  cache.getRange('D1:E1').setValues([['プラン', '売上']]);
  cache.getRange('D1:E1').setFontWeight('bold').setBackground(BK_COLOR.bgSub).setFontColor(BK_COLOR.gold);
  const plans = ['清 KIYOME (A)', '鏡 KAGAMI (B)', '匠 TAKUMI (C)', '将軍 SHOGUN (D)'];
  plans.forEach(function(p, i) {
    cache.getRange('D' + (i + 2)).setValue(p);
    cache.getRange('E' + (i + 2)).setFormula(
      '=IFERROR(SUMIFS(予約!K:K,予約!F:F,"' + p + '",予約!H:H,">="&' + pStart + ',予約!H:H,"<="&' + pEnd +
        ',予約!L:L,"<>キャンセル"),0)'
    );
  });

  // --- 決済状態別件数（D8:E12） ---
  cache.getRange('D8:E8').setValues([['決済状態', '件数']]);
  cache.getRange('D8:E8').setFontWeight('bold').setBackground(BK_COLOR.bgSub).setFontColor(BK_COLOR.gold);
  const pays = ['未清算', 'QR送信済み', '清算済み', '要確認'];
  pays.forEach(function(p, i) {
    cache.getRange('D' + (i + 9)).setValue(p);
    cache.getRange('E' + (i + 9)).setFormula(
      '=IFERROR(COUNTIFS(予約!T:T,"' + p + '",予約!H:H,">="&' + pStart + ',予約!H:H,"<="&' + pEnd +
        ',予約!L:L,"<>キャンセル"),0)'
    );
  });

  // --- 新規 vs リピート（D14:E15） ---
  // 新規 = 顧客の初回予約が期間内
  // リピート = 期間内予約 かつ 期間開始日より前にも予約あり
  cache.getRange('D14:E14').setValues([['区分', '件数']]);
  cache.getRange('D14:E14').setFontWeight('bold').setBackground(BK_COLOR.bgSub).setFontColor(BK_COLOR.gold);
  cache.getRange('D15').setValue('新規');
  cache.getRange('E15').setFormula(
    '=IFERROR(SUMPRODUCT(' +
      '(予約!H2:H10000>=' + pStart + ')*(予約!H2:H10000<=' + pEnd + ')*(予約!L2:L10000<>"キャンセル")' +
      '*(COUNTIFS(予約!B2:B10000,予約!B2:B10000,予約!H2:H10000,"<"&予約!H2:H10000)=0)),0)'
  );
  cache.getRange('D16').setValue('リピート');
  cache.getRange('E16').setFormula(
    '=IFERROR(SUMPRODUCT(' +
      '(予約!H2:H10000>=' + pStart + ')*(予約!H2:H10000<=' + pEnd + ')*(予約!L2:L10000<>"キャンセル")' +
      '*(COUNTIFS(予約!B2:B10000,予約!B2:B10000,予約!H2:H10000,"<"&予約!H2:H10000)>0)),0)'
  );

  // 3つの円グラフを並べる
  const chartOpts = {
    pie: (title, range, colors, posRow, posCol) => {
      return sh.newChart()
        .setChartType(Charts.ChartType.PIE)
        .addRange(range)
        .setPosition(posRow, posCol, 0, 0)
        .setOption('title', title)
        .setOption('titleTextStyle', { color: BK_COLOR.goldSoft, fontSize: 12, bold: true })
        .setOption('backgroundColor', BK_COLOR.bgCard)
        .setOption('legend', { position: 'right', textStyle: { color: BK_COLOR.text, fontSize: 10 } })
        .setOption('colors', colors)
        .setOption('pieHole', 0.4)
        .setOption('pieSliceTextStyle', { color: '#fff', fontSize: 10 })
        .setOption('chartArea', { left: 10, top: 30, width: '95%', height: '80%' })
        .setOption('width',  360)
        .setOption('height', 240)
        .build();
    }
  };

  sh.insertChart(chartOpts.pie('プラン別売上',
    cache.getRange('D1:E5'),
    [BK_COLOR.gold, BK_COLOR.blue, BK_COLOR.purple, BK_COLOR.red], row, 2));
  sh.insertChart(chartOpts.pie('決済状態',
    cache.getRange('D8:E12'),
    [BK_COLOR.textDim, BK_COLOR.orange, BK_COLOR.green, BK_COLOR.red], row, 6));
  sh.insertChart(chartOpts.pie('新規 vs リピート',
    cache.getRange('D14:E16'),
    [BK_COLOR.blue, BK_COLOR.gold], row, 10));

  for (let i = 0; i < 13; i++) sh.setRowHeight(row + i, 20);
  return row + 14;
}

// =====================================================
//  セクション: 当月日別売上（棒グラフ）
// =====================================================
function buildBkDailyBar_(sh, row, ss) {
  drawBkSectionHeader_(sh, row, '📅 当月 日別売上');
  row += 2;

  const cache = ss.getSheetByName(BK_CACHE_SHEET);
  cache.getRange('G1:H1').setValues([['日', '売上']]);
  cache.getRange('G1:H1').setFontWeight('bold').setBackground(BK_COLOR.bgSub).setFontColor(BK_COLOR.gold);
  for (let i = 0; i < 31; i++) {
    const r = i + 2;
    cache.getRange('G' + r).setFormula(
      '=IFERROR(IF(DAY(EOMONTH(TODAY(),0))>=' + (i + 1) + ',' +
        'DATE(YEAR(TODAY()),MONTH(TODAY()),' + (i + 1) + '),""),"")'
    );
    cache.getRange('H' + r).setFormula(
      '=IF(G' + r + '="","",' +
        'IFERROR(SUMIFS(予約!K:K,予約!H:H,G' + r + ',予約!L:L,"<>キャンセル"),0))'
    );
  }
  cache.getRange('G2:G32').setNumberFormat('M/d');

  const chart = sh.newChart()
    .setChartType(Charts.ChartType.COLUMN)
    .addRange(cache.getRange('G1:H32'))
    .setPosition(row, 2, 0, 0)
    .setOption('title', '')
    .setOption('backgroundColor', BK_COLOR.bgCard)
    .setOption('legend', { position: 'none' })
    .setOption('colors', [BK_COLOR.goldSoft])
    .setOption('hAxis', { textStyle: { color: BK_COLOR.text, fontSize: 9 }, gridlines: { color: BK_COLOR.bgSub } })
    .setOption('vAxis', { textStyle: { color: BK_COLOR.text }, gridlines: { color: BK_COLOR.bgSub }, format: '$#,###' })
    .setOption('chartArea', { left: 60, top: 20, width: '90%', height: '75%' })
    .setOption('width',  1100)
    .setOption('height', 260)
    .build();
  sh.insertChart(chart);

  for (let i = 0; i < 13; i++) sh.setRowHeight(row + i, 20);
  return row + 14;
}

// =====================================================
//  セクション: プラン別ランキング表
// =====================================================
function buildBkRankings_(sh, row, ss) {
  drawBkSectionHeader_(sh, row, '🏆 プラン別ランキング（期間内）');
  row += 2;

  const pStart = 'D' + 7;
  const pEnd   = 'E' + 7;

  sh.getRange(row, 2, 1, 4).setValues([['プラン', '件数', '売上', '構成比']])
    .setBackground(BK_COLOR.bgSub).setFontColor(BK_COLOR.gold).setFontWeight('bold')
    .setHorizontalAlignment('center');
  const plans = ['清 KIYOME (A)', '鏡 KAGAMI (B)', '匠 TAKUMI (C)', '将軍 SHOGUN (D)'];
  plans.forEach(function(p, i) {
    const r = row + 1 + i;
    sh.getRange(r, 2).setValue(p).setFontColor(BK_COLOR.text).setFontWeight('bold');
    sh.getRange(r, 3).setFormula(
      '=IFERROR(COUNTIFS(予約!F:F,"' + p + '",予約!H:H,">="&' + pStart + ',予約!H:H,"<="&' + pEnd +
        ',予約!L:L,"<>キャンセル"),0)'
    ).setNumberFormat('#,##0"件"').setHorizontalAlignment('center');
    sh.getRange(r, 4).setFormula(
      '=IFERROR(SUMIFS(予約!K:K,予約!F:F,"' + p + '",予約!H:H,">="&' + pStart + ',予約!H:H,"<="&' + pEnd +
        ',予約!L:L,"<>キャンセル"),0)'
    ).setNumberFormat('"$"#,##0').setHorizontalAlignment('right').setFontColor(BK_COLOR.gold);
    sh.getRange(r, 5).setFormula(
      '=IFERROR(D' + r + '/SUMIFS(予約!K:K,予約!H:H,">="&' + pStart + ',予約!H:H,"<="&' + pEnd +
        ',予約!L:L,"<>キャンセル"),0)'
    ).setNumberFormat('0.0%').setHorizontalAlignment('right');
  });
  sh.getRange(row, 2, plans.length + 1, 4)
    .setBorder(true, true, true, true, true, true, BK_COLOR.bgSub, SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(row + 1, 2, plans.length, 4).setBackground(BK_COLOR.bgCard);

  return row + plans.length + 2;
}

// =====================================================
//  セクション: 顧客LTV トップ10
// =====================================================
function buildBkLtvTop10_(sh, row, ss) {
  drawBkSectionHeader_(sh, row, '💎 顧客 LTV トップ10（累計・キャンセル除く）');
  row += 2;

  sh.getRange(row, 2, 1, 4).setValues([['順位', '氏名', '累計売上', '利用回数']])
    .setBackground(BK_COLOR.bgSub).setFontColor(BK_COLOR.gold).setFontWeight('bold')
    .setHorizontalAlignment('center');

  // QUERY で集計 → 顧客名と紐付け
  // 予約シートから 顧客ID (B) と 料金 (K) を取り、キャンセル以外で合計
  // VLOOKUP で顧客シートの氏名(D)を参照
  for (let i = 0; i < 10; i++) {
    const r = row + 1 + i;
    sh.getRange(r, 2).setValue(i + 1).setFontWeight('bold').setHorizontalAlignment('center')
      .setFontColor(i === 0 ? BK_COLOR.gold : (i < 3 ? BK_COLOR.goldSoft : BK_COLOR.text));
  }

  // ヘッダ下の1セルに巨大式を入れてテーブル化すると編集困難なので、QUERY ベース
  // C列: 氏名, D列: 累計売上, E列: 利用回数
  const queryCell = sh.getRange(row + 1, 3);
  queryCell.setFormula(
    '=IFERROR(QUERY(' +
      '{ARRAYFORMULA(IFERROR(VLOOKUP(予約!B2:B10000,顧客!A:D,4,FALSE))),予約!K2:K10000,予約!L2:L10000},' +
      '"select Col1, sum(Col2), count(Col2) where Col3<>\'キャンセル\' and Col1 is not null group by Col1 order by sum(Col2) desc limit 10 label sum(Col2) \'\', count(Col2) \'\'",0),"")'
  );

  sh.getRange(row + 1, 3, 10, 1).setFontColor(BK_COLOR.text);
  sh.getRange(row + 1, 4, 10, 1).setNumberFormat('"$"#,##0').setFontColor(BK_COLOR.gold)
    .setHorizontalAlignment('right');
  sh.getRange(row + 1, 5, 10, 1).setNumberFormat('#,##0"回"').setHorizontalAlignment('center');
  sh.getRange(row + 1, 2, 10, 4).setBackground(BK_COLOR.bgCard);
  sh.getRange(row, 2, 11, 4)
    .setBorder(true, true, true, true, true, true, BK_COLOR.bgSub, SpreadsheetApp.BorderStyle.SOLID);

  return row + 12;
}

// =====================================================
//  セクション: 経営アラート
// =====================================================
function buildBkAlerts_(sh, row) {
  drawBkSectionHeader_(sh, row, '🚨 経営アラート');
  row += 2;

  const pStart = 'D7';
  const pEnd   = 'E7';

  const alerts = [
    {
      label: 'キャンセル率',
      formula: '=IFERROR(TEXT(COUNTIFS(予約!H:H,">="&' + pStart + ',予約!H:H,"<="&' + pEnd +
        ',予約!L:L,"キャンセル")/COUNTIFS(予約!H:H,">="&' + pStart + ',予約!H:H,"<="&' + pEnd + '),"0.0%")&" " &' +
        'IF(COUNTIFS(予約!H:H,">="&' + pStart + ',予約!H:H,"<="&' + pEnd +
        ',予約!L:L,"キャンセル")/COUNTIFS(予約!H:H,">="&' + pStart + ',予約!H:H,"<="&' + pEnd + ')>0.1,"⚠️ 10%超え","✅ 健全"),"—")'
    },
    {
      label: '未清算の件数',
      formula: '=IFERROR(COUNTIFS(予約!T:T,"未清算",予約!L:L,"<>キャンセル")&"件 "&' +
        'IF(COUNTIFS(予約!T:T,"未清算",予約!L:L,"<>キャンセル")>=5,"⚠️ 5件以上","✅ OK"),"—")'
    },
    {
      label: '要確認の決済',
      formula: '=IFERROR(COUNTIFS(予約!T:T,"要確認")&"件 "&' +
        'IF(COUNTIFS(予約!T:T,"要確認")>0,"⚠️ 要対応","✅ なし"),"—")'
    },
    {
      label: '催促回数 3回以上',
      formula: '=IFERROR(COUNTIFS(予約!Y:Y,">=3",予約!T:T,"<>清算済み")&"件 "&' +
        'IF(COUNTIFS(予約!Y:Y,">=3",予約!T:T,"<>清算済み")>0,"🔴 要エスカレ","✅ なし"),"—")'
    }
  ];

  alerts.forEach(function(a, i) {
    const r = row + i;
    sh.getRange(r, 2, 1, 3).merge().setValue(a.label)
      .setBackground(BK_COLOR.bgCard).setFontColor(BK_COLOR.goldSoft).setFontWeight('bold')
      .setHorizontalAlignment('left').setVerticalAlignment('middle');
    sh.getRange(r, 5, 1, 8).merge().setFormula(a.formula)
      .setBackground(BK_COLOR.bgCard).setFontColor(BK_COLOR.text)
      .setHorizontalAlignment('left').setVerticalAlignment('middle');
    sh.setRowHeight(r, 28);
  });

  sh.getRange(row, 2, alerts.length, 11)
    .setBorder(true, true, true, true, true, true, BK_COLOR.bgSub, SpreadsheetApp.BorderStyle.SOLID);

  return row + alerts.length + 2;
}

// =====================================================
//  共通ヘルパー
// =====================================================
function drawBkSectionHeader_(sh, row, label) {
  sh.getRange(row, 2, 1, 12).merge()
    .setValue(label)
    .setBackground(BK_COLOR.bgSub).setFontColor(BK_COLOR.gold)
    .setFontSize(13).setFontWeight('bold')
    .setHorizontalAlignment('left').setVerticalAlignment('middle');
  sh.setRowHeight(row, 32);
}

function ensureBkCacheSheet_(ss) {
  let sh = ss.getSheetByName(BK_CACHE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(BK_CACHE_SHEET);
    sh.hideSheet();
  }
  return sh;
}

// =====================================================
//  デバッグ用
// =====================================================
function debugBookingDashboardPreview() {
  ensureBookingDashboard();
}
