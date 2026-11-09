/**
 * TgRelay.gs — Telegram の受付を Supabase に置いて、Bot の返事を「最大1分待ち」から「数秒」にする（2026-11-09）
 *
 * Daisuke「予約の部分もサクサク動くようにしたい」→ 段階①（データはシートのまま・受け取り方だけ替える）
 *
 * しくみ:
 *   今まで: GAS が1分ごとに Telegram へ「新着ある？」と聞きに行く（BotPoller.gs）→ 返事まで最大60秒待ち
 *   これから: Telegram が届いた瞬間に Supabase の受付（supabase/functions/tg-relay）へ送る
 *             → 受付がすぐ GAS の doPost（action=tg_relay）でキューに積み、続けて tg_drain でその場で処理させる
 *   キュー・処理済み一覧・各 Bot の処理（handleBookingBotUpdate 等）は今までと同じものを使う。
 *
 * Bot ごとに「受付（relay）」か「1分ごと（poll）」かを切り替える。切り替えは GAS エディタで:
 *   tgRelayEnableBooking()  … 予約Bot を受付に（Telegram に webhook を登録）
 *   tgRelayDisableBooking() … 予約Bot を1分ごとに戻す（webhook を外す。届いていない分は残る）
 *   tgRelayStatus()         … 今の状態を見る
 *   （業務Bot も同じ形の …Field を用意。まずは予約Bot だけで始める）
 *
 * 自動で戻す見張り（pollTelegramUpdates から毎分呼ぶ。中で間引く）:
 *   - 5分ごとに Telegram の webhook の状態を見る。登録先がずれていたらすぐ、前回より新しい配達の失敗があって
 *     未配達が残る、が2回続いたら、その Bot を1分ごとに戻して管理グループに知らせる（未配達は1分ごとで拾う）
 *   - 1時間ごとに受付の health を呼ぶ（受付が Supabase の表に1行書き、GAS の tg_ping まで届くか確かめる
 *     ＝予約がゼロの週でも「7日使わないと止まる」にかからない）。2回続けて失敗したら同じく1分ごとに戻す
 *   - Telegram が webhook を外せなかった時は relay のまま残し、毎分やり直す（外せないまま poll にすると誰も受け取らない）
 *   - 戻ったあと受付に戻すのは人の判断（tgRelayEnableBooking を実行）
 *
 * 設定（Script Properties・3つ。揃っていなければこの仕組みは丸ごと止まり、今までどおり1分ごと）:
 *   TG_RELAY_URL       https://<project>.supabase.co/functions/v1/tg-relay
 *   TG_RELAY_KEY       GAS と受付の合言葉（24文字以上。受付の GAS_RELAY_KEY と同じ値）
 *   TG_WEBHOOK_SECRET  Telegram と受付の合言葉（24〜256文字・英数字と _ - だけ。受付の TG_WEBHOOK_SECRET と同じ値）
 * 状態（Script Properties・1つ）: tg_relay_state_v1 = {"booking":"relay"|"poll", "field":…, "pendingFallback":{bot:理由}}
 *
 * 手順: docs/TG_RELAY_SUPABASE.md
 */

var TG_RELAY_STATE_KEY_ = 'tg_relay_state_v1';
var TG_RELAY_WATCH_EVERY_SEC_ = 5 * 60;   // webhook の状態を見る間隔
var TG_RELAY_PING_EVERY_SEC_ = 60 * 60;   // 受付の health を呼ぶ間隔
var TG_RELAY_ERROR_WINDOW_SEC_ = 10 * 60; // この時間内に配達の失敗があれば「怪しい」
var TG_RELAY_LOG_ = '📡 TgRelay: ';

// ====== 設定と状態 ======

/** 設定（3つ揃っていなければ null = 仕組みを止める） */
function tgRelayConfig_() {
  try {
    var p = PropertiesService.getScriptProperties();
    var url = String(p.getProperty('TG_RELAY_URL') || '').trim().replace(/\/+$/, '');
    var key = String(p.getProperty('TG_RELAY_KEY') || '').trim();
    var secret = String(p.getProperty('TG_WEBHOOK_SECRET') || '').trim();
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/functions\/v1\/[a-z0-9_-]+$/.test(url)) return null;
    if (key.length < 24) return null;
    if (!/^[A-Za-z0-9_-]{24,256}$/.test(secret)) return null;
    return { url: url, key: key, secret: secret };
  } catch (e) {
    Logger.log(TG_RELAY_LOG_ + 'config ' + e);
    return null;
  }
}

