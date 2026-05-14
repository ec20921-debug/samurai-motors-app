/**
 * DailyReport.gs — 日報（Phase 2e）
 *
 * 【責務】
 *   JST 20:00 に、当日の業務サマリーを管理グループの日報トピックへ送信する。
 *
 *   - 売上・ジョブ件数・プラン内訳     ← v7 の「予約」シートを openById で参照
 *   - 決済状況（清算済み/QR送信済み/未清算）
 *   - タスク状況（完了/未完/期限超過）← v7-ops の「タスク」シート
 *
 * 【スケジュール】
 *   hourlyTaskScheduler() が jstHour === 20 で sendDailyReport() を呼ぶ。
 *
 * 【グレースフル・デグラデーション】
 *   V7_SPREADSHEET_ID が未設定なら売上セクションをスキップしてタスクのみ送る。
 */

// ============================================================
//  エントリポイント
// ============================================================

function sendDailyReport() {
  const cfg = getConfig();
  if (!cfg.adminDailyReportThreadId) {
    Logger.log('⚠️ ADMIN_DAILY_REPORT_THREAD_ID 未設定 — 日報スキップ');
    return;
  }

  const jstToday = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd (E)');
  const ppToday  = Utilities.formatDate(new Date(), OPS_TZ,       'yyyy-MM-dd');

  const salesSection = buildSalesSection_(ppToday);
  const poolSection  = buildPoolBalanceSection_(ppToday);
  const taskSection  = buildTaskSection_();

  const text =
    '🌙 <b>日報 ' + jstToday + '</b>\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    salesSection + '\n\n' +
    poolSection + '\n\n' +
    taskSection;

  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, text, {
    parse_mode: 'HTML',
    message_thread_id: Number(cfg.adminDailyReportThreadId),
    disable_web_page_preview: true
  });
  Logger.log('📤 日報送信完了 (JST ' + jstToday + ')');
}

// ============================================================
//  売上セクション（v7 予約シートから集計）
// ============================================================

function buildSalesSection_(todayStr) {
  const cfg = getConfig();
  if (!cfg.v7SpreadsheetId) {
    return '💰 <b>売上</b>\n　（V7_SPREADSHEET_ID 未設定のためスキップ）';
  }

  let rows;
  try {
    rows = readV7BookingsForDate_(cfg.v7SpreadsheetId, todayStr);
  } catch (err) {
    Logger.log('❌ v7 予約シート読取失敗: ' + err);
    return '💰 <b>売上</b>\n　（v7 予約シート読取失敗: ' + escapeHtml_(String(err)) + '）';
  }

  if (rows.length === 0) {
    return '💰 <b>本日の売上</b>\n　📭 本日分の予約なし';
  }

  // 集計
  let total = 0;
  let completedCount = 0;
  const planMap = {};       // plan -> {count, amount}
  const payMap  = { '清算済み': 0, 'QR送信済み': 0, '未清算': 0, '要確認': 0, 'その他': 0 };

  rows.forEach(function(r) {
    const plan   = String(r['プラン'] || '不明');
    const amt    = Number(r['料金(USD)']) || 0;
    const prog   = String(r['進行状態'] || '');
    const pay    = String(r['決済状態'] || '未清算');

    if (prog !== 'cancelled') {
      total += amt;
      if (prog === 'completed') completedCount++;
      planMap[plan] = planMap[plan] || { count: 0, amount: 0 };
      planMap[plan].count  += 1;
      planMap[plan].amount += amt;
    }
    if (payMap.hasOwnProperty(pay)) payMap[pay] += 1;
    else payMap['その他'] += 1;
  });

  const lines = [];
  lines.push('💰 <b>本日の売上</b>');
  lines.push('　合計: <b>$' + total.toFixed(2) + '</b>');
  lines.push('　ジョブ: ' + rows.length + '件（完了 ' + completedCount + ' / キャンセル ' + countBy_(rows, '進行状態', 'cancelled') + '）');

  // プラン内訳
  const planNames = Object.keys(planMap);
  if (planNames.length > 0) {
    lines.push('');
    lines.push('📋 <b>プラン内訳</b>');
    planNames.forEach(function(p) {
      lines.push('　' + escapeHtml_(p) + ': ' + planMap[p].count + '件 / $' + planMap[p].amount.toFixed(2));
    });
  }

  // 決済状況
  lines.push('');
  lines.push('💳 <b>決済状況</b>');
  lines.push('　✅ 清算済み: ' + payMap['清算済み'] + '件');
  lines.push('　📨 QR送信済み: ' + payMap['QR送信済み'] + '件');
  lines.push('　⏳ 未清算: ' + payMap['未清算'] + '件');
  if (payMap['要確認'] > 0) lines.push('　⚠️ 要確認: ' + payMap['要確認'] + '件');

  return lines.join('\n');
}

