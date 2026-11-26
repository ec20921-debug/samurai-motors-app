/**
 * SystemAlert.gs — システムの異常を管理グループへ知らせる（2026-11-26）
 *
 * 【きっかけ】
 *   2026-11-26、予約カレンダーが実行アカウントの一覧から外れ、予約アプリの時間の枠に
 *   CALENDAR_NOT_FOUND が出た。お客さんの画面でしか分からず、気づくのが遅れた。
 *
 * 【やること】
 *   1. systemAlert_          : 異常を管理グループへ1通（同じ異常は1時間に1回まで）
 *   2. systemAlertException_ : ミニアプリの入口（doGet / doPost）で落ちた時に知らせる
 *   3. systemHealthWatch_    : 5分ごとの見回り（v7 のみ・pollTelegramUpdates から呼ぶ）
 *                              予約カレンダー / スプレッドシート / キューの滞留 / 常設トリガー
 *   4. 見回りで直ったと分かったら「復旧しました」を1通
 *
 * 【ルール】
 *   - ここの関数は例外を外へ出さない（知らせる側が業務を止めない）
 *   - 通知の間引き・「異常中」の印は CacheService（消えても通知が1通増える／復旧の知らせが出ないだけ）
 *   - エラー文に Bot のトークンが混ざることがあるので、送る前に必ず伏せる（sysAlertSafe_）
 *   - このファイルは v7/ と v7-operations/ に同じ内容で置く（tests/system_alert.test.js が同一を確かめる）
 */

var SYS_ALERT_REPEAT_SEC_ = 3600;        // 同じ異常の通知は1時間に1回まで
var SYS_ALERT_OPEN_SEC_ = 21600;         // 「異常中」の印（CacheService の上限＝6時間）
var SYS_HEALTH_EVERY_SEC_ = 300;         // 見回りの間隔（5分）
var SYS_QUEUE_STUCK_MIN_ = 10;           // キューの先頭がこの分数を超えて残っていたら「止まっている」
var SYS_REQUIRED_TRIGGERS_ = ['pollTelegramUpdates', 'processTelegramQueue', 'checkUnpaidReminders', 'cleanupOldProcessedIds'];
var SYS_ALERT_LOG_ = '🚨 SystemAlert: ';

/** 通知に使う Bot（v7＝予約Bot / v7-operations＝勤務Bot。どちらも管理グループに入っている） */
function sysAlertBot_() {
  if (typeof BOT_TYPE === 'undefined' || !BOT_TYPE) return '';
  return BOT_TYPE.BOOKING || BOT_TYPE.INTERNAL || '';
}

function sysAlertProjectName_() {
  return (typeof BOT_TYPE !== 'undefined' && BOT_TYPE && BOT_TYPE.BOOKING)
    ? '顧客対応（予約・現場アプリ・Bot）' : '社内業務（日報・勤怠・経費）';
}

/** トークン・合言葉を伏せ、長さを切る */
function sysAlertSafe_(s, max) {
  var t = String(s === null || s === undefined ? '' : s)
    .replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot***')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{30,}/g, '***')
    .replace(/((?:key|token|secret|password)=)[^&\s]+/gi, '$1***');
  max = max || 200;
  return t.length > max ? t.substring(0, max) + '…' : t;
}

function sysAlertKey_(prefix, code) {
  return (prefix + String(code).replace(/[^A-Za-z0-9_.:-]/g, '_')).substring(0, 200);
}

/**
 * 異常を管理グループへ知らせる
 *
 * @param {string} code   - 異常の種類（間引きの単位）
 * @param {string} title  - 何が起きているか（日本語・1行）
 * @param {string} detail - 影響・エラーの中身
 * @param {string} hint   - 対処（空でもよい）
 * @param {Object} [opts] - { track: true } で「異常中」の印を付ける（見回りが直ったと分かった時に復旧を知らせる）
 * @return {boolean} 送ったら true（間引いた・送れなかった時は false）
 */
function systemAlert_(code, title, detail, hint, opts) {
  try {
    var cache = CacheService.getScriptCache();
    var key = sysAlertKey_('sys_alert_', code);
    if (opts && opts.track) cache.put(sysAlertKey_('sys_alert_open_', code), '1', SYS_ALERT_OPEN_SEC_);
    if (cache.get(key)) return false;
    cache.put(key, '1', SYS_ALERT_REPEAT_SEC_);

    var text = '🚨 システムの異常を検知しました\n' +
      '■ ' + sysAlertSafe_(title, 120) + '\n' +
      (detail ? sysAlertSafe_(detail, 400) + '\n' : '') +
      (hint ? '\n対処: ' + sysAlertSafe_(hint, 400) + '\n' : '') +
      '\n系統: ' + sysAlertProjectName_() + '\n' +
      '（同じ異常の通知は1時間に1回までです）';
    Logger.log(SYS_ALERT_LOG_ + code + ' / ' + sysAlertSafe_(title, 120) + ' / ' + sysAlertSafe_(detail, 400));
    var res = sendMessage(sysAlertBot_(), getConfig().adminGroupId, text);
    if (!res || !res.ok) {
      cache.remove(key);   // 送れなかった時は次の機会にもう一度
      return false;
    }
    return true;
  } catch (e) {
    try { Logger.log(SYS_ALERT_LOG_ + '通知に失敗 code=' + code + ' err=' + sysAlertSafe_(e)); } catch (ignore) {}
    return false;
  }
}

