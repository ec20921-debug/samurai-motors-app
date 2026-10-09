/**
 * ExpenseSync.gs — 経費(Bot)→経費マスター 取りこぼし同期（安全網）
 *
 * 【背景】
 *   submitExpense() は appendToExpenseMaster_ で経費マスターへ自動転記するが、
 *   過去 getActive() 不具合や一時エラーで取りこぼした行が「経費」タブに滞留した
 *   （例: 2026-06 に EXP-20260529〜0624 の6件が滞留）。本ファイルは未転記行を
 *   検出して経費マスターへ一括転記する安全網。
 *
 * 【トリガー】setupExpenseSyncTrigger() で毎時実行（appendToExpenseMaster_ が
 *   元IDで冪等なので多重実行しても二重転記しない）。
 *
 * 【方針】
 *   - 既に元IDが経費マスター(O列)にあるものはスキップ
 *   - テスト・金額0・Codex等の動作確認行はスキップ
 *   - ロン君の立替入力は appendToExpenseMaster_ 側で「前払い金（ロン君）」・負担先=飯泉 として記録
 *     （前払い管理 D2 に算入され残金が自動で減る。2026-09-27 改訂）
 */

function syncMissingBotExpensesToMaster() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  const botSheet = ss.getSheetByName(SHEET_NAMES.EXPENSES);
  const masterSheet = ss.getSheetByName(EXPENSE_MASTER_SHEET_);
  if (!botSheet || !masterSheet) {
    Logger.log('⚠️ sync: 経費/経費マスター シートが見つからない');
    return 0;
  }

  // 既に転記済みの元ID集合（O列=15, データは4行目以降）
  const mLast = masterSheet.getLastRow();
  const transferred = {};
  if (mLast >= 4) {
    masterSheet.getRange(4, 15, mLast - 3, 1).getValues().forEach(function(r) {
      const v = String(r[0]).trim();
      if (v) transferred[v] = true;
    });
  }

  const bLast = botSheet.getLastRow();
  if (bLast < 2) { Logger.log('ℹ️ sync: 経費(Bot)行なし'); return 0; }
  const rows = botSheet.getRange(2, 1, bLast - 1, 20).getValues();

  let count = 0;
  rows.forEach(function(r) {
    const expenseId = String(r[0] || '').trim();        // A: 経費ID
    if (!expenseId || transferred[expenseId]) return;    // 未転記のみ
    const desc = String(r[3] || '').trim();              // D: 品目・摘要
    const amount = Number(r[4]);                         // E: 金額
    const registrant = String(r[8] || '').trim();        // I: 登録者
    // テスト・無効はスキップ
    if (!amount || amount <= 0) return;
    if (/テスト|接続テスト|かきコピー/.test(desc)) return;
    if (/Codex|TEST/i.test(registrant)) return;

    try {
      appendToExpenseMaster_({
        expenseId:   expenseId,
        // C: 取引日。セルが Date 型だと String() で "Fri Jun 26 2026 ..." になり月別集計から漏れる
        //    （2026-06〜07 に6件発生）→ Date は yyyy-MM-dd に整形する（2026-09-27 修正）
        txDate:      (r[2] instanceof Date)
                       ? Utilities.formatDate(r[2], 'Asia/Phnom_Penh', 'yyyy-MM-dd')
                       : String(r[2] || '').trim(),
        desc:        desc,
        amount:      amount,
        currency:    String(r[5] || 'USD').trim().toUpperCase(), // F: 通貨
        vendor:      String(r[6] || '').trim(),           // G: 取引先
        category:    String(r[7] || '').trim(),           // H: 勘定科目
        memo:        String(r[13] || '').trim(),          // N: メモ
        paymentType: String(r[14] || '会社直払い').trim(),// O: 立替区分
        reimburseTo: String(r[15] || '').trim(),          // P: 精算先
        receiptUrl:  '',                                  // 同期分はレシートURL省略（Bot側で参照可）
        staff:       { nameJp: registrant || 'ロン' }
      });
      transferred[expenseId] = true; // 同一実行内の重複防止
      count++;
    } catch (e) {
      Logger.log('⚠️ sync 転記失敗 ' + expenseId + ': ' + e);
    }
  });
  Logger.log('🔄 sync: ' + count + '件を経費マスターへ転記');
  return count;
}

/**
 * 毎時の取りこぼし同期トリガーを設定（既存の同名トリガーは張り替え）。
 * 初回のみ手動実行する。
 */
function setupExpenseSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncMissingBotExpensesToMaster') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('syncMissingBotExpensesToMaster')
    .timeBased().everyHours(1).create();
  Logger.log('✅ syncMissingBotExpensesToMaster 毎時トリガー設定完了');
}

/** デバッグ: 手動で同期実行 */
function debugSyncMissingBotExpenses() {
  const n = syncMissingBotExpensesToMaster();
  Logger.log('結果: ' + n + '件転記');
}

/**
 * 【1回だけ手動実行】2026-10 の経費マスター転記失敗の後始末（2026-10-09）
 *   原因: 経費マスター B列の入力規則が旧10分類のままで「車両費」「広告宣伝費」「地代家賃」等が拒否されていた。
 *   ① B列の入力規則を 17分類に更新
 *   ② 転記失敗で残った「日付(A列)だけの行」（B〜Q がすべて空）を削除（毎時の同期リトライで約170行）
 *   ③ 取りこぼし同期（経費タブ→経費マスター）と当月ルーティン経費の自動計上をやり直す
 *   → ロン君残金（前払い管理 F2）に未反映だった経費が反映される
 * 先に previewExpenseMasterRepair() で対象をログ確認してから実行するのが安全。
 */
function repairExpenseMasterAfterValidationBug() {
  return runExpenseMasterRepair_(false);
}

/** 上の修復の確認だけ（シートは変更しない） */
function previewExpenseMasterRepair() {
  return runExpenseMasterRepair_(true);
}

function runExpenseMasterRepair_(dryRun) {
  const ss = SpreadsheetApp.openById(getConfig().operationsSpreadsheetId);
  const sheet = ss.getSheetByName(EXPENSE_MASTER_SHEET_);
  if (!sheet) { Logger.log('⚠️ 経費マスターなし'); return; }
  Logger.log('残金(修復前): ' + getRonPrepaidBalance_());

  const lastRow = sheet.getLastRow();
  const junk = [];
  if (lastRow >= 4) {
    sheet.getRange(4, 1, lastRow - 3, 17).getValues().forEach(function(r, i) {
      if (!(r[0] instanceof Date)) return;
      for (let c = 1; c < 17; c++) { if (r[c] !== '' && r[c] !== null) return; }
      junk.push(4 + i);
    });
  }
  Logger.log('日付だけの行: ' + junk.length + '行 ' + (junk.length ? '(' + junk[0] + '〜' + junk[junk.length - 1] + ')' : ''));
  if (dryRun) { Logger.log('（確認のみ。変更なし）'); return junk.length; }

  ensureMasterCategoryValidation_(sheet, '車両費');

  // 下から連続区間ごとに削除（行番号がずれないように）
  for (let k = junk.length - 1; k >= 0; ) {
    let start = junk[k], count = 1;
    while (k - count >= 0 && junk[k - count] === start - 1) { start--; count++; }
    sheet.deleteRows(start, count);
    k -= count;
  }
  SpreadsheetApp.flush();

  Logger.log('同期: ' + syncMissingBotExpensesToMaster() + '件');
  Logger.log('ルーティン: ' + autoPostRoutineExpenses() + '件');
  Logger.log('残金(修復後): ' + getRonPrepaidBalance_());
  return junk.length;
}
