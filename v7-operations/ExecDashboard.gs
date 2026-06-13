/**
 * ExecDashboard.gs — 経営コックピット API（exec-dashboard.html 用）
 *
 * 【責務】
 *   日本側経営層がスマホで「売上・経費・予約状況」を1画面で確認するための
 *   集計 JSON を返す。管理ダッシュボード（シート版）のミニアプリ補完。
 *
 * 【データソース】
 *   - 売上・予約状況: v7 顧客系スプレッドシート「予約」「顧客」（openById で読取専用参照）
 *   - 経費:           ops「経費マスター」（K列=JPY換算 / P列=集計対象○ / Q列=経費計上●）
 *   - 為替:           ops「設定」B4=USD→JPY / B5=KHR→JPY（経費マスターのK列式と同じ参照元）
 *
 * 【認可】
 *   スタッフマスター role === 'admin' の chatId のみ。それ以外は FORBIDDEN。
 *
 * 【キャッシュ】
 *   CacheService 120秒（ym 単位）。財務数値の鮮度として十分・再読込を軽くする。
 */

const EXEC_DASH_CACHE_TTL_ = 120;   // 秒
const EXEC_TREND_MONTHS_   = 6;     // 月次トレンドの本数

/**
 * メインエントリ（Router.gs から呼ばれる）
 * @param {string} chatId   呼び出し元 Telegram chatId（admin 用）
 * @param {string} ymOpt    集計対象月 'yyyy-MM'（省略時は当月）
 * @param {string} shareKey 共有閲覧キー（?key= 付きURL用、chatId が無い場合の代替認可）
 * @return {Object} ダッシュボード JSON（ok:false 時は error）
 */
function getExecDashboard(chatId, ymOpt, shareKey) {
  // ── 認可: admin ロール、または共有キー一致（閲覧専用URL） ──
  const access = checkExecAccess_(chatId, shareKey);
  if (!access.ok) return access;

  const tz = OPS_TZ;
  const now = new Date();
  const curYm = Utilities.formatDate(now, tz, 'yyyy-MM');
  let ym = String(ymOpt || '').trim();
  if (!/^\d{4}-\d{2}$/.test(ym)) ym = curYm;

  // ── キャッシュ ──
  const cache = CacheService.getScriptCache();
  const cacheKey = 'exec_dash_' + ym;
  const hit = cache.get(cacheKey);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* 壊れていたら再計算 */ }
  }

  const cfg = getConfig();
  const todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const fx = readFxRates_();

  // ── v7 売上・予約 ──
  let sales = null, unpaid = null, bookingsNow = null;
  if (cfg.v7SpreadsheetId) {
    const v7 = readV7AllBookings_(cfg.v7SpreadsheetId);
    sales       = buildSalesSection2_(v7.rows, ym, todayStr);
    unpaid      = buildUnpaidSection_(v7.rows, now);
    bookingsNow = buildBookingsNowSection_(v7.rows, v7.customers, ym, todayStr, tz);
  }

  // ── 経費 ──
  const expenses = buildExpensesSection_(ym, fx);

  // ── 粗利（売上USD×レート − 経費JPY） ──
  const profit = buildProfitSection_(sales, expenses, fx);

  // ── ロン君 前払い・残額（全期間・ym非依存） ──
  const ronPrepaid = buildRonPrepaidSection_(expenses.ronAllTimeJpy || 0, fx);

  const result = {
    ok: true,
    asOf: Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm'),
    ym: ym,
    curYm: curYm,
    fx: fx,
    sales: sales,
    unpaid: unpaid,
    bookingsNow: bookingsNow,
    expenses: expenses,
    profit: profit,
    ronPrepaid: ronPrepaid
  };

  try { cache.put(cacheKey, JSON.stringify(result), EXEC_DASH_CACHE_TTL_); }
  catch (e) { Logger.log('⚠️ exec_dash cache put 失敗（サイズ超過の可能性）: ' + e); }
  return result;
}

// ============================================================
//  為替（ops 設定シート）
// ============================================================

/**
 * 設定!B4 (USD→JPY) / B5 (KHR→JPY) を読む。経費マスターK列の式と同じ参照元。
 */
