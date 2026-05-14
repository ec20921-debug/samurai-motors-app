/**
 * SubscriptionManager.gs — 定期支出（サブスク）管理 (P3)
 *
 * 【背景】
 *   Starlink・社内通信費など毎月発生する固定費を、
 *   「飯泉さんが請求書来てから鈴木に転送 → 鈴木が手入力」していたが
 *   1〜2 件取りこぼしが発生していた。テンプレ化して自動化する。
 *
 * 【設計】
 *   - シート `定期支出テンプレート` に契約を 1 行ずつ登録
 *   - 毎月 1 日 09:00 JST のトリガーで `runMonthlySubscriptionCheck` が起動
 *     ・金額固定(`金額固定=TRUE`) → submitExpense で即時自動投入 + 投入結果を通知
 *     ・金額変動(`金額固定=FALSE`) → "今月の請求金額を確定指示してください" と通知のみ
 *   - 鈴木さんは金額変動分について Claude Code に
 *     「今月のスターリンク ¥42,972 で確定」と伝えると `subscription_apply` API
 *     が叩かれ、経費が登録される
 *
 * 【冪等性】
 *   - 経費メモに `[SUB:<templateId>:<YYYY-MM>]` マーカーを埋め込む
 *   - 月次チェック時はこのマーカーで重複検出 → 既に投入済みならスキップ
 */

const SUBSCRIPTION_SHEET_NAME_ = '定期支出テンプレート';

const SUBSCRIPTION_HEADERS_ = [
  'テンプレID',
  'サービス名',
  '取引先',
  '勘定科目',
  '通貨',
  'デフォルト金額',
  '金額固定',
  '想定登録者',
  '立替区分',
  '想定請求日',
  'アクティブ',
  'メモ'
];

// ============================================================
//  セットアップ
// ============================================================

function ensureSubscriptionSheet() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  let sheet = ss.getSheetByName(SUBSCRIPTION_SHEET_NAME_);
  if (!sheet) {
    sheet = ss.insertSheet(SUBSCRIPTION_SHEET_NAME_);
    sheet.getRange(1, 1, 1, SUBSCRIPTION_HEADERS_.length).setValues([SUBSCRIPTION_HEADERS_]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, SUBSCRIPTION_HEADERS_.length)
      .setFontWeight('bold')
      .setBackground('#2b2b2b')
      .setFontColor('#e8e8e8');
    sheet.setColumnWidth(2, 180);  // サービス名
    sheet.setColumnWidth(12, 260); // メモ

    // サンプル行（Starlink / 社内 Wi-Fi）— 鈴木さんが値を埋める想定
    sheet.appendRow([
      'SUB-001', 'Starlink Japan', 'Starlink', '通信費', 'JPY', '', false,
      '飯泉', '立替', 16, true, 'AMEX(末尾1003) / 月により $0 or ¥42,972 等変動'
    ]);
    sheet.appendRow([
      'SUB-002', '会社携帯 Wi-Fi', '現地キャリア', '通信費', 'USD', 4, true,
      'ロン', '立替', 1, true, '毎月固定 $4'
    ]);

    Logger.log('✅ 定期支出テンプレートシート作成（サンプル 2 件投入）');
    return sheet;
  }
  // ヘッダー整備
  const lastCol = sheet.getLastColumn() || 1;
  const existing = sheet.getRange(1, 1, 1, Math.max(lastCol, SUBSCRIPTION_HEADERS_.length)).getValues()[0];
  let needs = false;
  SUBSCRIPTION_HEADERS_.forEach(function(h, i) { if (existing[i] !== h) needs = true; });
  if (needs) {
    sheet.getRange(1, 1, 1, SUBSCRIPTION_HEADERS_.length).setValues([SUBSCRIPTION_HEADERS_]);
    Logger.log('♻️ 定期支出テンプレートシート ヘッダー整備');
  }
  return sheet;
}

// ============================================================
//  テンプレート取得
// ============================================================

/**
 * アクティブな定期支出テンプレ一覧
 */
