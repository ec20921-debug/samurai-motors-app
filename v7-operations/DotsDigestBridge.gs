/**
 * DotsDigestBridge.gs — Run Kosal の秘書 dots（ChatGPT「ドッちゃん」）のメールを管理グループへ
 *
 * 【責務】（2026-10-24 Daisuke 指示「日報を dots に集約する」→ 2026-10-25 改訂「日報を毎日 GSS に記録・報連相の代わり」）
 *   Run Kosal はドッちゃんとクメール語で話す。ドッちゃんは日本語のメールを送る（送信元は Run Kosal の ChatGPT の Gmail）。
 *     - 日報（1日1通）  件名 [SM-DOTS] 日報 YYYY-MM-DD
 *         → 勤務用 GSS「日報」タブに1行（DotsDailyReport.gs）→ 管理グループに「記録しました」と中身
 *     - 報連相（その都度）件名 [SM-DOTS] 報告 / 連絡 / 相談 / 緊急 ＋ 件名
 *         → 管理グループへそのまま（GSS には書かない。その日の日報にまとめて入る）
 *     - テスト          件名 [SM-DOTS] テスト（「テスト 日報」なら GSS への記録まで試す）
 *
 *   ドッちゃん → メール（件名が [SM-DOTS] で始まる・本文に合言葉）→ 本 GAS の実行者の Gmail
 *        → runDotsBridge（専用の5分トリガー。pollInternalBot とは切り離す）
 *        → 管理グループ（DOTS_DIGEST_THREAD_ID、未設定なら日報トピック）
 *
 * 【Script Properties】（値はコードに書かない）
 *   DOTS_BRIDGE_ENABLED    'true' のときだけ動く（停止スイッチ。消すか 'false' で即停止）
 *   DOTS_SHARED_TOKEN      合言葉。本文に含まれないメールは転送しない（なりすまし対策。issueDotsSharedToken で作れる）
 *   DOTS_SENDER_ALLOWLIST  送信元メールアドレス（カンマ区切り）。外れたものは転送しない
 *   DOTS_DIGEST_THREAD_ID  投稿先トピック（任意。未設定なら ADMIN_DAILY_REPORT_THREAD_ID）
 *
 * 【届かない・送れないときは黙らない】
 *   - 出勤した日に 20:00（プノンペン）を過ぎても日報が無ければ、1回だけ知らせる
 *   - GSS への記録・Telegram への送信に失敗したら次の回で再試行（最大3回）。それでも駄目なら知らせる
 *   - 処理そのものが落ちたら1日1回知らせ、例外を投げ直して Google の失敗メールも出す
 *   - 弾いたメール（合言葉なし・送信元が許可外）は送信元と件名だけ、1回にまとめて知らせる
 *
 * 【ロック】
 *   勤怠・経費と共通のスクリプトロックは、処理済み ID の予約と状態の更新の瞬間だけ握る。
 *   Gmail 検索・GSS 書き込み・Telegram 送信はロックの外（勤怠・経費を「混雑中」にしない）。
 *   同じメールを2つの実行が同時に扱うことは、処理済み ID の予約で防ぐ。
 */

