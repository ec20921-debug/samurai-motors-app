/**
 * WeeklySalesReport.gs — 週次売上レポート（2026-11-14 Daisuke 指示）
 *
 * 【責務】
 *   毎週土曜 20:00〜20:29 JST に、その週（日曜〜土曜・プノンペンの日付）の売上とサービス明細を、
 *   先週比つきで管理グループの日報トピックへ送る。日報（20:30）より先に届く。
 *
 *   - 売上・作業件数・お客様の数・客単価  ← v7 の「予約」シート（日報と同じ読み方・キャンセルは除く）
 *   - サービス明細（件数・売上・先週比）  ← 日報の「プラン内訳」と同じ名前（bookingPlanLabel_）
 *   - 入金（清算済み / まだ）
 *
 * 【スケジュール】
 *   1分トリガー（pollInternalBot）起点。時刻窓の外は時刻判定だけで即 return。
 *   重複防止 = Script Properties の日付マーカー（日報と同じ方式）。
 *   今週も先週も予約が0件なら送らない。読めなかった時は送る（不具合を隠さない）。
 *
 * 【止め方】
 *   BotPoller.gs の maybeSendWeeklySalesReport_() の1行をコメントにして push。
 */

const WEEKLY_SALES_MAX_SERVICES_ = 12; // サービス明細の最大行数（超えた分は「その他」にまとめる）

/**
 * 毎週土曜 20:00〜20:29 JST の定時送信チェック（pollInternalBot から毎分呼ばれる）
 */
function maybeSendWeeklySalesReport_() {
  const now = new Date();
  if (Utilities.formatDate(now, 'Asia/Tokyo', 'u') !== '6') return; // 6 = 土曜
  const hm = Utilities.formatDate(now, 'Asia/Tokyo', 'HH:mm');
  if (hm < '20:00' || hm > '20:29') return;

  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  if (props.getProperty('weekly_sales_last_sent') === today) return;
  props.setProperty('weekly_sales_last_sent', today); // 送信前にマーク（多重送信防止優先）

  sendWeeklySalesReport();
}

/**
 * 週次売上レポートを送る。endStr（yyyy-MM-dd・週の最終日）を省くとプノンペンの今日
 */
function sendWeeklySalesReport(endStr) {
  const cfg = getConfig();
  if (!cfg.adminDailyReportThreadId) {
    Logger.log('⚠️ ADMIN_DAILY_REPORT_THREAD_ID 未設定 — 週次売上レポートをスキップ');
    return;
  }
  const text = buildWeeklySalesReportText_(cfg, endStr || Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd'));
  if (!text) {
    Logger.log('📭 週次売上レポート: 今週も先週も予約なし → 送信しない');
    return;
  }
  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, text, {
    parse_mode: 'HTML',
    message_thread_id: Number(cfg.adminDailyReportThreadId),
    disable_web_page_preview: true
  });
  Logger.log('📤 週次売上レポート送信完了');
}

/**
 * 本文を組み立てる（シートを読む）。今週も先週も0件なら ''
 */
function buildWeeklySalesReportText_(cfg, endStr) {
  const fromStr = weeklySalesShiftDay_(endStr, -6);
  const prevFrom = weeklySalesShiftDay_(endStr, -13);
  const prevTo = weeklySalesShiftDay_(endStr, -7);
  const head = '📊 <b>週次売上レポート</b>\n🗓 ' + weeklySalesDayLabel_(fromStr) + ' 〜 ' + weeklySalesDayLabel_(endStr) +
               '\n━━━━━━━━━━━━━━━━━━\n';
  if (!cfg.v7SpreadsheetId) return head + '（V7_SPREADSHEET_ID 未設定のため集計できません）';

  let all;
  try {
    all = readV7BookingsInRange_(cfg.v7SpreadsheetId, prevFrom, endStr); // 2週間分を1回で読む
  } catch (err) {
    Logger.log('❌ 週次売上レポート: v7 予約シート読取失敗: ' + err);
    return head + '（v7 予約シート読取失敗: ' + escapeHtml_(String(err)) + '）';
  }
  const tz = weeklySalesSheetTz_(cfg.v7SpreadsheetId);
  const thisRows = [], prevRows = [];
  all.forEach(function(r) {
    const ds = weeklySalesRowDate_(r, tz);
    if (ds >= fromStr) thisRows.push(r);
    else if (ds <= prevTo) prevRows.push(r);
  });
  if (!thisRows.length && !prevRows.length) return '';
  return head + formatWeeklySalesBody_(thisRows, prevRows);
}

/**
 * 今週・先週の予約行から本文（見出しの下）を作る。シートは読まない（テストしやすくするため）
 */
