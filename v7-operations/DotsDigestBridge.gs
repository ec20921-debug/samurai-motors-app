/**
 * DotsDigestBridge.gs — Run Kosal の秘書 dots（ChatGPT）のまとめを管理グループへ転送
 *
 * 【責務】（2026-10-24 Daisuke 指示「日報を dots に集約する」）
 *   Run Kosal は ChatGPT の dots（常駐エージェント）に日報・相談を話しかける。
 *   dots は 1日2回（プノンペン 12:00 / 18:00）、日本語のまとめをメールで送る。
 *   本モジュールはそのメールを Gmail から拾い、管理グループの日報トピックへ投稿する。
 *
 *   dots → メール（件名に [SM-DOTS]・本文に合言葉）→ 本 GAS の実行者の Gmail
 *        → maybeForwardDotsDigest_（pollInternalBot から毎分呼ばれ、5分に1回だけ動く）
 *        → 管理グループ（DOTS_DIGEST_THREAD_ID、未設定なら日報トピック）
 *
 * 【Script Properties】（値はコードに書かない）
 *   DOTS_BRIDGE_ENABLED    'true' のときだけ動く（停止スイッチ。消すか 'false' で即停止）
 *   DOTS_SHARED_TOKEN      合言葉。本文に含まれないメールは転送しない（なりすまし対策）
 *   DOTS_SENDER_ALLOWLIST  送信元メールアドレス（カンマ区切り）。外れたものは転送しない
 *   DOTS_DIGEST_THREAD_ID  投稿先トピック（任意。未設定なら ADMIN_DAILY_REPORT_THREAD_ID）
 *
 * 【届かないときは黙らない】
 *   12:40 / 18:40（プノンペン）を過ぎてもその回のまとめが無ければ、管理グループに1回だけ知らせる。
 *   弾いたメール（合言葉なし・送信元が許可外）も、送信元アドレスと件名だけ知らせる（本文は出さない）。
 */

const DOTS_SUBJECT_TAG = '[SM-DOTS]';
const DOTS_LABEL_DONE = 'sm-dots/forwarded';
const DOTS_LABEL_REJECTED = 'sm-dots/rejected';
const DOTS_RUN_EVERY_MIN = 5;
const DOTS_TG_CHUNK = 3500; // Telegram の上限 4096 字に余裕を持たせる
const DOTS_MAX_BODY = 10500; // 3通まで。超えた分は省略
const DOTS_SLOTS = [
  { key: 'noon',    label: '昼',  due: '12:00', alertAt: '12:40', from: '00:00', to: '14:59' },
  { key: 'evening', label: '夕方', due: '18:00', alertAt: '18:40', from: '15:00', to: '23:59' }
];
const DOTS_PROP = {
  ENABLED:   'DOTS_BRIDGE_ENABLED',
  TOKEN:     'DOTS_SHARED_TOKEN',
  ALLOWLIST: 'DOTS_SENDER_ALLOWLIST',
  THREAD_ID: 'DOTS_DIGEST_THREAD_ID',
  SEEN_IDS:  'dots_seen_message_ids',
  DAY_STATE: 'dots_day_state',
  LAST_RUN:  'dots_last_run_ms'
};

// ============================================================
//  エントリポイント
// ============================================================

/**
 * pollInternalBot から毎分呼ばれる。停止中・5分未満は即 return（軽量）。
 */
function maybeForwardDotsDigest_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(DOTS_PROP.ENABLED) !== 'true') return;

  const nowMs = Date.now();
  const last = parseInt(props.getProperty(DOTS_PROP.LAST_RUN) || '0', 10);
  if (nowMs - last < DOTS_RUN_EVERY_MIN * 60 * 1000 - 5000) return;
  props.setProperty(DOTS_PROP.LAST_RUN, String(nowMs));

  forwardDotsDigests_();
  checkMissingDotsDigest_();
}

/**
 * 未転送の dots メールを拾って管理グループへ投稿する。
 */
