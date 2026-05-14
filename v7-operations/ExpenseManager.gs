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
 * 【立替区分の意味（P2 で再定義）】
 *   - `会社直払い` = 会社カード・会社口座から直接払った（プール影響なし）
 *   - `立替`       = 自分の財布で払った会社経費
 *     ・登録者=ロン        → 前払いプールから消費したものと見なす（PoolManager で残高反映）
 *     ・登録者=ロン以外    → 個人立替（飯泉 AMEX 等）。記録のみ、精算タスクは自動生成しない
 *
 * 【精算タスクの自動生成について】
 *   v6 / 過去の v7-ops では `立替` 時に精算タスクを自動生成していたが、
 *   ノイズが多すぎたため γ 方針（記録のみ）で廃止。既存の未精算タスクは
 *   TaskManager.settleExpenseByTask_ 経由で後方互換的に閉じる。
 *
 * @param {string} chatId 登録者の Telegram chat_id（Claude Code 経由なら空でも可）
 * @param {Object} payload {
 *   transactionDate: 'yyyy-MM-dd',
 *   description:     string,
 *   amount:          number,
 *   currency:        'USD'|'KHR'|'JPY',
 *   vendor:          string (任意),
 *   category:        string,
 *   memo:            string (任意),
 *   photoBase64:     string (任意),
 *   photoMime:       'image/jpeg'|'image/png' 等,
 *   photoName:       'receipt.jpg' (任意),
 *   paymentType:     '立替'|'会社直払い',
 *   reimburseTo:     string (任意・参考情報のみ、自動タスクは作らない),
 *   reimburseDueDate:string (任意・参考情報のみ),
 *   actorName:       string (chatId なしの時の登録者氏名。例: '飯泉' / '鈴木')
 * }
 */
function submitExpense(chatId, payload) {
  payload = payload || {};

  // 登録者の解決：chatId 優先、それで見つからない場合は actorName（Claude Code 経由用）
  let staff = null;
  if (chatId) {
    staff = findStaffByChatId(String(chatId));
  }
  if (!staff && payload.actorName) {
    staff = findStaffByNameJp(String(payload.actorName));
  }
  if (!staff) {
    return {
      ok: false,
      error: 'STAFF_NOT_FOUND',
      chatId: String(chatId || ''),
      actorName: String(payload.actorName || '')
    };
  }

  const desc     = String(payload.description || '').trim();
  const amount   = Number(payload.amount || 0);
  const currency = String(payload.currency || 'USD').trim().toUpperCase();
  const vendor   = String(payload.vendor   || '').trim();
  const category = String(payload.category || '').trim();
  const memo     = String(payload.memo     || '').trim();

  // 立替区分（2値）
  var paymentType = String(payload.paymentType || '会社直払い').trim();
  if (EXPENSE_PAYMENT_TYPES_.indexOf(paymentType) < 0) paymentType = '会社直払い';
  const isReimburse = paymentType === '立替';
  // 精算先 / 精算期限：自動タスクを作らないので参考情報扱い。立替時も必須にしない
  const reimburseTo = isReimburse ? String(payload.reimburseTo || '').trim() : '';

  if (!desc) return { ok: false, error: 'DESC_REQUIRED' };
  if (!amount || isNaN(amount) || amount <= 0) return { ok: false, error: 'AMOUNT_INVALID' };
  if (EXPENSE_CURRENCIES_.indexOf(currency) < 0) return { ok: false, error: 'CURRENCY_INVALID' };

  const tz = staff.timezone || OPS_TZ;
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const txDate = String(payload.transactionDate || todayStr).trim() || todayStr;

  // 精算期限は明示指定があれば記録（参考用）。自動デフォルト +3日 は廃止
  const reimburseDue = isReimburse ? String(payload.reimburseDueDate || '').trim() : '';

  const expenseId = generateDateSeqId('EXP', SHEET_NAMES.EXPENSES, '経費ID');

  // レシート写真保存（任意）
  let receiptUrl = '';
  let ocrText = '';
  if (payload.photoBase64) {
    try {
      const saved = saveReceiptPhoto_(payload.photoBase64, payload.photoMime, payload.photoName, expenseId);
      receiptUrl = saved.url;
      // ocrText = performOcrOnFile_(saved.file); // 将来 Drive API v2 を有効化したら差し込む
    } catch (err) {
      Logger.log('⚠️ レシート保存失敗: ' + err);
    }
  }

  // ステータス判定（新セマンティクス）
  //   会社直払い            → 会社負担
  //   立替 + 登録者=ロン    → プール消費（前払い金を使った）
  //   立替 + その他登録者   → 個人立替（飯泉 AMEX 等。γ=記録のみで精算タスクは作らない）
  var statusValue;
  if (!isReimburse) {
    statusValue = '会社負担';
  } else if (staff.nameJp === 'ロン') {
    statusValue = 'プール消費';
  } else {
    statusValue = '個人立替';
  }

  // P2: 精算タスク自動生成は廃止（γ＝記録のみ）。既存「未精算」レコードの後方互換は TaskManager 側で維持
  const linkedTaskId = '';

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
    '登録者 Chat ID': String(chatId || staff.chatId || ''),
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
    reimburseDue: reimburseDue,
    statusValue:  statusValue
  }, staff);

  // ロンの「プール消費」だった場合は更新後の残高も返す（ミニアプリで即時表示できるように）
  var poolBalanceAfter = null;
  if (statusValue === 'プール消費' && typeof getPoolBalance === 'function') {
    try { poolBalanceAfter = getPoolBalance('ロン'); } catch (e) { /* ignore */ }
  }

  return {
    ok: true,
    expenseId: expenseId,
    receiptUrl: receiptUrl,
    paymentType: paymentType,
    reimburseTo: reimburseTo,
    reimburseDue: reimburseDue,
    linkedTaskId: linkedTaskId,
    statusValue: statusValue,
    actor: staff.nameJp,
    poolBalanceAfter: poolBalanceAfter
  };
}

