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
 *   SHEET_NAMES.EXPENSES = '経費（ロン入力）'
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

    const reimburseLine = (expenseInfo.paymentType === '立替')
      ? '\n🤝 立替先: ' + escapeHtml_(expenseInfo.reimburseTo) +
        ' / 期限: ' + escapeHtml_(expenseInfo.reimburseDue)
      : '';

    const text =
      '🆕 <b>経費追加</b>(現場から)\n' +
      '👤 追加者: ' + escapeHtml_(creator.nameJp) + '\n' +
      '📋 ID: ' + escapeHtml_(expenseInfo.expenseId) + '\n' +
      '💰 金額: ' + amountStr + ' ' + escapeHtml_(expenseInfo.currency) + '\n' +
      '📝 内容: ' + escapeHtml_(descShort) +
      (expenseInfo.vendor ? '\n🏪 取引先: ' + escapeHtml_(expenseInfo.vendor) : '') +
      (expenseInfo.category ? '\n🏷️ 勘定: ' + escapeHtml_(expenseInfo.category) : '') +
      '\n💳 区分: ' + escapeHtml_(expenseInfo.paymentType) +
      reimburseLine;

    const opts = { parse_mode: 'HTML' };
    if (threadId) opts.message_thread_id = threadId;
    sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, text, opts);
  } catch (err) {
    Logger.log('⚠️ notifyExpenseCreatedIfField_ 失敗(無視可): ' + err);
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
 * 毎週金曜 JST 18:00 に直近7日間の経費サマリを管理グループへ送信
 *
 * - 期間: 実行日を含む直近7日間（取引日ベース）
 * - 集計: 件数 / 通貨別合計 / カテゴリ別 / 担当者別 / 未精算の立替リスト
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

  // 期間内の経費がゼロでもサマリは送る（運用状況の把握のため）
  if (recent.length === 0) {
    sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId,
      '📊 <b>週次経費サマリ</b>\n' +
      '━━━━━━━━━━━━━━━━━━\n' +
      '🗓 対象期間: ' + fromStr + ' 〜 ' + toStr + '\n' +
      'ℹ️ 期間内の経費登録はありません。',
      { parse_mode: 'HTML', message_thread_id: Number(thread) });
    Logger.log('📤 週次経費サマリ送信（0件）');
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
    '📊 <b>週次経費サマリ</b>',
    '━━━━━━━━━━━━━━━━━━',
    '🗓 対象期間: ' + fromStr + ' 〜 ' + toStr,
    '📌 件数: <b>' + recent.length + '件</b>',
    '',
    '💵 <b>合計（通貨別）</b>'
  ];
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
  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(EXPENSE_MASTER_SHEET_);
  if (!sheet) {
    Logger.log('⚠️ 経費マスターシートなし、転記スキップ');
    return;
  }

  // 9カテゴリ正規化
  const cat9 = normalizeCategoryV7_(p.category, p.desc);

  // 集計対象判定（テスト系を除外）
  const desc = String(p.desc || '');
  const isTestLike = /テスト|かきコピー/.test(desc);
  const includeFlag = isTestLike ? '-' : '○';

  // 入力者名（短縮形）
  const inputUser = (p.staff && p.staff.nameJp) || '不明';

  // 負担先決定:
  //   立替: 実際に立て替えた現場スタッフ（ロンなど）
  //   会社直払い: '会社'
  let payer = '会社';
  if (p.paymentType === '立替') {
    // 現場スタッフ名を統一: 「ロン」→「ロン君」（経費マスターの既存表記に合わせる）
    payer = (inputUser === 'ロン') ? 'ロン君' : inputUser;
  }

  // レシート (HYPERLINK 形式の式が来る場合もそのまま入れる)
  const receiptCell = p.receiptUrl ? ('=HYPERLINK("' + p.receiptUrl + '","レシート")') : '';

  // 備考: メモ + 取引先 + 精算先（あれば）
  const noteParts = [];
  if (p.vendor)       noteParts.push('取引先: ' + p.vendor);
  if (p.memo)         noteParts.push(p.memo);
  if (p.reimburseTo)  noteParts.push('精算先: ' + p.reimburseTo);
  const noteText = noteParts.join(' / ');

  // 末尾行に追記
  const lastRow = sheet.getLastRow();
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
    p.paymentType,                         // G: 支払方法
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
  Logger.log('📋 経費マスター転記: row=' + newRow + ' id=' + p.expenseId + ' cat=' + cat9);
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
