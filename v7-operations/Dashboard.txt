/**
 * Dashboard.gs — 管理ダッシュボード（Phase 5）
 *
 * 【責務】
 *   「管理ダッシュボード」集約シートを生成・更新する。
 *   Admin がスプレッドシートを開いたら、勤怠 / タスク / 経費 / 日報 を
 *   横断的に可視化した1枚でパッと把握できるビューを提供する。
 *
 * 【構成】
 *   ① 🏯 バナー + 最終更新日時
 *   ② 📊 今日のKPI（4カード: 出勤中 / 残タスク / 本日売上 / 本日経費）
 *   ③ 👷 スタッフ状況（本日）: 出勤/退勤/勤務時間/日報/残タスク
 *   ④ 🔥 期限超過タスク一覧
 *   ⑤ 💰 今月の経費 勘定科目別 + SPARKLINE棒
 *   ⑥ 📅 今月のスタッフ別勤務時間 + SPARKLINE棒
 *   ⑦ 📝 今週の日報提出マトリクス
 *
 * 【自動更新】
 *   - v7-ops の各シートは formula 連動で即反映
 *   - v7 の売上データだけは GAS 経由で取得（refreshDashboard()）
 *   - 毎朝 JST 7:00 に自動更新トリガー
 *   - 手動更新: スプレッドシートの「📊 ダッシュボード」メニュー
 */

const DASHBOARD_SHEET_NAME = '管理ダッシュボード';
const DASHBOARD_CACHE_SHEET = '_ダッシュボードキャッシュ';  // v7売上等の一時置き場（非表示）

// カラーパレット（ダークゴールド）
const DB_COLOR = {
  bgDark:    '#0f0f0f',
  bgCard:    '#1a1a1a',
  border:    '#2a2a2a',
  gold:      '#c9a84c',
  goldDim:   '#8a7535',
  textMain:  '#e8e8e8',
  textDim:   '#888888',
  green:     '#00897B',
  red:       '#c62828',
  orange:    '#F57C00',
  purple:    '#8E24AA',
  header:    '#2b2b2b'
};

// ============================================================
//  エントリポイント
// ============================================================

/**
 * ダッシュボードシートを初期化（既存なら中身をリセットして再構築）
 */
function ensureDashboardSheet() {
  const ss = openOps_();
  ensureCacheSheet_(ss);

  let sh = ss.getSheetByName(DASHBOARD_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(DASHBOARD_SHEET_NAME, 0);  // 先頭タブ
  } else {
    // 先頭に移動
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(1);
  }

  // リセット
  sh.clear();
  sh.clearConditionalFormatRules();
  sh.getCharts().forEach(function(c) { sh.removeChart(c); });

  // グリッド設定
  sh.setHiddenGridlines(true);
  const totalCols = 10;
  // 全列幅を少しタイトに
  for (let c = 1; c <= totalCols; c++) sh.setColumnWidth(c, 110);
  sh.setColumnWidth(1, 160);   // A列ラベル系を広く
  sh.setColumnWidth(2, 140);
  sh.setColumnWidth(totalCols + 1, 40); // 右余白

  // 背景色
  sh.getRange(1, 1, 500, totalCols + 1).setBackground(DB_COLOR.bgDark);

  // セクション構築
  let row = 1;
  row = buildBanner_(sh, row, totalCols);
  row = buildKpiCards_(sh, row, totalCols);
  row = buildStaffTodayTable_(sh, row);
  row = buildOverdueTasks_(sh, row);
  row = buildMonthlyExpenses_(sh, row);
  row = buildMonthlyWorkHours_(sh, row);
  row = buildWeeklyReportMatrix_(sh, row);

  // 今日の日付を最初に表示（A2 で TEXT(NOW())）は refresh で上書きされる
  refreshDashboard();

  Logger.log('✅ 管理ダッシュボード 生成完了');
  SpreadsheetApp.flush();
}

/**
 * データ更新（v7 売上キャッシュ + 最終更新時刻）
 */
function refreshDashboard() {
  const ss = openOps_();
  const sh = ss.getSheetByName(DASHBOARD_SHEET_NAME);
  if (!sh) { Logger.log('⚠️ ダッシュボード未作成'); return; }

  refreshV7SalesCache_(ss);

  // 最終更新時刻（A2）
  const ts = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd HH:mm');
  sh.getRange('A2').setValue('🔄 最終更新: ' + ts + '  ｜  メニュー「📊 ダッシュボード」>「更新」');
}

/**
 * 毎朝 JST 7:00 の自動更新トリガーをセット
 */
function setupDashboardDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'refreshDashboard') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshDashboard')
    .timeBased()
    .atHour(7)
    .inTimezone('Asia/Tokyo')
    .everyDays(1)
    .create();
  Logger.log('✅ refreshDashboard を毎日 JST 7:00 で登録');
}

/**
 * スプレッドシートにカスタムメニュー「📊 ダッシュボード」を追加する
 * installable onOpen トリガーを設置
 */
function setupDashboardMenu() {
  const ss = openOps_();
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'dashboardOnOpen_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dashboardOnOpen_').forSpreadsheet(ss).onOpen().create();
  // 今すぐメニュー表示
  dashboardOnOpen_();
  Logger.log('✅ onOpen トリガーを設置（次回オープンからメニュー表示）');
}

/**
 * スプレッドシートを開いた時に呼ばれる（installable trigger）
 */
function dashboardOnOpen_() {
  try {
    const ss = openOps_();
    SpreadsheetApp.setActiveSpreadsheet(ss);
    const ui = SpreadsheetApp.getUi();
    ui.createMenu('📊 ダッシュボード')
      .addItem('🔄 更新',                       'refreshDashboard')
      .addSeparator()
      .addItem('🧱 ダッシュボード再生成',        'ensureDashboardSheet')
      .addItem('⏰ 毎朝自動更新を設定 (JST 7:00)', 'setupDashboardDailyTrigger')
      .addToUi();
  } catch (e) {
    Logger.log('⚠️ dashboardOnOpen_ error: ' + e);
  }
}

// ============================================================
//  セクション: バナー
// ============================================================

function buildBanner_(sh, row, cols) {
  // A1:J1 merged title
  sh.getRange(row, 1, 1, cols).merge()
    .setValue('🏯  SAMURAI MOTORS  —  管理ダッシュボード')
    .setBackground(DB_COLOR.gold)
    .setFontColor('#1a1200')
    .setFontWeight('bold')
    .setFontSize(18)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sh.setRowHeight(row, 40);
  row++;

  // A2:J2 merged subtitle（更新時刻）
  sh.getRange(row, 1, 1, cols).merge()
    .setValue('🔄 最終更新: —')
    .setBackground(DB_COLOR.bgCard)
    .setFontColor(DB_COLOR.textDim)
    .setFontSize(11)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sh.setRowHeight(row, 26);
  row++;

  // 空行
  sh.setRowHeight(row, 10);
  row++;
  return row;
}

// ============================================================
//  セクション: KPIカード
// ============================================================

function buildKpiCards_(sh, row, cols) {
  // セクション見出し
  row = drawSectionHeader_(sh, row, cols, '📊 今日のKPI');

  // 4カード × 各2列×2行
  // A:B = 出勤中  C:D = 残タスク  E:F = 本日売上  G:H = 本日経費
  // I:J = 日報提出数 + 完了タスク（アクセント）

  const today = "TEXT(TODAY(),\"yyyy-MM-dd\")";

  // 出勤中カード（A5:B6）
  drawCard_(sh, row, 1,
    '🕐 出勤中スタッフ',
    '=IFERROR(COUNTIFS(勤怠記録!A:A,' + today + ',勤怠記録!E:E,"<>""")-COUNTIFS(勤怠記録!A:A,' + today + ',勤怠記録!F:F,"<>"""),0)',
    '/ ' + '=IFERROR(COUNTIF(スタッフマスター!' + findColLetter_('スタッフマスター', '有効') + ':' + findColLetter_('スタッフマスター', '有効') + ',TRUE),"")',
    DB_COLOR.green
  );

  // 残タスクカード（C5:D6）
  drawCard_(sh, row, 3,
    '📋 残タスク（全体）',
    '=IFERROR(COUNTIFS(タスク!I:I,"未着手"),0)',
    '内 期限超過: =IFERROR(COUNTIFS(タスク!I:I,"未着手",タスク!G:G,"<"&' + today + ',タスク!G:G,"<>""")," ")',
    DB_COLOR.orange
  );

  // 本日売上（E5:F6） - キャッシュから
  drawCard_(sh, row, 5,
    '💰 本日売上 (USD)',
    "=IFERROR(VLOOKUP(\"today_sales\"," + DASHBOARD_CACHE_SHEET + "!A:B,2,FALSE),0)",
    '完了 =IFERROR(VLOOKUP("today_completed_jobs",' + DASHBOARD_CACHE_SHEET + '!A:B,2,FALSE),0) 件',
    DB_COLOR.gold
  );

  // 本日経費（G5:H6）
  drawCard_(sh, row, 7,
    '💵 本日経費 (USD相当)',
    '=IFERROR(SUMIFS(経費!E:E,経費!C:C,' + today + ',経費!F:F,"USD"),0)',
    'KHR合計: =IFERROR(SUMIFS(経費!E:E,経費!C:C,' + today + ',経費!F:F,"KHR"),0)',
    DB_COLOR.red
  );

  // 日報（I5:J6）
  drawCard_(sh, row, 9,
    '📝 本日の日報',
    '=IFERROR(COUNTIF(日報!C:C,' + today + '),0)',
    '/ =IFERROR(COUNTIF(スタッフマスター!' + findColLetter_('スタッフマスター', '有効') + ':' + findColLetter_('スタッフマスター', '有効') + ',TRUE),"")',
    DB_COLOR.purple
  );

  row += 2;  // カードは2行分

  // 空行
  sh.setRowHeight(row, 10);
  row++;

  return row;
}