/**
 * 現場スタッフ(role='field' = ロン等)が経費追加した時のみ管理グループに通知
 * 日本側(role='admin' = Daisuke / 飯泉)の追加は無音
 *
 * @param {Object} expenseInfo - 通知に使う経費情報
 * @param {Object} creator - スタッフ情報（findStaffByChatId/findStaffByNameJp の戻り値）
 */
function notifyExpenseCreatedIfField_(expenseInfo, creator) {
  if (!creator) return;
  try {
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

    // 立替時の追加情報行（精算先・期限は参考情報のみ）
    var reimburseLine = '';
    if (expenseInfo.paymentType === '立替' && (expenseInfo.reimburseTo || expenseInfo.reimburseDue)) {
      reimburseLine = '\n🤝 立替先: ' + escapeHtml_(expenseInfo.reimburseTo || '-') +
        (expenseInfo.reimburseDue ? ' / 期限: ' + escapeHtml_(expenseInfo.reimburseDue) : '');
    }

    // ロンのプール消費は残高も併記（管理者がリアルタイムに把握できるように）
    var balanceLine = '';
    if (expenseInfo.statusValue === 'プール消費' && typeof getPoolBalance === 'function') {
      try {
        const bal = getPoolBalance('ロン');
        balanceLine = '\n💼 ロン残高: <b>$' + (bal.balanceUSD).toFixed(2) + '</b>';
      } catch (e) { /* ignore */ }
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
      (expenseInfo.statusValue ? ' / ' + escapeHtml_(expenseInfo.statusValue) : '') +
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
 * - 集計: 件数 / 通貨別合計 / カテゴリ別 / 担当者別 / 個人立替リスト
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

  // 個人立替（精算待ち or 記録のみ）— 期間内に限らず全件
  //   P2 以降: ステータス '個人立替' = 飯泉 AMEX 等の自腹分（γ=記録のみ）
  //   P2 以前: ステータス '未精算'   = 旧フローの自動タスク連動分（後方互換）
  //   どちらも管理者目線では「会社→個人へ精算する可能性のあるもの」として一覧表示
  const unsettled = rows.filter(function(r) {
    if (String(r['立替区分']) !== '立替') return false;
    const status = String(r['ステータス']);
    return status === '未精算' || status === '個人立替';
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
    lines.push('⏳ <b>個人立替（記録のみ・全期間 ' + unsettled.length + '件）</b>');
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
  Logger.log('📤 週次経費サマリ送信: ' + recent.length + '件 / 個人立替' + unsettled.length + '件');
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
