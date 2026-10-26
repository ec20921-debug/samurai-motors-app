/**
 * DotsDigestBridge.gs — Run Kosal の秘書 dots（ChatGPT「ドッちゃん」）のメールを管理グループへ
 *
 * 【責務】（2026-10-24 Daisuke 指示「日報を dots に集約する」→ 2026-10-25 改訂「日報を毎日 GSS に記録・報連相の代わり」）
 *   Run Kosal はドッちゃんとクメール語で話す。ドッちゃんは日本語のメールを送る（送信元は Run Kosal の ChatGPT の Gmail）。
 *     - 日報（1日1通）  件名 [SM-DOTS] 日報 YYYY-MM-DD
 *         → 勤務用 GSS「日報」タブに記録（DotsDailyReport.gs）→ 管理グループに「記録しました」と中身
 *     - 報連相（その都度）件名 [SM-DOTS] 緊急 / 相談 / 連絡 / 報告 ＋ 題名
 *         → 管理グループへそのまま（GSS には書かない。その日の日報にまとめて入る）
 *     - テスト          件名 [SM-DOTS] テスト（「テスト 日報」なら GSS への記録まで試す）
 *
 *   ドッちゃん → メール（件名が [SM-DOTS] で始まる・本文に合言葉）→ 本 GAS の実行者の Gmail
 *        → runDotsBridge（専用の5分トリガー。pollInternalBot とは切り離す）
 *        → 管理グループ（DOTS_DIGEST_THREAD_ID、未設定なら日報トピック）
 *
 * 【Script Properties】（値はコードに書かない。状態のキーは DotsState.gs）
 *   DOTS_BRIDGE_ENABLED    'true' のときだけ動く（停止スイッチ。消すか 'false' で即停止）
 *   DOTS_SHARED_TOKEN      合言葉。本文に含まれないメールは転送しない（第三者のなりすまし対策。issueDotsSharedToken で作れる）
 *   DOTS_SENDER_ALLOWLIST  送信元メールアドレス（カンマ区切り）。外れたものは転送しない
 *   DOTS_DIGEST_THREAD_ID  投稿先トピック（任意。未設定なら ADMIN_DAILY_REPORT_THREAD_ID）
 *
 * 【届かない・送れないときは黙らない】
 *   - 出勤した日に 20:00（プノンペン）を過ぎても「日報」タブに今日の日報（アプリ・ドッちゃんどちらでも）が無ければ1回知らせる
 *   - GSS への記録・Telegram への送信・途中で落ちたものは次の回で再試行（1通につき最大3回）。それでも駄目なら知らせる
 *   - 処理そのものが落ちたら1日1回知らせ、例外を投げ直して Google の失敗メールも出す
 *   - 弾いたメール（合言葉なし・送信元が許可外・返信や転送の形）は送信元と件名だけ知らせる（1日10通まで）
 *
 * 【ロック】
 *   勤怠・経費と共通のスクリプトロックは、処理の予約と状態の更新の瞬間だけ握る（DotsState.gs）。
 *   Gmail 検索・GSS 書き込み・Telegram 送信はロックの外（勤怠・経費を「混雑中」にしない）。
 */