function getActiveSubscriptions() {
  ensureSubscriptionSheet();
  const rows = getAllRows(SUBSCRIPTION_SHEET_NAME_);
  return rows
    .filter(function(r) {
      return r['アクティブ'] === true || String(r['アクティブ']).toUpperCase() === 'TRUE';
    })
    .map(function(r) {
      return {
        templateId:    String(r['テンプレID']    || ''),
        serviceName:   String(r['サービス名']    || ''),
        vendor:        String(r['取引先']        || ''),
        category:      String(r['勘定科目']      || ''),
        currency:      String(r['通貨']          || 'JPY').toUpperCase(),
        defaultAmount: Number(r['デフォルト金額'] || 0),
        amountFixed:   r['金額固定'] === true || String(r['金額固定']).toUpperCase() === 'TRUE',
        actorName:     String(r['想定登録者']    || ''),
        paymentType:   String(r['立替区分']      || '立替'),
        billingDay:    Number(r['想定請求日']    || 1),
        memo:          String(r['メモ']          || '')
      };
    });
}

// ============================================================
//  月次チェック（自動投入 + 通知）
// ============================================================

/**
 * 毎月 1 日 09:00 JST のトリガーで呼ばれる想定。
 * - 金額固定のテンプレ → submitExpense で自動投入
 * - 金額変動のテンプレ → 通知のみ（鈴木さんに確定指示要求）
 *
 * 冪等性：経費メモの [SUB:templateId:YYYY-MM] マーカーで重複検出。
 */
function runMonthlySubscriptionCheck() {
  const tz = OPS_TZ;
  const now = new Date();
  const ym = Utilities.formatDate(now, tz, 'yyyy-MM');
  const subs = getActiveSubscriptions();

  if (subs.length === 0) {
    Logger.log('ℹ️ アクティブな定期支出テンプレなし、月次チェックスキップ');
    return { ok: true, applied: 0, pending: 0, skipped: 0 };
  }

  const applied = []; // 自動投入できたもの
  const pending = []; // 鈴木の確定指示待ち（金額変動）
  const skipped = []; // 既に投入済み

  subs.forEach(function(sub) {
    if (isSubscriptionApplied_(sub.templateId, ym)) {
      skipped.push(sub);
      return;
    }
    if (sub.amountFixed && sub.defaultAmount > 0) {
      const r = applySubscriptionInternal_(sub, sub.defaultAmount, ym, 'auto');
      if (r.ok) applied.push({ sub: sub, amount: sub.defaultAmount, expenseId: r.expenseId });
      else      pending.push({ sub: sub, error: r.error });
    } else {
      pending.push({ sub: sub, reason: '金額変動・要確定' });
    }
  });

  notifyMonthlySubscriptionReport_(ym, applied, pending, skipped);

  Logger.log('📤 月次定期支出チェック: 自動投入' + applied.length +
    '件 / 要確定' + pending.length + '件 / スキップ' + skipped.length + '件');
  return { ok: true, ym: ym, applied: applied.length, pending: pending.length, skipped: skipped.length };
}

/**
 * 鈴木さんが Claude Code 経由で金額確定指示する用。
 * 例：「今月のスターリンク ¥42,972 で確定」
 *   → applySubscriptionByName('Starlink Japan', 42972)
 */
function applySubscriptionByName(serviceName, amount, ym) {
  const tz = OPS_TZ;
  ym = ym || Utilities.formatDate(new Date(), tz, 'yyyy-MM');
  const subs = getActiveSubscriptions();
  // 完全一致 → サービス名/取引先の部分一致 で寛容に解決
  const target = subs.find(function(s) { return s.serviceName === serviceName; })
              || subs.find(function(s) { return String(s.serviceName).indexOf(serviceName) >= 0; })
              || subs.find(function(s) { return String(s.vendor).indexOf(serviceName) >= 0; });
  if (!target) return { ok: false, error: 'TEMPLATE_NOT_FOUND', serviceName: serviceName };
  if (isSubscriptionApplied_(target.templateId, ym)) {
    return { ok: false, error: 'ALREADY_APPLIED', templateId: target.templateId, ym: ym };
  }
  return applySubscriptionInternal_(target, Number(amount), ym, 'manual');
}

/**
 * テンプレID指定で確定（API 用）
 */
function applySubscriptionById(templateId, amount, ym) {
  const tz = OPS_TZ;
  ym = ym || Utilities.formatDate(new Date(), tz, 'yyyy-MM');
  const sub = getActiveSubscriptions().find(function(s) { return s.templateId === templateId; });
  if (!sub) return { ok: false, error: 'TEMPLATE_NOT_FOUND', templateId: templateId };
  if (isSubscriptionApplied_(sub.templateId, ym)) {
    return { ok: false, error: 'ALREADY_APPLIED', templateId: templateId, ym: ym };
  }
  return applySubscriptionInternal_(sub, Number(amount), ym, 'manual');
}