function tgRelayState_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(TG_RELAY_STATE_KEY_);
    var s = raw ? JSON.parse(raw) : {};
    return (s && typeof s === 'object') ? s : {};
  } catch (e) {
    return {};
  }
}

function tgRelaySetMode_(botType, mode) {
  var s = tgRelayState_();
  s[botType] = mode;
  PropertiesService.getScriptProperties().setProperty(TG_RELAY_STATE_KEY_, JSON.stringify(s));
}

function tgRelayValidBot_(botType) {
  return botType === BOT_TYPE.BOOKING || botType === BOT_TYPE.FIELD;
}

/** その Bot は受付で受けているか（設定が揃っていて、状態が relay の時だけ true） */
function tgRelayIsOn_(botType) {
  return tgRelayState_()[botType] === 'relay' && !!tgRelayConfig_();
}

function tgRelayWebhookUrl_(cfg, botType) {
  return cfg.url + '?bot=' + encodeURIComponent(botType);
}

/** 長さが同じでも全部比べる（合言葉の当て推量で時間差を出さない） */
function tgRelaySafeEqual_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ====== doPost から（受付が呼ぶ） ======

/**
 * action=tg_relay: 受付が受けた Telegram の update をキューに積むだけ（重い処理はしない＝すぐ返す）
 * @return {{ok:boolean, message?:string, duplicate?:boolean}}
 */
function apiTgRelay_(body) {
  var cfg = tgRelayConfig_();
  if (!cfg || !body || !tgRelaySafeEqual_(body.relayKey, cfg.key)) return { ok: false, message: 'FORBIDDEN' };
  var botType = String(body.botType || '');
  if (!tgRelayValidBot_(botType)) return { ok: false, message: 'BAD_BOT' };
  var update = body.update;
  if (!update || typeof update !== 'object' || !isFinite(update.update_id) || Math.floor(update.update_id) !== update.update_id) {
    return { ok: false, message: 'BAD_UPDATE' };
  }
  if (loadProcessedIds_(null).indexOf(String(update.update_id)) >= 0) return { ok: true, duplicate: true };
  // 受付が GAS の返事を待ちきれず Telegram が送り直した時、同じものがまだキューにあれば積まない
  var suffix = '_' + update.update_id;
  var all = PropertiesService.getScriptProperties().getProperties();
  var queued = Object.keys(all).some(function(k) {
    if (k.indexOf(STORAGE_KEYS.QUEUE_PREFIX) !== 0 || k.slice(-suffix.length) !== suffix) return false;
    try { return JSON.parse(all[k]).botType === botType; } catch (e) { return false; }
  });
  if (queued) return { ok: true, duplicate: true };
  enqueueTelegramUpdate(update, botType);
  return { ok: true };
}

/** action=tg_ping: 受付の health から呼ばれる。合言葉と、この版の GAS が受付を知っていることだけ確かめる */
function apiTgPing_(body) {
  var cfg = tgRelayConfig_();
  if (!cfg || !body || !tgRelaySafeEqual_(body.relayKey, cfg.key)) return { ok: false, message: 'FORBIDDEN' };
  return { ok: true };
}

/** action=tg_drain: キューをその場で処理する（先に別の処理が動いていれば、終わるのを少し待つ） */
function apiTgDrain_(body) {
  var cfg = tgRelayConfig_();
  if (!cfg || !body || !tgRelaySafeEqual_(body.relayKey, cfg.key)) return { ok: false, message: 'FORBIDDEN' };
  var ran = processTelegramQueueLocked_(25 * 1000);
  return { ok: true, ran: ran };
}

// ====== 見張り（pollTelegramUpdates から毎分呼ぶ・中で間引く） ======