const DOTS_SUBJECT_TAG = '[SM-DOTS]';
const DOTS_SUBJECT_RE = /^\s*\[SM-DOTS\]/;
const DOTS_REPLY_RE = /^\s*(?:re|fwd?|fw|転送)\s*[:：]/i;
const DOTS_LABEL_DONE = 'sm-dots/forwarded';
const DOTS_LABEL_REJECTED = 'sm-dots/rejected';
const DOTS_TRIGGER_FN = 'runDotsBridge';
const DOTS_TG_CHUNK = 3300;   // Telegram の上限 4096 字に余裕を持たせる（1通目は見出しと注意書きが足される）
const DOTS_MAX_BODY = 10500;  // これを超えた分は省略（全文はメールで見る）
const DOTS_MAX_RETRY = 3;
const DOTS_SEEN_KEEP = 200;   // メッセージ ID 約16字 × 200 ≒ 4KB（1プロパティ 9KB 以内）
const DOTS_REJECT_NOTICE_MAX = 10;     // 弾いたメールの知らせは1日この数まで（それ以上はログだけ）
const DOTS_REPORT_ALERT_AT = '20:00';  // 出勤した日、この時刻（プノンペン）までに日報が無ければ知らせる
const DOTS_REPORT_ALERT_JST = '22:00';
// 件名の [SM-DOTS]（と テスト）の直後の語で種類を決める。日報は直後にある時だけ（GSS に書くので厳しく）
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
  ENABLED:   'DOTS_BRIDGE_ENABLED',
  TOKEN:     'DOTS_SHARED_TOKEN',
  ALLOWLIST: 'DOTS_SENDER_ALLOWLIST',
  THREAD_ID: 'DOTS_DIGEST_THREAD_ID',
  ERROR_DAY: 'dots_error_notified_day',
  STUCK_DAY: 'dots_stuck_notified_day'
};

// ============================================================
//  エントリポイント（5分トリガー）
// ============================================================

function runDotsBridge() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(DOTS_PROP.ENABLED) !== 'true') return;
  noteDotsRun_(props);

  let forwardError = null;
  let res = { ran: false, pending: false, stuck: 0 };
  try {
    res = forwardDotsDigests_(props);
  } catch (e) {
    forwardError = e;
    Logger.log('❌ forwardDotsDigests_: ' + e);
    notifyDotsErrorOncePerDay_(props, e);
  }
  // 転送が走れなかった回・やり直し待ちのメールがある回に「届いていない」と言うと誤報になるので、その時は確認しない
  if (res.ran && !res.pending) {
    try { checkMissingDotsReport_(props); } catch (e) { Logger.log('❌ checkMissingDotsReport_: ' + e); }
  }
  if (forwardError) throw forwardError; // Google の失敗メールも出す
  // 管理グループへ失敗の知らせすら送れないメールがある → 1日1回、Google の失敗メールで気づけるようにする
  if (res.stuck > 0) {
    const today = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd');
    if (props.getProperty(DOTS_PROP.STUCK_DAY) !== today) {
      props.setProperty(DOTS_PROP.STUCK_DAY, today);
      throw new Error('ドッちゃんのメール ' + res.stuck + ' 通を管理グループへ送れていません（Telegram を確認。直れば自動で送ります）');
    }
  }
}

/**
 * 前回の続きから Gmail を探し、ドッちゃんのメールを1通ずつ処理する。
 * @return {{ran:boolean, pending:boolean, stuck:number}}
 *   ran 設定が揃って検索まで実行できた／pending やり直し待ちのメールがある／stuck 失敗の知らせも送れなかった数
 */
