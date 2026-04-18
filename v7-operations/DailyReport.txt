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
  const taskSection  = buildTaskSection_();

  const text =
    '🌙 <b>日報 ' + jstToday + '</b>\n' +
    '━━━━━━━━━━━━━━━━━━\n' +
    salesSection + '\n\n' +
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
          overdue:  due < todayStr
        });
      }
    }
  });

  const lines = [];
  lines.push('📋 <b>タスク状況</b>');
  lines.push('　✅ 本日完了: ' + doneToday + '件　❌ 未完了申告: ' + notDoneToday + '件　📌 残: ' + pending.length + '件');

  if (pending.length > 0) {
    lines.push('');
    lines.push('<b>未完了タスク一覧</b>');
    // 期限超過を先頭に、担当者別にソート
    pending.sort(function(a, b) {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.due !== b.due) return a.due < b.due ? -1 : 1;
      return a.assignee.localeCompare(b.assignee);
    });
    pending.slice(0, 20).forEach(function(t) {
      const mark = t.overdue ? '🔴' : '🟡';
      const descShort = t.desc.length > 40 ? t.desc.substring(0, 40) + '…' : t.desc;
      lines.push('　' + mark + ' ' + escapeHtml_(t.assignee) + ': ' + escapeHtml_(descShort) + ' <i>(期限 ' + t.due + ')</i>');
    });
    if (pending.length > 20) {
      lines.push('　…他 ' + (pending.length - 20) + '件');
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