function readFxRates_() {
  try {
    const ss = SpreadsheetApp.openById(getConfig().operationsSpreadsheetId);
    const sh = ss.getSheetByName('設定');
    if (!sh) return { usdJpy: 0, khrJpy: 0 };
    const vals = sh.getRange('B4:B5').getValues();
    return {
      usdJpy: Number(vals[0][0]) || 0,
      khrJpy: Number(vals[1][0]) || 0
    };
  } catch (e) {
    Logger.log('⚠️ 為替読取失敗: ' + e);
    return { usdJpy: 0, khrJpy: 0 };
  }
}

// ============================================================
//  v7 予約・顧客 読み取り
// ============================================================

/**
 * v7「予約」全行 + 「顧客」ID→氏名マップを一括取得
 */
function readV7AllBookings_(v7SsId) {
  const ss = SpreadsheetApp.openById(v7SsId);
  const ssTz = ss.getSpreadsheetTimeZone() || OPS_TZ;

  // 予約
  const sheet = ss.getSheetByName('予約');
  if (!sheet) throw new Error('v7「予約」シート未発見');
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  let rows = [];
  if (lastRow >= 2) {
    const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues().map(function(row) {
      const o = {};
      headers.forEach(function(h, j) { o[h] = row[j]; });
      o._date = normDateStr_(o['予約日'], ssTz);          // 'yyyy-MM-dd'
      o._time = normTimeStr_(o['予約時刻'], ssTz);        // 'HH:mm'
      return o;
    });
  }

  // 顧客（ID→氏名）
  const customers = {};
  const cSheet = ss.getSheetByName('顧客');
  if (cSheet && cSheet.getLastRow() >= 2) {
    const ch = cSheet.getRange(1, 1, 1, cSheet.getLastColumn()).getValues()[0];
    const idIdx = ch.indexOf('顧客ID'), nameIdx = ch.indexOf('氏名');
    if (idIdx >= 0 && nameIdx >= 0) {
      cSheet.getRange(2, 1, cSheet.getLastRow() - 1, cSheet.getLastColumn()).getValues()
        .forEach(function(r) {
          const id = String(r[idIdx] || '').trim();
          if (id) customers[id] = String(r[nameIdx] || '').trim();
        });
    }
  }

  return { rows: rows, customers: customers };
}

/** 日付セル（Date or 文字列）→ 'yyyy-MM-dd'（不正は ''） */
function normDateStr_(v, tz) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return String(v).trim().substring(0, 10);
}

/** 時刻セル（Date or 文字列）→ 'HH:mm'（不正は ''） */
function normTimeStr_(v, tz) {
  if (!v && v !== 0) return '';
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'HH:mm');
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (m) return ('0' + m[1]).slice(-2) + ':' + m[2];
  return s.substring(0, 5);
}

/** 売上計上対象か（キャンセル除外＝既存ダッシュボード・日報と同基準） */
function isRevenueRow_(r) {
  return String(r['進行状態'] || '') !== 'cancelled';
}

/** 行の売上額（USD）。日報の computeV7WeeklyKpi_ と同じく 料金(USD) を使う */
function rowRevenue_(r) {
  return Number(r['料金(USD)']) || 0;
}

// ============================================================
//  売上セクション
// ============================================================

