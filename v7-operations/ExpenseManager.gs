/**
 * ExpenseManager.gs — 経費入力（Phase 4）
 *
 * 【責務】
 *   - ミニアプリから送信された経費データ（＋任意のレシート写真）を
 *     「経費」シートに記録
 *   - レシート写真は Drive のフォルダへ保存し、シートにリンク
 *   - 毎週金曜 JST 18:00 に直近7日間の経費サマリを管理グループへ送信
 *
 * 【通知方針】
 *   - 即時通知は廃止（ノイズ削減）
 *   - 立替精算完了時のみ TaskManager.settleExpenseByTask_ から通知
 *   - 週次サマリは sendWeeklyExpenseSummary（hourlyTaskScheduler が金曜18:00 JSTで発火）
 *
 * 【OCR について】
 *   本実装では OCR はスキップ（写真は保存するのみ）。
 *   将来 Drive API v2 Advanced Service を有効化し、
 *   performOcrOnFile_() を差し込むだけで OCR 連携できる構造にしてある。
 *
 * 【シート】
 *   SHEET_NAMES.EXPENSES = '経費'
 */

const EXPENSE_HEADERS_ = [
  '経費ID', '登録日時', '取引日', '品目・摘要', '金額', '通貨',
  '取引先', '勘定科目', '登録者', '登録者 Chat ID',
  'レシート写真', 'OCR原文', 'ステータス', 'メモ',
  // ↓ Phase A: 立替精算フロー用
  '立替区分', '精算先', '精算期限', '精算日', '精算方法', '関連タスクID'
];

// 勘定科目の候補（freee っぽい分類 ゆるめ版）
const EXPENSE_CATEGORIES_ = [
  '消耗品費', '水道光熱費', '通信費', '車両費',
  '交通費', '会議費', '事務用品', '広告宣伝費',
  '修繕費', '雑費'
];

const EXPENSE_CURRENCIES_ = ['USD', 'KHR', 'JPY'];

// 立替区分（ミニアプリ側のトグル → シートに保存される値）
const EXPENSE_PAYMENT_TYPES_ = ['立替', '会社直払い'];

// 精算期限のデフォルト（営業日考慮なし・カレンダー日）
const REIMBURSE_DUE_DEFAULT_DAYS_ = 3;

// ============================================================
//  セットアップ
// ============================================================

/**
 * 経費シートが無ければ作成
 */
function ensureExpensesSheet() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  let sheet = ss.getSheetByName(SHEET_NAMES.EXPENSES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.EXPENSES);
    sheet.getRange(1, 1, 1, EXPENSE_HEADERS_.length).setValues([EXPENSE_HEADERS_]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, EXPENSE_HEADERS_.length)
      .setFontWeight('bold')
      .setBackground('#2b2b2b')
      .setFontColor('#e8e8e8');
    sheet.setColumnWidth(1, 170);  // 経費ID
    sheet.setColumnWidth(4, 260);  // 品目
    sheet.setColumnWidth(11, 200); // レシート
    sheet.setColumnWidth(12, 200); // OCR
    sheet.setColumnWidth(14, 220); // メモ
    Logger.log('✅ 経費シート作成');
  } else {
    const lastCol = sheet.getLastColumn() || 1;
    const existing = sheet.getRange(1, 1, 1, Math.max(lastCol, EXPENSE_HEADERS_.length)).getValues()[0];
    let needs = false;
    EXPENSE_HEADERS_.forEach(function(h, i) { if (existing[i] !== h) needs = true; });
    if (needs) {
      sheet.getRange(1, 1, 1, EXPENSE_HEADERS_.length).setValues([EXPENSE_HEADERS_]);
      Logger.log('♻️ 経費シート ヘッダー整備');
    } else {
      Logger.log('ℹ️ 経費シート 変更なし');
    }
  }
}

/**
 * レシート保存先 Drive フォルダを取得（無ければ作成）
 * RECEIPT_FOLDER_ID が未設定ならマイドライブ直下に作って ID をプロパティ保存
 */
function getOrCreateReceiptFolder_() {
  const cfg = getConfig();
  if (cfg.receiptFolderId) {
    try {
      return DriveApp.getFolderById(cfg.receiptFolderId);
    } catch (e) {
      Logger.log('⚠️ RECEIPT_FOLDER_ID 無効: ' + e);
      // フォールバックで新規作成
    }
  }
  const name = 'SamuraiMotors_Receipts';
  // 同名フォルダ検索
  const it = DriveApp.getFoldersByName(name);
  let folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
  PropertiesService.getScriptProperties().setProperty(CONFIG_KEYS.RECEIPT_FOLDER_ID, folder.getId());
  Logger.log('📁 レシートフォルダ設定: ' + folder.getName() + ' id=' + folder.getId());
  return folder;
}

// ============================================================
//  登録
// ============================================================

