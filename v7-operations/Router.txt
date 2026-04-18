/**
 * Router.gs — doGet/doPost ルーティング
 *
 * 【責務】
 *   ミニアプリ（home-internal.html / attendance.html 等）からの fetch リクエストを受け、
 *   各 Manager にディスパッチする。
 *
 * 【設計方針】
 *   - Webhook は使わず doPost は最小限（ミニアプリ API 用）
 *   - JSONP 対応は現状不要（Telegram ミニアプリ内 fetch で十分）
 *   - CORS は GAS 側で Access-Control-Allow-Origin 設定不可のため、
 *     ミニアプリ側で `contentType: 'text/plain'` を使って回避する想定
 */

/**
 * GET リクエスト（ヘルスチェック・静的データ取得）
 */
function doGet(e) {
  const action = (e.parameter && e.parameter.action) || 'ping';

  try {
    switch (action) {
      case 'ping':
        return jsonOut({ ok: true, service: 'v7-operations', time: new Date().toISOString() });

      case 'staff_list':
        return jsonOut({ ok: true, staff: getActiveStaff() });

      case 'whoami': {
        const chatId = String(e.parameter.chatId || '');
        const staff = chatId ? findStaffByChatId(chatId) : null;
        return jsonOut({ ok: true, staff: staff });
      }

      case 'attendance_today': {
        const chatId = String(e.parameter.chatId || '');
        if (!chatId) return jsonOut({ ok: false, error: 'MISSING_CHAT_ID' });
        return jsonOut(getTodayAttendance(chatId));
      }

      default:
        return jsonOut({ ok: false, error: 'UNKNOWN_ACTION', action: action });
    }
  } catch (err) {
    Logger.log('❌ doGet error action=' + action + ' err=' + err);
    return jsonOut({ ok: false, error: String(err) });
  }
}

/**
 * POST リクエスト（ミニアプリからの書き込み系）
 */
function doPost(e) {
  // v7 booking.html と同一方式:
  //   ミニアプリ側は Content-Type: 'text/plain;charset=utf-8' + body: JSON.stringify(...)
  //   GAS 側は e.postData.contents を JSON.parse
  let body = {};
  try {
    if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    } else if (e.parameter && e.parameter.payload) {
      body = JSON.parse(e.parameter.payload);
    }
  } catch (err) {
    return jsonOut({ ok: false, error: 'INVALID_JSON', raw: String(err) });
  }

  const action = body.action || '';

  try {
    switch (action) {
      case 'ping':
        return jsonOut({ ok: true, echo: body });

      // iOS Safari / Telegram WebView 対策で GET ではなく POST(text/plain) 経由でも受け付ける
      case 'whoami': {
        const chatId = String(body.chatId || '');
        const staff = chatId ? findStaffByChatId(chatId) : null;
        return jsonOut({ ok: true, staff: staff });
      }

      case 'attendance_today': {
        const chatId = String(body.chatId || '');
        if (!chatId) return jsonOut({ ok: false, error: 'MISSING_CHAT_ID' });
        return jsonOut(getTodayAttendance(chatId));
      }

      case 'punch_in': {
        const chatId = String(body.chatId || '');
        if (!chatId) return jsonOut({ ok: false, error: 'MISSING_CHAT_ID' });
        return jsonOut(punchIn(chatId, body.gps || null));
      }

      case 'punch_out': {
        const chatId = String(body.chatId || '');
        if (!chatId) return jsonOut({ ok: false, error: 'MISSING_CHAT_ID' });
        return jsonOut(punchOut(chatId, body.gps || null));
      }

      // ── タスク管理ミニアプリ ──
      case 'tasks_today': {
        const chatId = String(body.chatId || '');
        if (!chatId) return jsonOut({ ok: false, error: 'MISSING_CHAT_ID' });
        const staff = findStaffByChatId(chatId);
        if (!staff) return jsonOut({ ok: false, error: 'STAFF_NOT_FOUND' });
        const tasks = getPendingTasksForStaff_(staff);
        return jsonOut({ ok: true, tasks: tasks, staff: { nameJp: staff.nameJp, nameEn: staff.nameEn, role: staff.role } });
      }

      case 'task_done': {
        const chatId = String(body.chatId || '');
        const taskId = String(body.taskId || '');
        if (!chatId || !taskId) return jsonOut({ ok: false, error: 'MISSING_PARAMS' });
        const staff = findStaffByChatId(chatId);
        if (!staff) return jsonOut({ ok: false, error: 'STAFF_NOT_FOUND' });
        markTaskDone(taskId, { first_name: staff.nameJp, username: staff.username || '' });
        return jsonOut({ ok: true });
      }

      case 'task_notdone': {
        const chatId = String(body.chatId || '');
        const taskId = String(body.taskId || '');
        const reason = String(body.reason || '');
        if (!chatId || !taskId) return jsonOut({ ok: false, error: 'MISSING_PARAMS' });
        const staff = findStaffByChatId(chatId);
        if (!staff) return jsonOut({ ok: false, error: 'STAFF_NOT_FOUND' });
        markTaskNotDone(taskId, { first_name: staff.nameJp, username: staff.username || '' }, reason);
        return jsonOut({ ok: true });
      }

      // ── 日報提出ミニアプリ ──
      case 'report_today': {
        const chatId = String(body.chatId || '');
        if (!chatId) return jsonOut({ ok: false, error: 'MISSING_CHAT_ID' });
        return jsonOut(getTodayReport(chatId));
      }

      case 'report_submit': {
        const chatId = String(body.chatId || '');
        if (!chatId) return jsonOut({ ok: false, error: 'MISSING_CHAT_ID' });
        return jsonOut(submitDailyReport(chatId, {
          work:       String(body.work       || ''),
          notes:      String(body.notes      || ''),
          tomorrow:   String(body.tomorrow   || ''),
          targetDate: String(body.targetDate || '')
        }));
      }

      default:
        return jsonOut({ ok: false, error: 'UNKNOWN_ACTION', action: action });
    }
  } catch (err) {
    Logger.log('❌ doPost error action=' + action + ' err=' + err);
    return jsonOut({ ok: false, error: String(err) });
  }
}

/**
 * JSON レスポンス生成ヘルパー
 */
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