function buildSalesSection2_(rows, ym, todayStr) {
  const inMonth = rows.filter(function(r) { return r._date.substring(0, 7) === ym && isRevenueRow_(r); });

  // 当月KPI
  let revenue = 0;
  const custSet = {};
  inMonth.forEach(function(r) {
    revenue += rowRevenue_(r);
    const cid = String(r['顧客ID'] || r['チャットID'] || '').trim();
    if (cid) custSet[cid] = true;
  });
  const jobs = inMonth.length;
  const customers = Object.keys(custSet).length;

  // 前月KPI（比較用）
  const prevYm = shiftYm_(ym, -1);
  let prevRevenue = 0, prevJobs = 0;
  rows.forEach(function(r) {
    if (r._date.substring(0, 7) === prevYm && isRevenueRow_(r)) {
      prevRevenue += rowRevenue_(r);
      prevJobs++;
    }
  });

  // 本日（ym に関わらず「今」基準）
  let todayRevenue = 0, todayJobs = 0;
  rows.forEach(function(r) {
    if (r._date === todayStr && isRevenueRow_(r)) {
      todayRevenue += rowRevenue_(r);
      todayJobs++;
    }
  });

  // 日別（選択月、1日〜月末を0埋め）
  const daysInMonth = new Date(Number(ym.substring(0, 4)), Number(ym.substring(5, 7)), 0).getDate();
  const daily = [];
  for (let d = 1; d <= daysInMonth; d++) daily.push({ d: d, v: 0 });
  inMonth.forEach(function(r) {
    const d = Number(r._date.substring(8, 10));
    if (d >= 1 && d <= daysInMonth) daily[d - 1].v += rowRevenue_(r);
  });

  // 月次トレンド（選択月を末尾に6ヶ月）
  const monthly = [];
  for (let i = EXEC_TREND_MONTHS_ - 1; i >= 0; i--) {
    const m = shiftYm_(ym, -i);
    monthly.push({ ym: m, v: 0, jobs: 0 });
  }
  const mIdx = {};
  monthly.forEach(function(m, i) { mIdx[m.ym] = i; });
  rows.forEach(function(r) {
    const m = r._date.substring(0, 7);
    if (mIdx.hasOwnProperty(m) && isRevenueRow_(r)) {
      monthly[mIdx[m]].v += rowRevenue_(r);
      monthly[mIdx[m]].jobs++;
    }
  });

  // プラン別（選択月）
  const planMap = {};
  inMonth.forEach(function(r) {
    const p = String(r['プラン'] || '不明').trim() || '不明';
    if (!planMap[p]) planMap[p] = { name: p, revenue: 0, count: 0 };
    planMap[p].revenue += rowRevenue_(r);
    planMap[p].count++;
  });
  const byPlan = Object.keys(planMap).map(function(k) { return planMap[k]; })
    .sort(function(a, b) { return b.revenue - a.revenue; });

  return {
    month: { revenue: round2_(revenue), jobs: jobs, customers: customers,
             avgTicket: jobs > 0 ? round2_(revenue / jobs) : 0 },
    prevMonth: { revenue: round2_(prevRevenue), jobs: prevJobs },
    today: { revenue: round2_(todayRevenue), jobs: todayJobs },
    daily: daily,
    monthly: monthly,
    byPlan: byPlan
  };
}

// ============================================================
//  未回収セクション（作業完了済みなのに清算が済んでいないもの）
// ============================================================

function buildUnpaidSection_(rows, now) {
  const items = [];
  rows.forEach(function(r) {
    if (String(r['進行状態'] || '') !== 'completed') return;
    const pay = String(r['決済状態'] || '').trim();
    if (pay === '清算済み') return;

    const amount = Number(r['請求額(USD)']) || rowRevenue_(r);
    let hoursSinceQr = null;
    const qrAt = r['QR送信日時'];
    if (qrAt instanceof Date) hoursSinceQr = Math.floor((now.getTime() - qrAt.getTime()) / 3600000);

    items.push({
      id: String(r['予約ID'] || ''),
      date: r._date,
      amountUsd: round2_(amount),
      payState: pay || '未清算',
      hoursSinceQr: hoursSinceQr,
      reminders: Number(r['催促回数']) || 0
    });
  });
  items.sort(function(a, b) { return (b.hoursSinceQr || 0) - (a.hoursSinceQr || 0); });

  let total = 0;
  items.forEach(function(i) { total += i.amountUsd; });
  return { count: items.length, amountUsd: round2_(total), items: items.slice(0, 20) };
}

// ============================================================
//  予約状況セクション（「今」基準: 本日 + 今後7日）
// ============================================================

function buildBookingsNowSection_(rows, customers, ym, todayStr, tz) {
  const toItem = function(r) {
    return {
      id: String(r['予約ID'] || ''),
      date: r._date,
      time: r._time,
      customer: customers[String(r['顧客ID'] || '').trim()] || '（未登録）',
      car: String(r['車種名'] || '') || String(r['車種タイプ'] || ''),
      plan: String(r['プラン'] || ''),
      prog: String(r['進行状態'] || ''),
      pay: String(r['決済状態'] || ''),
      priceUsd: round2_(rowRevenue_(r))
    };
  };

  // 本日（全ステータス）
  const today = rows.filter(function(r) { return r._date === todayStr; })
    .map(toItem)
    .sort(function(a, b) { return a.time < b.time ? -1 : 1; });

  // 明日〜7日後（キャンセル除く）
  const limit = new Date();
  limit.setDate(limit.getDate() + 7);
  const limitStr = Utilities.formatDate(limit, tz, 'yyyy-MM-dd');
  const upcomingFlat = rows.filter(function(r) {
    return r._date > todayStr && r._date <= limitStr && String(r['進行状態']) !== 'cancelled';
  }).map(toItem).sort(function(a, b) {
    return (a.date + a.time) < (b.date + b.time) ? -1 : 1;
  });

  // 日付ごとにグループ
  const upcoming = [];
  const byDate = {};
  upcomingFlat.forEach(function(it) {
    if (!byDate[it.date]) { byDate[it.date] = { date: it.date, items: [] }; upcoming.push(byDate[it.date]); }
    byDate[it.date].items.push(it);
  });

  // 選択月のステータス内訳
  const counts = { confirmed: 0, in_progress: 0, completed: 0, cancelled: 0 };
  rows.forEach(function(r) {
    if (r._date.substring(0, 7) !== ym) return;
    const s = String(r['進行状態'] || '');
    if (counts.hasOwnProperty(s)) counts[s]++;
  });

  return { today: today, upcoming: upcoming, monthCounts: counts };
}

