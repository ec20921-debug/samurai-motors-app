/**
 * AttendanceManager.gs — 勤怠打刻（GPS付き）
 *
 * 【責務】
 *   - 出勤 / 退勤 打刻を「勤怠記録」シートに記録
 *   - 同日重複打刻を防止（出勤が既にあれば拒否、退勤も同様）
 *   - GPS 座標と精度を記録、Google Maps リンクを自動生成
 *   - 管理グループの「勤怠ログ」トピックへ通知（シンプル1行）
 *
 * 【シート列（勤怠記録）】
 *   日付 / スタッフID / 氏名(JP) / Chat ID /
 *   出勤時刻 / 退勤時刻 / 勤務分数 /
 *   出勤緯度 / 出勤経度 / 出勤マップリンク /
 *   退勤緯度 / 退勤経度 / 退勤マップリンク /
 *   位置精度(m) / メモ
 */

// ====== 公開 API ======

/**
 * 出勤打刻
 * @param {string} chatId - Telegram chat_id（ミニアプリから取得）
 * @param {Object} gps - { lat, lng, accuracy } または null
 * @return {Object} { ok, time, error }
 */
function punchIn(chatId, gps) {
  return doPunch_('in', chatId, gps);
}

/**
 * 退勤打刻
 */
function punchOut(chatId, gps) {
  return doPunch_('out', chatId, gps);
}

/**
 * 本日の打刻状況取得
 * @return {Object} { ok, clockIn, clockOut, workMinutes }
 */
function getTodayAttendance(chatId) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const today = todayStr_();
  const row = findTodayRow_(today, staff.staffId);

  if (!row) {
    return { ok: true, clockIn: null, clockOut: null, workMinutes: 0 };
  }

  return {
    ok: true,
    clockIn:     formatTimeCell_(row.data['出勤時刻']),
    clockOut:    formatTimeCell_(row.data['退勤時刻']),
    workMinutes: Number(row.data['勤務分数']) || 0
  };
}

// ====== 内部実装 ======

/**
 * 打刻共通処理
 */
function doPunch_(type, chatId, gps) {
  const staff = findStaffByChatId(chatId);
  if (!staff) {
    return { ok: false, error: 'STAFF_NOT_FOUND', message: 'スタッフ未登録' };
  }

  const now = new Date();
  const today = todayStr_();
  const timeStr = Utilities.formatDate(now, OPS_TZ, 'HH:mm');

  const existing = findTodayRow_(today, staff.staffId);

  if (type === 'in') {
    // 既に出勤打刻済み
    if (existing && existing.data['出勤時刻']) {
      return {
        ok: false,
        error: 'ALREADY_PUNCHED_IN',
        message: '既に出勤打刻済みです（' + formatTimeCell_(existing.data['出勤時刻']) + '）'
      };
    }

    const payload = {
      '日付':           today,
      'スタッフID':     staff.staffId,
      '氏名(JP)':       staff.nameJp,
      'Chat ID':        staff.chatId,
      '出勤時刻':       timeStr,
      '退勤時刻':       '',
      '勤務分数':       '',
      '出勤緯度':       gps ? gps.lat : '',
      '出勤経度':       gps ? gps.lng : '',
      '出勤マップリンク': gps ? mapLink_(gps.lat, gps.lng) : '',
      '退勤緯度':       '',
      '退勤経度':       '',
      '退勤マップリンク': '',
      '位置精度(m)':    gps ? Math.round(gps.accuracy || 0) : '',
      'メモ':           gps ? '' : 'GPS不可'
    };

    appendRow(SHEET_NAMES.ATTENDANCE, payload);
    notifyAdminSimple_('🟢 ' + timeStr + ' ' + staff.nameJp + ' 出勤', gps);

    return { ok: true, type: 'in', time: timeStr };
  }

  // 退勤
  if (!existing || !existing.data['出勤時刻']) {
    return {
      ok: false,
      error: 'NOT_PUNCHED_IN',
      message: '本日の出勤打刻がありません'
    };
  }
  if (existing.data['退勤時刻']) {
    return {
      ok: false,
      error: 'ALREADY_PUNCHED_OUT',
      message: '既に退勤打刻済みです（' + formatTimeCell_(existing.data['退勤時刻']) + '）'
    };
  }

  // 勤務分数計算
  const clockInStr = formatTimeCell_(existing.data['出勤時刻']);
  const workMinutes = diffMinutes_(clockInStr, timeStr);

  const updates = {
    '退勤時刻':       timeStr,
    '勤務分数':       workMinutes,
    '退勤緯度':       gps ? gps.lat : '',
    '退勤経度':       gps ? gps.lng : '',
    '退勤マップリンク': gps ? mapLink_(gps.lat, gps.lng) : ''
  };
  // 精度は上書きしない（出勤時のを保持）。GPS不可メモは追記
  if (!gps) {
    const prevMemo = String(existing.data['メモ'] || '');
    updates['メモ'] = prevMemo ? prevMemo + ' / 退勤GPS不可' : '退勤GPS不可';
  }

  updateRow(SHEET_NAMES.ATTENDANCE, existing.row, updates);
  notifyAdminSimple_('🔴 ' + timeStr + ' ' + staff.nameJp + ' 退勤', gps);

  return { ok: true, type: 'out', time: timeStr, workMinutes: workMinutes };
}

