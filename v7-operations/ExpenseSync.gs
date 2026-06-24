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
 *   - 立替は appendToExpenseMaster_ 側で「立替（残金別管理）」ラベル付与＝D2集計対象外
 *     （ロン君残金は前払い管理シートの実残高カウントで管理する物理アンカー方式）
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
        txDate:      String(r[2] || '').trim(),           // C: 取引日
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
