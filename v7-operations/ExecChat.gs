/**
 * ExecChat.gs — 経営コックピット AIチャット（exec-dashboard.html のチャット機能）
 *
 * 【責務】
 *   経営層の自然文質問（「今週のロン君の残金は？」「売上上位の顧客は？」等）に、
 *   実データを根拠に Claude (Anthropic API) が日本語で回答する。
 *
 * 【データパック】
 *   売上/予約    : v7「予約」「顧客」シート
 *   経費        : ops「経費マスター」（K列 JPY換算・P○Q●のみ集計）
 *   前払い・残金 : ops「前払い管理」（飯泉→ロン君送金）− ロン君負担経費 = 残金
 *   カレンダー   : BOOKING_CALENDAR_ID（任意設定）から直近14日の予定
 *
 * 【必要な Script Properties】
 *   ANTHROPIC_API_KEY    （必須）Anthropic API キー
 *   EXEC_CHAT_MODEL      （任意）既定 'claude-opus-4-8'
 *   BOOKING_CALENDAR_ID  （任意）'samuraimotors.japan@gmail.com'（v7と同値）
 *
 * 【認可】
 *   スタッフマスター role === 'admin' のみ（ExecDashboard と同じ）。
 *
 * 【依存】
 *   ExecDashboard.gs の readV7AllBookings_ / readFxRates_ / normDateStr_ /
 *   shiftYm_ / round2_ を再利用する。
 */

const EXEC_CHAT_MODEL_DEFAULT_ = 'claude-opus-4-8';
const EXEC_CHAT_PACK_TTL_     = 120;   // データパックのキャッシュ（秒）
const EXEC_CHAT_MAX_Q_LEN_    = 500;   // 質問の最大文字数
const EXEC_CHAT_MAX_HISTORY_  = 8;     // 会話履歴の最大ターン数

/**
 * メインエントリ（Router.gs から呼ばれる）
 * @param {string} chatId   呼び出し元 Telegram chatId
 * @param {string} question 質問文
 * @param {Array<{role:string, content:string}>} history 直近の会話履歴
 */
function handleExecChat(chatId, question, history) {
  // ── 認可 ──
  const staff = findStaffByChatId(String(chatId || ''));
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };
  if (staff.role !== 'admin') return { ok: false, error: 'FORBIDDEN' };

  // ── 入力検証 ──
  const q = String(question || '').trim();
  if (!q) return { ok: false, error: 'EMPTY_QUESTION' };
  if (q.length > EXEC_CHAT_MAX_Q_LEN_) return { ok: false, error: 'QUESTION_TOO_LONG' };

  const apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) return { ok: false, error: 'NO_API_KEY' };

  // ── データパック（120秒キャッシュ） ──
  let pack;
  try {
    pack = getExecChatDataPack_();
  } catch (e) {
    Logger.log('❌ exec_chat データパック生成失敗: ' + e);
    return { ok: false, error: 'DATA_PACK_FAILED: ' + String(e) };
  }

  // ── 会話履歴の整形（最大8ターン・各2000字まで） ──
  const msgs = [];
  (Array.isArray(history) ? history : [])
    .slice(-EXEC_CHAT_MAX_HISTORY_)
    .forEach(function(m) {
      const role = (m && m.role === 'assistant') ? 'assistant' : 'user';
      const content = String((m && m.content) || '').substring(0, 2000);
      if (content) msgs.push({ role: role, content: content });
    });
  // 先頭は user でなければならない（API仕様）
  while (msgs.length > 0 && msgs[0].role !== 'user') msgs.shift();
  msgs.push({ role: 'user', content: q });

  // ── Claude 呼び出し ──
  return callExecChatClaude_(apiKey, pack, msgs);
}

// ============================================================
//  Anthropic Messages API 呼び出し
// ============================================================

function callExecChatClaude_(apiKey, pack, messages) {
  const props = PropertiesService.getScriptProperties();
  const model = props.getProperty('EXEC_CHAT_MODEL') || EXEC_CHAT_MODEL_DEFAULT_;

  const systemText = buildExecChatSystemPrompt_(pack);

  const body = {
    model: model,
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    // データパックは120秒間同一バイト列 → 連続質問でプロンプトキャッシュが効く
    system: [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }],
    messages: messages
  };

  let res;
  try {
    res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(body),
      muteHttpExceptions: true
    });
  } catch (e) {
    return { ok: false, error: 'API_FETCH_FAILED: ' + String(e) };
  }

  const code = res.getResponseCode();
  let data;
  try { data = JSON.parse(res.getContentText()); }
  catch (e) { return { ok: false, error: 'API_BAD_RESPONSE (HTTP ' + code + ')' }; }

  if (code !== 200) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + code);
    Logger.log('❌ Anthropic API エラー: ' + msg);
    return { ok: false, error: 'API_ERROR: ' + msg };
  }

  // text ブロックのみ連結（thinking ブロックは除外）
  const answer = (data.content || [])
    .filter(function(b) { return b.type === 'text'; })
    .map(function(b) { return b.text; })
    .join('\n')
    .trim();

  return {
    ok: true,
    answer: answer || '（回答を生成できませんでした）',
    model: model,
    usage: data.usage || null
  };
}

