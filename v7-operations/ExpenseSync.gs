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
  try { postOctoberRoutineCatchUpOnce_(); } catch (e) { Logger.log('⚠️ 10月ルーティン追い計上失敗: ' + e); }
  try { notifyRonBalanceCorrectionOnce_(); } catch (e) { Logger.log('⚠️ 残金訂正のお知らせ失敗: ' + e); }
  return count;
}

// 2026-10-01 の月次自動計上は家賃の書き込み失敗で止まり、RT-002（家賃）・RT-003（スターリンク）・RT-004（Claude）の
// 10月分が未計上。そろうまで毎時の同期で追い計上する（2026-10 中のみ。元IDで冪等。Daisuke 指示 2026-10-09）
const ROUTINE_CATCHUP_FLAG_202610_ = 'ROUTINE_CATCHUP_2026_10';
const ROUTINE_CATCHUP_IDS_202610_ = ['RT-002-2026-10', 'RT-003-2026-10', 'RT-004-2026-10'];

function postOctoberRoutineCatchUpOnce_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(ROUTINE_CATCHUP_FLAG_202610_) === 'done') return;
  // autoPostRoutineExpenses は「当月分」を計上するため、10月を過ぎたら何もしない
  if (Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM') !== '2026-10') return;

  Logger.log('🔁 10月ルーティン追い計上: ' + autoPostRoutineExpenses() + '件');

  const master = SpreadsheetApp.openById(getConfig().operationsSpreadsheetId).getSheetByName(EXPENSE_MASTER_SHEET_);
  const posted = {};
  master.getRange(4, 15, Math.max(1, master.getLastRow() - 3), 1).getValues().forEach(function(r) {
    posted[String(r[0]).trim()] = true;
  });
  if (ROUTINE_CATCHUP_IDS_202610_.every(function(id) { return posted[id]; })) {
    props.setProperty(ROUTINE_CATCHUP_FLAG_202610_, 'done');
  }
}

// 2026-10-09: 入力規則の不具合で未転記だった3件。転記がそろったら管理グループへ1回だけ訂正を知らせる（Daisuke 指示）
const BALANCE_NOTICE_FLAG_20261009_ = 'BALANCE_NOTICE_20261009';
const BALANCE_NOTICE_IDS_20261009_ = ['EXP-20261002-001', 'EXP-20261006-001', 'EXP-20261009-001'];

function notifyRonBalanceCorrectionOnce_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(BALANCE_NOTICE_FLAG_20261009_) === 'sent') return;

  const cfg = getConfig();
  if (!cfg.adminGroupId) return;
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  const master = ss.getSheetByName(EXPENSE_MASTER_SHEET_);
  const bot = ss.getSheetByName(SHEET_NAMES.EXPENSES);
  if (!master || !bot || master.getLastRow() < 4 || bot.getLastRow() < 2) return;

  // 3件すべてが経費マスターに入るまでは待つ
  const inMaster = {};
  master.getRange(4, 15, master.getLastRow() - 3, 1).getValues().forEach(function(r) {
    inMaster[String(r[0]).trim()] = true;
  });
  if (BALANCE_NOTICE_IDS_20261009_.some(function(id) { return !inMaster[id]; })) return;

  // 金額・内容は「経費」タブ（Bot入力）から読む
  const byId = {};
  bot.getRange(2, 1, bot.getLastRow() - 1, 6).getValues().forEach(function(r) {
    byId[String(r[0]).trim()] = { desc: String(r[3] || ''), amount: Number(r[4]) || 0, currency: String(r[5] || 'USD') };
  });
  let totalUsd = 0;
  const lines = BALANCE_NOTICE_IDS_20261009_.map(function(id) {
    const e = byId[id] || { desc: '', amount: 0, currency: 'USD' };
    if (e.currency.toUpperCase() === 'USD') totalUsd += e.amount;
    return '・' + escapeHtml_(id) + ' ' + escapeHtml_(e.desc) + ' ' + e.amount.toFixed(2) + ' ' + escapeHtml_(e.currency);
  });

  const bal = getRonPrepaidBalance_();
  if (bal === null) return;

  const text =
    '💵 <b>ロン君 残金の訂正</b>(経費マスター転記の不具合)\n\n' +
    '10/2〜10/9 に現場から入った経費のうち3件が、残金の計算元「経費マスター」に入っていませんでした。\n' +
    '原因: 経費マスターの「分類」列の選択肢が 9/27 の分類変更前のままで、「車両費」「広告宣伝費」の書き込みがはじかれていたため。' +
    'このため残金が減らず、経費追加の通知にも残金が出ていませんでした。10/9 に修正済みです。\n\n' +
    '今回反映した経費:\n' + lines.join('\n') + '\n' +
    '計 $' + totalUsd.toFixed(2) + '\n\n' +
    '💵 ロン君 残金: $' + (bal + totalUsd).toFixed(2) + ' → <b>$' + bal.toFixed(2) + '</b>' +
    (bal < 10 ? ' ⚠️ 低残高' : '');

  const opts = { parse_mode: 'HTML' };
  if (cfg.adminExpenseThreadId) opts.message_thread_id = Number(cfg.adminExpenseThreadId);
  const res = sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, text, opts);
  if (res && res.ok) {
    props.setProperty(BALANCE_NOTICE_FLAG_20261009_, 'sent');
    Logger.log('📣 残金訂正のお知らせを管理グループへ送信: $' + bal.toFixed(2));
  } else {
    Logger.log('⚠️ 残金訂正のお知らせ送信失敗(次回の同期で再試行): ' + JSON.stringify(res));
  }
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
