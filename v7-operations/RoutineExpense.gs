/**
 * RoutineExpense.gs — 月次ルーティン経費の自動計上
 *
 * 「ルーティン経費」シートの 計上方法=🤖自動 の行を、毎月1日に経費マスターへ自動転記する。
 * 対象例: スターリンク月額(RT-003)・システム構築Claudecode(RT-004)。
 * 給与(RT-001)・家賃(RT-002)は 🖐手動 のため対象外。
 *
 * 二重計上防止: 元ID "RT-XXX-YYYY-MM" が経費マスター(O列)に既存ならスキップ。
 * トリガー: setupRoutineExpenseTrigger() で毎月1日6時に autoPostRoutineExpenses を実行。
 */

const ROUTINE_SHEET_ = 'ルーティン経費';

function autoPostRoutineExpenses() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  const rtSheet = ss.getSheetByName(ROUTINE_SHEET_);
  const msSheet = ss.getSheetByName(EXPENSE_MASTER_SHEET_);
  if (!rtSheet || !msSheet) { Logger.log('⚠️ routine: シート不足'); return 0; }

  const ym = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM');  // 例 2026-07
  const firstOfMonth = ym + '-01';

  // 経費マスター 既存元ID（O列=15, データ4行目以降）
  const mLast = msSheet.getLastRow();
  const posted = {};
  if (mLast >= 4) {
    msSheet.getRange(4, 15, mLast - 3, 1).getValues().forEach(function(r) {
      const v = String(r[0]).trim(); if (v) posted[v] = true;
    });
  }

  // ルーティン定義（行5以降 A:M）
  const rtLast = rtSheet.getLastRow();
  if (rtLast < 5) { Logger.log('ℹ️ routine: 定義なし'); return 0; }
  const defs = rtSheet.getRange(5, 1, rtLast - 4, 13).getValues();

  let count = 0;
  defs.forEach(function(d, idx) {
    const id = String(d[0] || '').trim();                 // A: ID (RT-XXX)
    if (!/^RT-/.test(id)) return;                          // 定義行のみ
    if (String(d[11] || '').indexOf('自動') < 0) return;  // L:計上方法 が 🤖自動 のみ
    const item = String(d[1] || '').trim();               // B: 項目
    const amount = Number(d[2]);                          // C: 金額
    if (!amount || amount <= 0) return;
    const currency = String(d[3] || 'USD').trim().toUpperCase(); // D: 通貨
    const category = String(d[5] || 'その他').trim();     // F: カテゴリ
    const payer = String(d[6] || '会社').trim();          // G: 負担先
    const payMethod = String(d[7] || '').trim();          // H: 支払方法
    const endMonth = String(d[9] || '').trim();           // J: 終了月（継続中 or yyyy-mm）

    // 終了月チェック（継続中以外で当月が終了月を超えていたら対象外）
    if (endMonth && endMonth !== '継続中') {
      const endYm = endMonth.length >= 7 ? endMonth.substring(0, 7) : endMonth;
      if (ym > endYm) return;
    }

    const oid = id + '-' + ym;                            // 元ID: RT-XXX-YYYY-MM
    if (posted[oid]) return;                              // 二重計上防止

    appendRoutineToMaster_(msSheet, {
      date: firstOfMonth,
      category: category,
      item: item + '（' + ym + '・自動計上）',
      amount: amount, currency: currency, payer: payer, payMethod: payMethod,
      note: 'ルーティン ' + id + ' / 月次自動計上', oid: oid
    });
    posted[oid] = true;
    rtSheet.getRange(5 + idx, 13).setValue(firstOfMonth); // M:最終自動計上 更新
    count++;
  });
  Logger.log('🔁 routine: ' + count + '件を経費マスターへ自動計上 (' + ym + ')');
  return count;
}

/** ルーティン1件を経費マスターへ追記（冪等・書式コピー付き） */
function appendRoutineToMaster_(sheet, p) {
  const lastRow = sheet.getLastRow();
  if (lastRow >= 4) {
    const oidCol = sheet.getRange(4, 15, lastRow - 3, 1).getValues();
    for (let i = 0; i < oidCol.length; i++) {
      if (String(oidCol[i][0]).trim() === p.oid) { Logger.log('⏭️ routine既存: ' + p.oid); return; }
    }
  }
  const newRow = lastRow + 1, r = newRow;
  const jpyFormula =
    '=IF(P' + r + '<>"○",0,IF(Q' + r + '<>"●",0,' +
    'IF(E' + r + '="USD",D' + r + '*設定!$B$4,' +
    'IF(E' + r + '="KHR",D' + r + '*設定!$B$5,' +
    'IF(E' + r + '="JPY",D' + r + ',0)))))';
  const monthFormula = '=IFERROR(TEXT(A' + r + ',"yyyy-mm"),"")';
  let nextId = 1;
  if (lastRow >= 4) {
    const prevId = sheet.getRange(lastRow, 13).getValue();
    if (typeof prevId === 'number') nextId = prevId + 1;
    else if (prevId) nextId = (Number(prevId) || 0) + 1;
  }
  sheet.getRange(newRow, 1, 1, 17).setValues([[
    p.date, p.category, p.item, p.amount, p.currency, p.payer, p.payMethod, '',
    p.note, '自動', jpyFormula, monthFormula, nextId, 'ルーティン自動計上', p.oid, '○', '●'
  ]]);
  if (lastRow >= 4) {
    sheet.getRange(lastRow, 1, 1, 17).copyTo(
      sheet.getRange(newRow, 1, 1, 17), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sheet.setRowHeight(newRow, 36);
  }
  Logger.log('📋 routine転記: row=' + newRow + ' ' + p.oid + ' ' + p.item);
}

/** 毎月1日6時のトリガーを設定（初回のみ手動実行） */
function setupRoutineExpenseTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'autoPostRoutineExpenses') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('autoPostRoutineExpenses').timeBased().onMonthDay(1).atHour(6).create();
  Logger.log('✅ autoPostRoutineExpenses 毎月1日6時トリガー設定完了');
}

/** デバッグ: 手動で当月分を自動計上 */
function debugAutoPostRoutineExpenses() {
  Logger.log('結果: ' + autoPostRoutineExpenses() + '件');
}