function tgRelayDue_(cacheKey, everySec) {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get(cacheKey)) return false;
    cache.put(cacheKey, '1', everySec);
    return true;
  } catch (e) {
    return false;   // Cache が使えない時は見張りを休む（業務は止めない）
  }
}

/** 「怪しい」が2回続いたか（1回目は印を付けるだけ） */
function tgRelayStrike_(name, bad) {
  var cache;
  try { cache = CacheService.getScriptCache(); } catch (e) { return false; }
  var k = 'tg_relay_strike_' + name;
  if (!bad) { try { cache.remove(k); } catch (ignore) {} return false; }
  if (cache.get(k)) { try { cache.remove(k); } catch (ignore) {} return true; }
  cache.put(k, '1', 3 * 3600);
  return false;
}

function tgRelayWatch_() {
  var state = tgRelayState_();
  var cfg = tgRelayConfig_();

  // 戻しが失敗して残っている時は、毎分やり直す（webhook が残ったままだと1分ごとの受け取りもできないため）
  [BOT_TYPE.BOOKING, BOT_TYPE.FIELD].forEach(function(b) {
    var pending = tgRelayPendingFallback_(b);
    if (pending) tgRelayFallback_(b, pending);
  });
  state = tgRelayState_();

  var relayBots = [BOT_TYPE.BOOKING, BOT_TYPE.FIELD].filter(function(b) { return state[b] === 'relay'; });
  if (relayBots.length === 0) return;

  if (!cfg) {
    // 設定が消された（＝止めたい時の非常口）→ 1分ごとに戻す
    relayBots.forEach(function(b) { tgRelayFallback_(b, '受付の設定（Script Properties）が見つかりません'); });
    return;
  }

  if (!tgRelayDue_('tg_relay_watch_at', TG_RELAY_WATCH_EVERY_SEC_)) return;
  relayBots.forEach(function(botType) {
    var info = getWebhookInfo(botType);
    if (!info || !info.ok || !info.result) return;   // Telegram に聞けない時は何もしない（判断材料がない）
    var r = info.result;
    if (String(r.url || '') !== tgRelayWebhookUrl_(cfg, botType)) {
      // 登録先がずれている間は誰も受け取らないので、すぐ戻す
      tgRelayFallback_(botType, 'Telegram に登録された受付の場所が違います（' + (r.url ? 'ほかの場所' : '未登録') + '）');
      return;
    }
    // 前回見た時より新しい配達の失敗があり、未配達が残っている時だけ「怪しい」（last_error_date は成功しても消えないため）
    var prevErr = tgRelayLastErr_(botType);
    var errDate = Number(r.last_error_date || 0);
    var isNew = errDate > 0 && (prevErr ? errDate > prevErr : (Date.now() / 1000 - errDate) < TG_RELAY_ERROR_WINDOW_SEC_);
    tgRelaySetLastErr_(botType, errDate);
    var reason = (isNew && (r.pending_update_count || 0) > 0)
      ? '受付への配達に失敗しています（未配達 ' + r.pending_update_count + ' 件・' + String(r.last_error_message || '').substring(0, 120) + '）'
      : '';
    if (tgRelayStrike_('wh_' + botType, !!reason)) tgRelayFallback_(botType, reason);
    else if (reason) Logger.log(TG_RELAY_LOG_ + botType + ' 怪しい(1回目): ' + reason);
  });
}

/** 1時間に1回、受付の health を呼ぶ（受付が Supabase の表に1行書き、GAS まで届くかも確かめる）。1分ごとの受け取りの後に呼ぶ */
function tgRelayPingWatch_() {
  var state = tgRelayState_();
  var relayBots = [BOT_TYPE.BOOKING, BOT_TYPE.FIELD].filter(function(b) { return state[b] === 'relay'; });
  var cfg = tgRelayConfig_();
  if (relayBots.length === 0 || !cfg) return;
  if (!tgRelayDue_('tg_relay_ping_at', TG_RELAY_PING_EVERY_SEC_)) return;
  var ping = tgRelayPing_(cfg);
  if (tgRelayStrike_('ping', !ping.ok)) {
    relayBots.forEach(function(b) {
      tgRelayFallback_(b, '受付の見回り（health）が2回続けて失敗しました（' + ping.detail + '）');
    });
  }
}