const DOTS_SUBJECT_TAG = '[SM-DOTS]';
const DOTS_SUBJECT_RE = /^\s*\[SM-DOTS\]/;
const DOTS_LABEL_DONE = 'sm-dots/forwarded';
const DOTS_LABEL_REJECTED = 'sm-dots/rejected';
const DOTS_TRIGGER_FN = 'runDotsBridge';
const DOTS_TG_CHUNK = 3500;   // Telegram の上限 4096 字に余裕を持たせる
const DOTS_MAX_BODY = 10500;  // これを超えた分は省略（全文はメールで見る）
const DOTS_MAX_RETRY = 3;
const DOTS_SEEN_KEEP = 200;   // メッセージ ID 約16字 × 200 ≒ 4KB（1プロパティ 9KB 以内）
const DOTS_REPORT_ALERT_AT = '20:00';   // 出勤した日、この時刻（プノンペン）までに日報が無ければ知らせる
const DOTS_REPORT_ALERT_JST = '22:00';
// 件名の [SM-DOTS] の後ろで、いちばん前に出てくる語で種類を決める。日報だけ GSS に記録する
const DOTS_KINDS = [
  { key: 'report',  word: '日報', icon: '📝', label: '日報' },
  { key: 'urgent',  word: '緊急', icon: '🚨', label: '緊急', ask: '👉 すぐに確認してください' },
  { key: 'consult', word: '相談', icon: '🙋', label: '相談', ask: '👉 日本側の返事が必要です' },
  { key: 'contact', word: '連絡', icon: '📨', label: '連絡' },
  { key: 'notice',  word: '報告', icon: '📢', label: '報告' }
];
const DOTS_KIND_OTHER = { key: 'other', word: '', icon: '💬', label: 'お知らせ' };
const DOTS_KIND_TEST = { key: 'test', word: '', icon: '🧪', label: '接続テスト' };
const DOTS_PROP = {
  ENABLED:       'DOTS_BRIDGE_ENABLED',
  TOKEN:         'DOTS_SHARED_TOKEN',
  ALLOWLIST:     'DOTS_SENDER_ALLOWLIST',
  THREAD_ID:     'DOTS_DIGEST_THREAD_ID',
  SEEN_IDS:      'dots_seen_message_ids',
  RETRY:         'dots_retry_counts',
  DAY_STATE:     'dots_day_state',
  ENABLED_SINCE: 'dots_enabled_since_ms',
  ERROR_DAY:     'dots_error_notified_day'
};

// ============================================================
//  エントリポイント（5分トリガー）
// ============================================================

function runDotsBridge() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(DOTS_PROP.ENABLED) !== 'true') return;

  let forwardError = null;
  let forwardRan = false;
  try {
    forwardRan = forwardDotsDigests_(props);
  } catch (e) {
    forwardError = e;
    Logger.log('❌ forwardDotsDigests_: ' + e);
    notifyDotsErrorOncePerDay_(props, e);
  }
  // 転送が走れなかった回に「届いていない」と言うと誤報になるので、走れた時だけ確認する
  if (forwardRan) {
    try { checkMissingDotsReport_(props); } catch (e) { Logger.log('❌ checkMissingDotsReport_: ' + e); }
  }
  if (forwardError) throw forwardError; // Google の失敗メールも出す
}

/**
 * 未転送のドッちゃんのメールを拾い、日報は GSS に記録してから管理グループへ投稿する。
 * @return {boolean} 設定が揃って検索まで実行できたら true
 */