// ============================================================
//  内部ヘルパー
// ============================================================

function isSubscriptionApplied_(templateId, ym) {
  const marker = '[SUB:' + templateId + ':' + ym + ']';
  try {
    const rows = getAllRows(SHEET_NAMES.EXPENSES);
    return rows.some(function(r) {
      return String(r['メモ'] || '').indexOf(marker) >= 0;
    });
  } catch (e) {
    return false;
  }
}

function applySubscriptionInternal_(sub, amount, ym, mode) {
  if (!amount || isNaN(amount) || amount <= 0) {
    return { ok: false, error: 'AMOUNT_INVALID', sub: sub };
  }

  // 取引日：その月の請求日（billingDay が当月末を超える場合は当月末日）
  const tz = OPS_TZ;
  const parts = ym.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const lastDay = new Date(y, m, 0).getDate(); // m は 1-indexed なので Date(y, m, 0) = 当月末日
  const day = Math.min(Math.max(1, sub.billingDay || 1), lastDay);
  const txDate = ym + '-' + ('0' + day).slice(-2);

  const memo = sub.memo
    ? sub.memo + ' [SUB:' + sub.templateId + ':' + ym + ':' + mode + ']'
    : '[SUB:' + sub.templateId + ':' + ym + ':' + mode + ']';

  // submitExpense は actorName で登録者を解決可能
  const result = submitExpense('', {
    transactionDate: txDate,
    description:     sub.serviceName + '（' + ym + ' 定期支出）',
    amount:          amount,
    currency:        sub.currency,
    vendor:          sub.vendor,
    category:        sub.category,
    memo:            memo,
    paymentType:     sub.paymentType,
    actorName:       sub.actorName
  });

  if (!result || !result.ok) {
    return { ok: false, error: result && result.error, sub: sub };
  }
  return { ok: true, expenseId: result.expenseId, templateId: sub.templateId, ym: ym, amount: amount };
}

function notifyMonthlySubscriptionReport_(ym, applied, pending, skipped) {
  try {
    const cfg = getConfig();
    if (!cfg.adminGroupId) return;
    const thread = cfg.adminExpenseThreadId || cfg.adminDailyReportThreadId;
    if (!thread) {
      Logger.log('⚠️ 経費通知トピック未設定、月次定期支出レポートスキップ');
      return;
    }

    const fmtAmount = function(a, c) {
      const s = (Number(a).toLocaleString)
        ? Number(a).toLocaleString('en-US')
        : String(a);
      return s + ' ' + c;
    };

    const lines = [
      '📅 <b>定期支出 月次チェック (' + ym + ')</b>',
      '━━━━━━━━━━━━━━━━━━'
    ];

    if (applied.length > 0) {
      lines.push('✅ <b>自動投入 ' + applied.length + '件</b>');
      applied.forEach(function(a) {
        lines.push('　・' + escapeHtml_(a.sub.serviceName) + ': ' +
          escapeHtml_(fmtAmount(a.amount, a.sub.currency)) +
          ' (<code>' + escapeHtml_(a.expenseId) + '</code>)');
      });
    }

    if (pending.length > 0) {
      lines.push('');
      lines.push('⏳ <b>鈴木さん 金額確定指示お願いします ' + pending.length + '件</b>');
      pending.forEach(function(p) {
        const reason = p.reason || p.error || '要確定';
        lines.push('　・' + escapeHtml_(p.sub.serviceName) +
          '（' + escapeHtml_(p.sub.vendor) + '）: ' + escapeHtml_(reason));
      });
      lines.push('');
      lines.push('💬 Claude Code に「今月の <i>サービス名</i> ¥<i>金額</i> で確定」と伝えてください');
    }

    if (skipped.length > 0) {
      lines.push('');
      lines.push('🔁 投入済 ' + skipped.length + '件（スキップ）');
    }

    sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), {
      parse_mode: 'HTML',
      message_thread_id: Number(thread),
      disable_web_page_preview: true
    });
  } catch (err) {
    Logger.log('⚠️ notifyMonthlySubscriptionReport_ 失敗(無視可): ' + err);
  }
}

// ============================================================
//  デバッグ
// ============================================================

function debugEnsureSubscriptionSheet() {
  ensureSubscriptionSheet();
}

function debugListSubscriptions() {
  Logger.log(JSON.stringify(getActiveSubscriptions(), null, 2));
}

function debugRunMonthlyCheck() {
  Logger.log(JSON.stringify(runMonthlySubscriptionCheck(), null, 2));
}
