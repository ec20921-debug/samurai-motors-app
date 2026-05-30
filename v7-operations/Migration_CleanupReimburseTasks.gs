/**
 * Migration_CleanupReimburseTasks.gs — 立替精算タスクの滞留行を掃除（使い捨て）
 *
 * 2026-05-30 マイグレーション:
 *   立替経費の精算タスク自動生成を廃止（経費マスター一本化）したのに伴い、
 *   過去に createExpenseReimburseTask_ が生成し、朝通知停止（2026-05-21〜）で
 *   誰にも届かず「未着手」のまま滞留している精算タスク行を掃除する。
 *
 * 【対象】タスクシートの行のうち、
 *   - 「関連経費ID」が非空（= 立替精算タスクとして自動生成された行）
 *   - かつ「ステータス」= 未着手（一度も操作されていない滞留行）
 *   ※ 完了 / 未完了 の行は「実際に精算した履歴」なので残す（削除しない）
 *
 * 【実行方法】
 *   1. まず dryRunCleanupReimburseTasks() を実行 → 削除候補をログで確認
 *   2. 問題なければ cleanupReimburseTasks() を実行 → 実削除
 *      （削除前に各行の内容をログ出力するので、実行ログから復元可能）
 *
 * 【後始末】
 *   実行成功後、本ファイルは削除して構わない（本番コード肥大化防止）。
 *   v7-operations は .claspignore で Migration_* を除外しないため、
 *   削除しないと clasp push でリモート GAS に残る点に注意。
 */

/**
 * 削除候補を抽出（共通ロジック）。シートは変更しない。
 * @return {{ sheet: Sheet, headers: string[], idxRelExp: number, idxStatus: number,
 *            candidates: Array<{ rowNumber: number, values: Object }> }}
 */
function _collectOrphanReimburseTasks_() {
  const sheet = getSheet(SHEET_NAMES.TASKS);
  const headers = getHeaders(SHEET_NAMES.TASKS);
  const idxRelExp = headers.indexOf('関連経費ID');
  const idxStatus = headers.indexOf('ステータス');
  if (idxRelExp < 0 || idxStatus < 0) {
    throw new Error('タスクシートに「関連経費ID」または「ステータス」列が見つかりません');
  }

  const lastRow = sheet.getLastRow();
  const candidates = [];
  if (lastRow >= 2) {
    const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    values.forEach(function(row, i) {
      const relExp = String(row[idxRelExp] || '').trim();
      const status = String(row[idxStatus] || '').trim();
      if (relExp && status === '未着手') {
        const obj = {};
        headers.forEach(function(h, j) { obj[h] = row[j]; });
        candidates.push({ rowNumber: i + 2, values: obj }); // +2: ヘッダー行 + 0始まり補正
      }
    });
  }
  return { sheet: sheet, headers: headers, idxRelExp: idxRelExp, idxStatus: idxStatus, candidates: candidates };
}

/**
 * Dry-run: 削除候補をログ出力するだけ。シートは一切変更しない。
 */
function dryRunCleanupReimburseTasks() {
  const r = _collectOrphanReimburseTasks_();
  Logger.log('🔍 立替精算タスク（未着手）の削除候補: ' + r.candidates.length + '件');
  r.candidates.forEach(function(c) {
    Logger.log('  row=' + c.rowNumber +
      ' / ' + String(c.values['タスクID']) +
      ' / 担当=' + String(c.values['担当者名']) +
      ' / 経費=' + String(c.values['関連経費ID']) +
      ' / ' + String(c.values['タスク内容']).substring(0, 60));
  });
  Logger.log('▶️ 問題なければ cleanupReimburseTasks() を実行してください。');
  return { count: r.candidates.length };
}

/**
 * 実削除: 未着手の立替精算タスク行を削除する。
 * 削除前に各行の全内容をログ出力（実行ログから復元可能にするため）。
 * 行番号のズレを避けるため、必ず下（大きい行番号）から削除する。
 */
function cleanupReimburseTasks() {
  const r = _collectOrphanReimburseTasks_();
  if (r.candidates.length === 0) {
    Logger.log('✅ 削除対象なし（未着手の立替精算タスクは存在しません）');
    return { deleted: 0 };
  }

  Logger.log('🗑 立替精算タスク（未着手）を削除します: ' + r.candidates.length + '件');
  // 下から削除（rowNumber 降順）
  const ordered = r.candidates.slice().sort(function(a, b) { return b.rowNumber - a.rowNumber; });
  let deleted = 0;
  ordered.forEach(function(c) {
    Logger.log('  削除 row=' + c.rowNumber + ' : ' + JSON.stringify(c.values));
    r.sheet.deleteRow(c.rowNumber);
    deleted++;
  });
  Logger.log('✅ 削除完了: ' + deleted + '件');
  return { deleted: deleted };
}
