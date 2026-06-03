/**
 * RoutineExpense.gs — ルーティン経費の自動計上
 *
 * 目的:
 *   「ルーティン経費」シートで「計上方法 = 🤖 自動」の行を、
 *   毎月1日に「経費マスター」へ自動計上する。
 *   現状の対象: WiFi通信費（RT-003, 飯泉個人AMEX引き落とし）
 *
 * 二重計上防止:
 *   元ID を「RT-XXX-YYYY-MM」形式（例 RT-003-2026-06）で発番し、
 *   経費マスターの O列（元ID）に同じものが既にあればスキップする。
 *
 * トリガー:
 *   setupRoutineExpenseTrigger() を1回実行 → 毎月1日 06:00 (Asia/Phnom_Penh) に自動実行
 *
 * 注意:
 *   「経費マスター」はヘッダーが3行目（1行目タイトル/2行目説明）にある特殊構造。
 *   そのため SheetHelpers.appendRow は使わず、最終行+1へ直接書き込む。
 */

// ルーティン経費シートの列インデックス（0始まり）
var RT_COL_ID         = 0;   // A: ID (RT-003)
var RT_COL_ITEM       = 1;   // B: 項目
var RT_COL_AMOUNT     = 2;   // C: 金額
var RT_COL_CURRENCY   = 3;   // D: 通貨
var RT_COL_CATEGORY   = 5;   // F: カテゴリ
var RT_COL_PAYER      = 6;   // G: 負担先
var RT_COL_METHOD     = 7;   // H: 支払方法
var RT_COL_END_MONTH  = 9;   // J: 終了月
var RT_COL_POST_MODE  = 11;  // L: 計上方法（🤖 自動 / 🖐 手動）
var RT_COL_LAST_POST  = 12;  // M: 最終自動計上（YYYY-MM）
var RT_DATA_START_ROW = 5;   // データ開始行（1始まり）

// 経費マスターのデータ開始行（ヘッダーが3行目）
var EM_DATA_START_ROW = 4;
var EM_COL_SRC_ID     = 15;  // O列（1始まり）= 元ID


/**
 * ルーティン経費の自動計上（毎月1日トリガーで実行）
 * @return {number} 追加した件数
 */
