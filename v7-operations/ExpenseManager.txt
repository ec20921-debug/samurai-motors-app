/**
 * ExpenseManager.gs — 経費入力（Phase 4）
 *
 * 【責務】
 *   - ミニアプリから送信された経費データ（＋任意のレシート写真）を
 *     「経費」シートに記録
 *   - レシート写真は Drive のフォルダへ保存し、シートにリンク
 *   - 登録後に管理グループ（経費または日報トピック）へ通知
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

  // Admin 通知（失敗してもユーザ登録自体は成功として返す）
  try {
    notifyExpenseSubmitted_(staff, {
      expenseId:    expenseId,
      txDate:       txDate,
      desc:         desc,
      amount:       amount,
      currency:     currency,
      vendor:       vendor,
      category:     category,
      receiptUrl:   receiptUrl,
      memo:         memo,
      paymentType:  paymentType,
      reimburseTo:  reimburseTo,
      reimburseDue: reimburseDue,
      linkedTaskId: linkedTaskId
    });
  } catch (err) {
    Logger.log('⚠️ 経費通知失敗: ' + err);
  }

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
 * 管理グループへ通知
 *
 * 立替の場合は精算先・精算期限を強調表示。会社直払いはシンプルに記録のみ。
 */
function notifyExpenseSubmitted_(staff, data) {
  const cfg = getConfig();
  const thread = cfg.adminExpenseThreadId || cfg.adminDailyReportThreadId;
  if (!thread) {
    Logger.log('⚠️ 経費通知先トピック未設定、スキップ');
    return;
  }

  const isReimburse = data.paymentType === '立替';
  const money = data.currency + ' ' + Number(data.amount).toLocaleString('en-US');

  const headerIcon = isReimburse ? '💸' : '💰';
  const headerLabel = isReimburse ? '立替経費登録' : '経費登録（会社直払い）';

  const lines = [
    headerIcon + ' <b>' + headerLabel + '</b>',
    '━━━━━━━━━━━━━━━━━━'
  ];

  if (isReimburse) {
    lines.push('👤 ' + escapeHtml_(staff.nameJp) + '（立替）→ <b>' + escapeHtml_(data.reimburseTo) + '</b>（精算先）');
  } else {
    lines.push('👤 ' + escapeHtml_(staff.nameJp));
  }

  lines.push('📅 取引日: ' + escapeHtml_(data.txDate));
  lines.push('💵 <b>' + escapeHtml_(money) + '</b>' + (data.category ? '（' + escapeHtml_(data.category) + '）' : ''));
  lines.push('📝 ' + escapeHtml_(String(data.desc).substring(0, 200)));

  if (data.vendor) lines.push('🏪 取引先: ' + escapeHtml_(data.vendor));
  if (data.memo)   lines.push('🗒 メモ: ' + escapeHtml_(String(data.memo).substring(0, 200)));
  if (data.receiptUrl) lines.push('🧾 <a href="' + data.receiptUrl + '">レシート写真</a>');

  if (isReimburse && data.reimburseDue) {
    lines.push('⏰ 精算期限: <b>' + escapeHtml_(data.reimburseDue) + '</b>');
  }

  lines.push('ID: <code>' + escapeHtml_(data.expenseId) + '</code>');

  if (isReimburse && data.linkedTaskId) {
    lines.push('');
    lines.push('📋 精算タスクを自動生成: <code>' + escapeHtml_(data.linkedTaskId) + '</code>');
    lines.push('→ ' + escapeHtml_(data.reimburseTo) + ' さんの朝通知（翌日以降のJST 8:00）で届きます。完了ボタンで自動精算処理。');
  } else if (isReimburse) {
    lines.push('');
    lines.push('⚠️ 精算タスクの自動生成に失敗しました（手動フォロー必要）');
  }

  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), {
    parse_mode: 'HTML',
    message_thread_id: Number(thread),
    disable_web_page_preview: true
  });
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