/**
 * 経費を登録
 *
 * @param {string} chatId 登録者
 * @param {Object} payload {
 *   transactionDate: 'yyyy-MM-dd',
 *   description:     string,
 *   amount:          number,
 *   currency:        'USD'|'KHR'|'JPY',
 *   vendor:          string (任意),
 *   category:        string,
 *   memo:            string (任意),
 *   photoBase64:     string (任意) - data URL 先頭なし or あり（あればstrip）,
 *   photoMime:       'image/jpeg'|'image/png' 等 (写真があれば必須),
 *   photoName:       'receipt.jpg' (任意)
 * }
 */
function submitExpense(chatId, payload) {
  const staff = findStaffByChatId(String(chatId));
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND', chatId: String(chatId) };

  const desc     = String((payload && payload.description) || '').trim();
  const amount   = Number((payload && payload.amount) || 0);
  const currency = String((payload && payload.currency) || 'USD').trim().toUpperCase();
  const vendor   = String((payload && payload.vendor)   || '').trim();
  const category = String((payload && payload.category) || '').trim();
  const memo     = String((payload && payload.memo)     || '').trim();

  // Phase A: 立替精算関連
  var paymentType = String((payload && payload.paymentType) || '会社直払い').trim();
  if (EXPENSE_PAYMENT_TYPES_.indexOf(paymentType) < 0) paymentType = '会社直払い';
  const isReimburse = paymentType === '立替';
  const reimburseTo = isReimburse ? String((payload && payload.reimburseTo) || '').trim() : '';

  if (!desc)   return { ok: false, error: 'DESC_REQUIRED' };
  if (!amount || isNaN(amount) || amount <= 0) return { ok: false, error: 'AMOUNT_INVALID' };
  if (EXPENSE_CURRENCIES_.indexOf(currency) < 0) return { ok: false, error: 'CURRENCY_INVALID' };
  if (isReimburse && !reimburseTo) return { ok: false, error: 'REIMBURSE_TO_REQUIRED' };

  // ── 二重登録防止 ──
  // ミニアプリの fetch は update_id を持たずキュー重複排除が効かないため、
  // 同一 chatId・同一摘要・同一金額・同一通貨が直近 10 分以内に登録済みなら重複とみなす。
  // ケース: ①送信ボタン2度押し ②レシート添付し忘れて再登録（後者はレシート付きを優先）。
  const hasNewReceipt = !!(payload && payload.photoBase64);
  try {
    const dup = findRecentDuplicateExpense_(String(chatId), desc, amount, currency, 600);
    if (dup) {
      // 既存にレシートが無く、今回レシート付きで来た場合 → 既存行のレシートだけ更新し、新規行は作らない
      if (hasNewReceipt && !dup.hasReceipt) {
        try {
          const saved = saveReceiptPhoto_(payload.photoBase64, payload.photoMime, payload.photoName, dup.expenseId);
          const sheet2 = SpreadsheetApp.openById(getConfig().operationsSpreadsheetId).getSheetByName(SHEET_NAMES.EXPENSES);
          sheet2.getRange(dup.row, 11).setValue('=HYPERLINK("' + saved.url + '","レシート")'); // K列=レシート写真
          Logger.log('🔁 重複検出: 既存 ' + dup.expenseId + ' にレシートを後付け（新規行は作らない）');
        } catch (e2) {
          Logger.log('⚠️ レシート後付け失敗: ' + e2);
        }
      } else {
        Logger.log('⏭️ 二重登録を検出しスキップ: ' + dup.expenseId + ' (' + desc + ' ' + amount + currency + ')');
      }
      return { ok: true, expenseId: dup.expenseId, duplicate: true };
    }
  } catch (err) {
    Logger.log('⚠️ 二重登録チェック失敗(続行): ' + err);
  }

  const tz = staff.timezone || OPS_TZ;
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const txDate = String((payload && payload.transactionDate) || todayStr).trim() || todayStr;

  // 精算期限（立替のみ、未指定なら +3日）
  var reimburseDue = '';
  if (isReimburse) {
    const requested = String((payload && payload.reimburseDueDate) || '').trim();
    if (requested) {
      reimburseDue = requested;
    } else {
      const d = new Date();
      d.setDate(d.getDate() + REIMBURSE_DUE_DEFAULT_DAYS_);
      reimburseDue = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    }
  }

  const expenseId = generateDateSeqId('EXP', SHEET_NAMES.EXPENSES, '経費ID');

  // レシート写真保存（任意）
  let receiptUrl = '';
  let ocrText = '';
  if (payload && payload.photoBase64) {
    try {
      const saved = saveReceiptPhoto_(payload.photoBase64, payload.photoMime, payload.photoName, expenseId);
      receiptUrl = saved.url;
      // ocrText = performOcrOnFile_(saved.file); // 将来 Drive API v2 を有効化したら差し込む
    } catch (err) {
      Logger.log('⚠️ レシート保存失敗: ' + err);
    }
  }

  // 立替なら「未精算」、会社直払いは精算不要なので「会社負担」
  const statusValue = isReimburse ? '未精算' : '会社負担';

  // Phase B: 立替時は先に精算タスクを自動生成 → 関連タスクIDをシートに書く
  var linkedTaskId = '';
  if (isReimburse) {
    try {
      const taskResult = createExpenseReimburseTask_(staff, {
        expenseId:    expenseId,
        amount:       amount,
        currency:     currency,
        desc:         desc,
        reimburseTo:  reimburseTo,
        reimburseDue: reimburseDue
      });
      if (taskResult && taskResult.ok) linkedTaskId = taskResult.taskId;
    } catch (err) {
      Logger.log('⚠️ 精算タスク自動生成失敗: ' + err);
    }
  }

  appendRow(SHEET_NAMES.EXPENSES, {
    '経費ID':        expenseId,
    '登録日時':      new Date(),
    '取引日':        txDate,
    '品目・摘要':    desc,
    '金額':          amount,
    '通貨':          currency,
    '取引先':        vendor,
    '勘定科目':      category,
    '登録者':        staff.nameJp,
    '登録者 Chat ID': String(chatId),
    'レシート写真':  receiptUrl ? '=HYPERLINK("' + receiptUrl + '","レシート")' : '',
    'OCR原文':       ocrText,
    'ステータス':    statusValue,
    'メモ':          memo,
    '立替区分':      paymentType,
    '精算先':        reimburseTo,
    '精算期限':      reimburseDue,
    '精算日':        '',
    '精算方法':      '',
    '関連タスクID':  linkedTaskId
  });

  // 経費マスターへの自動転記（Phase 2: 集約SoT用、失敗しても本処理に影響させない）
  try {
    appendToExpenseMaster_({
      expenseId:    expenseId,
      txDate:       txDate,
      desc:         desc,
      amount:       amount,
      currency:     currency,
      vendor:       vendor,
      category:     category,
      memo:         memo,
      paymentType:  paymentType,
      reimburseTo:  reimburseTo,
      receiptUrl:   receiptUrl,
      staff:        staff
    });
  } catch (err) {
    Logger.log('⚠️ 経費マスター転記失敗: ' + err);
  }

  // 現場スタッフ(ロン等)が追加した時のみ管理グループに通知
  notifyExpenseCreatedIfField_({
    expenseId:    expenseId,
    desc:         desc,
    amount:       amount,
    currency:     currency,
    vendor:       vendor,
    category:     category,
    paymentType:  paymentType,
    reimburseTo:  reimburseTo,
    reimburseDue: reimburseDue
  }, chatId);

  return {
    ok: true,
    expenseId: expenseId,
    receiptUrl: receiptUrl,
    paymentType: paymentType,
    reimburseTo: reimburseTo,
    reimburseDue: reimburseDue,
    linkedTaskId: linkedTaskId
  };
}