/**
 * 4セル（2列×2行）カードを描画
 */
function drawCard_(sh, row, col, label, bigValueFormula, subText, accent) {
  // 上半分：ラベル（1行目）
  const labelRange = sh.getRange(row, col, 1, 2).merge()
    .setValue(label)
    .setBackground(DB_COLOR.bgCard)
    .setFontColor(DB_COLOR.textDim)
    .setFontSize(10)
    .setFontWeight('bold')
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle')
    .setBorder(true, true, false, true, false, false, accent, SpreadsheetApp.BorderStyle.SOLID_THICK);
  sh.setRowHeight(row, 22);

  // 下半分：大きな数字 + サブテキスト（2行目）
  // 左（col） = 大値、右（col+1） = サブ
  sh.getRange(row + 1, col).setFormula(bigValueFormula)
    .setBackground(DB_COLOR.bgCard)
    .setFontColor(accent)
    .setFontSize(22)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');

  // subText に '=' が2回含まれるケース対応：末尾に数式行があってもセルにはテキストとして
  const subCell = sh.getRange(row + 1, col + 1);
  if (subText && subText.indexOf('=') === 0) {
    subCell.setFormula(subText);
  } else if (subText && subText.indexOf('=') >= 0) {
    // "ラベル: =FORMULA" の形 → setValue ではなくセル結合してラベル＋数式は諦めて setValue
    subCell.setValue(subText);
  } else {
    subCell.setValue(subText || '');
  }
  subCell
    .setBackground(DB_COLOR.bgCard)
    .setFontColor(DB_COLOR.textDim)
    .setFontSize(10)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle')
    .setWrap(true);

  sh.setRowHeight(row + 1, 48);

  // ボトムボーダー
  sh.getRange(row + 1, col, 1, 2)
    .setBorder(false, true, true, true, false, false, accent, SpreadsheetApp.BorderStyle.SOLID);
}

// ============================================================
//  セクション: 今日のスタッフ状況
// ============================================================