function forwardDotsDigests_(props) {
  const token = props.getProperty(DOTS_PROP.TOKEN) || '';
  const allow = parseDotsAllowlist_(props.getProperty(DOTS_PROP.ALLOWLIST));
  if (!token || allow.length === 0) {
    Logger.log('⚠️ dots: DOTS_SHARED_TOKEN / DOTS_SENDER_ALLOWLIST 未設定 — 転送しない');
    return false;
  }
  const cfg = getConfig();
  const self = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  const fromAllowed = '(' + allow.map(function(a) { return 'from:' + a; }).join(' OR ') + ')';
  const base = 'subject:"' + DOTS_SUBJECT_TAG + '" newer_than:2d -in:trash';

  // ① 許可リストの送信元だけを読む（弾いたメールで検索窓が埋まらないように）
  //    報連相は1日に何通も来るので、処理済みのスレッドも含めて新しい順に20件見る（処理済みかは ID で判定）
  GmailApp.search(base + ' ' + fromAllowed, 0, 20).forEach(function(thread) {
    let forwarded = false;
    let rejected = false;
    thread.getMessages().forEach(function(msg) {
      const subject = msg.getSubject() || '';
      if (!DOTS_SUBJECT_RE.test(subject)) return; // Re: / Fwd: など
      const sender = extractDotsEmail_(msg.getFrom());
      if (allow.indexOf(sender) === -1) return;   // 同じスレッドの別の人のメール
      const id = msg.getId();
      if (!claimDotsId_(props, id)) return;       // 処理済み（または他の実行が処理中）

      const body = msg.getPlainBody() || '';
      if (body.indexOf(token) === -1) {
        rejected = true;
        notifyDotsRejected_(cfg, props, [{ sender: sender, subject: subject }], '合言葉なし');
        return;
      }
      const kind = detectDotsKind_(subject);
      const clean = cleanDotsBody_(body, token);

      // 日報は先に GSS へ。失敗したら次の回にやり直す（同じメールの再試行は同じ行を上書きするので二重にならない）
      let rec = null;
      if (kind.key === 'report') {
        try {
          rec = recordDotsDailyReport_(msg, subject, clean, kind.test);
        } catch (e) {
          Logger.log('❌ dots 日報の GSS 記録失敗 id=' + id + ': ' + e);
          if (retryDotsLater_(props, id)) return;
          // 3回駄目 → 中身だけ先に管理グループへ出す（届いてはいるので未着の警告は出さない）
          rec = { error: String(e), reportDate: resolveDotsReportDate_(subject, msg.getDate()) };
        }
      }

      const r = postDotsMessage_(cfg, props, msg.getDate(), subject, kind, clean, rec);
      if (r.sent === 0) {
        if (retryDotsLater_(props, id)) return; // 1通も出ていないので二重投稿の恐れは無い
        sendDotsToAdmin_(cfg, props, '❌ ドッちゃんのメールを管理グループへ送れませんでした（' + DOTS_MAX_RETRY +
          '回失敗）。全文は Gmail の件名「' + subject.substring(0, 80) + '」を見てください。' +
          (rec && rec.reportId ? '\n（GSS「日報」への記録は済んでいます: ' + rec.reportId + '）' : ''));
        return;
      }
      if (r.sent < r.total) {
        sendDotsToAdmin_(cfg, props, '⚠️ ドッちゃんのメールが途中までしか送れませんでした（' + r.sent + '/' + r.total +
          '通）。続きは Gmail の件名「' + subject.substring(0, 80) + '」を見てください。');
      }
      forwarded = true;
      if (kind.key === 'report' && !kind.test && rec && rec.reportDate) markDotsReportReceived_(props, rec.reportDate);
    });
    if (forwarded) thread.addLabel(getOrCreateDotsLabel_(DOTS_LABEL_DONE));
    if (rejected) thread.addLabel(getOrCreateDotsLabel_(DOTS_LABEL_REJECTED));
  });

  // ② 許可リスト外の [SM-DOTS] メール: 本文は読まず、送信元と件名だけ1回にまとめて知らせる
  const others = [];
  const notAllowed = allow.map(function(a) { return '-from:' + a; }).join(' ');
  GmailApp.search(base + ' ' + notAllowed, 0, 5).forEach(function(thread) {
    let hit = false;
    thread.getMessages().forEach(function(msg) {
      const subject = msg.getSubject() || '';
      if (!DOTS_SUBJECT_RE.test(subject)) return;
      const sender = extractDotsEmail_(msg.getFrom());
      if (allow.indexOf(sender) !== -1) return;
      if (sender === self || /mailer-daemon|postmaster/.test(sender)) return; // 自分の送信・配信エラーは無視
      if (!claimDotsId_(props, msg.getId())) return;
      others.push({ sender: sender, subject: subject });
      hit = true;
    });
    if (hit) thread.addLabel(getOrCreateDotsLabel_(DOTS_LABEL_REJECTED));
  });
  if (others.length > 0) notifyDotsRejected_(cfg, props, others, '送信元が許可リスト外');
  return true;
}

/**
 * 出勤した日に 20:00 を過ぎても日報が無ければ1回だけ知らせる。
 * 有効化した時刻が締切より後（同じ日）なら、その日は知らせない（有効化当日の誤報防止）。
 */