/**
 * 直近 windowSec 秒以内に、同一 chatId・同一摘要・同一金額・同一通貨の
 * 経費が既に登録されていれば、その行情報を返す（無ければ null）。
 * ミニアプリの二重送信を弾くための冪等チェック。
 *
 * @param {string} chatId   登録者 Chat ID
 * @param {string} desc     品目・摘要
 * @param {number} amount   金額
 * @param {string} currency 通貨
 * @param {number} windowSec 判定する直近秒数（例 600）
 * @return {Object|null} {expenseId, row, hasReceipt} or null
 */
function findRecentDuplicateExpense_(chatId, desc, amount, currency, windowSec) {
  const sheet = SpreadsheetApp.openById(getConfig().operationsSpreadsheetId)
    .getSheetByName(SHEET_NAMES.EXPENSES);
  if (!sheet) return null;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  // 末尾最大12行だけ確認（直近のみ対象。全件走査は不要）
  const startRow = Math.max(2, lastRow - 11);
  const numRows = lastRow - startRow + 1;
  // A:経費ID, B:登録日時, D:品目・摘要, E:金額, F:通貨, J:登録者ChatID, K:レシート写真
  const values = sheet.getRange(startRow, 1, numRows, 11).getValues();

  const now = new Date().getTime();
  const descNorm = String(desc).trim();
  const amtNum = Number(amount);

  for (let i = values.length - 1; i >= 0; i--) {
    const r = values[i];
    const rowExpenseId = r[0];
    const rowRegistered = r[1];           // B: 登録日時（Date）
    const rowDesc = String(r[3] || '').trim();  // D
    const rowAmount = Number(r[4]);       // E
    const rowCurrency = String(r[5] || '').trim().toUpperCase(); // F
    const rowChatId = String(r[9] || '').trim(); // J
    const rowReceipt = String(r[10] || '').trim(); // K

    if (rowChatId !== String(chatId)) continue;
    if (rowDesc !== descNorm) continue;
    if (rowAmount !== amtNum) continue;
    if (rowCurrency !== String(currency).trim().toUpperCase()) continue;

    // 登録日時が windowSec 以内か
    let regMs = null;
    if (rowRegistered instanceof Date) {
      regMs = rowRegistered.getTime();
    } else if (rowRegistered) {
      const parsed = new Date(rowRegistered);
      if (!isNaN(parsed.getTime())) regMs = parsed.getTime();
    }
    if (regMs === null) continue;
    if ((now - regMs) <= windowSec * 1000) {
      return { expenseId: rowExpenseId, row: startRow + i, hasReceipt: !!rowReceipt };
    }
  }
  return null;
}