function buildStaffTodayTable_(sh, row) {
  row = drawSectionHeader_(sh, row, 10, '👷 本日のスタッフ状況');

  // ヘッダー
  const headers = ['氏名', '役割', 'TZ', '出勤', '退勤', '勤務時間', '状態', '日報', '残タスク', 'メモ'];
  const hRange = sh.getRange(row, 1, 1, headers.length).setValues([headers])
    .setBackground(DB_COLOR.header)
    .setFontColor(DB_COLOR.gold)
    .setFontWeight('bold')
    .setFontSize(11)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sh.setRowHeight(row, 28);
  row++;

  // 動的な行数を確保（最大20名）
  const maxStaff = 20;
  const today = 'TEXT(TODAY(),"yyyy-MM-dd")';

  // A列: スタッフマスターから有効な氏名を取得
  // 1名ずつ ARRAYFORMULA 的に並べる
  sh.getRange(row, 1).setFormula(
    '=IFERROR(FILTER(スタッフマスター!' +
      findColLetter_('スタッフマスター', '氏名(JP)') + '2:' + findColLetter_('スタッフマスター', '氏名(JP)') + ',' +
      'スタッフマスター!' + findColLetter_('スタッフマスター', '有効') + '2:' + findColLetter_('スタッフマスター', '有効') + '=TRUE),"")'
  );

  // 他の列は最大行数分あらかじめ数式を入れる（A列が空の行は "" を返す）
  for (let i = 0; i < maxStaff; i++) {
    const r = row + i;
    const name = 'A' + r;
    // 役割
    sh.getRange(r, 2).setFormula(
      '=IF(' + name + '="","",IFERROR(VLOOKUP(' + name + ',スタッフマスター!' + findColLetter_('スタッフマスター', '氏名(JP)') + ':' + findColLetter_('スタッフマスター', '役割') + ',' +
      (letterToIndex_(findColLetter_('スタッフマスター', '役割')) - letterToIndex_(findColLetter_('スタッフマスター', '氏名(JP)')) + 1) + ',FALSE),""))'
    );
    // TZ
    sh.getRange(r, 3).setFormula(
      '=IF(' + name + '="","",IFERROR(VLOOKUP(' + name + ',スタッフマスター!' + findColLetter_('スタッフマスター', '氏名(JP)') + ':' + findColLetter_('スタッフマスター', 'タイムゾーン') + ',' +
      (letterToIndex_(findColLetter_('スタッフマスター', 'タイムゾーン')) - letterToIndex_(findColLetter_('スタッフマスター', '氏名(JP)')) + 1) + ',FALSE),""))'
    );
    // 出勤
    sh.getRange(r, 4).setFormula(
      '=IF(' + name + '="","",IFERROR(INDEX(勤怠記録!E:E,MATCH(1,(勤怠記録!A:A=' + today + ')*(勤怠記録!C:C=' + name + '),0)),"—"))'
    );
    // 退勤
    sh.getRange(r, 5).setFormula(
      '=IF(' + name + '="","",IFERROR(INDEX(勤怠記録!F:F,MATCH(1,(勤怠記録!A:A=' + today + ')*(勤怠記録!C:C=' + name + '),0)),"—"))'
    );
    // 勤務時間
    sh.getRange(r, 6).setFormula(
      '=IF(' + name + '="","",IFERROR(' +
      'LET(m,INDEX(勤怠記録!G:G,MATCH(1,(勤怠記録!A:A=' + today + ')*(勤怠記録!C:C=' + name + '),0)),' +
      'IF(ISNUMBER(m),INT(m/60)&"h"&MOD(m,60)&"m","—"))' +
      ',"—"))'
    );
    // 状態
    sh.getRange(r, 7).setFormula(
      '=IF(' + name + '="","",IF(D' + r + '="—","⬜ 未出勤",' +
      'IF(D' + r + '="","⬜ 未出勤",IF(E' + r + '="","🟢 勤務中",IF(E' + r + '="—","🟢 勤務中","✅ 退勤済")))))'
    );
    // 日報
    sh.getRange(r, 8).setFormula(
      '=IF(' + name + '="","",IF(IFERROR(COUNTIFS(日報!D:D,' + name + ',日報!C:C,' + today + '),0)>0,"✅","—"))'
    );
    // 残タスク
    sh.getRange(r, 9).setFormula(
      '=IF(' + name + '="","",IFERROR(COUNTIFS(タスク!C:C,' + name + ',タスク!I:I,"未着手"),0))'
    );
    // メモ（期限超過数）
    sh.getRange(r, 10).setFormula(
      '=IF(' + name + '="","",LET(n,IFERROR(COUNTIFS(タスク!C:C,' + name + ',タスク!I:I,"未着手",タスク!G:G,"<"&' + today + ',タスク!G:G,"<>""")," "),IF(n="","",IF(n>0,"🔴 期限超過 "&n,""))))'
    );
  }

  // 書式
  const dataRange = sh.getRange(row, 1, maxStaff, 10);
  dataRange
    .setBackground(DB_COLOR.bgCard)
    .setFontColor(DB_COLOR.textMain)
    .setFontSize(11)
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sh.getRange(row, 1, maxStaff, 1).setHorizontalAlignment('left').setFontWeight('bold').setFontColor(DB_COLOR.gold);
  for (let i = 0; i < maxStaff; i++) sh.setRowHeight(row + i, 24);

  // 条件付き書式: 状態列の色分け
  const statusRange = sh.getRange(row, 7, maxStaff, 1);
  const rules = sh.getConditionalFormatRules();
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('🟢')
      .setBackground('#143d2f').setFontColor('#7fffb0')
      .setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('✅')
      .setBackground('#2a2a2a').setFontColor(DB_COLOR.textDim)
      .setRanges([statusRange]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('⬜')
      .setBackground(DB_COLOR.bgCard).setFontColor(DB_COLOR.textDim)
      .setRanges([statusRange]).build(),
    // 期限超過メモを赤く
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('🔴')
      .setBackground('#3d1414').setFontColor('#ff7e7e').setBold(true)
      .setRanges([sh.getRange(row, 10, maxStaff, 1)]).build()
  );
  sh.setConditionalFormatRules(rules);

  row += maxStaff;
  sh.setRowHeight(row, 10);
  row++;
  return row;
}

// ============================================================
//  セクション: 期限超過タスク
// ============================================================