function forwardDotsDigests_(props) {
  const token = props.getProperty(DOTS_PROP.TOKEN) || '';
  const allow = parseDotsAllowlist_(props.getProperty(DOTS_PROP.ALLOWLIST));
  if (!token || allow.length === 0) {
    Logger.log('⚠️ dots: DOTS_SHARED_TOKEN / DOTS_SENDER_ALLOWLIST 未設定 — 転送しない');
    return { ran: false, pending: false, stuck: 0 };
  }
  const cfg = getConfig();
  const self = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  const runStart = Date.now();
  const from = getDotsSearchFrom_(props, runStart);
  const seen = loadDotsSeenIds_(props); // ロックなしの先読み（終わったものはロックを取らずに飛ばす）
  const query = 'subject:"' + DOTS_SUBJECT_TAG + '" after:' + Math.floor(from / 1000) + ' -in:trash';
  let oldestPending = 0; // まだ終わっていないメールの時刻（次の回はここから探す）
  let stuck = 0;
  const rejects = [];

  searchDotsThreads_(query).forEach(function(thread) {
    let forwarded = false;
    let rejected = false;
    thread.getMessages().forEach(function(msg) {
      const date = msg.getDate();
      if (date.getTime() < from) return;           // 同じスレッドの古いメッセージ
      const id = msg.getId();
      if (seen.indexOf(id) !== -1) return;
      const subject = msg.getSubject() || '';
      const sender = extractDotsEmail_(msg.getFrom());
      const allowed = allow.indexOf(sender) !== -1;
      const isOurs = DOTS_SUBJECT_RE.test(subject);
      if (!isOurs && !(allowed && DOTS_REPLY_RE.test(subject))) return;    // 関係ないメール
      if (!allowed && (sender === self || /mailer-daemon|postmaster/.test(sender))) return; // 自分の送信・配信エラー

      const claim = claimDotsId_(props, id);
      if (claim === 'done') return;
      if (claim === 'busy') { oldestPending = minDotsTime_(oldestPending, date); return; }

      let outcome;
      try {
        // 前の実行が途中で落ちたものは失敗1回と数え、上限ならあきらめて知らせる
        if (claim === 'reclaimed' && bumpDotsRetry_(props, id) >= DOTS_MAX_RETRY) {
          outcome = giveUpDotsMessage_(cfg, props, id, subject, '処理が途中で止まりました');
        } else if (!allowed || !isOurs) {
          rejects.push({ id: id, date: date, sender: sender, subject: subject,
            reason: !allowed ? '送信元が許可リスト外' : '返信・転送の形（新しいメールで送ってもらう）' });
          rejected = true;
          return; // 予約は下でまとめて知らせてから外す
        } else {
          outcome = processDotsMessage_(cfg, props, msg, subject, sender, token);
        }
      } catch (e) {
        Logger.log('❌ dots 処理中の例外 id=' + id + ': ' + e);
        outcome = retryDotsLater_(props, id) ? 'retry' : giveUpDotsMessage_(cfg, props, id, subject, String(e));
      }
      if (outcome === 'retry') { oldestPending = minDotsTime_(oldestPending, date); return; }
      if (outcome === 'stuck') { // 失敗の知らせも送れない（Telegram 不通など）→ 終わりにせず次の回にもう一度
        releaseDotsId_(props, id);
        oldestPending = minDotsTime_(oldestPending, date);
        stuck++;
        return;
      }
      finishDotsId_(props, id);
      if (outcome === 'rejected') rejected = true; else forwarded = true;
    });
    if (forwarded) thread.addLabel(getOrCreateDotsLabel_(DOTS_LABEL_DONE));
    if (rejected) thread.addLabel(getOrCreateDotsLabel_(DOTS_LABEL_REJECTED));
  });

  // 弾いたメール: 本文は読まず、送信元と件名だけまとめて知らせる。送れなければ次の回にやり直す
  if (rejects.length > 0) {
    const sent = notifyDotsRejected_(cfg, props, rejects);
    rejects.forEach(function(it) {
      if (sent || !retryDotsLater_(props, it.id)) finishDotsId_(props, it.id);
      else oldestPending = minDotsTime_(oldestPending, it.date);
    });
  }
  setDotsCursor_(props, oldestPending ? Math.min(oldestPending, runStart) : runStart);
  return { ran: true, pending: oldestPending > 0, stuck: stuck };
}

/** 新しい順に最大200スレッドまで（50件ずつ） */
function searchDotsThreads_(query) {
  let all = [];
  for (let start = 0; start < 200; start += 50) {
    const page = GmailApp.search(query, start, 50);
    all = all.concat(page);
    if (page.length < 50) break;
  }
  return all;
}

/**
 * 許可リストの送信元の [SM-DOTS] メール1通を処理する。
 * @return {string} 'done' 転送した・諦めて知らせた／'rejected' 合言葉なし／'retry' 次の回にやり直す
 *                  'stuck' 3回失敗し、その知らせも送れなかった（次の回にもう一度）
 */