// ============================================================
//  経費セクション（経費マスター）
// ============================================================

/**
 * 経費マスターを列固定（A..Q）で読む。
 * ヘッダー行は先頭6行から A列='日付' を探して特定（既定: 3行目）。
 * 集計は K列(JPY換算) を使用。K は P≠○ / Q≠● のとき式が 0 を返す設計だが、
 * 念のためこちらでも P/Q を確認する。
 */
function buildExpensesSection_(ym, fx) {
  const ss = SpreadsheetApp.openById(getConfig().operationsSpreadsheetId);
  const sh = ss.getSheetByName('経費マスター');
  const empty = { month: { jpy: 0, usd: 0 }, prevMonth: { jpy: 0 }, byCategory: [],
                  byPayer: [], monthly: [], recent: [], available: false, ronAllTimeJpy: 0 };
  if (!sh) return empty;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return empty;
  const tz = ss.getSpreadsheetTimeZone() || OPS_TZ;

  // ヘッダー行検出
  const head = sh.getRange(1, 1, Math.min(6, lastRow), 1).getValues();
  let headerRow = 3;
  for (let i = 0; i < head.length; i++) {
    if (String(head[i][0]).trim() === '日付') { headerRow = i + 1; break; }
  }
  if (lastRow <= headerRow) return empty;

  // A..Q を一括読取
  const vals = sh.getRange(headerRow + 1, 1, lastRow - headerRow, 17).getValues();

  // 月次トレンド枠
  const monthly = [];
  const mIdx = {};
  for (let i = EXEC_TREND_MONTHS_ - 1; i >= 0; i--) {
    const m = shiftYm_(ym, -i);
    mIdx[m] = monthly.length;
    monthly.push({ ym: m, jpy: 0 });
  }
  const prevYm = shiftYm_(ym, -1);

  let monthJpy = 0, prevJpy = 0, ronAllJpy = 0;
  const catMap = {}, payerMap = {};
  const monthRows = [];

  vals.forEach(function(row) {
    const dStr = normDateStr_(row[0], tz);          // A: 日付
    if (!dStr || dStr.length < 7) return;
    const m = dStr.substring(0, 7);
    const include = String(row[15]).trim() === '○' && String(row[16]).trim() === '●'; // P/Q
    if (!include) return;
    const jpy = Number(row[10]) || 0;               // K: JPY換算
    if (!jpy) return;

    const payer = String(row[5] || '会社').trim();  // F: 負担先
    if (payer === 'ロン君') ronAllJpy += jpy;        // 全期間累計（前払い残額の計算用）

    if (mIdx.hasOwnProperty(m)) monthly[mIdx[m]].jpy += jpy;
    if (m === prevYm) prevJpy += jpy;
    if (m !== ym) return;

    monthJpy += jpy;
    const cat = String(row[1] || 'その他').trim();  // B: カテゴリ
    catMap[cat] = (catMap[cat] || 0) + jpy;
    payerMap[payer] = (payerMap[payer] || 0) + jpy;
    monthRows.push({
      date: dStr,
      desc: String(row[2] || ''),                   // C: 項目・摘要
      jpy: Math.round(jpy),
      category: cat,
      payer: payer
    });
  });

  monthly.forEach(function(m) { m.jpy = Math.round(m.jpy); });
  const toSorted = function(map) {
    return Object.keys(map).map(function(k) { return { name: k, jpy: Math.round(map[k]) }; })
      .sort(function(a, b) { return b.jpy - a.jpy; });
  };
  monthRows.sort(function(a, b) { return a.date < b.date ? 1 : -1; });

  return {
    month: { jpy: Math.round(monthJpy), usd: fx.usdJpy > 0 ? round2_(monthJpy / fx.usdJpy) : 0 },
    prevMonth: { jpy: Math.round(prevJpy) },
    byCategory: toSorted(catMap),
    byPayer: toSorted(payerMap),
    monthly: monthly,
    recent: monthRows.slice(0, 8),
    available: true,
    ronAllTimeJpy: Math.round(ronAllJpy)
  };
}

