/**
 * IntegrationSync.gs — v7-operations 経費 → 経費統合スプレッドシートへの同期
 *
 * 【責務】
 *   - v7-ops の「経費」シート（OPERATIONS_SPREADSHEET_ID）の行を、
 *     経費統合スプレッドシート（INTEGRATION_SPREADSHEET_ID）の「統合明細」シートに
 *     プッシュ追記する。
 *   - 同じ元ID（v7-ops の経費ID）が既にあれば再追記しない（冪等性）。
 *
 * 【設計】
 *   ① プッシュ（リアルタイム）
 *     ExpenseManager.submitExpense の末尾から appendToIntegrationSheet_ を呼ぶ。
 *     統合シート未設定や書き込み失敗時も経費登録自体は止めない。
 *   ② バックフィル（一括）
 *     syncExpensesToIntegration を手動 or 1日1回トリガーで実行。
 *     経費シート全行をスキャン → 統合シートにまだ無い元IDだけ追加。
 *
 * 【列マッピング（v7-ops 経費 → 統合明細）】
 *   出典       = "Bot経費登録"（固定）
 *   元ID       = 経費ID
 *   取引日     = 取引日
 *   カテゴリ   = 勘定科目
 *   項目・摘要 = 品目・摘要
 *   金額(円)/(USD)/(リエル) = 通貨に応じて振り分け
 *   JPY換算合計 = 金額 × 設定シートの為替レート（USD/KHR/JPY）
 *   負担先     = 立替時は精算先、会社直払い時は登録者
 *   支払方法   = 立替区分
 *   備考       = メモ
 *   集計対象   = "○"（固定）
 *   カテゴリ(元) = 勘定科目（同じ値）
 *
 * 【統合シートの構造前提】
 *   - シート名: "統合明細"（1行目ヘッダー）
 *   - 為替レート参照シート: "設定"（列A=通貨, 列B=JPY換算レート）
 *   - Excel(.xlsx) ではなくネイティブ Google Sheets であること
 */

const INTEGRATION_SHEET_NAME_    = '統合明細';
const INTEGRATION_SETTINGS_NAME_ = '設定';
const INTEGRATION_SOURCE_LABEL_  = 'Bot経費登録';

// ============================================================
//  公開エントリポイント
// ============================================================

/**
 * 1件追記（ExpenseManager.submitExpense から呼ぶ）
 *
 * @param {Object} expData v7-ops 経費シート1行ぶんのオブジェクト
 *   { 経費ID, 取引日, 品目・摘要, 金額, 通貨, 勘定科目,
 *     登録者, 立替区分, 精算先, メモ }
 * @return {{ok: boolean, skipped?: boolean, error?: string}}
 */
function appendToIntegrationSheet_(expData) {
  try {
    const cfg = getConfig();
    if (!cfg.integrationSpreadsheetId) {
      return { ok: false, error: 'INTEGRATION_SPREADSHEET_ID 未設定' };
    }
    const ctx = openIntegrationContext_(cfg.integrationSpreadsheetId);
    const motoId = String(expData['経費ID'] || '').trim();
    if (!motoId) return { ok: false, error: 'motoId empty' };

    if (ctx.existingIds[motoId]) {
      Logger.log('ℹ️ 統合シート: ' + motoId + ' は既存、スキップ');
      return { ok: true, skipped: true };
    }

    const row = buildIntegrationRow_(expData, ctx);
    ctx.sheet.appendRow(row);
    ctx.existingIds[motoId] = true;
    return { ok: true };
  } catch (err) {
    Logger.log('⚠️ appendToIntegrationSheet_ 失敗(無視可): ' + err);
    return { ok: false, error: String(err) };
  }
}

/**
 * バックフィル: v7-ops 経費の全行を統合シートへ同期
 * 既に元IDが存在するものはスキップ（冪等）。
 *
 * @return {{added: number, skipped: number, failed: number}}
 */
function syncExpensesToIntegration() {
  const cfg = getConfig();
  if (!cfg.integrationSpreadsheetId) {
    Logger.log('❌ INTEGRATION_SPREADSHEET_ID が未設定です。PropertiesService に登録してください。');
    return { added: 0, skipped: 0, failed: 0 };
  }

  const ctx = openIntegrationContext_(cfg.integrationSpreadsheetId);
  const rows = getAllRows(SHEET_NAMES.EXPENSES);

  const newRows = [];
  let skipped = 0, failed = 0;

  rows.forEach(function(r) {
    const motoId = String(r['経費ID'] || '').trim();
    if (!motoId) { failed++; return; }
    if (ctx.existingIds[motoId]) { skipped++; return; }
    try {
      newRows.push(buildIntegrationRow_(r, ctx));
      ctx.existingIds[motoId] = true;
    } catch (err) {
      Logger.log('❌ ' + motoId + ' 変換失敗: ' + err);
      failed++;
    }
  });

  if (newRows.length > 0) {
    const startRow = ctx.sheet.getLastRow() + 1;
    ctx.sheet.getRange(startRow, 1, newRows.length, ctx.headerCount).setValues(newRows);
  }

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🔁 経費 → 統合シート 同期結果');
  Logger.log('  追加: ' + newRows.length + ' 件');
  Logger.log('  スキップ(既存): ' + skipped + ' 件');
  Logger.log('  失敗: ' + failed + ' 件');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  return { added: newRows.length, skipped: skipped, failed: failed };
}

// ============================================================
//  内部ヘルパー
// ============================================================

/**
 * 統合シートを開いて、ヘッダー・既存元ID・為替レートをまとめて取得
 */