function forwardDotsDigests_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('⚠️ forwardDotsDigests_: lock busy — 次回に回す');
    return;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const token = props.getProperty(DOTS_PROP.TOKEN) || '';
    const allow = parseDotsAllowlist_(props.getProperty(DOTS_PROP.ALLOWLIST));
    if (!token || allow.length === 0) {
      Logger.log('⚠️ dots: DOTS_SHARED_TOKEN / DOTS_SENDER_ALLOWLIST 未設定 — 転送しない');
      return;
    }

    const seen = loadDotsSeenIds_(props);
    // 二重投稿の防止は処理済み ID（ScriptProperties）で行う。ラベルは人が Gmail で見分けるため
    const query = 'subject:"' + DOTS_SUBJECT_TAG + '" newer_than:3d';
    const threads = GmailApp.search(query, 0, 10);
    if (threads.length === 0) return;

    const doneLabel = getOrCreateDotsLabel_(DOTS_LABEL_DONE);
    const rejectedLabel = getOrCreateDotsLabel_(DOTS_LABEL_REJECTED);

    threads.forEach(function(thread) {
      const messages = thread.getMessages();
      let threadHandled = false;
      let threadRejected = false;
      messages.forEach(function(msg) {
        const id = msg.getId();
        if (seen.indexOf(id) !== -1) return;
        if (msg.getSubject().indexOf(DOTS_SUBJECT_TAG) === -1) return; // 返信等の別件

        const sender = extractDotsEmail_(msg.getFrom());
        const body = msg.getPlainBody() || '';
        // 先に既読マーク（送信の途中で落ちても二重投稿しない方を優先。DailyReport と同じ方針）
        seen.push(id);
        saveDotsSeenIds_(props, seen);
        threadHandled = true;

        if (allow.indexOf(sender) === -1 || body.indexOf(token) === -1) {
          threadRejected = true;
          notifyDotsRejected_(sender, msg.getSubject(), allow.indexOf(sender) === -1 ? '送信元が許可リスト外' : '合言葉なし');
          return;
        }
        postDotsDigest_(msg.getDate(), cleanDotsBody_(body, token));
        markDotsSlotReceived_(props, msg.getDate());
      });
      if (threadHandled) {
        thread.markRead();
        thread.addLabel(threadRejected ? rejectedLabel : doneLabel);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/**
 * 12:40 / 18:40 を過ぎてもその回のまとめが無ければ1回だけ知らせる。
 */
function checkMissingDotsDigest_() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const hm = Utilities.formatDate(now, OPS_TZ, 'HH:mm');
  const state = loadDotsDayState_(props, now);
  let changed = false;

  DOTS_SLOTS.forEach(function(slot) {
    if (hm < slot.alertAt) return;
    if (state.received[slot.key] || state.alerted[slot.key]) return;
    state.alerted[slot.key] = true; // 送信前にマーク（多重通知防止）
    changed = true;
    const text =
      '⚠️ <b>dots の' + slot.label + 'のまとめが届いていません</b>（' + slot.due + ' 予定・プノンペン時間）\n' +
      '・Run Kosal の dots の「Scheduled」に定期タスクが残っているか\n' +
      '・メールが迷惑メールに入っていないか（件名 ' + escapeHtml_(DOTS_SUBJECT_TAG) + '）\n' +
      'を確認してください。';
    sendDotsToAdmin_(text);
  });
  if (changed) props.setProperty(DOTS_PROP.DAY_STATE, JSON.stringify(state));
}

// ============================================================
//  投稿
// ============================================================

function postDotsDigest_(date, body) {
  const when = Utilities.formatDate(date, OPS_TZ, 'yyyy-MM-dd (E) HH:mm');
  const slot = findDotsSlot_(Utilities.formatDate(date, OPS_TZ, 'HH:mm'));
  const header = '🤖 <b>Run Kosal 秘書（dots）' + slot.label + 'のまとめ</b>\n' +
    '<i>' + when + ' プノンペン受信</i>\n━━━━━━━━━━━━━━━━━━\n';
  const notes = [];
  if (/[ក-៿]/.test(body)) {
    notes.push('⚠️ クメール語の原文を含みます（未校閲・社内参考のみ。外へ出す時は Panha を通す）');
  }

  let text = body;
  if (text.length > DOTS_MAX_BODY) {
    text = text.substring(0, DOTS_MAX_BODY);
    notes.push('✂️ 長すぎるため後半を省略しました。全文はメール（件名 ' + DOTS_SUBJECT_TAG + '）で確認してください');
  }
  const chunks = splitDotsText_(text, DOTS_TG_CHUNK);
  chunks.forEach(function(chunk, i) {
    let msg = (i === 0 ? header : '（続き ' + (i + 1) + '/' + chunks.length + '）\n') + escapeHtml_(chunk);
    if (i === chunks.length - 1 && notes.length > 0) {
      msg += '\n\n' + notes.map(escapeHtml_).join('\n');
    }
    sendDotsToAdmin_(msg);
  });
  Logger.log('📤 dots まとめ転送 ' + when + ' chunks=' + chunks.length);
}

function notifyDotsRejected_(sender, subject, reason) {
  sendDotsToAdmin_(
    '🚫 <b>dots のまとめを転送しませんでした</b>（' + escapeHtml_(reason) + '）\n' +
    '送信元: ' + escapeHtml_(sender || '不明') + '\n' +
    '件名: ' + escapeHtml_(String(subject || '').substring(0, 120)) + '\n' +
    '本物なら Script Properties の ' + DOTS_PROP.ALLOWLIST + ' / ' + DOTS_PROP.TOKEN + ' を確認してください。'
  );
}

function sendDotsToAdmin_(text) {
  const cfg = getConfig();
  const threadId = PropertiesService.getScriptProperties().getProperty(DOTS_PROP.THREAD_ID) ||
    cfg.adminDailyReportThreadId;
  const options = { parse_mode: 'HTML', disable_web_page_preview: true };
  if (threadId) options.message_thread_id = Number(threadId);
  const res = sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, text, options);
  if (!res || !res.ok) Logger.log('❌ dots 管理グループ送信失敗: ' + JSON.stringify(res));
}

// ============================================================
//  ヘルパー
// ============================================================

function parseDotsAllowlist_(raw) {
  return String(raw || '').split(',')
    .map(function(s) { return s.trim().toLowerCase(); })
    .filter(function(s) { return s.length > 0; });
}

/** "Name <a@b.com>" → "a@b.com" */
function extractDotsEmail_(from) {
  const m = String(from || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(from || '')).trim().toLowerCase();
}

/** 合言葉の行・引用（> で始まる行）・前後の空白を落とす */
function cleanDotsBody_(body, token) {
  const lines = String(body).replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^On .+wrote:$/.test(line.trim())) break; // 返信の引用部分から先は捨てる
    if (line.indexOf(token) !== -1) continue;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function splitDotsText_(text, size) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size; // 改行が無ければ文字数で切る
    out.push(rest.substring(0, cut));
    rest = rest.substring(cut).replace(/^\n+/, '');
  }
  if (rest.length > 0 || out.length === 0) out.push(rest);
  return out;
}