function tgRelayLastErr_(botType) {
  try { return Number(CacheService.getScriptCache().get('tg_relay_lasterr_' + botType) || 0); } catch (e) { return 0; }
}
function tgRelaySetLastErr_(botType, errDate) {
  try { CacheService.getScriptCache().put('tg_relay_lasterr_' + botType, String(errDate || 0), 6 * 3600); } catch (e) {}
}

/** 戻しに失敗した Bot の理由（Script Properties に残す＝消えない）。無ければ '' */
function tgRelayPendingFallback_(botType) {
  var s = tgRelayState_();
  return (s.pendingFallback && s.pendingFallback[botType]) || '';
}

/** 受付の health を呼ぶ。受付は Supabase の表に1行書いて { ok:true, db:true } を返す */
function tgRelayPing_(cfg) {
  try {
    var res = UrlFetchApp.fetch(cfg.url, {
      method: 'get', headers: { 'x-relay-key': cfg.key }, muteHttpExceptions: true, followRedirects: true
    });
    var code = res.getResponseCode();
    var data = null;
    try { data = JSON.parse(res.getContentText()); } catch (ignore) {}
    // gas=true: 受付から GAS（この版）まで合言葉つきで届いた。db=true: Supabase の表に書けた
    var ok = code === 200 && !!data && data.ok === true && data.gas === true;
    if (ok && data.db !== true) Logger.log(TG_RELAY_LOG_ + 'health OK だが表に書けていない（relay_heartbeat を確認）');
    return { ok: ok, detail: 'HTTP ' + code + (data && data.gas === false ? '・受付から GAS に届かない（GAS_EXEC_URL・合言葉・GAS の版を確認）' : '') +
      (data && data.db === false ? '・表に書けず' : '') };
  } catch (e) {
    return { ok: false, detail: String(e).substring(0, 120) };
  }
}

/**
 * 受付をやめて1分ごとに戻す（未配達の分は消さない＝1分ごとの方で拾う）。管理グループに知らせる。
 * Telegram が webhook を外せなかった時は relay のまま残し、次の1分でやり直す（poll にして webhook が残ると誰も受け取らない）
 */
function tgRelayFallback_(botType, reason) {
  var del = callTelegramApi(botType, 'deleteWebhook', { drop_pending_updates: false });
  var s = tgRelayState_();
  s.pendingFallback = s.pendingFallback || {};
  if (!del || !del.ok) {
    var first = !s.pendingFallback[botType];
    s.pendingFallback[botType] = reason;
    PropertiesService.getScriptProperties().setProperty(TG_RELAY_STATE_KEY_, JSON.stringify(s));
    Logger.log(TG_RELAY_LOG_ + botType + ' webhook を外せなかった（次の1分でやり直す）: ' + JSON.stringify(del));
    if (first) tgRelayNotify_(botType, '⚠️ ' + tgRelayBotName_(botType) + 'の受付（Supabase）に問題があり、1分ごとに戻そうとしていますが、Telegram が応じません。毎分やり直しています。\n理由: ' + reason);
    return false;
  }
  delete s.pendingFallback[botType];
  s[botType] = 'poll';
  PropertiesService.getScriptProperties().setProperty(TG_RELAY_STATE_KEY_, JSON.stringify(s));
  Logger.log(TG_RELAY_LOG_ + botType + ' → 1分ごとに戻した: ' + reason);
  tgRelayNotify_(botType,
    '⚠️ ' + tgRelayBotName_(botType) + 'の受付（Supabase）を止めて、1分ごとの受け取りに戻しました\n' +
    '理由: ' + reason + '\n' +
    'お客様のメッセージは Telegram が預かっているので、通常は消えません（返事が最大1分遅れるだけです）。\n' +
    '直したら GAS エディタで ' + (botType === BOT_TYPE.BOOKING ? 'tgRelayEnableBooking' : 'tgRelayEnableField') + ' を実行すると受付に戻ります。');
  return true;
}

function tgRelayBotName_(botType) { return botType === BOT_TYPE.BOOKING ? '予約Bot' : '業務Bot'; }

