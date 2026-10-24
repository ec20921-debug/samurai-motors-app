/**
 * DotsDigestBridge.gs — Run Kosal の秘書 dots（ChatGPT）のまとめを管理グループへ転送
 *
 * 【責務】（2026-10-24 Daisuke 指示「日報を dots に集約する」）
 *   Run Kosal は ChatGPT の dots（常駐エージェント）に日報・相談を話しかける。
 *   dots は 1日2回（プノンペン 12:00 / 18:00）、日本語のまとめをメールで送る。
 *   本モジュールはそのメールを Gmail から拾い、管理グループの日報トピックへ投稿する。
 *
 *   dots → メール（件名が [SM-DOTS] で始まる・本文に合言葉）→ 本 GAS の実行者の Gmail
 *        → runDotsBridge（専用の5分トリガー。pollInternalBot とは切り離す）
 *        → 管理グループ（DOTS_DIGEST_THREAD_ID、未設定なら日報トピック）
 *
 * 【Script Properties】（値はコードに書かない）
 *   DOTS_BRIDGE_ENABLED    'true' のときだけ動く（停止スイッチ。消すか 'false' で即停止）
 *   DOTS_SHARED_TOKEN      合言葉。本文に含まれないメールは転送しない（なりすまし対策）
 *   DOTS_SENDER_ALLOWLIST  送信元メールアドレス（カンマ区切り）。外れたものは転送しない
 *   DOTS_DIGEST_THREAD_ID  投稿先トピック（任意。未設定なら ADMIN_DAILY_REPORT_THREAD_ID）
 *
 * 【届かない・送れないときは黙らない】
 *   - 12:40 / 18:40（プノンペン）を過ぎてもその回のまとめが無ければ、1回だけ知らせる
 *   - Telegram への送信に失敗したら次の回で再試行（最大3回）。それでも駄目なら知らせる
 *   - 処理そのものが落ちたら1日1回知らせ、例外を投げ直して Google の失敗メールも出す
 *   - 弾いたメール（合言葉なし・送信元が許可外）は送信元と件名だけ、1回にまとめて知らせる
 *
 * 【ロック】
 *   勤怠・経費と共通のスクリプトロックは、処理済み ID の予約と状態の更新の瞬間だけ握る。
 *   Gmail 検索・Telegram 送信はロックの外（勤怠・経費を「混雑中」にしない）。
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
const DOTS_SLOTS = [
  { key: 'noon',    label: '昼',   subjectRe: /昼/,   due: '12:00', dueJst: '14:00', earliest: '11:00', alertAt: '12:40' },
  { key: 'evening', label: '夕方', subjectRe: /夕方/, due: '18:00', dueJst: '20:00', earliest: '17:00', alertAt: '18:40' }
];
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
    try { checkMissingDotsDigest_(props); } catch (e) { Logger.log('❌ checkMissingDotsDigest_: ' + e); }
  }
  if (forwardError) throw forwardError; // Google の失敗メールも出す
}

/**
 * 未転送の dots メールを拾って管理グループへ投稿する。
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
  GmailApp.search(base + ' ' + fromAllowed, 0, 10).forEach(function(thread) {
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
      const r = postDotsDigest_(cfg, props, msg.getDate(), subject, cleanDotsBody_(body, token));
      if (r.sent === 0) {
        const n = bumpDotsRetry_(props, id);
        if (n < DOTS_MAX_RETRY) {
          releaseDotsId_(props, id); // 1通も出ていないので二重投稿の恐れは無い → 次の回で再試行
          Logger.log('⚠️ dots 送信失敗 ' + n + '/' + DOTS_MAX_RETRY + ' — 次回再試行 id=' + id);
          return;
        }
        sendDotsToAdmin_(cfg, props, '❌ dots のまとめを管理グループへ送れませんでした（' + DOTS_MAX_RETRY +
          '回失敗）。全文は Gmail の件名「' + subject.substring(0, 80) + '」を見てください。');
        return;
      }
      if (r.sent < r.total) {
        sendDotsToAdmin_(cfg, props, '⚠️ dots のまとめが途中までしか送れませんでした（' + r.sent + '/' + r.total +
          '通）。続きは Gmail の件名「' + subject.substring(0, 80) + '」を見てください。');
      }
      forwarded = true;
      markDotsSlotReceived_(props, msg.getDate(), subject);
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
 * 12:40 / 18:40 を過ぎてもその回のまとめが無ければ1回だけ知らせる。
 * 有効化した時刻より前に締切を過ぎた回は知らせない（有効化当日の誤報防止）。
 */
function checkMissingDotsDigest_(props) {
  const now = new Date();
  const hm = Utilities.formatDate(now, OPS_TZ, 'HH:mm');
  const enabledSince = parseInt(props.getProperty(DOTS_PROP.ENABLED_SINCE) || '0', 10);
  const sinceSameDay = enabledSince > 0 &&
    Utilities.formatDate(new Date(enabledSince), OPS_TZ, 'yyyy-MM-dd') === Utilities.formatDate(now, OPS_TZ, 'yyyy-MM-dd');
  const sinceHm = sinceSameDay ? Utilities.formatDate(new Date(enabledSince), OPS_TZ, 'HH:mm') : '00:00';

  const due = [];
  updateDotsDayState_(props, function(state) {
    DOTS_SLOTS.forEach(function(slot) {
      if (hm < slot.alertAt || sinceHm >= slot.alertAt) return;
      if (state.received[slot.key] || state.alerted[slot.key]) return;
      state.alerted[slot.key] = true; // 送信前にマーク（多重通知防止）
      due.push(slot);
    });
  });
  if (due.length === 0) return;

  const cfg = getConfig();
  due.forEach(function(slot) {
    sendDotsToAdmin_(cfg, props,
      '⚠️ dots の' + slot.label + 'のまとめが届いていません（' + slot.due + ' 予定・日本 ' + slot.dueJst + '）\n' +
      '・Run Kosal の dots の「Scheduled」に定期タスクが残っているか\n' +
      '・Gmail で迷惑メールに入っていないか（件名 ' + DOTS_SUBJECT_TAG + '）\n' +
      'を確認してください。');
  });
}