/**
 * 現場スタッフ(role='field' = ロン等)が経費追加した時のみ管理グループに通知
 * 日本側(role='admin' = Daisuke / 飯泉)の追加は無音
 *
 * @param {Object} expenseInfo - 通知に使う経費情報
 * @param {string} creatorChatId - 追加した人の Telegram chat_id
 */
function notifyExpenseCreatedIfField_(expenseInfo, creatorChatId) {
  if (!creatorChatId) return;
  try {
    const creator = findStaffByChatId(String(creatorChatId));
    if (!creator) return;
    if (creator.role !== 'field') return; // 日本側 admin の追加は通知しない

    const cfg = getConfig();
    if (!cfg.adminGroupId) return;
    const threadId = cfg.adminExpenseThreadId ? Number(cfg.adminExpenseThreadId) : null;

    const descShort = (expenseInfo.desc || '').length > 80
      ? expenseInfo.desc.substring(0, 80) + '…'
      : expenseInfo.desc;

    const amountStr = expenseInfo.amount.toLocaleString
      ? expenseInfo.amount.toLocaleString()
      : String(expenseInfo.amount);

    // ロン君は前払いから使うため精算期限は表示しない（立替先のみ）
    const reimburseLine = (expenseInfo.paymentType === '立替' && expenseInfo.reimburseTo)
      ? '\n🤝 立替先: ' + escapeHtml_(expenseInfo.reimburseTo)
      : '';

    // 立替は前払い(petty cash)から使う → 現在の残金を通知（ledger-driven：立替入力で残金が減る）
    let balanceLine = '';
    if (expenseInfo.paymentType === '立替') {
      const bal = getRonPrepaidBalance_();
      if (bal !== null) {
        balanceLine = '\n💵 ロン君 残金: <b>$' + bal.toFixed(2) + '</b>'
          + (bal < 10 ? ' ⚠️ 低残高' : '');
      }
    }

    const text =
      '🆕 <b>経費追加</b>(現場から)\n' +
      '👤 追加者: ' + escapeHtml_(creator.nameJp) + '\n' +
      '📋 ID: ' + escapeHtml_(expenseInfo.expenseId) + '\n' +
      '💰 金額: ' + amountStr + ' ' + escapeHtml_(expenseInfo.currency) + '\n' +
      '📝 内容: ' + escapeHtml_(descShort) +
      (expenseInfo.vendor ? '\n🏪 取引先: ' + escapeHtml_(expenseInfo.vendor) : '') +
      (expenseInfo.category ? '\n🏷️ 勘定: ' + escapeHtml_(expenseInfo.category) : '') +
      '\n💳 区分: ' + escapeHtml_(expenseInfo.paymentType) +
      reimburseLine +
      balanceLine;

    const opts = { parse_mode: 'HTML' };
    if (threadId) opts.message_thread_id = threadId;
    sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, text, opts);
  } catch (err) {
    Logger.log('⚠️ notifyExpenseCreatedIfField_ 失敗(無視可): ' + err);
  }
}

/**
 * ロン君の現在残金（前払い管理シートの残金セル）を取得。取得不可なら null。
 * 立替転記後に呼ぶ想定（ledger-driven：立替がD2に算入され残金が減る）。
 */
function getRonPrepaidBalance_() {
  try {
    SpreadsheetApp.flush(); // 直前の立替転記(K式)を確定させD2を再計算させる
    const ss = SpreadsheetApp.openById(getConfig().operationsSpreadsheetId);
    const sh = ss.getSheetByName('前払い管理');
    if (!sh) return null;
    // 2行目の「残金」ラベルの右セルを残金値とみなす（A2:F2 想定）
    const r2 = sh.getRange(2, 1, 1, 6).getValues()[0];
    for (let i = 0; i < r2.length - 1; i++) {
      if (/残金|残額/.test(String(r2[i]))) {
        const v = Number(String(r2[i + 1]).replace(/[^0-9.\-]/g, ''));
        if (!isNaN(v)) return v;
      }
    }
    return null;
  } catch (e) {
    Logger.log('⚠️ getRonPrepaidBalance_ 失敗(無視可): ' + e);
    return null;
  }
}

/**
 * レシート画像を Drive に保存
 */
function saveReceiptPhoto_(base64, mime, name, expenseId) {
  // data URL 先頭が付いていれば外す
  const raw = base64.indexOf(',') > 0 ? base64.substring(base64.indexOf(',') + 1) : base64;
  const bytes = Utilities.base64Decode(raw);
  const m = String(mime || 'image/jpeg');
  const ext = m.indexOf('png') >= 0 ? 'png' : (m.indexOf('webp') >= 0 ? 'webp' : 'jpg');
  const filename = expenseId + '_' + (name || 'receipt') + '.' + ext;
  const blob = Utilities.newBlob(bytes, m, filename);
  const folder = getOrCreateReceiptFolder_();
  const file = folder.createFile(blob);
  return { url: file.getUrl(), fileId: file.getId(), file: file };
}