/**
 * 指定日・スタッフIDの行を検索
 */
function findTodayRow_(dateStr, staffId) {
  const sheet = getSheet(SHEET_NAMES.ATTENDANCE);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const headers = getHeaders(SHEET_NAMES.ATTENDANCE);
  const dateIdx = headers.indexOf('日付');
  const idIdx   = headers.indexOf('スタッフID');
  if (dateIdx < 0 || idIdx < 0) {
    throw new Error('❌ 勤怠記録シートに「日付」または「スタッフID」列がありません');
  }

  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  Logger.log('🔍 findTodayRow_ target=' + dateStr + '/' + staffId + ' rows=' + values.length);
  for (let i = 0; i < values.length; i++) {
    const d = formatDateCell_(values[i][dateIdx]);
    const id = String(values[i][idIdx]);
    Logger.log('  row=' + (i+2) + ' date=' + d + ' id=' + id);
    if (d === dateStr && id === String(staffId)) {
      const data = {};
      headers.forEach(function(h, j) { data[h] = values[i][j]; });
      Logger.log('  ✅ match row=' + (i+2));
      return { row: i + 2, data: data };
    }
  }
  Logger.log('  ❌ no match');
  return null;
}

/**
 * Admin 勤怠ログトピックへシンプル通知
 */
function notifyAdminSimple_(text, gps) {
  const cfg = getConfig();
  if (!cfg.adminGroupId) {
    Logger.log('⚠️ notifyAdminSimple_: adminGroupId 未設定');
    return;
  }

  let body = text;
  if (gps && gps.lat && gps.lng) {
    body += ' 📍<a href="' + mapLink_(gps.lat, gps.lng) + '">マップ</a>';
  } else {
    body += ' 📍GPS不可';
  }

  const options = {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (cfg.attendanceTopicId) {
    options.message_thread_id = parseInt(cfg.attendanceTopicId, 10);
  }

  const res = sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, body, options);
  if (!res || !res.ok) {
    Logger.log('❌ notifyAdminSimple_ 失敗 chat=' + cfg.adminGroupId
             + ' topic=' + (cfg.attendanceTopicId || '（なし）')
             + ' res=' + JSON.stringify(res));
  } else {
    Logger.log('✅ notifyAdminSimple_ 送信OK ' + body);
  }
}

/**
 * Admin通知を単独でテストするデバッグ関数
 * GAS エディタで実行して、勤怠ログトピックにテストメッセージが飛ぶか確認する
 */
function debugNotifyAdmin() {
  const testGps = { lat: 35.758238, lng: 140.028751, accuracy: 7 };
  notifyAdminSimple_('🧪 テスト通知（debugNotifyAdmin）', testGps);
}

// ====== ヘルパー ======

