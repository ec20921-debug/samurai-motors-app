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
 *       not older than STAFF_AUTH_MAX_AGE_SEC, and the user is
 *         - an active row of the staff master (v7-operations spreadsheet 'スタッフマスター', 有効=TRUE,
 *           spreadsheet id = ScriptProperty OPERATIONS_SPREADSHEET_ID — same value as in v7-operations), or
 *         - a member of the admin group (isAdminGroupMember_ in PartnerSelfRegister.gs).
 *   (b) Field app home-screen link (PWA, no Telegram): `_fu` (chatId) + `_fk` (key).
 *       The key must equal v7-operations FieldLink.gs fieldLinkKey_(chatId), so ScriptProperty
 *       FIELD_LINK_SECRET here must be the same value as in v7-operations. `_fu` must also be active staff.
 *
 * [Mode] ScriptProperty TG_AUTH_MODE (the Phase 2 switch named in TelegramAuth.gs)
 *   - 'audit' (default / missing): never blocks. Records what would have been blocked.
 *   - 'enforce': staff-only actions without a staff identity get AUTH_REQUIRED.
 *   Rollback = set TG_AUTH_MODE back to 'audit' (no redeploy needed).
 *   View: GET ?action=staff_gate_audit[&days=7] — counts and reasons only (no user IDs).
 *
 * NOTE: v7 only. TelegramAuth.gs must stay identical in v7/ and v7-operations/, so this file does not touch it.
 */

var STAFF_ONLY_ACTIONS_ = {
  booking_today: 1, field_partner_shops: 1, manual_campaign_list: 1,
  job_start: 1, job_end: 1, job: 1,
  chat_history: 1, chat_send: 1,
  manual_campaign_create: 1, manual_campaign_settle: 1, manual_campaign_sale: 1
};

var STAFF_GATE_AUDIT_PREFIX_ = 'STAFF_GATE_AUDIT_';
var STAFF_GATE_AUDIT_KEEP_DAYS_ = 14;
var STAFF_GATE_AUDIT_MAX_FAILS_ = 20;
var STAFF_GATE_DEFAULT_MAX_AGE_SEC_ = 7 * 86400;   // a field shift can keep the mini app open; replay is limited to a week
var STAFF_GATE_IDS_CACHE_SEC_ = 600;
var STAFF_GATE_ADMIN_CACHE_SEC_ = 6 * 3600;

function isStaffOnlyAction_(action) {
  return STAFF_ONLY_ACTIONS_.hasOwnProperty(String(action || ''));
}

function staffGateEnforced_() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty('TG_AUTH_MODE') || '').toLowerCase() === 'enforce';
  } catch (e) {
    return false;
  }
}

function staffGateDenied_() {
  return {
    status: 'error', ok: false, error: 'AUTH_REQUIRED',
    message: 'Staff only. Please open the app from Telegram or your staff link.'
  };
}

/**
 * Decide whether the caller is staff, record the result, and return it. Never throws.
 * @param {string} action
 * @param {string} initData  raw Telegram initData ('' if not sent)
 * @param {string} linkChatId  `_fu` from the field app link mode
 * @param {string} linkKey     `_fk` from the field app link mode
 * @return {{allowed:boolean, via:string, reason:string}}
 */
function staffGate_(action, initData, linkChatId, linkKey) {
  var res = { allowed: false, via: '', reason: '' };
  try {
    res = staffGateCheck_(initData, linkChatId, linkKey);
  } catch (err) {
    Logger.log('⚠️ staffGate_: ' + err);
    res = { allowed: false, via: '', reason: 'error' };
  }
  recordStaffGate_(action, res);
  return res;
}