/**
 * 週次レビューの先頭に出す「経営KPI」ブロックを組み立てる。
 * v7 予約シート（V7_SPREADSHEET_ID）を期間集計し、経営ダッシュボード相当の
 * 売上 / 予約件数 / 客数 / 客単価 を返す。タスクは含めない。
 * 取得できない場合は空文字（KPIブロックを出さない）。
 *
 * @param {Object} cfg getConfig() の結果
 * @param {string} fromStr 'yyyy-MM-dd'
 * @param {string} toStr 'yyyy-MM-dd'
 * @return {string} HTML（複数行）または ''
 */
function buildWeeklyKpiBlock_(cfg, fromStr, toStr) {
  if (!cfg.v7SpreadsheetId) return ''; // 未設定ならKPIスキップ（経費だけ送る）
  let rows;
  try {
    rows = readV7BookingsInRange_(cfg.v7SpreadsheetId, fromStr, toStr);
  } catch (err) {
    Logger.log('⚠️ 週次KPI: v7予約シート読取失敗: ' + err);
    return '📈 <b>経営KPI</b>\n　（売上データ読取失敗）';
  }
  const k = computeV7WeeklyKpi_(rows);
  return [
    '📈 <b>経営KPI（今週）</b>',
    '　💴 売上: <b>$' + k.sales.toFixed(2) + '</b>',
    '　🧾 予約件数: <b>' + k.count + '件</b>',
    '　👥 客数: <b>' + k.customers + '名</b>',
    '　💰 客単価: <b>$' + k.avg.toFixed(1) + '</b>'
  ].join('\n');
}

/**
 * 毎週金曜 JST 18:00 に直近7日間の週次レビューを管理グループへ送信
 *
 * - 期間: 実行日を含む直近7日間
 * - 内容: 経営KPI（売上/予約件数/客数/客単価）＋ 経費サマリ（件数/通貨別/カテゴリ別/担当者別/未精算）
 * - タスクは含めない（Daisuke 指示 2026-06-07）
 * - 通知先: ADMIN_EXPENSE_THREAD_ID（未設定なら ADMIN_DAILY_REPORT_THREAD_ID）
 *
 * hourlyTaskScheduler から呼ばれる。手動実行は debugSendWeeklyExpenseSummary を使用。
 */
