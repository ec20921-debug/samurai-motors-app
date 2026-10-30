/**
 * StaffGate.gs — staff-only API actions (2026-10-30, security assessment L3)
 *
 * [Why]
 *   The v7 web app is deployed "anyone, anonymous" and its URL is written in the public mini apps.
 *   Until now anyone could call the staff actions below with a self-declared chatId:
 *   today's bookings (names / address / map), customer chats, sending as the booking bot, starting/ending jobs.
 *   TelegramAuth.gs Phase 1 only records signatures, so nothing stopped those calls.
 *
 * [Who counts as staff]
 *   (a) Telegram mini app: initData verified by verifyTelegramInitData_ (TelegramAuth.gs),
 *       not older than STAFF_AUTH_MAX_AGE_SEC (default 24h, same as v7-operations FieldLink.gs), and the user is
 *         - an active row of the staff master (v7-operations spreadsheet 'スタッフマスター', 有効=TRUE,
 *           spreadsheet id = ScriptProperty OPERATIONS_SPREADSHEET_ID — same value as in v7-operations), or
 *         - a member of the admin group (isAdminGroupMember_ in PartnerSelfRegister.gs).
 *   (b) Field app home-screen link (PWA, no Telegram): `_fu` (chatId) + `_fk` (key), attached by tg-auth.js.
 *       The key must equal v7-operations FieldLink.gs fieldLinkKey_(chatId), so ScriptProperty
 *       FIELD_LINK_SECRET here must be the same value as in v7-operations.
 *       !! When FIELD_LINK_SECRET is replaced or deleted in v7-operations, do the same here at the same time,
 *          otherwise revoked links keep working in v7 and new links are rejected.
 *       `_fu` must also be active staff.
 *
 * [Mode] ScriptProperty TG_AUTH_MODE (the Phase 2 switch named in TelegramAuth.gs)
 *   - 'audit' (default / missing): never blocks. Records what would have been blocked.
 *   - 'enforce': staff-only actions without a staff identity get AUTH_REQUIRED (retryable:false).
 *   - If the property cannot be read, the last known mode is used; with nothing known it fails closed (enforce).
 *   - ScriptProperty STAFF_GATE_ENFORCE_ACTIONS (comma list, optional): enforce only these actions while
 *     TG_AUTH_MODE is still audit (e.g. chat_send,chat_history, which only the Telegram job manager calls).
 *   Rollback = set TG_AUTH_MODE back to 'audit' and clear STAFF_GATE_ENFORCE_ACTIONS (no redeploy needed).
 *   View the record: run showStaffGateAudit() in the Apps Script editor (not exposed on the web).
 *
 * NOTE: v7 only. TelegramAuth.gs must stay identical in v7/ and v7-operations/, so this file does not touch it.
 */

var STAFF_ONLY_ACTIONS_ = {
  booking_today: 1, field_partner_shops: 1, manual_campaign_list: 1,
  job_start: 1, job_start_photos: 1, job_end: 1, job: 1,
  chat_history: 1, chat_send: 1,
  manual_campaign_create: 1, manual_campaign_settle: 1, manual_campaign_sale: 1
};

var STAFF_GATE_AUDIT_PREFIX_ = 'STAFF_GATE_AUDIT_';
var STAFF_GATE_AUDIT_KEEP_DAYS_ = 7;
var STAFF_GATE_AUDIT_MAX_FAILS_ = 30;
var STAFF_GATE_DEFAULT_MAX_AGE_SEC_ = 24 * 3600;
var STAFF_GATE_CLOCK_SKEW_SEC_ = 300;
var STAFF_GATE_IDS_CACHE_SEC_ = 600;
var STAFF_GATE_IDS_LKG_SEC_ = 6 * 3600;          // last known good list, used only while the sheet cannot be read
var STAFF_GATE_ANON_SAMPLE_SEC_ = 10;            // anonymous denials are recorded at most once per 10s per action