/**
 * システムプロンプト生成（ルール + データパックJSON）
 */
function buildExecChatSystemPrompt_(pack) {
  const fxNote = pack.fx && pack.fx.usdJpy ? ('$1 = ¥' + pack.fx.usdJpy) : '未設定';
  return [
    'あなたは「Samurai Motors」（カンボジア・プノンペンの出張洗車サービス）の経営アシスタントAIです。',
    '経営者（日本人）からの質問に、下記の DATA だけを根拠として日本語で答えてください。',
    '',
    '## ルール',
    '- DATA にない情報は推測せず「該当データがありません」と正直に伝える',
    '- 金額は通貨を明記する（USD は $、JPY は ¥）。換算レート: ' + fxNote + '（設定シート連動）',
    '- 「今週」とは ' + pack.thisWeek.from + '〜' + pack.thisWeek.to + '（月曜起点）のこと。「先週」も同様に月曜起点で解釈する',
    '- ロン君の残金 = 前払い送金合計 − ロン君負担の経費合計。DATA の ronPrepaid.balanceUsd を使い、根拠（送金合計と経費合計）も添える',
    '- 売上は受注ベース（キャンセル除く・料金(USD)基準）',
    '- 簡潔に。基本は3〜6行、箇条書き活用。数字には期間・件数の根拠を添える',
    '- Markdown記法（# や ** など）は使わない。「・」による箇条書きと改行のみ',
    '- 売上トレンドは直近6ヶ月分、経費明細は直近分のみ保持している。それより古い詳細を聞かれたら範囲外と伝える',
    '- 経営判断に踏み込む質問には、データから言える事実と、データだけでは判断できない点を分けて答える',
    '',
    '## DATA (JSON)',
    JSON.stringify(pack)
  ].join('\n');
}

// ============================================================
//  データパック生成（CacheService 120秒）
// ============================================================

function getExecChatDataPack_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('exec_chat_pack');
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* 再生成 */ }
  }

  const cfg = getConfig();
  const tz = OPS_TZ;
  const now = new Date();
  const todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const ym = todayStr.substring(0, 7);
  const fx = readFxRates_();

  // 今週（月曜起点）
  const isoDow = Number(Utilities.formatDate(now, tz, 'u'));   // 1=月 … 7=日
  const monday = new Date(now.getTime() - (isoDow - 1) * 86400000);
  const sunday = new Date(monday.getTime() + 6 * 86400000);
  const weekFrom = Utilities.formatDate(monday, tz, 'yyyy-MM-dd');
  const weekTo   = Utilities.formatDate(sunday, tz, 'yyyy-MM-dd');

  const pack = {
    asOf: Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm'),
    today: todayStr + '（' + '日月火水木金土'.charAt(now.getDay()) + '）',
    timezone: tz,
    fx: fx,
    thisWeek: { from: weekFrom, to: weekTo },
    sales: null,
    bookings: null,
    calendarEvents: null,
    expenses: buildChatExpenses_(ym, weekFrom, weekTo, fx),
    ronPrepaid: null
  };

  // v7 売上・予約・顧客
  if (cfg.v7SpreadsheetId) {
    try {
      const v7 = readV7AllBookings_(cfg.v7SpreadsheetId);
      pack.sales    = buildChatSales_(v7, ym, todayStr, weekFrom, weekTo);
      pack.bookings = buildChatBookings_(v7, todayStr, tz);
    } catch (e) {
      Logger.log('⚠️ exec_chat v7読取失敗: ' + e);
    }
  }

  // 前払い・残金（経費パックのロン君合計を使う）
  pack.ronPrepaid = buildChatRonPrepaid_(pack.expenses, fx);

  // カレンダー（任意）
  pack.calendarEvents = readChatCalendar_(tz);

  try { cache.put('exec_chat_pack', JSON.stringify(pack), EXEC_CHAT_PACK_TTL_); }
  catch (e) { Logger.log('⚠️ exec_chat pack cache put 失敗: ' + e); }
  return pack;
}

// ── 売上（月次6ヶ月・今週・本日・顧客ランキング・未回収） ──