function sendWeeklyExpenseSummary() {
  const cfg = getConfig();
  const thread = cfg.adminExpenseThreadId || cfg.adminDailyReportThreadId;
  if (!thread) {
    Logger.log('⚠️ 経費通知先トピック未設定、週次サマリ送信スキップ');
    return;
  }

  const tz = OPS_TZ;
  const now = new Date();
  const fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fromStr = Utilities.formatDate(fromDate, tz, 'yyyy-MM-dd');
  const toStr   = Utilities.formatDate(now,      tz, 'yyyy-MM-dd');

  const rows = getAllRows(SHEET_NAMES.EXPENSES);
  const recent = rows.filter(function(r) {
    const txDate = formatDateCellTz_(r['取引日'], tz);
    return txDate && txDate >= fromStr && txDate <= toStr;
  });

  // 経営KPI（売上/予約件数/客数/客単価）を v7 予約シートから集計（先頭に表示）
  const kpiBlock = buildWeeklyKpiBlock_(cfg, fromStr, toStr);

  // 期間内の経費がゼロでもサマリは送る（運用状況の把握のため）
  if (recent.length === 0) {
    sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId,
      '📊 <b>週次レビュー</b>\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '🗓 対象期間: ' + fromStr + ' 〜 ' + toStr + '\n' +
      (kpiBlock ? '\n' + kpiBlock + '\n' : '') +
      '\n💸 <b>経費</b>\n　ℹ️ 期間内の経費登録はありません。',
      { parse_mode: 'HTML', message_thread_id: Number(thread), disable_web_page_preview: true });
    Logger.log('📤 週次レビュー送信（経費0件）');
    return;
  }

  // 通貨別合計
  const byCurrency = {};
  recent.forEach(function(r) {
    const cur = String(r['通貨'] || 'USD');
    byCurrency[cur] = (byCurrency[cur] || 0) + Number(r['金額'] || 0);
  });

  // カテゴリ別（件数 + 通貨別金額）
  const byCategory = {};
  recent.forEach(function(r) {
    const cat = String(r['勘定科目'] || '未分類');
    if (!byCategory[cat]) byCategory[cat] = { count: 0, byCur: {} };
    byCategory[cat].count++;
    const cur = String(r['通貨'] || 'USD');
    byCategory[cat].byCur[cur] = (byCategory[cat].byCur[cur] || 0) + Number(r['金額'] || 0);
  });

  // 担当者別
  const byStaff = {};
  recent.forEach(function(r) {
    const name = String(r['登録者'] || '?');
    if (!byStaff[name]) byStaff[name] = { count: 0, byCur: {} };
    byStaff[name].count++;
    const cur = String(r['通貨'] || 'USD');
    byStaff[name].byCur[cur] = (byStaff[name].byCur[cur] || 0) + Number(r['金額'] || 0);
  });

  // 未精算の立替経費（期間内に限らず全件 → 滞留把握のため）
  const unsettled = rows.filter(function(r) {
    return String(r['立替区分']) === '立替' && String(r['ステータス']) === '未精算';
  });

  const fmtAmounts = function(byCur) {
    return Object.keys(byCur).map(function(c) {
      return c + ' ' + byCur[c].toLocaleString('en-US');
    }).join(' / ');
  };

  const lines = [
    '📊 <b>週次レビュー</b>',
    '━━━━━━━━━━━━━━━━━━',
    '🗓 対象期間: ' + fromStr + ' 〜 ' + toStr
  ];
  // 先頭に経営KPI（売上等）
  if (kpiBlock) {
    lines.push('');
    lines.push(kpiBlock);
  }
  // 経費セクション
  lines.push('');
  lines.push('💸 <b>経費</b>');
  lines.push('📌 件数: <b>' + recent.length + '件</b>');
  lines.push('');
  lines.push('💵 <b>合計（通貨別）</b>');
  Object.keys(byCurrency).forEach(function(cur) {
    lines.push('　' + cur + ': <b>' + byCurrency[cur].toLocaleString('en-US') + '</b>');
  });

  lines.push('');
  lines.push('🏷 <b>カテゴリ別</b>');
  Object.keys(byCategory)
    .sort(function(a, b) { return byCategory[b].count - byCategory[a].count; })
    .forEach(function(cat) {
      const info = byCategory[cat];
      lines.push('　' + escapeHtml_(cat) + ': ' + info.count + '件 (' + fmtAmounts(info.byCur) + ')');
    });

  lines.push('');
  lines.push('👥 <b>担当者別</b>');
  Object.keys(byStaff)
    .sort(function(a, b) { return byStaff[b].count - byStaff[a].count; })
    .forEach(function(name) {
      const info = byStaff[name];
      lines.push('　' + escapeHtml_(name) + ': ' + info.count + '件 (' + fmtAmounts(info.byCur) + ')');
    });

  if (unsettled.length > 0) {
    lines.push('');
    lines.push('⏳ <b>未精算の立替経費（全期間 ' + unsettled.length + '件）</b>');
    unsettled.slice(0, 10).forEach(function(r) {
      const money = String(r['通貨']) + ' ' + Number(r['金額']).toLocaleString('en-US');
      const due = formatDateCellTz_(r['精算期限'], tz);
      lines.push('　・<code>' + escapeHtml_(String(r['経費ID'])) + '</code> ' +
        escapeHtml_(String(r['登録者'])) + ' → ' + escapeHtml_(String(r['精算先'])) +
        ' / <b>' + money + '</b>' + (due ? ' (期限: ' + escapeHtml_(due) + ')' : ''));
    });
    if (unsettled.length > 10) {
      lines.push('　… 他 ' + (unsettled.length - 10) + '件');
    }
  }

  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), {
    parse_mode: 'HTML',
    message_thread_id: Number(thread),
    disable_web_page_preview: true
  });
  Logger.log('📤 週次経費サマリ送信: ' + recent.length + '件 / 未精算' + unsettled.length + '件');
}

/**
 * 精算先候補（スタッフマスターのアクティブ全員）
 * ミニアプリの精算先プルダウン用。
 *
 * 並び順: 飯泉 → 鈴木 → 五木田 → ロン → その他（スタッフマスター追加順）
 * 飯泉さんをデフォルトにするため先頭固定。以降は業務上の優先度順。
 */
function getExpenseReimburseCandidates_() {
  const staff = (typeof getActiveStaff === 'function') ? getActiveStaff() : [];
  const names = [];
  staff.forEach(function(s) {
    if (s && s.nameJp && names.indexOf(s.nameJp) < 0) names.push(s.nameJp);
  });

  // 優先順（この順で先頭に寄せる）
  const PRIORITY = ['飯泉', '鈴木', '五木田', 'ロン'];

  const ordered = [];
  // 優先メンバーを順番通り先頭へ（スタッフマスター未登録でも候補に出す）
  PRIORITY.forEach(function(name) {
    const idx = names.indexOf(name);
    if (idx >= 0) {
      names.splice(idx, 1);
      ordered.push(name);
    } else {
      ordered.push(name);
    }
  });
  // 残りのスタッフを末尾に追加
  names.forEach(function(n) { ordered.push(n); });
  return ordered;
}

// ============================================================
//  デバッグ
// ============================================================

function debugEnsureExpensesSheet() {
  ensureExpensesSheet();
}

function debugGetOrCreateReceiptFolder() {
  const f = getOrCreateReceiptFolder_();
  Logger.log('📁 ' + f.getName() + ' (' + f.getId() + ')\n' + f.getUrl());
}

function debugSendWeeklyExpenseSummary() {
  sendWeeklyExpenseSummary();
}