function isStaffOnlyAction_(action) {
  return Object.prototype.hasOwnProperty.call(STAFF_ONLY_ACTIONS_, String(action || ''));
}

/** true = block callers without a staff identity for this action. */
function staffGateEnforced_(action) {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { /* ignore */ }
  try {
    var props = PropertiesService.getScriptProperties();
    var on = String(props.getProperty('TG_AUTH_MODE') || '').trim().toLowerCase() === 'enforce';
    var list = String(props.getProperty('STAFF_GATE_ENFORCE_ACTIONS') || '');
    if (cache) cache.put('staff_gate_mode', JSON.stringify({ on: on, list: list }), 21600);
    return on || staffGateInList_(list, action);
  } catch (err) {
    // fail closed: use the last known mode, or block when nothing is known
    try {
      var m = cache ? JSON.parse(cache.get('staff_gate_mode') || 'null') : null;
      if (m) return !!m.on || staffGateInList_(m.list, action);
    } catch (e2) { /* ignore */ }
    return true;
  }
}

function staffGateInList_(list, action) {
  if (!list || !action) return false;
  return String(list).split(',').map(function (s) { return s.trim(); }).indexOf(String(action)) >= 0;
}

function staffGateDenied_(clientId) {
  var res = {
    status: 'error', ok: false, error: 'AUTH_REQUIRED', retryable: false,
    message: 'Staff only. Please open the app again from Telegram or your staff link.'
  };
  if (clientId) res.client_id = String(clientId);   // field/outbox.js moves the record to "review" instead of retrying
  return res;
}

/**
 * Decide whether the caller is staff, record the result, and return it. Never throws.
 * @param {string} action
 * @param {string} initData    raw Telegram initData ('' if not sent)
 * @param {string} linkChatId  `_fu` from the field app link mode
 * @param {string} linkKey     `_fk` from the field app link mode
 * @param {string} hint        extra tag for the record ('cid' = the request came with a client_id, i.e. an app outbox)
 * @return {{allowed:boolean, via:string, reason:string, userId:string}}
 */
function staffGate_(action, initData, linkChatId, linkKey, hint) {
  var res;
  try {
    res = staffGateCheck_(initData, linkChatId, linkKey);
  } catch (err) {
    Logger.log('⚠️ staffGate_: ' + err);
    res = { allowed: false, via: '', reason: 'error', userId: '' };
  }
  var channel = initData ? 'tg' : ((linkChatId || linkKey) ? 'link' : 'none');
  recordStaffGate_(action, res, channel + (hint ? '+' + hint : ''));
  return res;
}

function staffGateCheck_(initData, linkChatId, linkKey) {
  var tgReason = 'no_auth';
  var tgUser = '';
  if (initData) {
    var v = verifyTelegramInitData_(initData);
    if (!v.ok) {
      tgReason = 'tg_' + v.reason;
    } else if (!(v.ageSec >= -STAFF_GATE_CLOCK_SKEW_SEC_ && v.ageSec <= staffGateMaxAgeSec_())) {
      tgReason = 'tg_expired';
    } else {
      tgUser = String(v.userId || '');
      var ids = staffGateStaffIds_();
      if (staffGateHas_(ids, tgUser)) return { allowed: true, via: 'tg_staff', reason: '', userId: tgUser };
      if (staffGateIsAdminMember_(tgUser)) return { allowed: true, via: 'tg_admin', reason: '', userId: tgUser };
      tgReason = ids ? 'tg_not_staff' : 'staff_list_unavailable';
    }
  }

  if (linkChatId || linkKey) {
    var u = String(linkChatId || '');
    var secret = PropertiesService.getScriptProperties().getProperty('FIELD_LINK_SECRET');
    if (!secret) return { allowed: false, via: '', reason: 'link_unconfigured', userId: '' };
    if (!u || !linkKey || staffGateLinkKey_(secret, u) !== String(linkKey)) {
      return { allowed: false, via: '', reason: 'link_bad', userId: '' };
    }
    var staff = staffGateStaffIds_();
    if (!staff) return { allowed: false, via: '', reason: 'staff_list_unavailable', userId: u };
    if (!staffGateHas_(staff, u)) return { allowed: false, via: '', reason: 'link_not_staff', userId: u };
    return { allowed: true, via: 'link_staff', reason: '', userId: u };
  }

  return { allowed: false, via: '', reason: tgReason, userId: tgUser };
}