function checkMissingDotsReport_(props) {
  const now = new Date();
  if (Utilities.formatDate(now, OPS_TZ, 'HH:mm') < DOTS_REPORT_ALERT_AT) return;
  const today = Utilities.formatDate(now, OPS_TZ, 'yyyy-MM-dd');
  const enabledSince = parseInt(props.getProperty(DOTS_PROP.ENABLED_SINCE) || '0', 10);
  if (enabledSince > 0 &&
      Utilities.formatDate(new Date(enabledSince), OPS_TZ, 'yyyy-MM-dd') === today &&
      Utilities.formatDate(new Date(enabledSince), OPS_TZ, 'HH:mm') >= DOTS_REPORT_ALERT_AT) return;
  // 20:00 以降は5分ごとに呼ばれるので、済んでいる日はロックを取らずに抜ける
  const seen = loadDotsJson_(props, DOTS_PROP.DAY_STATE, {});
  if (seen.date === today && ((seen.received || {}).report || (seen.alerted || {}).report)) return;

  let due = false;
  updateDotsDayState_(props, function(state) {
    if (state.received.report || state.alerted.report) return;
    state.alerted.report = true; // 送信前にマーク（多重通知防止。休みの日の確認も1日1回で済む）
    due = true;
  });
  if (!due || !isDotsStaffOnDutyToday_()) return;

  sendDotsToAdmin_(getConfig(), props,
    '⚠️ 今日（' + formatDotsDay_(today) + '）の Run Kosal の日報が、ドッちゃんからまだ届いていません（出勤あり・' +
    DOTS_REPORT_ALERT_AT + ' 時点・日本 ' + DOTS_REPORT_ALERT_JST + '）\n' +
    '・Run Kosal がドッちゃんに「日報を送って」と言ったか\n' +
    '・ドッちゃんの送信が承認待ち（Needs approval）で止まっていないか\n' +
    '・Gmail で迷惑メールに入っていないか（件名 ' + DOTS_SUBJECT_TAG + '）\n' +
    'を確認してください。');
}

// ============================================================
//  投稿（すべてプレーンテキスト。HTML の解析エラーで落ちないように parse_mode は使わない）
// ============================================================

/** @return {{sent:number,total:number}} */
function postDotsMessage_(cfg, props, date, subject, kind, body, rec) {
  const header = buildDotsHeader_(date, subject, kind, rec) + '\n━━━━━━━━━━━━━━━━━━\n';
  const notes = [];
  if (/[ក-៿]/.test(body)) {
    notes.push('⚠️ クメール語の原文を含みます（未校閲・社内参考のみ。外へ出す時は Panha を通す）');
  }
  let text = body || '（本文なし）';
  if (text.length > DOTS_MAX_BODY) {
    text = safeDotsCut_(text, DOTS_MAX_BODY);
    notes.push('✂️ 長すぎるため後半を省略しました。全文は Gmail（件名 ' + DOTS_SUBJECT_TAG + '）で確認してください');
  }
  const chunks = splitDotsText_(text, DOTS_TG_CHUNK);
  let sent = 0;
  for (let i = 0; i < chunks.length; i++) {
    let msg = (i === 0 ? header : '（続き ' + (i + 1) + '/' + chunks.length + '）\n') + chunks[i];
    if (i === chunks.length - 1 && notes.length > 0) msg += '\n\n' + notes.join('\n');
    if (!sendDotsToAdmin_(cfg, props, msg)) break;
    sent++;
  }
  Logger.log('📤 dots 転送 ' + kind.key + (kind.test ? '(test)' : '') + ' sent=' + sent + '/' + chunks.length);
  return { sent: sent, total: chunks.length };
}

/** 種類ごとの見出し（日報は GSS の記録結果つき） */
function buildDotsHeader_(date, subject, kind, rec) {
  const when = Utilities.formatDate(date, OPS_TZ, 'M/d HH:mm') + ' プノンペン受信（日本 ' +
    Utilities.formatDate(date, 'Asia/Tokyo', 'HH:mm') + '）';
  const lines = [(kind.test && kind.key !== 'test' ? '🧪 テスト ' : '') + kind.icon + ' ' + kind.label + ' — Run Kosal（ドッちゃん経由）' +
    (rec && rec.reportDate ? ' ' + formatDotsDay_(rec.reportDate) : '')];
  if (kind.key === 'report') {
    if (rec && rec.reportId) {
      lines.push('✅ GSS「日報」に' + (rec.updated ? '上書きしました（同じ日の2通目以降）' : '記録しました') + '（' + rec.reportId + '）');
      if (kind.test) lines.push('（試験の行です。確認したら「日報」タブから消してください）');
    } else {
      lines.push('⚠️ GSS「日報」への記録に' + DOTS_MAX_RETRY + '回失敗しました。中身だけ先に送ります（「日報」タブへの記入をお願いします）');
    }
  } else {
    const title = dotsSubjectTitle_(subject, kind);
    if (title) lines.push('「' + title + '」');
    if (kind.ask) lines.push(kind.ask);
  }
  lines.push(when);
  return lines.join('\n');
}