function buildOverdueTasks_(sh, row) {
  row = drawSectionHeader_(sh, row, 10, '🔥 期限超過タスク（未完了）');

  const headers = ['担当者', '期限', '経過日数', 'タスク内容', 'タスクID'];
  sh.getRange(row, 1, 1, 5).setValues([headers])
    .setBackground(DB_COLOR.header)
    .setFontColor(DB_COLOR.gold).setFontWeight('bold').setFontSize(11)
    .setHorizontalAlignment('center');
  sh.setRowHeight(row, 26);
  row++;

  // QUERY で期限超過の未着手タスクを引く
  const formula =
    '=IFERROR(QUERY(' +
      'ARRAYFORMULA({タスク!C:C,タスク!G:G,IFERROR(TODAY()-DATEVALUE(タスク!G:G),""),タスク!H:H,タスク!A:A,タスク!I:I,タスク!G:G}),' +
      '"select Col1, Col2, Col3, Col4, Col5 where Col6 = \'未着手\' and Col7 < \'"&TEXT(TODAY(),"yyyy-MM-dd")&"\' and Col7 is not null order by Col2 asc limit 20",0),' +
      '"（期限超過なし）")';
  sh.getRange(row, 1).setFormula(formula);

  // 書式（20行分ぐらい）
  const dataRange = sh.getRange(row, 1, 20, 5);
  dataRange
    .setBackground(DB_COLOR.bgCard)
    .setFontColor(DB_COLOR.textMain)
    .setFontSize(11)
    .setVerticalAlignment('middle');
  sh.getRange(row, 4, 20, 1).setWrap(true).setHorizontalAlignment('left');
  sh.getRange(row, 1, 20, 1).setFontWeight('bold').setFontColor(DB_COLOR.gold).setHorizontalAlignment('left');
  sh.getRange(row, 2, 20, 1).setHorizontalAlignment('center');
  sh.getRange(row, 3, 20, 1).setHorizontalAlignment('center').setFontColor('#ff7e7e').setFontWeight('bold');
  sh.getRange(row, 5, 20, 1).setHorizontalAlignment('center').setFontColor(DB_COLOR.textDim).setFontSize(9);

  // 条件付き書式: 経過日数 >= 3 日でさらに赤く
  const rules = sh.getConditionalFormatRules();
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThanOrEqualTo(7)
      .setBackground('#3d1414').setFontColor('#ff4444').setBold(true)
      .setRanges([sh.getRange(row, 3, 20, 1)]).build()
  );
  sh.setConditionalFormatRules(rules);

  row += 20;
  sh.setRowHeight(row, 10);
  row++;
  return row;
}

// ============================================================
//  セクション: 今月の経費（勘定科目別）
// ============================================================