function openIntegrationContext_(ssId) {
  const ss = SpreadsheetApp.openById(ssId);
  const sheet = ss.getSheetByName(INTEGRATION_SHEET_NAME_);
  if (!sheet) {
    throw new Error('❌ シート未発見: ' + INTEGRATION_SHEET_NAME_ +
      '（ファイルが .xlsx のままになっていませんか？ ネイティブ Google Sheets に変換してください）');
  }

  // ヘッダー読み取り（1行目想定）
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h) {
    return String(h).trim();
  });
  const idx = {};
  headers.forEach(function(h, i) { if (h) idx[h] = i; });
  if (idx['元ID'] === undefined || idx['出典'] === undefined) {
    throw new Error('❌ 統合明細シートのヘッダーに「元ID」「出典」が見つかりません。1行目に列名があるか確認してください。');
  }

  // 既存元IDをセット化（重複チェック高速化）
  const existingIds = {};
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const idCol = idx['元ID'] + 1;
    const ids = sheet.getRange(2, idCol, lastRow - 1, 1).getValues();
    ids.forEach(function(row) {
      const v = String(row[0] || '').trim();
      if (v) existingIds[v] = true;
    });
  }

  // 次の No 番号
  let nextNo = 1;
  if (idx['No'] !== undefined && lastRow >= 2) {
    const noCol = idx['No'] + 1;
    const nos = sheet.getRange(2, noCol, lastRow - 1, 1).getValues();
    let maxNo = 0;
    nos.forEach(function(row) {
      const n = Number(row[0]);
      if (!isNaN(n) && n > maxNo) maxNo = n;
    });
    nextNo = maxNo + 1;
  }

  // 為替レート
  const rates = loadIntegrationRates_(ss);

  return {
    sheet: sheet,
    headers: headers,
    headerCount: headers.length,
    idx: idx,
    existingIds: existingIds,
    nextNo: nextNo,
    rates: rates
  };
}

/**
 * 設定シートから為替レートを読む
 * 想定レイアウト: A列=通貨, B列=JPY換算レート
 * 取れない場合はデフォルト (USD=160, KHR=0.04, JPY=1)
 */
function loadIntegrationRates_(ss) {
  const defaults = { USD: 160, KHR: 0.04, JPY: 1 };
  const sheet = ss.getSheetByName(INTEGRATION_SETTINGS_NAME_);
  if (!sheet) return defaults;
  try {
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return defaults;
    const values = sheet.getRange(1, 1, lastRow, 2).getValues();
    const out = Object.assign({}, defaults);
    values.forEach(function(row) {
      const cur = String(row[0] || '').trim().toUpperCase();
      const rate = Number(row[1]);
      if (['USD', 'KHR', 'JPY'].indexOf(cur) >= 0 && !isNaN(rate) && rate > 0) {
        out[cur] = rate;
      }
    });
    return out;
  } catch (err) {
    Logger.log('⚠️ 為替レート読み取り失敗、デフォルト使用: ' + err);
    return defaults;
  }
}

/**
 * 経費1行を統合明細1行（配列）に変換
 */
function buildIntegrationRow_(expData, ctx) {
  const row = new Array(ctx.headerCount).fill('');
  function set(colName, val) {
    if (ctx.idx[colName] !== undefined) row[ctx.idx[colName]] = val;
  }

  const currency = String(expData['通貨'] || 'USD').toUpperCase();
  const amount   = Number(expData['金額'] || 0);
  const paymentType = String(expData['立替区分'] || '').trim();
  const reimburseTo = String(expData['精算先']   || '').trim();
  const registrant  = String(expData['登録者']   || '').trim();
  const category    = String(expData['勘定科目'] || '').trim();

  set('No',         ctx.nextNo);
  ctx.nextNo++;
  set('出典',       INTEGRATION_SOURCE_LABEL_);
  set('元ID',       expData['経費ID']);
  set('取引日',     expData['取引日']);
  set('カテゴリ',   category);
  set('項目・摘要', expData['品目・摘要'] || '');

  // 通貨別振り分け
  if (currency === 'JPY') set('金額(円)',     amount);
  if (currency === 'USD') set('金額(USD)',    amount);
  if (currency === 'KHR') set('金額(リエル)', amount);

  // JPY換算
  const rate = ctx.rates[currency] || 1;
  set('JPY換算合計', amount * rate);

  // 負担先: 立替なら精算先、会社直払いなら登録者
  const payerJp = (paymentType === '立替' && reimburseTo) ? reimburseTo : registrant;
  set('負担先', payerJp);

  set('支払方法', paymentType);
  set('備考',     expData['メモ'] || '');
  set('集計対象', '○');
  set('カテゴリ(元)', category);
  // テスト/ノイズ・金額未確定・未払/見積 は空のまま

  return row;
}

// ============================================================
//  デバッグ
// ============================================================

function debugSyncExpensesToIntegration() {
  syncExpensesToIntegration();
}

function debugShowIntegrationContext() {
  const cfg = getConfig();
  if (!cfg.integrationSpreadsheetId) {
    Logger.log('❌ INTEGRATION_SPREADSHEET_ID 未設定');
    return;
  }
  const ctx = openIntegrationContext_(cfg.integrationSpreadsheetId);
  Logger.log('シート: ' + ctx.sheet.getName());
  Logger.log('ヘッダー: ' + ctx.headers.join(' | '));
  Logger.log('既存元ID数: ' + Object.keys(ctx.existingIds).length);
  Logger.log('次のNo: ' + ctx.nextNo);
  Logger.log('為替: USD=' + ctx.rates.USD + ' / KHR=' + ctx.rates.KHR + ' / JPY=' + ctx.rates.JPY);
}
