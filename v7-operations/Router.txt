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
  // ミニアプリ側は URLSearchParams で payload=<JSON> を送る（iOS Safari の 302 リダイレクト回避のため）
  // 旧互換として e.postData.contents が直接 JSON の場合もサポート
  let body = {};
  try {
    if (e.parameter && e.parameter.payload) {
      body = JSON.parse(e.parameter.payload);
    } else if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
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