function buildMonthlyExpenses_(sh, row) {
  row = drawSectionHeader_(sh, row, 10, '💰 今月の経費（勘定科目別）');

  const headers = ['勘定科目', '件数', 'USD合計', 'KHR合計', 'JPY合計', 'USD割合', 'バー'];
  sh.getRange(row, 1, 1, 7).setValues([headers])
    .setBackground(DB_COLOR.header).setFontColor(DB_COLOR.gold)
    .setFontWeight('bold').setFontSize(11)
    .setHorizontalAlignment('center');
  sh.setRowHeight(row, 26);
  row++;

  const categories = EXPENSE_CATEGORIES_ || [
    '消耗品費','水道光熱費','通信費','車両費','交通費','会議費','事務用品','広告宣伝費','修繕費','雑費'
  ];

  // 今月初日と翌月初日
  const monthStart = '"&TEXT(EOMONTH(TODAY(),-1)+1,"yyyy-MM-dd")&"';
  const monthEnd   = '"&TEXT(EOMONTH(TODAY(),0),"yyyy-MM-dd")&"';

  categories.forEach(function(cat, i) {
    const r = row + i;
    sh.getRange(r, 1).setValue(cat);
    // 件数
    sh.getRange(r, 2).setFormula(
      '=IFERROR(COUNTIFS(経費!H:H,"' + cat + '",経費!C:C,">=' + monthStart + '",経費!C:C,"<=' + monthEnd + '"),0)'
    );
    // USD合計
    sh.getRange(r, 3).setFormula(
      '=IFERROR(SUMIFS(経費!E:E,経費!H:H,"' + cat + '",経費!F:F,"USD",経費!C:C,">=' + monthStart + '",経費!C:C,"<=' + monthEnd + '"),0)'
    );
    // KHR合計
    sh.getRange(r, 4).setFormula(
      '=IFERROR(SUMIFS(経費!E:E,経費!H:H,"' + cat + '",経費!F:F,"KHR",経費!C:C,">=' + monthStart + '",経費!C:C,"<=' + monthEnd + '"),0)'
    );
    // JPY合計
    sh.getRange(r, 5).setFormula(
      '=IFERROR(SUMIFS(経費!E:E,経費!H:H,"' + cat + '",経費!F:F,"JPY",経費!C:C,">=' + monthStart + '",経費!C:C,"<=' + monthEnd + '"),0)'
    );
    // USD割合
    sh.getRange(r, 6).setFormula(
      '=IFERROR(C' + r + '/SUM(C' + row + ':C' + (row + categories.length - 1) + '),0)'
    ).setNumberFormat('0.0%');
    // SPARKLINE バー
    sh.getRange(r, 7).setFormula(
      '=IF(C' + r + '>0,SPARKLINE(C' + r + ',{"charttype","bar";"max",MAX(C' + row + ':C' + (row + categories.length - 1) + ');"color1","#F57C00"}),"")'
    );
  });

  // 合計行
  const totalRow = row + categories.length;
  sh.getRange(totalRow, 1).setValue('合計');
  sh.getRange(totalRow, 2).setFormula('=SUM(B' + row + ':B' + (totalRow - 1) + ')');
  sh.getRange(totalRow, 3).setFormula('=SUM(C' + row + ':C' + (totalRow - 1) + ')');
  sh.getRange(totalRow, 4).setFormula('=SUM(D' + row + ':D' + (totalRow - 1) + ')');
  sh.getRange(totalRow, 5).setFormula('=SUM(E' + row + ':E' + (totalRow - 1) + ')');
  sh.getRange(totalRow, 6).setValue('100%').setNumberFormat('@');

  // 書式
  const data = sh.getRange(row, 1, categories.length + 1, 7);
  data.setBackground(DB_COLOR.bgCard).setFontColor(DB_COLOR.textMain).setFontSize(11).setVerticalAlignment('middle');
  sh.getRange(row, 1, categories.length + 1, 1).setFontWeight('bold').setFontColor(DB_COLOR.gold).setHorizontalAlignment('left');
  sh.getRange(row, 2, categories.length + 1, 5).setHorizontalAlignment('right');
  sh.getRange(row, 3, categories.length + 1, 1).setNumberFormat('$#,##0.00');
  sh.getRange(row, 4, categories.length + 1, 1).setNumberFormat('#,##0" KHR"');
  sh.getRange(row, 5, categories.length + 1, 1).setNumberFormat('#,##0" JPY"');
  sh.getRange(totalRow, 1, 1, 7).setBackground(DB_COLOR.header).setFontColor(DB_COLOR.gold).setFontWeight('bold');

  row += categories.length + 1;
  sh.setRowHeight(row, 10);
  row++;
  return row;
}

// ============================================================
//  セクション: 今月のスタッフ別勤務時間
// ============================================================

function buildMonthlyWorkHours_(sh, row) {
  row = drawSectionHeader_(sh, row, 10, '📅 今月の勤務時間（スタッフ別）');

  const headers = ['氏名', '出勤日数', '総勤務分', '時間換算', 'バー'];
  sh.getRange(row, 1, 1, 5).setValues([headers])
    .setBackground(DB_COLOR.header).setFontColor(DB_COLOR.gold)
    .setFontWeight('bold').setFontSize(11)
    .setHorizontalAlignment('center');
  sh.setRowHeight(row, 26);
  row++;

  const maxStaff = 20;
  const monthStart = '"&TEXT(EOMONTH(TODAY(),-1)+1,"yyyy-MM-dd")&"';
  const monthEnd   = '"&TEXT(EOMONTH(TODAY(),0),"yyyy-MM-dd")&"';

  // 氏名は FILTER
  sh.getRange(row, 1).setFormula(
    '=IFERROR(FILTER(スタッフマスター!' +
      findColLetter_('スタッフマスター', '氏名(JP)') + '2:' + findColLetter_('スタッフマスター', '氏名(JP)') + ',' +
      'スタッフマスター!' + findColLetter_('スタッフマスター', '有効') + '2:' + findColLetter_('スタッフマスター', '有効') + '=TRUE),"")'
  );

  for (let i = 0; i < maxStaff; i++) {
    const r = row + i;
    const name = 'A' + r;
    // 出勤日数
    sh.getRange(r, 2).setFormula(
      '=IF(' + name + '="","",IFERROR(COUNTIFS(勤怠記録!C:C,' + name + ',勤怠記録!A:A,">=' + monthStart + '",勤怠記録!A:A,"<=' + monthEnd + '",勤怠記録!E:E,"<>"""),0))'
    );
    // 総勤務分
    sh.getRange(r, 3).setFormula(
      '=IF(' + name + '="","",IFERROR(SUMIFS(勤怠記録!G:G,勤怠記録!C:C,' + name + ',勤怠記録!A:A,">=' + monthStart + '",勤怠記録!A:A,"<=' + monthEnd + '"),0))'
    );
    // 時間換算
    sh.getRange(r, 4).setFormula(
      '=IF(' + name + '="","",IF(ISNUMBER(C' + r + '),INT(C' + r + '/60)&"h"&MOD(C' + r + ',60)&"m",""))'
    );
    // SPARKLINE
    sh.getRange(r, 5).setFormula(
      '=IF(OR(' + name + '="",C' + r + '=0),"",SPARKLINE(C' + r + ',{"charttype","bar";"max",MAX(C' + row + ':C' + (row + maxStaff - 1) + ');"color1","#00897B"}))'
    );
  }

  const data = sh.getRange(row, 1, maxStaff, 5);
  data.setBackground(DB_COLOR.bgCard).setFontColor(DB_COLOR.textMain).setFontSize(11).setVerticalAlignment('middle');
  sh.getRange(row, 1, maxStaff, 1).setFontWeight('bold').setFontColor(DB_COLOR.gold).setHorizontalAlignment('left');
  sh.getRange(row, 2, maxStaff, 3).setHorizontalAlignment('center');
  for (let i = 0; i < maxStaff; i++) sh.setRowHeight(row + i, 24);

  row += maxStaff;
  sh.setRowHeight(row, 10);
  row++;
  return row;
}