function autoPostRoutineExpenses() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  const routineSheet = ss.getSheetByName(SHEET_NAMES.ROUTINE_EXPENSES);
  const masterSheet  = ss.getSheetByName(SHEET_NAMES.EXPENSE_MASTER);

  if (!routineSheet) { Logger.log('⚠️ ルーティン経費シート未発見'); return 0; }
  if (!masterSheet)  { Logger.log('⚠️ 経費マスターシート未発見'); return 0; }

  const tz = OPS_TZ;
  const now = new Date();
  const ym    = Utilities.formatDate(now, tz, 'yyyy-MM');     // 例 2026-06
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  // ルーティン定義（行5以降, A〜M = 13列）
  const rLast = routineSheet.getLastRow();
  if (rLast < RT_DATA_START_ROW) { Logger.log('ルーティン定義なし'); return 0; }
  const defs = routineSheet.getRange(RT_DATA_START_ROW, 1, rLast - RT_DATA_START_ROW + 1, 13).getValues();

  // 経費マスターの既存「元ID」一覧（重複チェック用）
  const mLast = masterSheet.getLastRow();
  const existingIds = (mLast >= EM_DATA_START_ROW)
    ? masterSheet.getRange(EM_DATA_START_ROW, EM_COL_SRC_ID, mLast - EM_DATA_START_ROW + 1, 1)
        .getValues().reduce(function(acc, r) { acc.push(String(r[0])); return acc; }, [])
    : [];

  let added = 0;

  for (let i = 0; i < defs.length; i++) {
    const r = defs[i];
    const id        = String(r[RT_COL_ID] || '').trim();
    if (!id) continue;

    const postMode  = String(r[RT_COL_POST_MODE] || '');
    if (postMode.indexOf('自動') < 0) continue;  // 「🤖 自動」のみ対象

    // 終了月チェック（終了済みならスキップ）
    const endMonth = String(r[RT_COL_END_MONTH] || '').trim();
    if (endMonth && /^\d{4}-\d{2}$/.test(endMonth) && endMonth < ym) continue;

    const targetId = id + '-' + ym;  // 例 RT-003-2026-06
    if (existingIds.indexOf(targetId) >= 0) {
      Logger.log('⏭️ 計上済みスキップ: ' + targetId);
      continue;
    }

    const item     = String(r[RT_COL_ITEM] || '').trim();
    const amount   = Number(String(r[RT_COL_AMOUNT] || '0').replace(/,/g, ''));
    const currency = String(r[RT_COL_CURRENCY] || 'JPY').trim().toUpperCase();
    const category = String(r[RT_COL_CATEGORY] || 'その他').trim();
    const payer    = String(r[RT_COL_PAYER] || '').trim();
    const method   = String(r[RT_COL_METHOD] || '').trim();

    if (!amount || isNaN(amount) || amount <= 0) {
      Logger.log('⚠️ 金額不正でスキップ: ' + targetId);
      continue;
    }

    // 経費マスター 最終行+1 へ書き込み
    const row = masterSheet.getLastRow() + 1;
    const jpyFormula =
      '=IF(P' + row + '<>"○",0,IF(Q' + row + '<>"●",0,' +
      'IF(E' + row + '="USD",D' + row + '*設定!$B$4,' +
      'IF(E' + row + '="KHR",D' + row + '*設定!$B$5,' +
      'IF(E' + row + '="JPY",D' + row + ',0)))))';
    const monthFormula = '=IFERROR(TEXT(A' + row + ',"yyyy-mm"),"")';
    const newSeq = row - (EM_DATA_START_ROW - 1);  // 連番（ヘッダー3行ぶん控除）

    masterSheet.getRange(row, 1, 1, 17).setValues([[
      today,                                  // A 日付
      category,                               // B カテゴリ
      item + '（' + ym + '・自動計上）',        // C 項目
      amount,                                 // D 金額
      currency,                               // E 通貨
      payer,                                  // F 負担先
      method,                                 // G 支払方法
      '',                                     // H レシート
      'ルーティン ' + id + ' / GAS自動計上',   // I 備考
      '自動',                                 // J 入力者
      jpyFormula,                             // K JPY換算
      monthFormula,                           // L 月
      newSeq,                                 // M ID
      'ルーティン自動計上',                     // N 出典
      targetId,                               // O 元ID
      '○',                                    // P 集計対象
      '●'                                     // Q 経費計上
    ]]);

    // 直前行の書式をコピー（見た目を揃える）
    if (row > EM_DATA_START_ROW) {
      const srcRange = masterSheet.getRange(row - 1, 1, 1, 17);
      const dstRange = masterSheet.getRange(row, 1, 1, 17);
      srcRange.copyTo(dstRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    }

    // ルーティン経費シートの「最終自動計上」列（M列）を更新
    routineSheet.getRange(RT_DATA_START_ROW + i, RT_COL_LAST_POST + 1).setValue(ym);

    existingIds.push(targetId);
    added++;
    Logger.log('✅ ルーティン自動計上: ' + targetId + ' / ' + item + ' / ' + amount + ' ' + currency);
  }

  Logger.log('🔁 ルーティン自動計上 完了: ' + added + '件');
  return added;
}


/**
 * 毎月1日 06:00 (Asia/Phnom_Penh) に autoPostRoutineExpenses を実行するトリガーを設定。
 * 初回のみ手動で1回実行すること（GASエディタの実行ボタン）。
 */
function setupRoutineExpenseTrigger() {
  // 既存の同名トリガーを削除（重複防止）
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'autoPostRoutineExpenses') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // 毎月1日 06:00 に実行
  ScriptApp.newTrigger('autoPostRoutineExpenses')
    .timeBased()
    .onMonthDay(1)
    .atHour(6)
    .inTimezone(OPS_TZ)
    .create();
  Logger.log('✅ ルーティン自動計上トリガー設定完了（毎月1日 06:00 ' + OPS_TZ + '）');
}