function formatWeeklySalesBody_(thisRows, prevRows) {
  const cur = computeV7WeeklyKpi_(thisRows);
  const prev = computeV7WeeklyKpi_(prevRows);
  const cancelled = thisRows.filter(function(r) { return isCancelledStatus_(r['進行状態']); }).length;

  const lines = [];
  lines.push('💰 <b>売上: $' + cur.sales.toFixed(2) + '</b>');
  lines.push('　' + weeklySalesDiff_(cur.sales, prev.sales, 'usd') + '（先週 $' + prev.sales.toFixed(2) + '）');
  lines.push('🚗 作業: <b>' + cur.count + '件</b>　' + weeklySalesDiff_(cur.count, prev.count, '件'));
  lines.push('👥 お客様: <b>' + cur.customers + '名</b>　' + weeklySalesDiff_(cur.customers, prev.customers, '名'));
  lines.push('💵 客単価: <b>$' + cur.avg.toFixed(1) + '</b>（先週 $' + prev.avg.toFixed(1) + '）');
  if (cancelled) lines.push('🚫 キャンセル: ' + cancelled + '件（売上・件数には入れていません）');

  // サービス明細（今週の売上が多い順。先週だけにあったサービスも 0件として出す）
  const curMap = weeklySalesByService_(thisRows);
  const prevMap = weeklySalesByService_(prevRows);
  const names = Object.keys(curMap);
  Object.keys(prevMap).forEach(function(n) { if (!curMap[n]) names.push(n); });
  names.sort(function(a, b) {
    const x = curMap[a] || { count: 0, amount: 0 }, y = curMap[b] || { count: 0, amount: 0 };
    return (y.amount - x.amount) || (y.count - x.count) || (a < b ? -1 : 1);
  });
  lines.push('');
  lines.push('🧽 <b>サービス明細</b>（件数 / 売上 ← 先週比）');
  const medals = ['🥇', '🥈', '🥉'];
  const shown = names.slice(0, WEEKLY_SALES_MAX_SERVICES_);
  shown.forEach(function(n, i) {
    const c = curMap[n] || { count: 0, amount: 0 };
    const p = prevMap[n] || { count: 0, amount: 0 };
    const mark = c.count ? (medals[i] || '▫️') : '💤';
    lines.push(mark + ' ' + escapeHtml_(n) + ': <b>' + c.count + '件 / $' + c.amount.toFixed(2) + '</b>');
    lines.push('　　' + (p.count ? weeklySalesDiff_(c.count, p.count, '件') + '・' + weeklySalesMoneyDelta_(c.amount - p.amount)
                                 : '🆕 先週はなし'));
  });
  if (names.length > shown.length) {
    let oc = 0, oa = 0;
    names.slice(shown.length).forEach(function(n) { const c = curMap[n]; if (c) { oc += c.count; oa += c.amount; } });
    lines.push('▫️ その他 ' + (names.length - shown.length) + '種類: ' + oc + '件 / $' + oa.toFixed(2));
  }

  // 入金（キャンセルを除く今週分）
  let paid = 0, unpaid = 0, unpaidAmt = 0;
  thisRows.forEach(function(r) {
    if (isCancelledStatus_(r['進行状態'])) return;
    if (String(r['決済状態'] || '').trim() === '清算済み') paid++;
    else { unpaid++; unpaidAmt += Number(r['料金(USD)']) || 0; }
  });
  lines.push('');
  lines.push('💳 <b>入金</b>');
  lines.push('　✅ 清算済み: ' + paid + '件　' + (unpaid ? '⏳ まだ: ' + unpaid + '件（$' + unpaidAmt.toFixed(2) + '）' : '🎉 未入金なし'));
  return lines.join('\n');
}

/** サービス名 → {count, amount}（キャンセルは除く・名前は日報の「プラン内訳」と同じ） */
function weeklySalesByService_(rows) {
  const map = {};
  rows.forEach(function(r) {
    if (isCancelledStatus_(r['進行状態'])) return;
    const name = bookingPlanLabel_(r);
    map[name] = map[name] || { count: 0, amount: 0 };
    map[name].count += 1;
    map[name].amount += Number(r['料金(USD)']) || 0;
  });
  return map;
}

/** 先週比の表示。unit='usd' は金額（＋％）、それ以外は件数など */
function weeklySalesDiff_(cur, prev, unit) {
  const d = cur - prev;
  if (unit === 'usd') {
    if (Math.abs(d) < 0.005) return '➡️ 先週と同じ';
    const pct = prev > 0 ? '（' + (d > 0 ? '+' : '−') + Math.abs(Math.round(d / prev * 100)) + '%）' : '';
    return weeklySalesMoneyDelta_(d) + pct;
  }
  if (d === 0) return '➡️ 先週と同じ';
  return (d > 0 ? '📈 +' : '📉 −') + Math.abs(d) + unit;
}

function weeklySalesMoneyDelta_(d) {
  if (Math.abs(d) < 0.005) return '➡️ ±$0';
  return (d > 0 ? '📈 +$' : '📉 −$') + Math.abs(d).toFixed(2);
}

/** 'yyyy-MM-dd' を n 日ずらす（タイムゾーンに左右されないよう UTC の正午で計算） */
function weeklySalesShiftDay_(str, n) {
  const p = String(str).split('-');
  const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n, 12));
  return d.toISOString().substring(0, 10);
}

/** 'yyyy-MM-dd' → '11/08(日)' */
function weeklySalesDayLabel_(str) {
  const p = String(str).split('-');
  const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12));
  return p[1] + '/' + p[2] + '(' + '日月火水木金土'.charAt(d.getUTCDay()) + ')';
}

/** 予約行の予約日を 'yyyy-MM-dd' に（readV7BookingsInRange_ と同じ読み方） */
function weeklySalesRowDate_(r, tz) {
  const d = r['予約日'];
  return (d instanceof Date) ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : String(d || '').trim().substring(0, 10);
}

function weeklySalesSheetTz_(v7SsId) {
  try { return SpreadsheetApp.openById(v7SsId).getSpreadsheetTimeZone() || OPS_TZ; } catch (e) { return OPS_TZ; }
}

/** 手動確認用: 今日を週の最終日として今すぐ送る（時刻窓・送信済みの印を無視） */
function debugSendWeeklySalesReportNow() {
  sendWeeklySalesReport();
}

/** 手動確認用: 送らずに本文だけログに出す */
function debugPreviewWeeklySalesReport() {
  Logger.log(buildWeeklySalesReportText_(getConfig(), Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd')) || '（今週も先週も予約なし）');
}
