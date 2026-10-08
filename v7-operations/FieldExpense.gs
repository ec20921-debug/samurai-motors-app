/**
 * FieldExpense.gs — 現場アプリ v2 の経費登録（2026-10-08）
 *
 * 圏外で保存した経費は、電波が戻ると送り直される。応答が届かず同じ記録がもう一度来ても
 * 1件だけ登録するため、記録ごとの client_id を「経費」シートの client_id 列で照合する。
 *   - client_id 列が無ければ末尾に追加（既存の列位置は変えない。ExpenseSync は A〜T 列だけを読む）
 *   - 照合 → 登録までをスクリプトロックで囲む（同時に2本来ても二重にならない）
 *   - 登録処理そのものは既存の submitExpense（前払い金の固定・経費マスター転記・通知もそのまま）
 */

function ensureExpenseClientIdCol_() {
  const sheet = getSheet(SHEET_NAMES.EXPENSES);
  const headers = getHeaders(SHEET_NAMES.EXPENSES);
  let idx = headers.indexOf('client_id');
  if (idx >= 0) return { sheet: sheet, col: idx + 1 };
  sheet.getRange(1, headers.length + 1).setValue('client_id');
  SpreadsheetApp.flush();
  idx = getHeaders(SHEET_NAMES.EXPENSES).indexOf('client_id');
  if (idx < 0) throw new Error('client_id 列を追加できませんでした');
  return { sheet: sheet, col: idx + 1 };
}

/** シートに書く自由入力が = + - @ で始まると数式として動くため、先頭に ' を付けて文字として保存する */
function safeCellText_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function submitExpenseV2_(chatId, payload, clientId) {
  if (!/^[0-9a-fA-F-]{36}$/.test(String(clientId || ''))) return { ok: false, error: 'INVALID_CLIENT_ID' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'BUSY', message: '混雑中。あとで自動で送り直します' };
  try {
    const c = ensureExpenseClientIdCol_();
    const last = c.sheet.getLastRow();
    if (last >= 2) {
      const ids = c.sheet.getRange(2, c.col, last - 1, 1).getValues();
      for (let i = ids.length - 1; i >= 0; i--) {
        if (String(ids[i][0]) === clientId) {
          const expenseId = String(c.sheet.getRange(i + 2, 1).getValue());
          return { ok: true, status: 'duplicate', expenseId: expenseId };
        }
      }
    }
    payload.clientId = clientId;
    payload.skipFuzzyDup = true;
    payload.description = safeCellText_(payload.description);
    payload.memo = safeCellText_(payload.memo);
    payload.vendor = safeCellText_(payload.vendor);
    const res = submitExpense(chatId, payload);
    if (res && res.ok) res.status = res.duplicate ? 'duplicate' : 'ok';
    return res;
  } finally {
    lock.releaseLock();
  }
}