function countBy_(rows, col, value) {
  let n = 0;
  rows.forEach(function(r) { if (String(r[col]) === value) n++; });
  return n;
}

/**
 * v7 予約シートから当日分（PP日付）の行だけ返す
 */
function readV7BookingsForDate_(v7SsId, todayStr) {
  const ss = SpreadsheetApp.openById(v7SsId);
  const sheet = ss.getSheetByName('予約');
  if (!sheet) throw new Error('v7「予約」シート未発見');

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return [];

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const values  = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  const ssTz = ss.getSpreadsheetTimeZone() || OPS_TZ;

  return values
    .map(function(row) {
      const o = {};
      headers.forEach(function(h, j) { o[h] = row[j]; });
      return o;
    })
    .filter(function(r) {
      const d = r['予約日'];
      if (!d) return false;
      const ds = (d instanceof Date)
        ? Utilities.formatDate(d, ssTz, 'yyyy-MM-dd')
        : String(d).trim().substring(0, 10);
      return ds === todayStr;
    });
}

// ============================================================
//  ロン プール残高セクション（P4）
// ============================================================

/**
 * ロン君の前払いプール残高セクションを構築。
 * - 現在残高（USD換算）
 * - 今日の入金（あれば）
 * - 今日の立替消費（あれば、USD/KHR 通貨別 + USD換算）
 *
 * PoolManager が無い／例外時は短いフォールバック文字列を返す（日報全体を落とさない）。
 */
function buildPoolBalanceSection_(todayStr) {
  try {
    if (typeof getPoolBalance !== 'function') {
      return '💼 <b>ロン手持ち残高</b>\n　（PoolManager 未配置）';
    }
    const bal = getPoolBalance('ロン');

    // 今日の入金
    const deposits = (typeof getAllRows === 'function')
      ? getAllRows(POOL_SHEET_NAME_).filter(function(r) {
          if (String(r['受領者']) !== 'ロン') return false;
          const ds = formatDateCellTz_(r['入金日'], OPS_TZ);
          return ds === todayStr;
        })
      : [];

    // 今日のロン立替消費（経費シート）
    var todaySpendUSD = 0;
    var todaySpendCount = 0;
    var todaySpendByCur = { USD: 0, KHR: 0 };
    try {
      const exps = getAllRows(SHEET_NAMES.EXPENSES);
      exps.forEach(function(r) {
        if (String(r['登録者']) !== 'ロン') return;
        if (String(r['立替区分']) !== '立替') return;
        const ds = formatDateCellTz_(r['取引日'], OPS_TZ);
        if (ds !== todayStr) return;
        const amt = Number(r['金額'] || 0);
        const cur = String(r['通貨'] || 'USD').toUpperCase();
        if (todaySpendByCur[cur] === undefined) todaySpendByCur[cur] = 0;
        todaySpendByCur[cur] += amt;
        if (cur === 'USD') todaySpendUSD += amt;
        else if (cur === 'KHR') todaySpendUSD += amt / 4000;
        todaySpendCount++;
      });
    } catch (e) { /* ignore */ }

    const lines = [];
    lines.push('💼 <b>ロン手持ち残高（前払いプール）</b>');
    lines.push('　現在: <b>$' + bal.balanceUSD.toFixed(2) + '</b>');

    if (deposits.length > 0) {
      const depositLine = deposits.map(function(d) {
        const amt = Number(d['金額'] || 0);
        const cur = String(d['通貨'] || 'USD');
        return cur + ' ' + amt.toLocaleString('en-US') + '（' + String(d['入金者'] || '') +
          ' / ' + String(d['方法'] || '') + '）';
      }).join(', ');
      lines.push('　🆕 本日入金: ' + escapeHtml_(depositLine));
    }

    if (todaySpendCount > 0) {
      const parts = [];
      if (todaySpendByCur.USD > 0) parts.push('USD ' + todaySpendByCur.USD.toFixed(2));
      if (todaySpendByCur.KHR > 0) parts.push('KHR ' + todaySpendByCur.KHR.toLocaleString('en-US'));
      lines.push('　🧾 本日消費: ' + parts.join(' + ') + '（' + todaySpendCount + '件・USD換算 $' + todaySpendUSD.toFixed(2) + '）');
    }

    return lines.join('\n');
  } catch (err) {
    Logger.log('⚠️ buildPoolBalanceSection_ 失敗: ' + err);
    return '💼 <b>ロン手持ち残高</b>\n　（取得失敗: ' + escapeHtml_(String(err)) + '）';
  }
}

// ============================================================
//  タスクセクション
// ============================================================