function notifyDotsRejected_(cfg, props, items, reason) {
  const shown = items.slice(0, 3).map(function(it) {
    return '・' + (it.sender || '不明') + '／' + String(it.subject || '').substring(0, 80);
  });
  if (items.length > 3) shown.push('・ほか ' + (items.length - 3) + ' 通');
  sendDotsToAdmin_(cfg, props,
    '🚫 ドッちゃんのメールとして扱わなかったメールがあります（' + reason + '）\n' + shown.join('\n') + '\n' +
    '本物なら Script Properties の ' + DOTS_PROP.ALLOWLIST + ' / ' + DOTS_PROP.TOKEN + ' を確認してください。');
}

function notifyDotsErrorOncePerDay_(props, err) {
  const today = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd');
  if (props.getProperty(DOTS_PROP.ERROR_DAY) === today) return;
  props.setProperty(DOTS_PROP.ERROR_DAY, today);
  try {
    sendDotsToAdmin_(getConfig(), props, '❌ ドッちゃんのメール転送でエラーが出ています（本日1回だけ通知）\n' +
      String(err).substring(0, 300) + '\nGAS の実行ログを確認してください。');
  } catch (e) {
    Logger.log('❌ dots エラー通知も失敗: ' + e);
  }
}

/** @return {boolean} 送れたら true */
function sendDotsToAdmin_(cfg, props, text) {
  const raw = props.getProperty(DOTS_PROP.THREAD_ID) || cfg.adminDailyReportThreadId;
  const threadId = Number(raw);
  const options = { disable_web_page_preview: true };
  if (raw && isFinite(threadId) && threadId > 0) options.message_thread_id = threadId;
  const res = sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, text, options);
  if (!res || !res.ok) {
    Logger.log('❌ dots 管理グループ送信失敗: ' + JSON.stringify(res));
    return false;
  }
  return true;
}

// ============================================================
//  状態（ロックは読み書きの瞬間だけ）
// ============================================================

function withDotsLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { locked: false };
  try {
    return { locked: true, value: fn() };
  } finally {
    lock.releaseLock();
  }
}

/** 処理済み ID を予約する。既にある・ロックが取れない時は false（次の回に回る） */
function claimDotsId_(props, id) {
  const r = withDotsLock_(function() {
    const seen = loadDotsJson_(props, DOTS_PROP.SEEN_IDS, []);
    if (seen.indexOf(id) !== -1) return false;
    seen.push(id);
    props.setProperty(DOTS_PROP.SEEN_IDS, JSON.stringify(seen.slice(-DOTS_SEEN_KEEP)));
    return true;
  });
  return r.locked && r.value === true;
}

function releaseDotsId_(props, id) {
  withDotsLock_(function() {
    const seen = loadDotsJson_(props, DOTS_PROP.SEEN_IDS, []).filter(function(x) { return x !== id; });
    props.setProperty(DOTS_PROP.SEEN_IDS, JSON.stringify(seen));
  });
}

/**
 * まだ再試行できるなら予約を外して true（次の回でやり直す）。上限に達したら false。
 * 記録失敗・送信失敗で回数は共通（1通につき最大3回）
 */
function retryDotsLater_(props, id) {
  const n = bumpDotsRetry_(props, id);
  if (n >= DOTS_MAX_RETRY) return false;
  releaseDotsId_(props, id);
  Logger.log('⚠️ dots 失敗 ' + n + '/' + DOTS_MAX_RETRY + ' — 次回再試行 id=' + id);
  return true;
}

function bumpDotsRetry_(props, id) {
  const r = withDotsLock_(function() {
    const map = loadDotsJson_(props, DOTS_PROP.RETRY, {});
    map[id] = (map[id] || 0) + 1;
    const keys = Object.keys(map);
    if (keys.length > 20) delete map[keys[0]]; // 古いものから捨てる
    props.setProperty(DOTS_PROP.RETRY, JSON.stringify(map));
    return map[id];
  });
  return r.locked ? r.value : DOTS_MAX_RETRY; // ロックが取れない時は諦めて通知側へ
}