function debugSubmitTestExpense() {
  const staff = getActiveStaff()[0];
  if (!staff || !staff.chatId) { Logger.log('⚠️ スタッフなし/chatId未登録'); return; }
  const r = submitExpense(staff.chatId, {
    description: 'テスト: A4コピー用紙 1束',
    amount: 4.50,
    currency: 'USD',
    vendor: 'Aeon Mall',
    category: '事務用品',
    memo: 'テスト登録'
  });
  Logger.log(JSON.stringify(r));
}

// ============================================================
//  経費マスター 自動転記（Phase 2）
//  Bot入力された経費を「経費マスター」シートにも書き込む
//  - カテゴリは 9 カテゴリに正規化
//  - 集計対象=○ デフォルト / 経費計上=● デフォルト
//  - テスト文字列は集計対象=- に
// ============================================================

const EXPENSE_MASTER_SHEET_ = '経費マスター';

// 立替経費を経費マスターに記録する際の支払方法ラベル。
// ロン君の残金（前払い管理 D2 = SUMIFS 支払方法="立替"）には算入させず、
// 残金は「前払い管理」シートの実残高カウントで管理する（物理アンカー方式）。
// 顧客現金がpetty cashに混在し立替ログ≠実現金のため、立替を残金式に直結させない。
const ADV_BALANCE_LABEL_ = '立替（残金別管理）';

/**
 * 旧カテゴリ → v7 9カテゴリへの正規化
 * @param {string} catRaw 元のカテゴリ名（勘定科目）
 * @param {string} itemName 項目・摘要（手数料の振り分けに使用）
 * @returns {string} 正規化されたカテゴリ
 */
function normalizeCategoryV7_(catRaw, itemName) {
  const cat = String(catRaw || '').trim();
  const item = String(itemName || '');

  // 手数料の項目別振り分け
  if (cat === '手数料') {
    if (/採用|人材|紹介料|派遣|給与/.test(item)) return '人件費';
    if (/敷金|賃貸|不動産|家賃/.test(item))       return '賃貸・水道光熱';
    if (/ロゴ|デザイン|チラシ|広告/.test(item))   return '広告・販促';
    if (/スターリンク|設置|システム/.test(item))  return 'システム・IT';
    return 'その他';
  }

  // 項目名で家具家電を判定（カテゴリ「備品」等でも、家具・家電は別カテゴリに）
  // ※ 車両用ランプ・洗車用品は除外
  if (/ヘッドランプ|LEDヘッド|洗車|タイヤ|ガラコ|ワックス|コーティング/.test(item)) {
    // 車両用品ぽい → 家具家電ではない
  } else if (/冷蔵庫|エアコン|洗濯機|椅子|テーブル|ソファ|ランプ|カーペット|家具|家電|スターリンク本体/.test(item)) {
    return '家具家電';
  }

  const map = {
    '消耗品費':   '備品・消耗品',
    '消耗品':     '備品・消耗品',
    '日用品':     '備品・消耗品',
    '備品':       '備品・消耗品',
    '設備・備品': '備品・消耗品',
    '家電':       '家具家電',
    '家具':       '家具家電',
    '食料品':     '備品・消耗品',
    '作業用品':   '備品・消耗品',
    '事務用品':   '備品・消耗品',
    '雑費':       'その他',
    '会議費':     'その他',
    '飲食費':     'その他',
    '試作費':     '試作・R&D',
    '渡航費':     '渡航・出張',
    '視察費':     '渡航・出張',
    '宿泊費':     '渡航・出張',
    '賃貸費':     '賃貸・水道光熱',
    '賃貸料':     '賃貸・水道光熱',
    '公共料金':   '賃貸・水道光熱',
    'システム費': 'システム・IT',
    '広告宣伝費': '広告・販促',
    '洗車用品':   '車両・洗車',
    '人件費':     '人件費',
    '給与':       '人件費'
  };
  return map[cat] || 'その他';
}

/**
 * 経費マスターシートに1行追記
 * @param {Object} p { expenseId, txDate, desc, amount, currency, vendor, category, memo, paymentType, reimburseTo, receiptUrl, staff }
 */