function buildChatSales_(v7, ym, todayStr, weekFrom, weekTo) {
  const rows = v7.rows, customers = v7.customers;

  const monthly = [];
  const mIdx = {};
  for (let i = 5; i >= 0; i--) {
    const m = shiftYm_(ym, -i);
    mIdx[m] = monthly.length;
    monthly.push({ ym: m, revenueUsd: 0, jobs: 0 });
  }

  let today = { revenueUsd: 0, jobs: 0 };
  let week  = { revenueUsd: 0, jobs: 0 };
  const custMap = {};
  const unpaid = [];

  rows.forEach(function(r) {
    const cancelled = String(r['進行状態'] || '') === 'cancelled';
    const rev = rowRevenue_(r);
    const d = r._date;
    if (!cancelled && d) {
      const m = d.substring(0, 7);
      if (mIdx.hasOwnProperty(m)) { monthly[mIdx[m]].revenueUsd += rev; monthly[mIdx[m]].jobs++; }
      if (d === todayStr) { today.revenueUsd += rev; today.jobs++; }
      if (d >= weekFrom && d <= weekTo) { week.revenueUsd += rev; week.jobs++; }

      // 顧客別累計（全期間）
      const cid = String(r['顧客ID'] || '').trim();
      if (cid) {
        if (!custMap[cid]) custMap[cid] = { name: customers[cid] || cid, revenueUsd: 0, jobs: 0, lastDate: '' };
        custMap[cid].revenueUsd += rev;
        custMap[cid].jobs++;
        if (d > custMap[cid].lastDate) custMap[cid].lastDate = d;
      }
    }
    // 未回収（完了済み・清算済み以外）
    if (String(r['進行状態']) === 'completed' && String(r['決済状態'] || '').trim() !== '清算済み') {
      unpaid.push({
        id: String(r['予約ID'] || ''), date: d,
        customer: customers[String(r['顧客ID'] || '').trim()] || '',
        amountUsd: round2_(Number(r['請求額(USD)']) || rev),
        payState: String(r['決済状態'] || '未清算')
      });
    }
  });

  monthly.forEach(function(m) { m.revenueUsd = round2_(m.revenueUsd); });
  const topCustomers = Object.keys(custMap).map(function(k) { return custMap[k]; })
    .sort(function(a, b) { return b.revenueUsd - a.revenueUsd; })
    .slice(0, 10)
    .map(function(c) { c.revenueUsd = round2_(c.revenueUsd); return c; });

  return {
    note: '売上は受注ベース（キャンセル除く）。monthly は直近6ヶ月。topCustomers は全期間の累計上位10名。',
    today: { revenueUsd: round2_(today.revenueUsd), jobs: today.jobs },
    thisWeek: { revenueUsd: round2_(week.revenueUsd), jobs: week.jobs },
    monthly: monthly,
    topCustomers: topCustomers,
    unpaid: unpaid.slice(0, 15)
  };
}

// ── 予約状況（本日＋今後14日） ──

function buildChatBookings_(v7, todayStr, tz) {
  const limit = new Date();
  limit.setDate(limit.getDate() + 14);
  const limitStr = Utilities.formatDate(limit, tz, 'yyyy-MM-dd');

  return v7.rows
    .filter(function(r) {
      return r._date >= todayStr && r._date <= limitStr && String(r['進行状態']) !== 'cancelled';
    })
    .map(function(r) {
      return {
        id: String(r['予約ID'] || ''),
        date: r._date, time: r._time,
        customer: v7.customers[String(r['顧客ID'] || '').trim()] || '',
        car: String(r['車種名'] || '') || String(r['車種タイプ'] || ''),
        plan: String(r['プラン'] || ''),
        status: String(r['進行状態'] || ''),
        pay: String(r['決済状態'] || ''),
        priceUsd: round2_(rowRevenue_(r))
      };
    })
    .sort(function(a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; })
    .slice(0, 40);
}

// ── 経費（今月・先月・今週明細・カテゴリ/負担先別・直近明細・ロン君全期間合計） ──