/** 見回りで「正常」と分かった時に呼ぶ。異常中の印があれば復旧を1通知らせる */
function systemAlertClear_(code, title) {
  try {
    var cache = CacheService.getScriptCache();
    var openKey = sysAlertKey_('sys_alert_open_', code);
    if (!cache.get(openKey)) return false;
    cache.remove(openKey);
    cache.remove(sysAlertKey_('sys_alert_', code));
    cache.remove(sysAlertKey_('sys_alert_strike_', code));
    var res = sendMessage(sysAlertBot_(), getConfig().adminGroupId, '✅ 復旧しました\n■ ' + sysAlertSafe_(title, 120));
    return !!(res && res.ok);
  } catch (e) {
    try { Logger.log(SYS_ALERT_LOG_ + '復旧の通知に失敗 code=' + code + ' err=' + sysAlertSafe_(e)); } catch (ignore) {}
    return false;
  }
}

/** action → どの画面の話か（管理者向けの呼び名） */
function sysAlertScreenName_(action) {
  var a = String(action || '');
  if (a.indexOf('booking_today') === 0) return '現場アプリ（今日・明日の予約）';
  if (a.indexOf('booking_') === 0) return '予約アプリ（お客さんの画面）';
  if (a.indexOf('job') === 0 || a.indexOf('chat_') === 0 || a.indexOf('field_') === 0 ||
      a.indexOf('manual_campaign_') === 0 || a === 'menu_prices') return '現場アプリ（スタッフの画面）';
  if (a.indexOf('tg_') === 0) return 'Bot の受付';
  return 'ミニアプリ';
}

/**
 * ミニアプリの入口（doGet / doPost）で落ちた時に知らせる。action が無い呼び出し（外からの迷い込み）は知らせない
 */
function systemAlertException_(where, action, err) {
  try {
    var a = String(action || '');
    if (!a) return false;
    return systemAlert_('ex_' + where + '_' + a,
      sysAlertScreenName_(a) + 'でエラーが出ました',
      '操作: ' + a + '\nエラー: ' + sysAlertSafe_(err, 300),
      '同じ操作をもう一度試して、続くようなら Claude にこの通知を見せてください。');
  } catch (e) {
    return false;
  }
}

/** 予約カレンダーが見つからない（BookingLogic.gs getBookingCalendar_ と見回りの両方から呼ぶ） */
function systemAlertCalendarMissing_() {
  var calId = '';
  try { calId = String(getConfig().bookingCalendarId || ''); } catch (ignore) {}
  return systemAlert_('calendar', '予約カレンダーが見つかりません',
    'お客さんが予約アプリで時間を選べない状態です（画面には CALENDAR_NOT_FOUND と出ます）。' +
    '現場アプリの予定・休業日の反映・キャンペーン予約も止まります。',
    'アプリを動かしている Google アカウントのカレンダーの一覧に、予約カレンダー' + (calId ? '（' + calId + '）' : '') +
    'があるか確認してください。無ければ、予約カレンダー側の「設定と共有」で「予定の変更」の権限があるかを見て、一覧に追加し直します。',
    { track: true });
}

// ====== 見回り（v7 のみ・pollTelegramUpdates から毎分呼ぶ・中で5分に1回に間引く） ======

function sysHealthDue_() {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('sys_health_at')) return false;
    cache.put('sys_health_at', '1', SYS_HEALTH_EVERY_SEC_);
    return true;
  } catch (e) {
    return false;   // Cache が使えない時は見回りを休む（業務は止めない）
  }
}

/** 一時的な失敗で騒がないよう、2回続いた時だけ true（1回目は印だけ） */
function sysHealthStrike_(code, bad) {
  try {
    var cache = CacheService.getScriptCache();
    var k = sysAlertKey_('sys_alert_strike_', code);
    if (!bad) { cache.remove(k); return false; }
    if (cache.get(k)) return true;
    cache.put(k, '1', 3 * 3600);
    return false;
  } catch (e) {
    return false;
  }
}

/**
 * 見回りの本体。結果の一覧を返す（[{ code, ok, title }]）。5分に1回だけ動く
 */