function appendToExpenseMaster_(p) {
  // v7-ops はスタンドアロン(webhook)スクリプトのため SpreadsheetApp.getActive() は null。
  // 必ず operationsSpreadsheetId を openById で開く（旧 getActive() 実装が転記取りこぼしの真因だった）。
  const ss = SpreadsheetApp.openById(getConfig().operationsSpreadsheetId);
  const sheet = ss.getSheetByName(EXPENSE_MASTER_SHEET_);
  if (!sheet) {
    Logger.log('⚠️ 経費マスターシートなし、転記スキップ');
    return;
  }

  const lastRow = sheet.getLastRow();

  // ── 冪等性: 同じ元ID(O列=15)が既にあれば二重転記しない ──
  if (lastRow >= 4 && p.expenseId) {
    const oidCol = sheet.getRange(4, 15, lastRow - 3, 1).getValues();
    for (let i = 0; i < oidCol.length; i++) {
      if (String(oidCol[i][0]).trim() === String(p.expenseId).trim()) {
        Logger.log('⏭️ 経費マスター既に転記済み(スキップ): ' + p.expenseId);
        return;
      }
    }
  }

  // 9カテゴリ正規化
  const cat9 = normalizeCategoryV7_(p.category, p.desc);

  // 集計対象判定（テスト系を除外）
  const desc = String(p.desc || '');
  const isTestLike = /テスト|かきコピー/.test(desc);
  const includeFlag = isTestLike ? '-' : '○';

  // 入力者名（短縮形）
  const inputUser = (p.staff && p.staff.nameJp) || '不明';

  // ── 支払方法ラベル & 負担先 ──
  //   立替: ロン君の前払い(petty cash)からの支出。残金は「前払い管理」の実残高カウントで
  //         管理するため、支払方法を ADV_BALANCE_LABEL_(立替（残金別管理）) とし、
  //         残金式 D2(=SUMIFS G="立替") には算入させない（顧客現金混在で立替ログ≠実現金）。
  //         負担先は現場スタッフ名（既存表記に合わせ「ロン」→「ロン君」）。
  //   会社直払い: 会社が直接支払い（残金に無関係）。
  let gLabel, payer;
  if (p.paymentType === '立替') {
    gLabel = '立替';  // ledger-driven: 残金式D2に算入→ロン君残金が自動減算される
    payer = (inputUser === 'ロン') ? 'ロン君' : inputUser;
  } else {
    gLabel = '会社直払い';
    payer = '会社';
  }

  // レシート (HYPERLINK 形式の式が来る場合もそのまま入れる)
  const receiptCell = p.receiptUrl ? ('=HYPERLINK("' + p.receiptUrl + '","レシート")') : '';

  // 備考: 立替注記 + 取引先 + メモ + 精算先（あれば）
  const noteParts = [];
  if (p.paymentType === '立替') noteParts.push('Bot立替（ledger-driven・残金自動減算）');
  if (p.vendor)       noteParts.push('取引先: ' + p.vendor);
  if (p.memo)         noteParts.push(p.memo);
  if (p.reimburseTo)  noteParts.push('精算先: ' + p.reimburseTo);
  const noteText = noteParts.join(' / ');

  // 末尾行に追記
  const newRow = lastRow + 1;
  const rowIndex = newRow; // 1-based

  // 数式（K列: JPY換算 / L列: 月）
  const jpyFormula =
    '=IF(P' + rowIndex + '<>"○",0,IF(Q' + rowIndex + '<>"●",0,' +
    'IF(E' + rowIndex + '="USD",D' + rowIndex + '*設定!$B$4,' +
    'IF(E' + rowIndex + '="KHR",D' + rowIndex + '*設定!$B$5,' +
    'IF(E' + rowIndex + '="JPY",D' + rowIndex + ',0)))))';
  const monthFormula = '=IFERROR(TEXT(A' + rowIndex + ',"yyyy-mm"),"")';

  // ID（連番）= 既存最終行のM列 +1
  let nextId = 1;
  if (lastRow >= 4) {
    const prevId = sheet.getRange(lastRow, 13).getValue();
    if (typeof prevId === 'number') nextId = prevId + 1;
    else if (prevId) nextId = (Number(prevId) || 0) + 1;
  }

  // A〜Q（17列）の値を一括書き込み
  const rowValues = [[
    p.txDate,                              // A: 日付
    cat9,                                  // B: カテゴリ
    desc,                                  // C: 項目・摘要
    p.amount,                              // D: 金額
    p.currency,                            // E: 通貨
    payer,                                 // F: 負担先
    gLabel,                                // G: 支払方法（立替は残金別管理ラベル）
    receiptCell,                           // H: レシート
    noteText,                              // I: 備考
    inputUser,                             // J: 入力者
    jpyFormula,                            // K: JPY換算
    monthFormula,                          // L: 月
    nextId,                                // M: ID
    'サムライモーターズ_Bot経費登録',     // N: 出典
    p.expenseId,                           // O: 元ID
    includeFlag,                           // P: 集計対象
    '●'                                    // Q: 経費計上（デフォルト●）
  ]];

  sheet.getRange(newRow, 1, 1, 17).setValues(rowValues);

  // 直前行から書式コピー（体裁統一）+ 行高
  if (lastRow >= 4) {
    sheet.getRange(lastRow, 1, 1, 17).copyTo(
      sheet.getRange(newRow, 1, 1, 17), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    sheet.setRowHeight(newRow, 36);
  }
  Logger.log('📋 経費マスター転記: row=' + newRow + ' id=' + p.expenseId + ' cat=' + cat9 + ' G=' + gLabel);
}

function debugAppendToExpenseMaster() {
  // テスト用: ダミーデータで appendToExpenseMaster_ を実行
  appendToExpenseMaster_({
    expenseId:    'EXP-TEST-001',
    txDate:       Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd'),
    desc:         'テスト: 経費マスター転記',
    amount:       12.34,
    currency:     'USD',
    vendor:       'TestVendor',
    category:     '事務用品',
    memo:         'デバッグ',
    paymentType:  '立替',
    reimburseTo:  '飯泉',
    receiptUrl:   '',
    staff:        { nameJp: 'ロン' }
  });
}
