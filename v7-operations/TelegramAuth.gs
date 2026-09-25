/**
 * TelegramAuth.gs — Telegram Mini App initData signature verification (audit mode)
 *
 * [Purpose]
 *   Mini apps currently send a self-declared chatId. Telegram also hands every mini app
 *   a signed "initData" string (HMAC-SHA256 keyed by the bot token). Verifying it on the
 *   server proves who the user really is, so nobody can impersonate staff/admin by
 *   sending someone else's chatId.
 *
 * [Phase 1 = audit only (2026-09-25〜)]
 *   - NEVER blocks a request. Only records the verification result per action.
 *   - Frontend (tg-auth.js) adds `_tgInitData` to POST bodies and `_tg` to GET queries.
 *   - Results are aggregated per day in ScriptProperties (TG_AUTH_AUDIT_yyyyMMdd).
 *   - View: GET ?action=auth_audit  (counts + failure reasons only, no user IDs)
 *   - Phase 2 (enforce) flips TG_AUTH_MODE to 'enforce' after the audit is clean.
 *
 * NOTE: this file is identical in v7/ and v7-operations/. Keep them in sync.
 *
 * Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *   secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   hash       = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
 *   data_check_string = all fields except `hash`, sorted by key, "key=value" joined by "\n"
 */

var TG_AUTH_TOKEN_PROPS_ = ['BOT_TOKEN_BOOKING', 'BOT_TOKEN_FIELD', 'BOT_TOKEN_INTERNAL'];
var TG_AUTH_AUDIT_PREFIX_ = 'TG_AUTH_AUDIT_';
var TG_AUTH_AUDIT_KEEP_DAYS_ = 14;
var TG_AUTH_AUDIT_MAX_FAILS_ = 15;
var TG_AUTH_TZ_ = 'Asia/Phnom_Penh';

/**
 * Verify a Telegram initData string against every bot token available in this project.
 * @return {{ok:boolean, reason:string, userId:string, bot:string, ageSec:number}}
 */
function verifyTelegramInitData_(initData) {
  var res = { ok: false, reason: '', userId: '', bot: '', ageSec: -1 };
  if (!initData) { res.reason = 'missing'; return res; }

  var fields = parseInitData_(String(initData));
  if (!fields || !fields.hash) { res.reason = 'parse_error'; return res; }

  // user.id と auth_date は署名の成否に関係なく取り出しておく（ログ用）
  try {
    var user = fields.user ? JSON.parse(fields.user) : null;
    if (user && user.id) res.userId = String(user.id);
  } catch (e) { /* ignore */ }
  var authDate = Number(fields.auth_date || 0);
  if (authDate > 0) res.ageSec = Math.floor(Date.now() / 1000) - authDate;

  // Telegram は Bot API 8.0 以降 `signature` フィールドも付ける。
  // 公式仕様では hash 以外すべてが対象だが、念のため signature 除外版も試す。
  var dcsAll = buildDataCheckString_(fields, ['hash']);
  var dcsNoSig = fields.signature ? buildDataCheckString_(fields, ['hash', 'signature']) : null;
  var expected = String(fields.hash).toLowerCase();

  var props = PropertiesService.getScriptProperties();
  var triedAny = false;
  for (var i = 0; i < TG_AUTH_TOKEN_PROPS_.length; i++) {
    var token = props.getProperty(TG_AUTH_TOKEN_PROPS_[i]);
    if (!token) continue;
    triedAny = true;
    var secret = Utilities.computeHmacSha256Signature(token, 'WebAppData');
    if (hmacHex_(dcsAll, secret) === expected ||
        (dcsNoSig && hmacHex_(dcsNoSig, secret) === expected)) {
      res.ok = true;
      res.reason = 'valid';
      res.bot = TG_AUTH_TOKEN_PROPS_[i].replace('BOT_TOKEN_', '').toLowerCase();
      return res;
    }
  }
  res.reason = triedAny ? 'hash_mismatch' : 'no_token';
  return res;
}

/** "a=1&b=2" → {a:'1', b:'2'}（URLSearchParams と同じく + は空白として扱う） */
function parseInitData_(s) {
  var out = {};
  var parts = s.split('&');
  for (var i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    var idx = parts[i].indexOf('=');
    var k = idx >= 0 ? parts[i].substring(0, idx) : parts[i];
    var v = idx >= 0 ? parts[i].substring(idx + 1) : '';
    try {
      out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
    } catch (e) {
      return null;
    }
  }
  return out;
}

function buildDataCheckString_(fields, excludeKeys) {
  return Object.keys(fields)
    .filter(function (k) { return excludeKeys.indexOf(k) < 0; })
    .sort()
    .map(function (k) { return k + '=' + fields[k]; })
    .join('\n');
}

