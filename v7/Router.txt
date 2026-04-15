/**
 * Router.gs — Webhook / ミニアプリ API のルーティング
 *
 * 【責務】
 *   - doPost: Telegram Webhook を受け取り、重複排除してキューに投入 → 即 'ok' 返却
 *   - doGet:  ミニアプリからの API リクエストを各ハンドラへ振り分ける
 *
 * 【絶対ルール（v6崩壊の原因）】
 *   doPost は 1秒以内 に必ず ContentService.createTextOutput('ok') を return する。
 *   重い処理（API呼び出し・シート書き込み・画像保存など）は絶対にここに書かない。
 *   実処理は QueueManager.gs の processTelegramQueue() が1分間隔で実行する。
 *
 * 【Bot識別方法】
 *   Webhook URL のクエリ `?bot=booking` or `?bot=field` で Bot種別を識別する。
 *   例: https://script.google.com/.../exec?bot=booking
 *   setWebhook 時にこのクエリを含めて登録すること。
 */

/**
 * Telegram Webhook 受信エンドポイント
 *
 * 処理：
 *   1. JSON パース
 *   2. Bot種別識別（?bot= クエリ）
 *   3. update_id 重複チェック（ScriptProperties）
 *   4. キューに投入
 *   5. 即 'ok' 返却
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput('ok');
    }

    // ── Bot種別識別 ──
    const botType = (e.parameter && e.parameter.bot) || '';
    if (botType !== BOT_TYPE.BOOKING && botType !== BOT_TYPE.FIELD) {
      Logger.log('⚠️ doPost: 不明な botType クエリ=' + JSON.stringify(e.parameter));
      return ContentService.createTextOutput('ok');
    }

    // ── JSON パース ──
    const update = JSON.parse(e.postData.contents);
    const updateId = update.update_id;
    if (!updateId) {
      return ContentService.createTextOutput('ok');
    }

    // ── 重複排除 ──
    const props = PropertiesService.getScriptProperties();
    const processedKey = STORAGE_KEYS.PROCESSED_PREFIX + updateId;
    if (props.getProperty(processedKey)) {
      return ContentService.createTextOutput('ok'); // 既に処理済み
    }

    // ── キューに投入（重い処理はしない） ──
    enqueueTelegramUpdate(update, botType);

    // ── 即 return ──
    return ContentService.createTextOutput('ok');

  } catch (err) {
    // エラーでも ok を返す（Telegram のリトライ防止）
    Logger.log('❌ doPost error: ' + err + ' stack=' + (err.stack || ''));
    return ContentService.createTextOutput('ok');
  }
}

/**
 * ミニアプリからの API リクエスト受信エンドポイント
 *
 * URL例: https://script.google.com/.../exec?action=getSlots&date=2026-04-20
 *
 * Phase 1 時点では action ルーティング枠のみ実装。
 * 各 action の実処理は Phase 3 以降で BookingLogic.gs / JobManager.gs に追加する。
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