function staffGateHas_(ids, id) {
  return !!ids && !!id && Object.prototype.hasOwnProperty.call(ids, String(id));
}

function staffGateMaxAgeSec_() {
  var n = Number(PropertiesService.getScriptProperties().getProperty('STAFF_AUTH_MAX_AGE_SEC'));
  return n > 0 ? n : STAFF_GATE_DEFAULT_MAX_AGE_SEC_;
}

/** Same formula as v7-operations FieldLink.gs fieldLinkKey_ (keep them in sync). */
function staffGateLinkKey_(secret, chatId) {
  var sig = Utilities.computeHmacSha256Signature('field-link-v1:' + String(chatId), secret);
  return sig.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 24);
}

/**
 * Active staff chat IDs from the v7-operations staff master, as { chatId: true }.
 * While the sheet cannot be read, the last list read in the past 6 hours is used.
 * null = nothing usable — callers treat it as "not staff".
 */
function staffGateStaffIds_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('staff_gate_ids');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }
  var ids = staffGateReadStaffSheet_();
  if (ids) {
    var json = JSON.stringify(ids);
    cache.put('staff_gate_ids', json, STAFF_GATE_IDS_CACHE_SEC_);
    cache.put('staff_gate_ids_lkg', json, STAFF_GATE_IDS_LKG_SEC_);
    return ids;
  }
  try { return JSON.parse(cache.get('staff_gate_ids_lkg') || 'null'); } catch (e) { return null; }
}

function staffGateReadStaffSheet_() {
  var ssId = PropertiesService.getScriptProperties().getProperty('OPERATIONS_SPREADSHEET_ID');
  if (!ssId) return null;
  try {
    var sheet = SpreadsheetApp.openById(ssId).getSheetByName('スタッフマスター');
    if (!sheet) return null;
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return null;
    var head = values[0].map(function (h) { return String(h).trim(); });
    var cId = head.indexOf('Chat ID');
    var cOn = head.indexOf('有効');
    if (cId < 0 || cOn < 0) return null;
    var ids = {};
    for (var i = 1; i < values.length; i++) {
      var on = values[i][cOn];
      var id = String(values[i][cId] || '').trim();
      if (id && (on === true || String(on).toUpperCase() === 'TRUE')) ids[id] = true;
    }
    return ids;
  } catch (err) {
    Logger.log('⚠️ staffGateReadStaffSheet_: ' + err);
    return null;
  }
}

/** Admin group membership. Members are cached 30 min, non-members 2 min, unknown 30 s (treated as no). */
function staffGateIsAdminMember_(userId) {
  if (!userId) return false;
  var cache = CacheService.getScriptCache();
  var key = 'staff_gate_admin_' + userId;
  var hit = cache.get(key);
  if (hit === '1') return true;
  if (hit === '0' || hit === 'n') return false;
  var r = (typeof isAdminGroupMember_ === 'function') ? isAdminGroupMember_(userId) : null;
  cache.put(key, r === true ? '1' : (r === false ? '0' : 'n'), r === true ? 1800 : (r === false ? 120 : 30));
  return r === true;
}