function hmacHex_(message, keyBytes) {
  var msgBytes = Utilities.newBlob(message).getBytes(); // UTF-8
  var sig = Utilities.computeHmacSha256Signature(msgBytes, keyBytes);
  return sig.map(function (b) {
    var h = (b & 0xff).toString(16);
    return h.length === 1 ? '0' + h : h;
  }).join('');
}

/**
 * Audit hook called from doGet/doPost. Never throws, never blocks.
 * @param {string} action
 * @param {string} claimedChatId  chatId the client says it is (may be a customer ID on some actions)
 * @param {string} initData       raw Telegram.WebApp.initData ('' if not sent)
 */
function auditTelegramAuth_(action, claimedChatId, initData) {
  try {
    if (!action || action === 'ping' || action === 'auth_audit') return;
    var v = verifyTelegramInitData_(initData);

    var category;
    if (v.ok) {
      if (!claimedChatId) category = 'valid_noclaim';
      else category = (String(claimedChatId) === v.userId) ? 'valid_match' : 'valid_mismatch';
    } else {
      category = v.reason; // missing / parse_error / hash_mismatch / no_token
    }

    var ageBucket = v.ageSec < 0 ? 'na'
      : v.ageSec < 3600 ? 'lt1h'
      : v.ageSec < 86400 ? 'lt24h'
      : 'gt24h';

    var props = PropertiesService.getScriptProperties();
    var key = TG_AUTH_AUDIT_PREFIX_ + Utilities.formatDate(new Date(), TG_AUTH_TZ_, 'yyyyMMdd');
    var raw = props.getProperty(key);
    var data = raw ? JSON.parse(raw) : null;
    if (!data) {
      data = { counts: {}, bots: {}, ages: {}, fails: [] };
      cleanupOldAuthAudit_(props);
    }

    var ck = action + '|' + category;
    data.counts[ck] = (data.counts[ck] || 0) + 1;
    if (v.bot) data.bots[v.bot] = (data.bots[v.bot] || 0) + 1;
    if (v.ok) data.ages[ageBucket] = (data.ages[ageBucket] || 0) + 1;

    // 失敗・食い違いのみ時刻と理由を残す（ユーザーIDは残さない）
    if (category !== 'valid_match' && category !== 'valid_noclaim') {
      data.fails.push({
        t: Utilities.formatDate(new Date(), TG_AUTH_TZ_, 'HH:mm:ss'),
        a: action,
        c: category,
        age: ageBucket
      });
      if (data.fails.length > TG_AUTH_AUDIT_MAX_FAILS_) {
        data.fails = data.fails.slice(-TG_AUTH_AUDIT_MAX_FAILS_);
      }
    }

    // 同時書き込みで数件取りこぼしても監査目的では許容（予約等の ScriptLock と競合させない）
    props.setProperty(key, JSON.stringify(data));
  } catch (err) {
    Logger.log('⚠️ auditTelegramAuth_ failed (ignored): ' + err);
  }
}

function cleanupOldAuthAudit_(props) {
  try {
    var cutoff = Utilities.formatDate(
      new Date(Date.now() - TG_AUTH_AUDIT_KEEP_DAYS_ * 86400000), TG_AUTH_TZ_, 'yyyyMMdd');
    props.getKeys().forEach(function (k) {
      if (k.indexOf(TG_AUTH_AUDIT_PREFIX_) === 0 && k.substring(TG_AUTH_AUDIT_PREFIX_.length) < cutoff) {
        props.deleteProperty(k);
      }
    });
  } catch (e) { /* ignore */ }
}

/** GET ?action=auth_audit[&days=7] — daily summaries (no user IDs) */
function apiAuthAudit_(params) {
  var days = Math.min(Math.max(Number((params && params.days) || 7), 1), TG_AUTH_AUDIT_KEEP_DAYS_);
  var props = PropertiesService.getScriptProperties();
  var out = [];
  for (var i = 0; i < days; i++) {
    var d = Utilities.formatDate(new Date(Date.now() - i * 86400000), TG_AUTH_TZ_, 'yyyyMMdd');
    var raw = props.getProperty(TG_AUTH_AUDIT_PREFIX_ + d);
    if (raw) out.push({ date: d, data: JSON.parse(raw) });
  }
  return { ok: true, status: 'ok', mode: 'audit', days: out };
}

/** Pull initData from a POST body or GET parameters */
function extractInitData_(obj) {
  if (!obj) return '';
  return String(obj._tgInitData || obj._tg || '');
}