function processDotsMessage_(cfg, props, msg, subject, sender, token) {
  const id = msg.getId();
  const body = msg.getPlainBody() || '';
  if (body.indexOf(token) === -1) {
    if (notifyDotsRejected_(cfg, props, [{ sender: sender, subject: subject, reason: '合言葉なし' }])) return 'rejected';
    return retryDotsLater_(props, id) ? 'retry' : 'rejected';
  }
  const kind = detectDotsKind_(subject);
  const clean = maskDotsText_(cleanDotsBody_(body, token), token);

  // 先に GSS へ（日報 →「日報」タブ＋「日報明細」、報連相 →「日報明細」に1行）。テストの報連相は書かない。
  // 失敗したら次の回にやり直す（同じメールの再試行は同じ行・同じ明細を書き直すので二重にならない）
  let rec = null;
  if (kind.key === 'report' || !kind.test) {
    try {
      rec = kind.key === 'report'
        ? recordDotsDailyReport_(msg, subject, clean, kind.test)
        : { status: 'logged', itemId: recordDotsHourensou_(msg, kind, clean, token) };
    } catch (e) {
      Logger.log('❌ dots GSS 記録失敗 id=' + id + ': ' + e);
      if (retryDotsLater_(props, id)) return 'retry';
      rec = { status: 'failed', reportDate: kind.key === 'report' ? resolveDotsReportDate_(subject, msg.getDate()) : '' }; // 中身だけ先に出す
    }
  }
  // 日報が届いた（形式違い・上書きなしも含む）日は、未着の警告を出さない
  if (kind.key === 'report' && !kind.test && rec && rec.reportDate) markDotsReportSeen_(props, rec.reportDate);

  const r = postDotsMessage_(cfg, props, msg.getDate(), subject, token, kind, clean, rec);
  if (r.sent === 0) {
    if (retryDotsLater_(props, id)) return 'retry'; // 1通も出ていないので二重投稿の恐れは無い
    const ok = sendDotsToAdmin_(cfg, props, '❌ ドッちゃんのメールを管理グループへ送れませんでした（' + DOTS_MAX_RETRY +
      '回失敗）。全文は Gmail の件名「' + safeDotsSubject_(subject, token) + '」を見てください。' +
      (rec && rec.reportId ? '\n（GSS「日報」への記録は済んでいます: ' + rec.reportId + '）' : ''));
    return ok ? 'done' : 'stuck';
  }
  if (r.sent < r.total) {
    sendDotsToAdmin_(cfg, props, '⚠️ ドッちゃんのメールが途中までしか送れませんでした（' + r.sent + '/' + r.total +
      '通）。続きは Gmail の件名「' + safeDotsSubject_(subject, token) + '」を見てください。');
  }
  return 'done';
}

/** 3回やっても駄目だったメールを知らせて終わりにする（知らせも送れなければ 'stuck'） */
function giveUpDotsMessage_(cfg, props, id, subject, why) {
  const ok = sendDotsToAdmin_(cfg, props, '❌ ドッちゃんのメールを処理できませんでした（' + DOTS_MAX_RETRY + '回失敗）\n' +
    '件名「' + safeDotsSubject_(subject, props.getProperty(DOTS_PROP.TOKEN)) + '」\n' + String(why).substring(0, 200) +
    '\nGmail で中身を確認し、日報なら「日報」タブへ手で記入してください。');
  return ok ? 'done' : 'stuck';
}

// ============================================================
//  投稿（すべてプレーンテキスト。HTML の解析エラーで落ちないように parse_mode は使わない）
// ============================================================