function buildChatExpenses_(ym, weekFrom, weekTo, fx) {
  const ss = SpreadsheetApp.openById(getConfig().operationsSpreadsheetId);
  const sh = ss.getSheetByName('経費マスター');
  if (!sh || sh.getLastRow() < 2) return { available: false };
  const tz = ss.getSpreadsheetTimeZone() || OPS_TZ;

  // ヘッダー行検出（A列 '日付'）
  const head = sh.getRange(1, 1, Math.min(6, sh.getLastRow()), 1).getValues();
  let headerRow = 3;
  for (let i = 0; i < head.length; i++) {
    if (String(head[i][0]).trim() === '日付') { headerRow = i + 1; break; }
  }
  if (sh.getLastRow() <= headerRow) return { available: false };

  const vals = sh.getRange(headerRow + 1, 1, sh.getLastRow() - headerRow, 17).getValues();
  const prevYm = shiftYm_(ym, -1);

  let monthJpy = 0, prevJpy = 0, weekJpy = 0, ronAllJpy = 0, ronWeekJpy = 0;
  const catMap = {}, payerMap = {};
  const weekItems = [], allItems = [];

  vals.forEach(function(row) {
    const dStr = normDateStr_(row[0], tz);
    if (!dStr || dStr.length < 10) return;
    const include = String(row[15]).trim() === '○' && String(row[16]).trim() === '●';
    if (!include) return;
    const jpy = Number(row[10]) || 0;
    if (!jpy) return;

    const m = dStr.substring(0, 7);
    const payer = String(row[5] || '会社').trim();
    const item = {
      date: dStr, desc: String(row[2] || ''), jpy: Math.round(jpy),
      category: String(row[1] || 'その他').trim(), payer: payer
    };

    if (payer === 'ロン君') {
      ronAllJpy += jpy;
      if (dStr >= weekFrom && dStr <= weekTo) ronWeekJpy += jpy;
    }
    if (dStr >= weekFrom && dStr <= weekTo) { weekJpy += jpy; weekItems.push(item); }
    if (m === prevYm) prevJpy += jpy;
    if (m === ym) {
      monthJpy += jpy;
      catMap[item.category] = (catMap[item.category] || 0) + jpy;
      payerMap[payer] = (payerMap[payer] || 0) + jpy;
    }
    allItems.push(item);
  });

  const toSorted = function(map) {
    return Object.keys(map).map(function(k) { return { name: k, jpy: Math.round(map[k]) }; })
      .sort(function(a, b) { return b.jpy - a.jpy; });
  };
  allItems.sort(function(a, b) { return a.date < b.date ? 1 : -1; });

  const usd = function(jpy) { return fx.usdJpy > 0 ? round2_(jpy / fx.usdJpy) : null; };

  return {
    available: true,
    note: '集計対象○・経費計上●の行のみ。jpy は設定シートのレートでJPY換算済み。',
    thisMonth: { ym: ym, jpy: Math.round(monthJpy), usdApprox: usd(monthJpy),
                 byCategory: toSorted(catMap), byPayer: toSorted(payerMap) },
    lastMonth: { ym: prevYm, jpy: Math.round(prevJpy), usdApprox: usd(prevJpy) },
    thisWeek:  { jpy: Math.round(weekJpy), usdApprox: usd(weekJpy), items: weekItems.slice(0, 30) },
    recentItems: allItems.slice(0, 25),
    ronTotals: { allTimeJpy: Math.round(ronAllJpy), allTimeUsdApprox: usd(ronAllJpy),
                 thisWeekJpy: Math.round(ronWeekJpy), thisWeekUsdApprox: usd(ronWeekJpy) }
  };
}

// ── 前払い管理（飯泉→ロン君送金）と残金 ──

/**
 * ExecDashboard.gs の buildRonPrepaidSection_ に委譲（共通実装）。
 * 2026-06-13 ダッシュボード常設表示化に伴い統合。
 */
function buildChatRonPrepaid_(expenses, fx) {
  const ronJpy = (expenses && expenses.available && expenses.ronTotals)
    ? (expenses.ronTotals.allTimeJpy || 0) : 0;
  return buildRonPrepaidSection_(ronJpy, fx);
}

// ── 予約カレンダー（任意・BOOKING_CALENDAR_ID 設定時のみ） ──

function readChatCalendar_(tz) {
  const calId = PropertiesService.getScriptProperties().getProperty('BOOKING_CALENDAR_ID');
  if (!calId) return { available: false, note: 'BOOKING_CALENDAR_ID 未設定（予約は bookings を参照）' };
  try {
    const cal = CalendarApp.getCalendarById(calId);
    if (!cal) return { available: false, note: 'カレンダーにアクセスできません' };
    const now = new Date();
    const until = new Date(now.getTime() + 14 * 86400000);
    const events = cal.getEvents(now, until).slice(0, 30).map(function(ev) {
      return {
        date: Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd'),
        time: ev.isAllDayEvent() ? '終日' : Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm'),
        title: String(ev.getTitle() || '').substring(0, 60)
      };
    });
    return { available: true, note: '予約カレンダー（今後14日）', events: events };
  } catch (e) {
    Logger.log('⚠️ カレンダー読取失敗: ' + e);
    return { available: false, note: 'カレンダー読取エラー' };
  }
}