// ============================================================
//  ロン君 前払い・残額（前払い管理シート / 全期間）
// ============================================================

/**
 * 「前払い管理」シート（飯泉→ロン君 ABA送金履歴）を読み、残額を計算する。
 *   残額 = 前払い送金合計（USD） − ロン君負担経費の全期間合計（USD換算）
 * 列構造はヘッダー名から自動検出（日付/送金日・金額・通貨・メモ）。
 * exec_chat（封印中のAIチャット）とも共用する共通実装。
 *
 * @param {number} ronAllTimeJpy 経費マスター由来のロン君負担経費合計（JPY）
 * @param {{usdJpy:number, khrJpy:number}} fx 為替レート
 */
function buildRonPrepaidSection_(ronAllTimeJpy, fx) {
  const ss = SpreadsheetApp.openById(getConfig().operationsSpreadsheetId);
  const sh = ss.getSheetByName('前払い管理');
  if (!sh || sh.getLastRow() < 2) {
    return { available: false, note: '「前払い管理」シートが見つかりません' };
  }
  const ronJpy = Number(ronAllTimeJpy) || 0;
  if (ronJpy > 0 && !(fx.usdJpy > 0)) {
    return { available: false, note: '為替レート（設定!B4）未設定のため残額を計算できません' };
  }
  const tz = ss.getSpreadsheetTimeZone() || OPS_TZ;

  const DATE_RE = /日付|日時|送金日|入金日|年月日|date/i;
  const AMT_RE  = /金額|amount|USD|\$/i;

  // ヘッダー行・列の自動検出（先頭6行）
  const lastCol = Math.min(sh.getLastColumn(), 12);
  const scan = sh.getRange(1, 1, Math.min(6, sh.getLastRow()), lastCol).getValues();
  let headerRow = -1, dateCol = -1, amtCol = -1, curCol = -1, noteCol = -1;
  for (let i = 0; i < scan.length && headerRow < 0; i++) {
    const cells = scan[i].map(function(c) { return String(c); });
    const looksHeader = cells.some(function(c) { return DATE_RE.test(c) || AMT_RE.test(c); });
    if (!looksHeader) continue;
    headerRow = i + 1;
    cells.forEach(function(s, k) { if (dateCol < 0 && DATE_RE.test(s)) dateCol = k; });
    cells.forEach(function(s, k) {
      if (k === dateCol) return;
      if (amtCol  < 0 && AMT_RE.test(s)) amtCol = k;
      if (curCol  < 0 && /通貨|currency/i.test(s)) curCol = k;
      if (noteCol < 0 && /メモ|備考|内容|note|摘要/i.test(s)) noteCol = k;
    });
  }
  if (headerRow < 0 || amtCol < 0 || sh.getLastRow() <= headerRow) {
    return { available: false, note: '「前払い管理」シートの列構造を認識できませんでした' };
  }

  // 送金履歴の集計（既定通貨は USD = ABA送金。通貨列があれば換算）
  const vals = sh.getRange(headerRow + 1, 1, sh.getLastRow() - headerRow, lastCol).getValues();
  let totalUsd = 0;
  const transfers = [];
  vals.forEach(function(row) {
    const amt = Number(row[amtCol]) || 0;
    if (!amt) return;
    let amtUsd = amt;
    const cur = curCol >= 0 ? String(row[curCol] || 'USD').toUpperCase() : 'USD';
    if (cur === 'KHR' && fx.khrJpy > 0 && fx.usdJpy > 0) amtUsd = amt * fx.khrJpy / fx.usdJpy;
    if (cur === 'JPY' && fx.usdJpy > 0) amtUsd = amt / fx.usdJpy;
    totalUsd += amtUsd;
    transfers.push({
      date: dateCol >= 0 ? normDateStr_(row[dateCol], tz) : '',
      amountUsd: round2_(amtUsd),
      note: noteCol >= 0 ? String(row[noteCol] || '').substring(0, 60) : ''
    });
  });
  transfers.sort(function(a, b) { return a.date < b.date ? 1 : -1; });

  const ronUsd = fx.usdJpy > 0 ? ronJpy / fx.usdJpy : 0;
  const balanceUsd = round2_(totalUsd - ronUsd);

  // 設定シートの残金アラート閾値（任意・A列ラベルから検索）
  let alertThreshold = null;
  try {
    const setSh = ss.getSheetByName('設定');
    if (setSh && setSh.getLastRow() > 0) {
      const rows = setSh.getRange(1, 1, Math.min(setSh.getLastRow(), 30), 2).getValues();
      for (let i = 0; i < rows.length; i++) {
        if (/残金|残額|アラート|閾値/.test(String(rows[i][0]))) {
          const v = Number(rows[i][1]);
          if (v) { alertThreshold = v; break; }
        }
      }
    }
  } catch (e) { /* 閾値は任意項目 */ }

  return {
    available: true,
    note: '残額 = 前払い送金合計（USD） − ロン君負担の経費合計（USD換算・全期間）',
    totalTransfersUsd: round2_(totalUsd),
    ronExpensesAllTimeUsd: round2_(ronUsd),
    balanceUsd: balanceUsd,
    alertThresholdUsd: alertThreshold,
    transferCount: transfers.length,
    recentTransfers: transfers.slice(0, 5)
  };
}