function systemHealthWatch_() {
  if (!sysHealthDue_()) return null;
  var out = [];
  var cfg;
  try { cfg = getConfig(); } catch (e) {
    systemAlert_('config', '設定（Script Properties）が読めません', 'エラー: ' + sysAlertSafe_(e, 300),
      'GAS エディタの「プロジェクトの設定」で、必要な項目が消えていないか確認してください。', { track: true });
    return [{ code: 'config', ok: false }];
  }
  systemAlertClear_('config', '設定（Script Properties）が読めるようになりました');

  // 1. 予約カレンダー（見つからない＝一覧から外れた・共有が切れた。たまたまの失敗では起きないので1回で知らせる）
  try {
    var cal = CalendarApp.getCalendarById(cfg.bookingCalendarId);
    if (cal) systemAlertClear_('calendar', '予約カレンダーが見えるようになりました');
    else systemAlertCalendarMissing_();
    out.push({ code: 'calendar', ok: !!cal });
  } catch (e) {
    Logger.log(SYS_ALERT_LOG_ + 'カレンダーの確認ができなかった（今回は判断しない）: ' + sysAlertSafe_(e));
  }

  // 2. スプレッドシート（開けない時。Google 側の一時的な失敗があるので2回続いた時だけ）
  var sheetErr = '';
  try { SpreadsheetApp.openById(cfg.spreadsheetId).getId(); } catch (e) { sheetErr = sysAlertSafe_(e, 300); }
  if (!sheetErr) {
    sysHealthStrike_('sheet', false);
    systemAlertClear_('sheet', 'スプレッドシート（v7 Database）が開けるようになりました');
  } else if (sysHealthStrike_('sheet', true)) {
    systemAlert_('sheet', 'スプレッドシート（v7 Database）が開けません',
      '予約・作業記録・お客さんの登録ができない状態です。\nエラー: ' + sheetErr,
      'シートが削除・移動されていないか、アプリを動かしている Google アカウントに編集の権限があるか確認してください。', { track: true });
  }
  out.push({ code: 'sheet', ok: !sheetErr });

  // 3. キューの滞留（Bot に届いたメッセージが処理されずに残っている）
  try {
    var q = sysHealthQueue_(PropertiesService.getScriptProperties().getKeys(), Date.now());
    if (q.stuck) {
      systemAlert_('queue', 'Bot の返事が止まっています',
        '処理待ちのメッセージが ' + q.count + ' 件あり、いちばん古いものは ' + q.oldestMin + ' 分待っています。' +
        'お客さん・スタッフへの返事が届いていない可能性があります。',
        'GAS エディタの「実行数」で processTelegramQueue が失敗していないか確認してください。', { track: true });
    } else {
      systemAlertClear_('queue', 'Bot の返事が流れるようになりました');
    }
    out.push({ code: 'queue', ok: !q.stuck });
  } catch (e) {
    Logger.log(SYS_ALERT_LOG_ + 'キューの確認ができなかった: ' + sysAlertSafe_(e));
  }

  // 4. 常設トリガー（消えていると催促・掃除・キュー処理が止まる）
  try {
    var have = {};
    ScriptApp.getProjectTriggers().forEach(function(t) { have[t.getHandlerFunction()] = true; });
    var missing = SYS_REQUIRED_TRIGGERS_.filter(function(n) { return !have[n]; });
    if (missing.length > 0) {
      systemAlert_('triggers', '定期実行（トリガー）が消えています',
        '無いもの: ' + missing.join(', ') + '\n未払いの催促・古い記録の掃除・メッセージの処理のどれかが動いていません。',
        'GAS エディタで setupV7Triggers を実行すると作り直せます。', { track: true });
    } else {
      systemAlertClear_('triggers', '定期実行（トリガー）がそろいました');
    }
    out.push({ code: 'triggers', ok: missing.length === 0 });
  } catch (e) {
    Logger.log(SYS_ALERT_LOG_ + 'トリガーの確認ができなかった: ' + sysAlertSafe_(e));
  }

  return out;
}

/** キューのキー（queue_{ミリ秒}_{update_id}）から、件数といちばん古いものの待ち時間を出す */
function sysHealthQueue_(keys, nowMs) {
  var prefix = (typeof STORAGE_KEYS !== 'undefined' && STORAGE_KEYS && STORAGE_KEYS.QUEUE_PREFIX) || 'queue_';
  var count = 0, oldest = 0;
  (keys || []).forEach(function(k) {
    if (String(k).indexOf(prefix) !== 0) return;
    count++;
    var ts = Number(String(k).substring(prefix.length).split('_')[0]);
    if (ts > 0 && (!oldest || ts < oldest)) oldest = ts;
  });
  var oldestMin = oldest ? Math.floor((nowMs - oldest) / 60000) : 0;
  return { count: count, oldestMin: oldestMin, stuck: count > 0 && oldestMin >= SYS_QUEUE_STUCK_MIN_ };
}

/** 動作確認用（GAS エディタで実行）: 管理グループへテストの通知を1通送る */
function systemAlertTest() {
  try { CacheService.getScriptCache().remove(sysAlertKey_('sys_alert_', 'test')); } catch (ignore) {}
  var sent = systemAlert_('test', 'これは通知のテストです', '異常は起きていません。この通知が管理グループに届けば、設定は正しく動いています。', '');
  Logger.log(SYS_ALERT_LOG_ + 'テスト通知: ' + (sent ? '送りました' : '送れませんでした'));
}
