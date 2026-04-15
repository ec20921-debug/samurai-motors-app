/**
 * Router.gs — ミニアプリ API のルーティング
 *
 * 【責務】
 *   - doGet: ミニアプリからの API リクエストを各ハンドラへ振り分ける
 *
 * 【Polling方式への切替】
 *   2026-04-15: Webhook方式は GAS の302リダイレクトを Telegram が追えない既知問題のため、
 *   Polling方式へ切替。doPost は廃止し、BotPoller.gs の pollTelegramUpdates() が
 *   1分間隔トリガーで Telegram API の getUpdates を呼んでキューに投入する。
 *
 * 【ミニアプリ API】
 *   URL例: https://script.google.com/.../exec?action=getSlots&date=2026-04-20
 *   各 action の実処理は Phase 3 以降で BookingLogic.gs / JobManager.gs に追加する。
 */

/**
 * ミニアプリからの API リクエスト受信エンドポイント
 */
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || '';

    let result;
    switch (action) {
      case 'ping':
        result = { ok: true, message: 'v7 router alive', date: new Date().toISOString() };
        break;

      // ── Phase 3 で実装 ──
      case 'getSlots':
      case 'createBooking':
      case 'getPlanPrices':
      // ── Phase 4 で実装 ──
      case 'getTodayJobs':
      case 'startJob':
      case 'endJob':
        result = { ok: false, error: 'NOT_IMPLEMENTED', action: action };
        break;

      default:
        result = { ok: false, error: 'UNKNOWN_ACTION', action: action };
    }

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log('❌ doGet error: ' + err);
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