function findDotsSlot_(hm) {
  for (let i = 0; i < DOTS_SLOTS.length; i++) {
    if (hm >= DOTS_SLOTS[i].from && hm <= DOTS_SLOTS[i].to) return DOTS_SLOTS[i];
  }
  return DOTS_SLOTS[DOTS_SLOTS.length - 1];
}

function loadDotsDayState_(props, now) {
  const today = Utilities.formatDate(now, OPS_TZ, 'yyyy-MM-dd');
  try {
    const s = JSON.parse(props.getProperty(DOTS_PROP.DAY_STATE) || '{}');
    if (s.date === today && s.received && s.alerted) return s;
  } catch (e) {
    Logger.log('⚠️ dots_day_state 破損 — 作り直す: ' + e);
  }
  return { date: today, received: {}, alerted: {} };
}

function markDotsSlotReceived_(props, date) {
  const state = loadDotsDayState_(props, new Date());
  if (Utilities.formatDate(date, OPS_TZ, 'yyyy-MM-dd') !== state.date) return; // 前日分の遅着
  state.received[findDotsSlot_(Utilities.formatDate(date, OPS_TZ, 'HH:mm')).key] = true;
  props.setProperty(DOTS_PROP.DAY_STATE, JSON.stringify(state));
}

function loadDotsSeenIds_(props) {
  try {
    const arr = JSON.parse(props.getProperty(DOTS_PROP.SEEN_IDS) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

function saveDotsSeenIds_(props, ids) {
  props.setProperty(DOTS_PROP.SEEN_IDS, JSON.stringify(ids.slice(-60)));
}

function getOrCreateDotsLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

// ============================================================
//  手動実行（GAS エディタから）
// ============================================================

/** 設定の確認（合言葉そのものはログに出さない） */
function debugDotsBridgeConfig() {
  const p = PropertiesService.getScriptProperties();
  Logger.log('DOTS_BRIDGE_ENABLED   : ' + (p.getProperty(DOTS_PROP.ENABLED) || '(未設定=停止)'));
  Logger.log('DOTS_SHARED_TOKEN     : ' + (p.getProperty(DOTS_PROP.TOKEN) ? '設定済み' : '未設定'));
  Logger.log('DOTS_SENDER_ALLOWLIST : ' + (p.getProperty(DOTS_PROP.ALLOWLIST) || '未設定'));
  Logger.log('DOTS_DIGEST_THREAD_ID : ' + (p.getProperty(DOTS_PROP.THREAD_ID) || '(未設定=日報トピック)'));
  Logger.log('day_state             : ' + (p.getProperty(DOTS_PROP.DAY_STATE) || '{}'));
}

/** 5分待たずに今すぐ転送を試す（停止スイッチは尊重する） */
function debugForwardDotsDigestNow() {
  if (PropertiesService.getScriptProperties().getProperty(DOTS_PROP.ENABLED) !== 'true') {
    Logger.log('⏸ DOTS_BRIDGE_ENABLED が true ではないので何もしない');
    return;
  }
  forwardDotsDigests_();
}