function buildTaskSection_() {
  const rows = getAllRows(SHEET_NAMES.TASKS);
  const jstToday = Utilities.formatDate(new Date(), 'Asia/Tokyo',       'yyyy-MM-dd');
  const ppToday  = Utilities.formatDate(new Date(), 'Asia/Phnom_Penh',  'yyyy-MM-dd');

  let doneToday   = 0;
  let notDoneToday = 0;
  const pending = [];   // 未着手で期限 <= 今日（担当者TZで比較）

  rows.forEach(function(r) {
    const status = String(r['ステータス'] || '');
    if (status === '繰返し中') return;

    const tz = String(r['担当 timezone'] || OPS_TZ);
    const todayStr = (tz === 'Asia/Tokyo') ? jstToday : ppToday;
    const due = formatDateCellTz_(r['期限'], tz);

    if (status === '完了') {
      // 今日の日付で完了した分だけカウント（完了日時基準、ざっくり）
      const finStr = formatDateCellTz_(r['完了日時'], tz);
      if (finStr === todayStr) doneToday++;
      return;
    }
    if (status === '未完了') {
      const finStr = formatDateCellTz_(r['完了日時'], tz);
      if (finStr === todayStr) notDoneToday++;
      return;
    }
    if (status === '未着手') {
      if (!due) return;
      if (due <= todayStr) {
        pending.push({
          assignee: String(r['担当者名']),
          desc:     String(r['タスク内容']),
          due:      due,
          overdue:  due < todayStr,
          parentId: String(r['親タスクID'] || '').trim()  // 繰返し親ID
        });
      }
    }
  });

  // ── 繰返しタスクの重複排除 (2026-05-07 追加) ──
  // 同一「親タスクID」を持つ未着手子タスクは、最も古い期限の1件のみを代表として表示。
  // 過剰な重複表示を防ぎつつ、溜まり具合は (+N件) で可視化。
  const dedupedPending = (function dedupeRecurring(tasks) {
    const byParent = {};   // parentId → { rep: 最古期限の1件, count: 同親の総数 }
    const standalone = []; // parentId が空(繰返しでない単独タスク)

    tasks.forEach(function(t) {
      if (!t.parentId) {
        standalone.push(t);
        return;
      }
      if (!byParent[t.parentId]) {
        byParent[t.parentId] = { rep: t, count: 1 };
      } else {
        byParent[t.parentId].count++;
        if (t.due < byParent[t.parentId].rep.due) {
          byParent[t.parentId].rep = t;
        }
      }
    });

    // 代表に集約数を埋め込む
    Object.keys(byParent).forEach(function(pid) {
      byParent[pid].rep.recurringCount = byParent[pid].count;
    });

    return standalone.concat(Object.keys(byParent).map(function(pid) {
      return byParent[pid].rep;
    }));
  })(pending);

  const lines = [];
  lines.push('📋 <b>タスク状況</b>');
  // 残: 総件数(個別実体ベース)+ ユニーク数(繰返し集約後)
  const uniqueLine = (dedupedPending.length !== pending.length)
    ? '　✅ 本日完了: ' + doneToday + '件　❌ 未完了申告: ' + notDoneToday + '件　📌 残: ' + pending.length + '件 (種類: ' + dedupedPending.length + ')'
    : '　✅ 本日完了: ' + doneToday + '件　❌ 未完了申告: ' + notDoneToday + '件　📌 残: ' + pending.length + '件';
  lines.push(uniqueLine);

  if (dedupedPending.length > 0) {
    lines.push('');
    lines.push('<b>未完了タスク一覧</b>');
    // 期限超過を先頭に、担当者別にソート
    dedupedPending.sort(function(a, b) {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.due !== b.due) return a.due < b.due ? -1 : 1;
      return a.assignee.localeCompare(b.assignee);
    });
    dedupedPending.slice(0, 20).forEach(function(t) {
      const mark = t.overdue ? '🔴' : '🟡';
      const descShort = t.desc.length > 40 ? t.desc.substring(0, 40) + '…' : t.desc;
      // 繰返し集約: 「(+N件)」の補足を末尾に
      const recurrSuffix = (t.recurringCount && t.recurringCount > 1)
        ? ' <i>+' + (t.recurringCount - 1) + '件溜まり</i>'
        : '';
      lines.push('　' + mark + ' ' + escapeHtml_(t.assignee) + ': ' + escapeHtml_(descShort) + ' <i>(期限 ' + t.due + ')</i>' + recurrSuffix);
    });
    if (dedupedPending.length > 20) {
      lines.push('　…他 ' + (dedupedPending.length - 20) + '件');
    }
  }

  return lines.join('\n');
}

// ============================================================
//  デバッグ
// ============================================================

function debugSendDailyReportNow() {
  sendDailyReport();
}

function debugPreviewDailyReport() {
  const ppToday = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd');
  Logger.log('--- 売上セクション ---');
  Logger.log(buildSalesSection_(ppToday));
  Logger.log('--- タスクセクション ---');
  Logger.log(buildTaskSection_());
}