/** 当日の状態 {date, received, alerted} を読み、mutate して保存する */
function updateDotsDayState_(props, mutate) {
  withDotsLock_(function() {
    const today = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd');
    let state = loadDotsJson_(props, DOTS_PROP.DAY_STATE, {});
    if (state.date !== today || !state.received || !state.alerted) {
      state = { date: today, received: {}, alerted: {} };
    }
    mutate(state);
    props.setProperty(DOTS_PROP.DAY_STATE, JSON.stringify(state));
  });
}

/** 今日の分の日報が届いたら「受信済み」にする（前日分・テストは数えない） */
function markDotsReportReceived_(props, reportDate) {
  updateDotsDayState_(props, function(state) {
    if (state.date === reportDate) state.received.report = true;
  });
}

function loadDotsJson_(props, key, fallback) {
  try {
    const v = JSON.parse(props.getProperty(key) || 'null');
    if (v === null || typeof v !== 'object' || Array.isArray(v) !== Array.isArray(fallback)) return fallback;
    return v;
  } catch (e) {
    Logger.log('⚠️ ' + key + ' 破損 — 作り直す: ' + e);
    return fallback;
  }
}

// ============================================================
//  ヘルパー
// ============================================================

function parseDotsAllowlist_(raw) {
  return String(raw || '').split(',')
    .map(function(s) { return s.trim().toLowerCase(); })
    .filter(function(s) { return /^[^\s@()]+@[^\s@()]+$/.test(s); });
}

/** "Name <a@b.com>" → "a@b.com"（表示名の中の <...> に騙されないよう末尾を取る） */
function extractDotsEmail_(from) {
  const s = String(from || '');
  const m = s.match(/<([^<>]+)>\s*$/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/**
 * 件名から種類を決める。[SM-DOTS] の後ろでいちばん前に出てくる語（日報・緊急・相談・連絡・報告）で判定。
 * 「テスト」「test」が入っていれば test=true。語が無ければテストは接続テスト、それ以外はお知らせ。
 */
function detectDotsKind_(subject) {
  const rest = String(subject || '').replace(DOTS_SUBJECT_RE, '');
  const isTest = /テスト|\btest\b/i.test(rest);
  let best = null;
  let bestAt = -1;
  DOTS_KINDS.forEach(function(k) {
    const at = rest.indexOf(k.word);
    if (at !== -1 && (bestAt === -1 || at < bestAt)) { best = k; bestAt = at; }
  });
  const kind = best || (isTest ? DOTS_KIND_TEST : DOTS_KIND_OTHER);
  return Object.assign({}, kind, { test: isTest });
}

/** 件名から [SM-DOTS]・種類の語・テストを除いた残り（報連相の見出しに出す） */
function dotsSubjectTitle_(subject, kind) {
  let s = String(subject || '').replace(DOTS_SUBJECT_RE, '');
  if (kind.word) s = s.replace(kind.word, '');
  s = s.replace(/テスト|\btest\b/ig, '').replace(/^[\s:：・｜|\-—]+/, '').trim();
  return s.substring(0, 80);
}

/** 'yyyy-MM-dd' → 'M/d（曜）' */
function formatDotsDay_(ds) {
  const m = String(ds || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(ds || '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number(m[2]) + '/' + Number(m[3]) + '（' + '日月火水木金土'.charAt(d.getDay()) + '）';
}

/** 合言葉と「KEY:」を消し、返信の引用部分から先を落とす */
function cleanDotsBody_(body, token) {
  const lines = String(body).replace(/\r\n/g, '\n').split(token).join('').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^On .+wrote:\s*$/.test(line.trim()) || /^\d{4}年.+(?:書きました|wrote)[:：]?\s*$/.test(line.trim())) break;
    const stripped = line.replace(/^\s*KEY\s*[:：]\s*/i, '');
    if (stripped !== line && stripped.trim() === '') continue;
    kept.push(stripped);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 絵文字（サロゲートペア）の途中で切らない */
function safeDotsCut_(text, at) {
  let cut = Math.min(at, text.length);
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xD800 && c <= 0xDBFF) cut--;
  return text.substring(0, cut);
}

function splitDotsText_(text, size) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = safeDotsCut_(rest, size).length; // 改行が無ければ文字数で切る
    out.push(rest.substring(0, cut));
    rest = rest.substring(cut).replace(/^\n+/, '');
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
}

function getOrCreateDotsLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// ============================================================
//  セットアップ・手動実行（GAS エディタから）
// ============================================================

/**
 * 5分トリガーを登録する（1回だけ実行）。Gmail の権限確認もここで出る。
 * 合言葉がまだ無ければ作ってログに出す（issueDotsSharedToken）。許可リストは先に Script Properties へ入れておく。
 * 動き出すのは DOTS_BRIDGE_ENABLED を 'true' にしてから。
 */
function setupDotsBridgeTrigger() {
  issueDotsSharedToken();
  removeDotsBridgeTrigger();
  GmailApp.getUserLabelByName(DOTS_LABEL_DONE); // Gmail の権限確認を出すための呼び出し
  ScriptApp.newTrigger(DOTS_TRIGGER_FN).timeBased().everyMinutes(5).create();
  PropertiesService.getScriptProperties().setProperty(DOTS_PROP.ENABLED_SINCE, String(Date.now()));
  Logger.log('✅ dots 転送トリガー設定（5分ごと）');
  debugDotsBridgeConfig();
}

function removeDotsBridgeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === DOTS_TRIGGER_FN) ScriptApp.deleteTrigger(t);
  });
}