// ============================================================
//  投稿（すべてプレーンテキスト。HTML の解析エラーで落ちないように parse_mode は使わない）
// ============================================================

/** @return {{sent:number,total:number}} */
function postDotsDigest_(cfg, props, date, subject, body) {
  const pp = Utilities.formatDate(date, OPS_TZ, 'yyyy-MM-dd HH:mm');
  const jst = Utilities.formatDate(date, 'Asia/Tokyo', 'HH:mm');
  const slot = detectDotsSlot_(subject, date);
  const isTest = /テスト|test/i.test(subject);
  const header = '🤖 Run Kosal 秘書（dots）' + (isTest ? 'テスト' : slot.label + 'のまとめ') + '\n' +
    pp + ' プノンペン受信（日本 ' + jst + '）\n━━━━━━━━━━━━━━━━━━\n';
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
  Logger.log('📤 dots まとめ転送 ' + pp + ' sent=' + sent + '/' + chunks.length);
  return { sent: sent, total: chunks.length };
}

function notifyDotsRejected_(cfg, props, items, reason) {
  const shown = items.slice(0, 3).map(function(it) {
    return '・' + (it.sender || '不明') + '／' + String(it.subject || '').substring(0, 80);
  });
  if (items.length > 3) shown.push('・ほか ' + (items.length - 3) + ' 通');
  sendDotsToAdmin_(cfg, props,
    '🚫 dots のまとめとして転送しなかったメールがあります（' + reason + '）\n' + shown.join('\n') + '\n' +
    '本物なら Script Properties の ' + DOTS_PROP.ALLOWLIST + ' / ' + DOTS_PROP.TOKEN + ' を確認してください。');
}

function notifyDotsErrorOncePerDay_(props, err) {
  const today = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd');
  if (props.getProperty(DOTS_PROP.ERROR_DAY) === today) return;
  props.setProperty(DOTS_PROP.ERROR_DAY, today);
  try {
    sendDotsToAdmin_(getConfig(), props, '❌ dots 転送の処理でエラーが出ています（本日1回だけ通知）\n' +
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

/**
 * その回を「受信済み」にする。件名で回を決め（時刻は予備）、
 * テスト・前日分・締切1時間より前に来たものは数えない（朝の試験で昼の警告が消えないように）。
 */
function markDotsSlotReceived_(props, date, subject) {
  if (/テスト|test/i.test(subject)) return;
  const day = Utilities.formatDate(date, OPS_TZ, 'yyyy-MM-dd');
  const hm = Utilities.formatDate(date, OPS_TZ, 'HH:mm');
  const slot = detectDotsSlot_(subject, date);
  if (hm < slot.earliest) return;
  updateDotsDayState_(props, function(state) {
    if (state.date === day) state.received[slot.key] = true;
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

function detectDotsSlot_(subject, date) {
  for (let i = 0; i < DOTS_SLOTS.length; i++) {
    if (DOTS_SLOTS[i].subjectRe.test(subject || '')) return DOTS_SLOTS[i];
  }
  return Utilities.formatDate(date, OPS_TZ, 'HH:mm') < '15:00' ? DOTS_SLOTS[0] : DOTS_SLOTS[1];
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
 * 先に Script Properties 4項目を入れてから実行する。
 */
function setupDotsBridgeTrigger() {
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

/** 設定の確認（合言葉・アドレスそのものはログに出さない） */
function debugDotsBridgeConfig() {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty(DOTS_PROP.TOKEN) || '';
  const allow = parseDotsAllowlist_(p.getProperty(DOTS_PROP.ALLOWLIST));
  const triggers = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === DOTS_TRIGGER_FN; });
  Logger.log('DOTS_BRIDGE_ENABLED   : ' + (p.getProperty(DOTS_PROP.ENABLED) || '(未設定=停止)'));
  Logger.log('DOTS_SHARED_TOKEN     : ' + (token ? token.length + '文字' + (token.length < 20 ? ' ⚠️ 20文字以上にしてください' : '') : '未設定'));
  Logger.log('DOTS_SENDER_ALLOWLIST : ' + allow.length + '件');
  Logger.log('DOTS_DIGEST_THREAD_ID : ' + (p.getProperty(DOTS_PROP.THREAD_ID) || '(未設定=日報トピック)'));
  Logger.log('トリガー              : ' + triggers.length + '本');
  Logger.log('day_state             : ' + (p.getProperty(DOTS_PROP.DAY_STATE) || '{}'));
}

/** 5分待たずに今すぐ1回動かす（停止スイッチは尊重する） */
function debugRunDotsBridgeNow() {
  runDotsBridge();
}