function tgRelayNotify_(botType, text) {
  try {
    sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId, text);
  } catch (e) {
    Logger.log(TG_RELAY_LOG_ + '管理グループへの通知に失敗: ' + e);
  }
}

// ====== GAS エディタから実行する ======

function tgRelayEnable_(botType) {
  if (!tgRelayValidBot_(botType)) throw new Error('botType が違います: ' + botType);
  var cfg = tgRelayConfig_();
  if (!cfg) throw new Error('Script Properties の TG_RELAY_URL / TG_RELAY_KEY / TG_WEBHOOK_SECRET が揃っていません（docs/TG_RELAY_SUPABASE.md）');
  var ping = tgRelayPing_(cfg);
  if (!ping.ok) throw new Error('受付の health が通りません（' + ping.detail + '）。Supabase の Secrets と関数の設定を確認してください');
  var res = callTelegramApi(botType, 'setWebhook', {
    url: tgRelayWebhookUrl_(cfg, botType),
    secret_token: cfg.secret,
    drop_pending_updates: false,
    max_connections: 1   // 1件ずつ順番に届ける（同じお客様の会話の順番を守る）
  });
  if (!res || !res.ok) throw new Error('setWebhook に失敗: ' + JSON.stringify(res));
  var info = getWebhookInfo(botType);
  tgRelaySetLastErr_(botType, (info && info.result && info.result.last_error_date) || 0);   // 切り替える前の古い失敗は数えない
  tgRelaySetMode_(botType, 'relay');
  try { CacheService.getScriptCache().removeAll(['tg_relay_strike_wh_' + botType, 'tg_relay_strike_ping']); } catch (ignore) {}
  Logger.log('✅ ' + botType + ' を受付（Supabase）に切り替えました。Bot にメッセージを送って、数秒で返事が来るか確かめてください');
  tgRelayStatus();
}

function tgRelayDisable_(botType) {
  if (!tgRelayValidBot_(botType)) throw new Error('botType が違います: ' + botType);
  var res = callTelegramApi(botType, 'deleteWebhook', { drop_pending_updates: false });
  if (!res || !res.ok) throw new Error('deleteWebhook に失敗しました（もう一度実行してください）: ' + JSON.stringify(res));
  var s = tgRelayState_();
  s[botType] = 'poll';
  if (s.pendingFallback) delete s.pendingFallback[botType];
  PropertiesService.getScriptProperties().setProperty(TG_RELAY_STATE_KEY_, JSON.stringify(s));
  Logger.log('↩️ ' + botType + ' を1分ごとに戻しました');
}

function tgRelayEnableBooking() { tgRelayEnable_(BOT_TYPE.BOOKING); }
function tgRelayDisableBooking() { tgRelayDisable_(BOT_TYPE.BOOKING); }
function tgRelayEnableField() { tgRelayEnable_(BOT_TYPE.FIELD); }
function tgRelayDisableField() { tgRelayDisable_(BOT_TYPE.FIELD); }

/** 今の状態をログに出す（合言葉は出さない） */
function tgRelayStatus() {
  var cfg = tgRelayConfig_();
  var state = tgRelayState_();
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📡 受付（Supabase）の状態');
  Logger.log('設定: ' + (cfg ? '揃っている（' + cfg.url + '）' : '未設定 → 1分ごとで動作'));
  [BOT_TYPE.BOOKING, BOT_TYPE.FIELD].forEach(function(b) {
    var info = getWebhookInfo(b);
    var r = (info && info.result) || {};
    Logger.log('[' + b + '] 受け取り方=' + (state[b] === 'relay' ? '受付' : '1分ごと') +
      ' / webhook=' + (r.url ? (cfg && r.url === tgRelayWebhookUrl_(cfg, b) ? '受付' : 'ほかの場所') : 'なし') +
      ' / 未配達=' + (r.pending_update_count || 0) +
      (r.last_error_date ? ' / 最後の失敗=' + new Date(r.last_error_date * 1000).toISOString() + ' ' + String(r.last_error_message || '') : ''));
  });
  if (cfg) Logger.log('health: ' + JSON.stringify(tgRelayPing_(cfg)));
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
