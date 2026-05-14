/**
 * ConsolidatedSync.gs — 統合明細タブへの自動転記 (P5)
 *
 * 【背景】
 *   経費は v7-ops の「経費」シートと、別 GSS（経理母艦）の「統合明細」タブの
 *   2 箇所に分かれていた。本ファイルは v7-ops → 統合明細への自動 append を担当。
 *
 * 【設定】
 *   ScriptProperties に以下を設定（CONSOLIDATED_SS_ID 未設定なら no-op）：
 *     - CONSOLIDATED_SS_ID         : 経理母艦スプレッドシートの ID
 *     - CONSOLIDATED_SHEET_NAME    : タブ名（未設定なら '統合明細'）
 *     - CONSOLIDATED_SOURCE_LABEL  : 出典列の識別子（未設定なら 'samurai-motors-v7-ops'）
 *
 * 【列マッピング】
 *   統合明細タブの列構成に合わせて変換（既存運用：USD×160=JPY, KHR×0.04=JPY）：
 *
 *     A  No              連番（appendRow 時に末尾+1）
 *     B  出典            CONSOLIDATED_SOURCE_LABEL
 *     C  元ID            経費ID（重複排除キー）
 *     D  取引日          経費.取引日
 *     E  カテゴリ        経費.勘定科目
 *     F  項目・摘要      経費.品目・摘要（+ 取引先）
 *     G  金額(円)        通貨=JPY のときのみ
 *     H  金額(USD)       通貨=USD のときのみ
 *     I  金額(リエル)    通貨=KHR のときのみ
 *     J  JPY換算合計     USD×160 / KHR×0.04 / JPY そのまま
 *     K  負担先          経費.登録者
 *     L  支払方法        経費.立替区分 + ステータス簡易表現
 *     M  備考            経費.メモ（先頭にレシート URL）
 *     N  集計対象        'O'
 *     O  カテゴリ(元)    経費.勘定科目
 *     P  テスト/ノイズ   ''
 *     Q  金額未確定      ''
 *     R  未払い/見積     ''
 *
 * 【冪等性】
 *   元ID（経費ID）列を毎回見て、既に存在するなら append しない。
 *
 * 【失敗時の挙動】
 *   経費登録の本流を絶対に止めない（失敗してもログだけ出して return）。
 *   月次手動 reconcile (backfillConsolidatedFromExpenses) で取りこぼし回復できる。
 */

const CONSOLIDATED_DEFAULT_SHEET_NAME_ = '統合明細';
const CONSOLIDATED_DEFAULT_SOURCE_     = 'samurai-motors-v7-ops';

// 統合明細タブの列順（左から右）
const CONSOLIDATED_HEADERS_ = [
  'No',
  '出典',
  '元ID',
  '取引日',
  'カテゴリ',
  '項目・摘要',
  '金額(円)',
  '金額(USD)',
  '金額(リエル)',
  'JPY換算合計',
  '負担先',
  '支払方法',
  '備考',
  '集計対象',
  'カテゴリ(元)',
  'テスト/ノイズ',
  '金額未確定',
  '未払い/見積'
];

// 既存運用の固定換算レート（統合明細タブの実データから逆算）
const CONSOLIDATED_JPY_PER_USD_ = 160;
const CONSOLIDATED_JPY_PER_KHR_ = 0.04;   // = 160 / 4000

// ============================================================
//  メイン: 1 件追記
// ============================================================

/**
 * 経費 1 件を統合明細タブへ append（冪等）。
 *
 * @param {Object} exp - 経費シート 1 行（オブジェクト）
 *   必須キー: 経費ID / 取引日 / 品目・摘要 / 金額 / 通貨 / 取引先 / 勘定科目
 *             登録者 / 立替区分 / ステータス / メモ / レシート写真
 * @return {{ok:boolean, appended:boolean, reason?:string, error?:string}}
 */
function appendExpenseToConsolidated_(exp) {
  try {
    const cfg = getConfig();
    if (!cfg.consolidatedSsId) {
      return { ok: false, appended: false, reason: 'CONSOLIDATED_SS_ID_NOT_SET' };
    }

    const ss = SpreadsheetApp.openById(cfg.consolidatedSsId);
    const sheetName = cfg.consolidatedSheetName || CONSOLIDATED_DEFAULT_SHEET_NAME_;
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      return { ok: false, appended: false, reason: 'SHEET_NOT_FOUND', sheetName: sheetName };
    }

    const expenseId = String(exp['経費ID'] || '').trim();
    if (!expenseId) {
      return { ok: false, appended: false, reason: 'EXPENSE_ID_MISSING' };
    }

    // 冪等チェック：元ID 列で既存マッチを探す
    if (isExpenseInConsolidated_(sheet, expenseId)) {
      return { ok: true, appended: false, reason: 'ALREADY_EXISTS', expenseId: expenseId };
    }

    const row = buildConsolidatedRow_(exp, cfg.consolidatedSourceLabel || CONSOLIDATED_DEFAULT_SOURCE_, sheet);
    sheet.appendRow(row);
    Logger.log('📤 統合明細へ転記: ' + expenseId);
    return { ok: true, appended: true, expenseId: expenseId };
  } catch (err) {
    Logger.log('⚠️ 統合明細転記失敗 (' + (exp && exp['経費ID']) + '): ' + err);
    return { ok: false, appended: false, error: String(err) };
  }
}

// ============================================================
//  経費シート全件 → 統合明細 取りこぼし回復
// ============================================================

/**
 * 経費シート全行をスキャンして、統合明細にないものを append。
 * 月次手動 reconcile or 初回投入向け。
 */