/** @return {{sent:number,total:number}} */
function postDotsMessage_(cfg, props, date, subject, token, kind, body, rec) {
  const header = buildDotsHeader_(date, subject, token, kind, rec) + '\n━━━━━━━━━━━━━━━━━━\n';
  const notes = [];
  if (/[ក-៿]/.test(body)) {
    notes.push('⚠️ クメール語の原文を含みます（未校閲・社内参考のみ。外へ出す時は Panha を通す）');
  }
  // 日報は明細を区分ごとに並べて見やすくする（明細が作れなかった時は本文のまま）
  let text = body || '（本文なし）';
  if (rec && rec.items && rec.items.length > 0) {
    text = [rec.preamble, renderDotsItems_(rec.items)].filter(Boolean).join('\n\n');
  }
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
function buildDotsHeader_(date, subject, token, kind, rec) {
  const recvDay = Utilities.formatDate(date, OPS_TZ, 'yyyy-MM-dd');
  const when = Utilities.formatDate(date, OPS_TZ, 'M/d HH:mm') + ' プノンペン受信（日本 ' +
    Utilities.formatDate(date, 'Asia/Tokyo', 'HH:mm') + '）';
  const lines = [(kind.test && kind.key !== 'test' ? '🧪 テスト ' : '') + kind.icon + ' ' + kind.label + ' — Run Kosal（ドッちゃん経由）' +
    (rec && rec.reportDate ? ' ' + formatDotsDay_(rec.reportDate) : '')];
  if (kind.key === 'report') {
    lines.push(describeDotsRecord_(rec));
    const asks = rec && rec.items ? rec.items.filter(function(it) { return it.decision || it.cat === '相談'; }).length : 0;
    if (asks > 0) lines.push('★ 日本側の判断が必要: ' + asks + '件（「日報明細」の対応状況を「済」にすると消し込めます）');
    if (rec && rec.reportDate && rec.reportDate !== recvDay) {
      lines.push('📅 件名の日付 ' + formatDotsDay_(rec.reportDate) + '／受信 ' + formatDotsDay_(recvDay) + '（日付が合っているか確認してください）');
    }
    if (kind.test && rec && rec.reportId) lines.push('（試験の行です。確認したら「日報」タブから消してください）');
  } else {
    const title = safeDotsSubject_(kind.title, token);
    if (title) lines.push('「' + title + '」');
    if (kind.ask) lines.push(kind.ask);
    if (rec && rec.itemId) lines.push('📒 日報明細に記録（' + rec.itemId + '）');
    else if (rec && rec.status === 'failed') lines.push('⚠️ 日報明細への記録に' + DOTS_MAX_RETRY + '回失敗しました（必要なら手で記入）');
  }
  lines.push(when);
  return lines.join('\n');
}

/** GSS への記録結果の1行 */
function describeDotsRecord_(rec) {
  const st = rec ? rec.status : 'failed';
  const n = rec && rec.itemCount ? '・明細 ' + rec.itemCount + '件' : '';
  if (st === 'created') return '✅ GSS に記録しました（日報 ' + rec.reportId + n + '）';
  if (st === 'updated') return '✅ GSS を上書きしました（同じ日の2通目以降・日報 ' + rec.reportId + n + '）';
  if (st === 'older') return '⚠️ この日の日報はもっと新しいものが記録済みなので、上書きしていません（' + rec.reportId + '）';
  if (st === 'otherDay') return '⚠️ この日の日報は別の日に記録済みなので、上書きしていません（' + rec.reportId + '）。直すなら「日報」タブを手で';
  if (st === 'noHeadings') return '⚠️ 見出し【…】が無いので GSS には記録していません（形式違い）。必要なら「日報」タブへ手で';
  return '⚠️ GSS「日報」への記録に' + DOTS_MAX_RETRY + '回失敗しました。中身だけ先に送ります（「日報」タブへの記入をお願いします）';
}

/** @return {boolean} 知らせを出せた（または1日の上限で出さないと決めた）ら true */
function notifyDotsRejected_(cfg, props, items) {
  let allowed = true;
  updateDotsDayState_(props, function(state) {
    if ((state.rejects || 0) >= DOTS_REJECT_NOTICE_MAX) { allowed = false; return; }
    state.rejects = (state.rejects || 0) + 1;
  });
  if (!allowed) { Logger.log('ℹ️ dots 弾いたメールの知らせは本日上限 — ログのみ ' + items.length + '通'); return true; }
  const token = props.getProperty(DOTS_PROP.TOKEN);
  const shown = items.slice(0, 5).map(function(it) {
    return '・' + (it.sender || '不明') + '／' + safeDotsSubject_(it.subject, token) + '（' + it.reason + '）';
  });
  if (items.length > 5) shown.push('・ほか ' + (items.length - 5) + ' 通');
  return sendDotsToAdmin_(cfg, props,
    '🚫 ドッちゃんのメールとして扱わなかったメールがあります\n' + shown.join('\n') + '\n' +
    '本物なら Script Properties の ' + DOTS_PROP.ALLOWLIST + ' / ' + DOTS_PROP.TOKEN + ' を確認し、ドッちゃんに新しいメールで送り直してもらってください。');
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
 * 件名から種類を決める。[SM-DOTS] の直後（「テスト」はさらにその前に置ける）の語で判定。
 * 直後に無い時は 緊急＞相談＞連絡＞報告 の順で件名の中を探す（日報にはしない）。
 * @return {Object} 種類 + {test:boolean, title:string（報連相の見出しに出す残りの件名）}
 */
function detectDotsKind_(subject) {
  let rest = String(subject || '').replace(DOTS_SUBJECT_RE, '').replace(/^[\s:：・【\[（(]+/, '');
  const lead = rest.match(/^(?:テスト|test(?![a-z]))/i);
  const isTest = !!lead;
  if (lead) rest = rest.substring(lead[0].length).replace(/^[\s:：・]+/, '');
  let kind = null;
  let title = rest;
  DOTS_KINDS.forEach(function(k) {
    // 語の直後が区切り・日付・終わりの時だけ（「日報の修正を連絡」を日報にしない）
    const after = rest.charAt(k.word.length);
    if (!kind && rest.indexOf(k.word) === 0 && (after === '' || /[\s:：・｜|\-—\d（(【\[]/.test(after))) {
      kind = k;
      title = rest.substring(k.word.length);
    }
  });
  if (!kind) {
    DOTS_KINDS.slice(1).forEach(function(k) { if (!kind && rest.indexOf(k.word) !== -1) kind = k; });
  }
  kind = kind || (isTest ? DOTS_KIND_TEST : DOTS_KIND_OTHER);
  title = title.replace(/^[\s:：・｜|\-—】\])）]+/, '').trim().substring(0, 80);
  return Object.assign({}, kind, { test: isTest, title: title });
}

/** 'yyyy-MM-dd' → 'M/d（曜）' */
function formatDotsDay_(ds) {
  const m = String(ds || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(ds || '');
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number(m[2]) + '/' + Number(m[3]) + '（' + '日月火水木金土'.charAt(d.getDay()) + '）';
}

function minDotsTime_(cur, date) {
  const t = date.getTime();
  return (!cur || t < cur) ? t : cur;
}

/** 合言葉と「KEY:」を消し、返信の引用部分から先を落とす */
function cleanDotsBody_(body, token) {
  const lines = String(body).replace(/\r\n/g, '\n').split(token).join('').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^On .+wrote:\s*$/.test(line.trim()) || /^\d{4}年.+(?:書きました|wrote)[:：]\s*$/.test(line.trim())) break;
    const stripped = line.replace(/^\s*KEY\s*[:：]\s*/i, '');
    if (stripped !== line && stripped.trim() === '') continue;
    kept.push(stripped);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 最後の砦: 合言葉・電話番号らしいもの・8桁以上の数字（口座番号など）を伏せる。
 * ドッちゃんには「書かない」と指示してあるが、書いてしまっても GSS・Telegram に残さない。
 */
function maskDotsText_(text, token) {
  let s = String(text || '');
  if (token) s = s.split(token).join('（合言葉は伏せました）');
  return s
    .replace(/(?<!\d)(?:\+?855[\s-]?|0)\d{2}[\s-]?\d{3}[\s-]?\d{3,4}(?!\d)/g, '［番号は伏せました］')
    .replace(/\d{8,}/g, '［番号は伏せました］');
}

/** 件名を表示用に（合言葉を伏せ、URL は押せないように崩し、80字まで） */
function safeDotsSubject_(subject, token) {
  return maskDotsText_(String(subject || ''), token).replace(/https?:\/\//gi, 'hxxp://').substring(0, 80);
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