// ============================================================
//  セクション: 今週の日報提出マトリクス
// ============================================================

function buildWeeklyReportMatrix_(sh, row) {
  row = drawSectionHeader_(sh, row, 10, '📝 今週の日報提出状況');

  // ヘッダー: 氏名 / Mon-Sun の日付（今週）
  // 月曜を週の頭とする
  const headers = ['氏名', '月', '火', '水', '木', '金', '土', '日', '今週'];
  sh.getRange(row, 1, 1, 9).setValues([headers])
    .setBackground(DB_COLOR.header).setFontColor(DB_COLOR.gold)
    .setFontWeight('bold').setFontSize(11).setHorizontalAlignment('center');
  sh.setRowHeight(row, 24);
  row++;

  // 日付行（動的）
  sh.getRange(row, 1).setValue('日付 →').setFontColor(DB_COLOR.textDim).setFontStyle('italic');
  for (let d = 0; d < 7; d++) {
    // 今週の月曜 + d
    const formula = '=TEXT(TODAY()-WEEKDAY(TODAY(),2)+1+' + d + ',"M/d")';
    sh.getRange(row, 2 + d).setFormula(formula)
      .setFontColor(DB_COLOR.textDim).setFontSize(10);
  }
  sh.getRange(row, 9).setValue('件数').setFontColor(DB_COLOR.textDim).setFontStyle('italic');
  sh.getRange(row, 1, 1, 9)
    .setBackground(DB_COLOR.bgCard)
    .setHorizontalAlignment('center');
  row++;

  const maxStaff = 20;

  // 氏名
  sh.getRange(row, 1).setFormula(
    '=IFERROR(FILTER(スタッフマスター!' +
      findColLetter_('スタッフマスター', '氏名(JP)') + '2:' + findColLetter_('スタッフマスター', '氏名(JP)') + ',' +
      'スタッフマスター!' + findColLetter_('スタッフマスター', '有効') + '2:' + findColLetter_('スタッフマスター', '有効') + '=TRUE),"")'
  );

  for (let i = 0; i < maxStaff; i++) {
    const r = row + i;
    const name = 'A' + r;
    for (let d = 0; d < 7; d++) {
      // 対応日 = 今週月曜+d
      sh.getRange(r, 2 + d).setFormula(
        '=IF(' + name + '="","",' +
        'LET(d,TEXT(TODAY()-WEEKDAY(TODAY(),2)+1+' + d + ',"yyyy-MM-dd"),' +
        'IF(IFERROR(COUNTIFS(日報!D:D,' + name + ',日報!C:C,d),0)>0,"✅","·")))'
      );
    }
    // 今週提出数
    sh.getRange(r, 9).setFormula(
      '=IF(' + name + '="","",' +
      'IFERROR(COUNTIFS(日報!D:D,' + name + ',日報!C:C,">="&TEXT(TODAY()-WEEKDAY(TODAY(),2)+1,"yyyy-MM-dd"),日報!C:C,"<="&TEXT(TODAY()-WEEKDAY(TODAY(),2)+7,"yyyy-MM-dd")),0))'
    );
  }

  const data = sh.getRange(row, 1, maxStaff, 9);
  data.setBackground(DB_COLOR.bgCard).setFontColor(DB_COLOR.textMain).setFontSize(12).setVerticalAlignment('middle');
  sh.getRange(row, 1, maxStaff, 1).setFontWeight('bold').setFontColor(DB_COLOR.gold).setHorizontalAlignment('left').setFontSize(11);
  sh.getRange(row, 2, maxStaff, 8).setHorizontalAlignment('center');
  for (let i = 0; i < maxStaff; i++) sh.setRowHeight(row + i, 24);

  // 条件付き書式: ✅を緑に
  const rules = sh.getConditionalFormatRules();
  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('✅')
      .setBackground('#143d2f').setFontColor('#7fffb0')
      .setRanges([sh.getRange(row, 2, maxStaff, 7)]).build()
  );
  sh.setConditionalFormatRules(rules);

  row += maxStaff;
  return row;
}