/**
 * 「今日」の yyyy-MM-dd
 * ★スプレッドシートの TZ を優先（Sheets が Date に変換する際の TZ と一致させる）
 */
function todayStr_() {
  return Utilities.formatDate(new Date(), getSheetTz_(), 'yyyy-MM-dd');
}

/**
 * シートのタイムゾーンを取得（失敗時は OPS_TZ にフォールバック）
 */
function getSheetTz_() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || OPS_TZ;
  } catch (_) {
    return OPS_TZ;
  }
}

function mapLink_(lat, lng) {
  return 'https://www.google.com/maps?q=' + lat + ',' + lng;
}

/**
 * シートセルの日付を yyyy-MM-dd に正規化
 * ★Sheets が Date に変換したセルはシートの TZ で解釈する（todayStr_ と対応）
 */
function formatDateCell_(cell) {
  if (cell instanceof Date) {
    return Utilities.formatDate(cell, getSheetTz_(), 'yyyy-MM-dd');
  }
  return String(cell || '').trim();
}

/**
 * シートセルの時刻を HH:mm に正規化
 * ★ Date セルはシートの TZ で解釈（日付セルと同様、TZ ズレ対策）
 */
function formatTimeCell_(cell) {
  if (cell === '' || cell === null || cell === undefined) return '';
  if (cell instanceof Date) {
    return Utilities.formatDate(cell, getSheetTz_(), 'HH:mm');
  }
  // "HH:mm" or "HH:mm:ss"
  const s = String(cell);
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return ('0' + m[1]).slice(-2) + ':' + m[2];
  return s;
}

/**
 * 2つの HH:mm 文字列の差分を分で返す（退勤 - 出勤）
 * 退勤 < 出勤 の場合は翌日扱い（深夜帯）
 */
function diffMinutes_(inStr, outStr) {
  const inM  = toMinutes_(inStr);
  const outM = toMinutes_(outStr);
  if (inM < 0 || outM < 0) return 0;
  let diff = outM - inM;
  if (diff < 0) diff += 24 * 60;
  return diff;
}

function toMinutes_(hhmm) {
  const m = String(hhmm).match(/(\d{1,2}):(\d{2})/);
  if (!m) return -1;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// ====== 勤務Bot update 処理（Queueからディスパッチ） ======

/**
 * QueueManager.processInternalQueue から呼ばれる
 * /start コマンドにはミニアプリ起動ボタンを返信
 */
function handleInternalBotUpdate(update) {
  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const text = String(msg.text || '');

  if (text === '/start' || text === '/menu') {
    sendInternalMenu_(chatId);
    return;
  }

  // それ以外のメッセージは無視（現時点）
  Logger.log('ℹ️ 勤務Bot: 未対応メッセージ chat=' + chatId + ' text=' + text);
}

/**
 * ミニアプリ起動ボタンを送信
 */
function sendInternalMenu_(chatId) {
  const cfg = getConfig();
  if (!cfg.internalMiniappUrl) {
    sendMessage(BOT_TYPE.INTERNAL, chatId,
      '⚠️ ミニアプリURLが未登録です。管理者に連絡してください。');
    return;
  }

  const text =
    '👋 សូមស្វាគមន៍មកកាន់ Samurai Motors\n' +
    'Welcome to Samurai Motors Internal\n\n' +
    '👇 ខាងក្រោមបើកមិនីកម្មវិធី / Tap below to open the app';

  sendMessage(BOT_TYPE.INTERNAL, chatId, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '🚀 បើកកម្មវិធី / Open App', web_app: { url: cfg.internalMiniappUrl } }
      ]]
    }
  });
}

// ====== デバッグ用 ======

function debugPunchInMe() {
  // 自分の chatId でテスト打刻（ロンの chatId を使用）
  const res = punchIn('7500384947', null);
  Logger.log(JSON.stringify(res, null, 2));
}

function debugPunchOutMe() {
  const res = punchOut('7500384947', null);
  Logger.log(JSON.stringify(res, null, 2));
}

function debugTodayMe() {
  const res = getTodayAttendance('7500384947');
  Logger.log(JSON.stringify(res, null, 2));
}