function recordStaffGate_(action, res, channel) {
  try {
    // Anonymous denials (no signature, no link) are sampled so that probing cannot burn the property quota.
    if (!res.allowed && channel.indexOf('none') === 0) {
      var cache = CacheService.getScriptCache();
      var sk = 'staff_gate_anon_' + action;
      if (cache.get(sk)) return;
      cache.put(sk, '1', STAFF_GATE_ANON_SAMPLE_SEC_);
    }
    var props = PropertiesService.getScriptProperties();
    var tz = (typeof TG_AUTH_TZ_ !== 'undefined') ? TG_AUTH_TZ_ : 'Asia/Phnom_Penh';
    var key = STAFF_GATE_AUDIT_PREFIX_ + Utilities.formatDate(new Date(), tz, 'yyyyMMdd');
    var raw = props.getProperty(key);
    var data = raw ? JSON.parse(raw) : null;
    if (!data) {
      data = { counts: {}, fails: [] };
      cleanupOldStaffGateAudit_(props, tz);
    }
    var ck = action + '|' + (res.allowed ? 'ok_' + res.via : 'deny_' + res.reason) + '|' + channel;
    data.counts[ck] = (data.counts[ck] || 0) + 1;
    if (!res.allowed) {
      // time, action, reason and the last 4 digits of the user (to find a missing staff row) — never the full ID.
      // This record is only shown in the Apps Script editor (showStaffGateAudit).
      data.fails.push({
        t: Utilities.formatDate(new Date(), tz, 'HH:mm:ss'), a: action, r: res.reason, c: channel,
        u4: res.userId ? String(res.userId).slice(-4) : ''
      });
      if (data.fails.length > STAFF_GATE_AUDIT_MAX_FAILS_) data.fails = data.fails.slice(-STAFF_GATE_AUDIT_MAX_FAILS_);
    }
    props.setProperty(key, JSON.stringify(data));
  } catch (err) {
    Logger.log('⚠️ recordStaffGate_ failed (ignored): ' + err);
  }
}

function cleanupOldStaffGateAudit_(props, tz) {
  try {
    var cutoff = Utilities.formatDate(new Date(Date.now() - STAFF_GATE_AUDIT_KEEP_DAYS_ * 86400000), tz, 'yyyyMMdd');
    props.getKeys().forEach(function (k) {
      if (k.indexOf(STAFF_GATE_AUDIT_PREFIX_) === 0 && k.substring(STAFF_GATE_AUDIT_PREFIX_.length) < cutoff) {
        props.deleteProperty(k);
      }
    });
  } catch (e) { /* ignore */ }
}

/** Summary of the last `days` days (run from the Apps Script editor; not exposed on the web). */
function staffGateAuditSummary_(days) {
  var n = Math.min(Math.max(Number(days || 7), 1), STAFF_GATE_AUDIT_KEEP_DAYS_);
  var props = PropertiesService.getScriptProperties();
  var tz = (typeof TG_AUTH_TZ_ !== 'undefined') ? TG_AUTH_TZ_ : 'Asia/Phnom_Penh';
  var out = [];
  for (var i = 0; i < n; i++) {
    var d = Utilities.formatDate(new Date(Date.now() - i * 86400000), tz, 'yyyyMMdd');
    var raw = props.getProperty(STAFF_GATE_AUDIT_PREFIX_ + d);
    if (raw) out.push({ date: d, data: JSON.parse(raw) });
  }
  var sheetIds = staffGateReadStaffSheet_();
  return {
    mode: String(props.getProperty('TG_AUTH_MODE') || 'audit'),
    enforceActions: String(props.getProperty('STAFF_GATE_ENFORCE_ACTIONS') || ''),
    staffSheetReadable: !!sheetIds,
    activeStaffCount: sheetIds ? Object.keys(sheetIds).length : 0,
    fieldLinkConfigured: !!props.getProperty('FIELD_LINK_SECRET'),
    days: out
  };
}

/** Run this in the Apps Script editor to see the record (Logger). */
function showStaffGateAudit() {
  Logger.log(JSON.stringify(staffGateAuditSummary_(7), null, 2));
}