/**
 * 合言葉を作って Script Properties に入れる（まだ無い時だけ）。
 * 作った合言葉はこの実行ログに1回だけ出るので、ドッちゃんへの指示文の <KEY> に貼る（GitHub・Vault・チャットには書かない）。
 * 作り直す時は DOTS_SHARED_TOKEN を消してから再実行し、ドッちゃんにも新しい合言葉を伝える。
 */
function issueDotsSharedToken() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty(DOTS_PROP.TOKEN)) {
    Logger.log('ℹ️ 合言葉は設定済みです（作り直す時は DOTS_SHARED_TOKEN を消してから再実行）');
    return;
  }
  const token = 'SM' + Utilities.getUuid().replace(/-/g, '').substring(0, 22);
  p.setProperty(DOTS_PROP.TOKEN, token);
  Logger.log('✅ 合言葉を作りました。ドッちゃんへの指示文の <KEY> にこれを貼ってください: ' + token);
}

/** 設定の確認（合言葉・アドレスそのものはログに出さない） */
function debugDotsBridgeConfig() {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty(DOTS_PROP.TOKEN) || '';
  const allow = parseDotsAllowlist_(p.getProperty(DOTS_PROP.ALLOWLIST));
  const triggers = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === DOTS_TRIGGER_FN; });
  let staff = null;
  try { staff = resolveDotsStaff_(); } catch (e) { Logger.log('⚠️ スタッフ解決失敗: ' + e); }
  Logger.log('DOTS_BRIDGE_ENABLED   : ' + (p.getProperty(DOTS_PROP.ENABLED) || '(未設定=停止)'));
  Logger.log('DOTS_SHARED_TOKEN     : ' + (token ? token.length + '文字' + (token.length < 20 ? ' ⚠️ 20文字以上にしてください' : '') : '未設定'));
  Logger.log('DOTS_SENDER_ALLOWLIST : ' + allow.length + '件');
  Logger.log('DOTS_DIGEST_THREAD_ID : ' + (p.getProperty(DOTS_PROP.THREAD_ID) || '(未設定=日報トピック)'));
  Logger.log('日報の作成者名        : ' + (staff ? staff.nameJp + '（スタッフマスター）' : '⚠️ 解決できず（RON_CHAT_ID を確認）'));
  Logger.log('トリガー              : ' + triggers.length + '本');
  Logger.log('day_state             : ' + (p.getProperty(DOTS_PROP.DAY_STATE) || '{}'));
}

/** 5分待たずに今すぐ1回動かす（停止スイッチは尊重する） */
function debugRunDotsBridgeNow() {
  runDotsBridge();
}