function staffGateCheck_(initData, linkChatId, linkKey) {
  var tgReason = 'no_auth';
  if (initData) {
    var v = verifyTelegramInitData_(initData);
    if (!v.ok) {
      tgReason = 'tg_' + v.reason;
    } else if (!(v.ageSec >= 0 && v.ageSec <= staffGateMaxAgeSec_())) {
      tgReason = 'tg_expired';
    } else {
      var ids = staffGateStaffIds_();
      if (ids && ids[v.userId]) return { allowed: true, via: 'tg_staff', reason: '' };
      if (staffGateIsAdminMember_(v.userId)) return { allowed: true, via: 'tg_admin', reason: '' };
      tgReason = ids ? 'tg_not_staff' : 'staff_list_unavailable';
    }
  }

  if (linkChatId || linkKey) {
    var secret = PropertiesService.getScriptProperties().getProperty('FIELD_LINK_SECRET');
    if (!secret) return { allowed: false, via: '', reason: 'link_unconfigured' };
    if (!linkChatId || !linkKey || staffGateLinkKey_(secret, linkChatId) !== String(linkKey)) {
      return { allowed: false, via: '', reason: 'link_bad' };
    }
    var staff = staffGateStaffIds_();
    if (!staff) return { allowed: false, via: '', reason: 'staff_list_unavailable' };
    if (!staff[String(linkChatId)]) return { allowed: false, via: '', reason: 'link_not_staff' };
    return { allowed: true, via: 'link_staff', reason: '' };
  }

  return { allowed: false, via: '', reason: tgReason };
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
 * null = cannot read (property missing / sheet missing / error) — callers treat it as "not staff".
 */
function staffGateStaffIds_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('staff_gate_ids');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }
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
    cache.put('staff_gate_ids', JSON.stringify(ids), STAFF_GATE_IDS_CACHE_SEC_);
    return ids;
  } catch (err) {
    Logger.log('⚠️ staffGateStaffIds_: ' + err);
    return null;
  }
}

/** Admin group membership, cached per user (unknown results are not cached). */
function staffGateIsAdminMember_(userId) {
  if (!userId) return false;
  var cache = CacheService.getScriptCache();
  var key = 'staff_gate_admin_' + userId;
  var hit = cache.get(key);
  if (hit === '1') return true;
  if (hit === '0') return false;
  var r = (typeof isAdminGroupMember_ === 'function') ? isAdminGroupMember_(userId) : null;
  if (r === true || r === false) cache.put(key, r ? '1' : '0', STAFF_GATE_ADMIN_CACHE_SEC_);
  return r === true;
}

function recordStaffGate_(action, res) {
  try {
    var props = PropertiesService.getScriptProperties();
    var tz = (typeof TG_AUTH_TZ_ !== 'undefined') ? TG_AUTH_TZ_ : 'Asia/Phnom_Penh';
    var key = STAFF_GATE_AUDIT_PREFIX_ + Utilities.formatDate(new Date(), tz, 'yyyyMMdd');
    var raw = props.getProperty(key);
    var data = raw ? JSON.parse(raw) : null;
    if (!data) {
      data = { counts: {}, fails: [] };
      cleanupOldStaffGateAudit_(props, tz);
    }
    var ck = action + '|' + (res.allowed ? 'ok_' + res.via : 'deny_' + res.reason);
    data.counts[ck] = (data.counts[ck] || 0) + 1;
    if (!res.allowed) {
      // time, action and reason only (no user IDs)
      data.fails.push({ t: Utilities.formatDate(new Date(), tz, 'HH:mm:ss'), a: action, r: res.reason });
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

/** GET ?action=staff_gate_audit[&days=7] — daily summaries (no user IDs) */
function apiStaffGateAudit_(params) {
  var days = Math.min(Math.max(Number((params && params.days) || 7), 1), STAFF_GATE_AUDIT_KEEP_DAYS_);
  var props = PropertiesService.getScriptProperties();
  var tz = (typeof TG_AUTH_TZ_ !== 'undefined') ? TG_AUTH_TZ_ : 'Asia/Phnom_Penh';
  var out = [];
  for (var i = 0; i < days; i++) {
    var d = Utilities.formatDate(new Date(Date.now() - i * 86400000), tz, 'yyyyMMdd');
    var raw = props.getProperty(STAFF_GATE_AUDIT_PREFIX_ + d);
    if (raw) out.push({ date: d, data: JSON.parse(raw) });
  }
  return {
    ok: true, status: 'ok',
    mode: staffGateEnforced_() ? 'enforce' : 'audit',
    configured: {
      staffList: !!props.getProperty('OPERATIONS_SPREADSHEET_ID'),
      fieldLink: !!props.getProperty('FIELD_LINK_SECRET')
    },
    days: out
  };
}