// ============================================================
//  セクション見出し
// ============================================================

function drawSectionHeader_(sh, row, cols, text) {
  sh.getRange(row, 1, 1, cols).merge()
    .setValue('━━━  ' + text + '  ━━━')
    .setBackground(DB_COLOR.bgCard)
    .setFontColor(DB_COLOR.gold)
    .setFontWeight('bold')
    .setFontSize(13)
    .setHorizontalAlignment('left')
    .setVerticalAlignment('middle');
  sh.setRowHeight(row, 30);
  return row + 1;
}

// ============================================================
//  v7 売上キャッシュ
// ============================================================

function ensureCacheSheet_(ss) {
  let sh = ss.getSheetByName(DASHBOARD_CACHE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(DASHBOARD_CACHE_SHEET);
    sh.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
  }
  // 非表示にする
  try { sh.hideSheet(); } catch (e) {}
}

function refreshV7SalesCache_(ss) {
  const cache = ss.getSheetByName(DASHBOARD_CACHE_SHEET);
  if (!cache) return;

  const cfg = getConfig();
  const tz = OPS_TZ;
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  const values = [
    ['key',                   'value'],
    ['generated_at',          new Date()],
    ['today_sales',           0],
    ['today_bookings',        0],
    ['today_completed_jobs',  0],
    ['today_paid_usd',        0]
  ];

  if (cfg.v7SpreadsheetId) {
    try {
      const v7 = SpreadsheetApp.openById(cfg.v7SpreadsheetId);
      const sh = v7.getSheetByName('予約');
      if (sh) {
        const lastRow = sh.getLastRow();
        if (lastRow >= 2) {
          const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
          const rows = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();
          const ssTz = v7.getSpreadsheetTimeZone() || tz;

          const idxDate    = headers.indexOf('予約日');
          const idxAmount  = headers.indexOf('料金(USD)');
          const idxStatus  = headers.indexOf('進行状態');
          const idxPayment = headers.indexOf('決済状態');

          let sales = 0, bookings = 0, completed = 0, paid = 0;
          rows.forEach(function(r) {
            const d = r[idxDate];
            const ds = (d instanceof Date)
              ? Utilities.formatDate(d, ssTz, 'yyyy-MM-dd')
              : String(d).trim().substring(0, 10);
            if (ds !== todayStr) return;
            const prog = String(r[idxStatus] || '');
            if (prog === 'cancelled') return;
            bookings++;
            const amt = Number(r[idxAmount]) || 0;
            sales += amt;
            if (prog === 'completed') completed++;
            if (String(r[idxPayment] || '') === '清算済み') paid += amt;
          });
          values[2][1] = sales;
          values[3][1] = bookings;
          values[4][1] = completed;
          values[5][1] = paid;
        }
      }
    } catch (err) {
      Logger.log('⚠️ v7売上キャッシュ更新失敗: ' + err);
    }
  }

  cache.clear();
  cache.getRange(1, 1, values.length, 2).setValues(values);
}

// ============================================================
//  ユーティリティ
// ============================================================

function openOps_() {
  const cfg = getConfig();
  return SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
}

/**
 * 列ヘッダー（文字列）から列文字を返す（例: 'A','B',...）
 */
function findColLetter_(sheetName, headerName) {
  const sh = getSheet(sheetName);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const idx = headers.indexOf(headerName);
  if (idx < 0) {
    Logger.log('⚠️ findColLetter_ 列 ' + headerName + ' 未発見 in ' + sheetName + ' → A にフォールバック');
    return 'A';
  }
  return indexToLetter_(idx + 1);
}

function indexToLetter_(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function letterToIndex_(letter) {
  let n = 0;
  for (let i = 0; i < letter.length; i++) {
    n = n * 26 + (letter.charCodeAt(i) - 64);
  }
  return n;
}