function backfillConsolidatedFromExpenses() {
  const cfg = getConfig();
  if (!cfg.consolidatedSsId) {
    Logger.log('⚠️ CONSOLIDATED_SS_ID 未設定。backfill スキップ');
    return { ok: false, error: 'CONSOLIDATED_SS_ID_NOT_SET' };
  }
  const expenses = getAllRows(SHEET_NAMES.EXPENSES);
  Logger.log('📋 backfill 対象 経費行数: ' + expenses.length);

  let appended = 0, skipped = 0, failed = 0;
  expenses.forEach(function(exp) {
    const r = appendExpenseToConsolidated_(exp);
    if (r.appended) appended++;
    else if (r.reason === 'ALREADY_EXISTS') skipped++;
    else failed++;
  });

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ backfill 完了: 追加 ' + appended + ' / スキップ ' + skipped + ' / 失敗 ' + failed);
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  return { ok: true, appended: appended, skipped: skipped, failed: failed };
}

// ============================================================
//  内部ヘルパー
// ============================================================

function isExpenseInConsolidated_(sheet, expenseId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  // 元ID 列を特定（ヘッダー名で探す。見つからなければ列番号 3 を fallback）
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  let colIdx = headers.indexOf('元ID');
  if (colIdx < 0) colIdx = 2; // 0-indexed: C列

  const values = sheet.getRange(2, colIdx + 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === expenseId) return true;
  }
  return false;
}

function buildConsolidatedRow_(exp, sourceLabel, sheet) {
  const amount   = Number(exp['金額'] || 0);
  const currency = String(exp['通貨'] || 'USD').toUpperCase();
  const txDate   = (typeof formatDateCellTz_ === 'function')
    ? formatDateCellTz_(exp['取引日'], OPS_TZ)
    : String(exp['取引日'] || '');

  const amountJPY = currency === 'JPY' ? amount
                 : currency === 'USD' ? amount * CONSOLIDATED_JPY_PER_USD_
                 : currency === 'KHR' ? amount * CONSOLIDATED_JPY_PER_KHR_
                 : 0;

  // 項目・摘要 = 品目 (+ 取引先)
  const desc   = String(exp['品目・摘要'] || '').trim();
  const vendor = String(exp['取引先'] || '').trim();
  const summary = vendor ? (desc + '（' + vendor + '）') : desc;

  // 支払方法（既存運用のラベルに寄せる：'立替（プール消費）' / '立替（個人）' / '会社直払い'）
  const paymentType = String(exp['立替区分'] || '').trim();
  const status      = String(exp['ステータス'] || '').trim();
  var payMethod;
  if (paymentType === '立替') {
    payMethod = (status === 'プール消費') ? '立替（前払いプール）'
              : (status === '個人立替')   ? '立替（個人）'
              : (status === '未精算' || status === '精算済み') ? ('立替（' + status + '）')
              : '立替';
  } else {
    payMethod = '会社直払い';
  }

  // 備考 = メモ + レシート URL（HYPERLINK 式は使わず素のテキストに）
  const memo = String(exp['メモ'] || '').trim();
  const receipt = String(exp['レシート写真'] || '').trim();
  const receiptUrl = extractUrlFromHyperlink_(receipt);
  const remarks = [receiptUrl ? ('レシート: ' + receiptUrl) : '', memo].filter(function(s) { return s; }).join(' / ');

  // 次の No 列 = 既存最終行の No + 1（既存値が無ければ 1）
  const lastRow = sheet.getLastRow();
  let nextNo = 1;
  if (lastRow >= 2) {
    // No 列のヘッダー位置（普通は 0）
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    let noIdx = headers.indexOf('No');
    if (noIdx < 0) noIdx = 0;
    const lastNoCell = sheet.getRange(lastRow, noIdx + 1).getValue();
    const lastNo = Number(lastNoCell);
    nextNo = isNaN(lastNo) ? lastRow : lastNo + 1;
  }

  // 列順は CONSOLIDATED_HEADERS_ と一致させる
  return [
    nextNo,                                    // No
    sourceLabel,                               // 出典
    String(exp['経費ID'] || ''),               // 元ID
    txDate,                                    // 取引日
    String(exp['勘定科目'] || ''),             // カテゴリ
    summary,                                   // 項目・摘要
    currency === 'JPY' ? amount : '',          // 金額(円)
    currency === 'USD' ? amount : '',          // 金額(USD)
    currency === 'KHR' ? amount : '',          // 金額(リエル)
    Math.round(amountJPY),                     // JPY換算合計
    String(exp['登録者'] || ''),               // 負担先
    payMethod,                                 // 支払方法
    remarks,                                   // 備考
    'O',                                       // 集計対象
    String(exp['勘定科目'] || ''),             // カテゴリ(元)
    '',                                        // テスト/ノイズ
    '',                                        // 金額未確定
    ''                                         // 未払い/見積
  ];
}

/**
 * `=HYPERLINK("https://...", "ラベル")` から URL だけ抜く。
 * 既に URL 単体ならそのまま返す。空なら空文字。
 */
function extractUrlFromHyperlink_(s) {
  if (!s) return '';
  const str = String(s);
  const m = str.match(/HYPERLINK\("([^"]+)"/i);
  if (m) return m[1];
  if (/^https?:\/\//.test(str)) return str;
  return '';
}

// ============================================================
//  デバッグ
// ============================================================

function debugBackfillConsolidated() {
  Logger.log(JSON.stringify(backfillConsolidatedFromExpenses(), null, 2));
}

function debugAppendLatestExpenseToConsolidated() {
  const rows = getAllRows(SHEET_NAMES.EXPENSES);
  if (rows.length === 0) { Logger.log('経費なし'); return; }
  const last = rows[rows.length - 1];
  Logger.log('対象: ' + last['経費ID']);
  Logger.log(JSON.stringify(appendExpenseToConsolidated_(last), null, 2));
}