// ============================================================
//  粗利セクション
// ============================================================

function buildProfitSection_(sales, expenses, fx) {
  if (!sales || !expenses || !fx.usdJpy) return null;

  const calc = function(revUsd, expJpy) {
    const revJpy = revUsd * fx.usdJpy;
    const jpy = Math.round(revJpy - expJpy);
    const marginPct = revJpy > 0 ? Math.round((jpy / revJpy) * 100) : null;
    return { jpy: jpy, marginPct: marginPct };
  };

  const month = calc(sales.month.revenue, expenses.month.jpy);

  // 月次トレンド（売上・経費の monthly は同じ月並び）
  const monthly = sales.monthly.map(function(sm, i) {
    const em = expenses.monthly[i] || { jpy: 0 };
    const p = calc(sm.v, em.jpy);
    return { ym: sm.ym, jpy: p.jpy };
  });

  return { month: month, monthly: monthly };
}

// ============================================================
//  認可・共有URL
// ============================================================

/**
 * 経営コックピットへのアクセス権チェック。
 * 優先: chatId（スタッフマスター admin）→ shareKey（EXEC_DASH_SHARE_KEY と完全一致）。
 */
function checkExecAccess_(chatId, shareKey) {
  const cid = String(chatId || '').trim();
  if (cid) {
    const staff = findStaffByChatId(cid);
    if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };
    if (staff.role !== 'admin') return { ok: false, error: 'FORBIDDEN' };
    return { ok: true, mode: 'admin' };
  }
  const key = String(shareKey || '').trim();
  if (key) {
    const stored = PropertiesService.getScriptProperties().getProperty('EXEC_DASH_SHARE_KEY');
    if (stored && key === stored) return { ok: true, mode: 'share' };
    return { ok: false, error: 'INVALID_SHARE_KEY' };
  }
  return { ok: false, error: 'MISSING_AUTH' };
}

/**
 * 共有閲覧キーを発行（既存があれば同じものを返す）。admin のみ実行可。
 * 無効化（=配布済みURLを全て失効）するには Script Properties から
 * EXEC_DASH_SHARE_KEY を削除する。再度ボタンを押せば新キーが発行される。
 */
function getExecShareKey(chatId) {
  const staff = findStaffByChatId(String(chatId || ''));
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };
  if (staff.role !== 'admin') return { ok: false, error: 'FORBIDDEN' };

  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('EXEC_DASH_SHARE_KEY');
  if (!key) {
    // 40文字のランダムキー（UUID×2 から生成）
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').substring(0, 40);
    props.setProperty('EXEC_DASH_SHARE_KEY', key);
  }
  return { ok: true, key: key };
}

// ============================================================
//  共通ユーティリティ
// ============================================================

/** 'yyyy-MM' を diff ヶ月ずらす */
function shiftYm_(ym, diff) {
  const y = Number(ym.substring(0, 4));
  const m = Number(ym.substring(5, 7));
  const d = new Date(y, m - 1 + diff, 1);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
}

function round2_(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
