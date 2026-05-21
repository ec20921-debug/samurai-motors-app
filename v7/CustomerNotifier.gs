/**
 * CustomerNotifier.gs — 顧客 Touchpoint 自動配信
 *
 * 【責務】
 *   - A2: 予約 1 時間前に「もうすぐ伺います」リマインダーを顧客 Telegram に送信
 *   - A4: 作業完了から 24 時間後に「フィードバックお願い」メッセージを顧客に送信
 *
 * 【トリガー】
 *   - send1HourReminders        : 15 分間隔(/exec ベース)
 *   - send24HoursFeedback       : 1 時間間隔(/exec ベース)
 *
 * 【冪等性】
 *   - 各レコードの BOOKINGS 列「1h前リマインダー送信日時」「フィードバック送信日時」を
 *     見て、既送信ならスキップ。多重送信防止。
 *
 * 【依存】
 *   Setup_MenuV2.gs の ensureBookingCampaignColumnsV2_() で
 *   BOOKINGS シートに以下 2 列が追加されていること:
 *   - 1h前リマインダー送信日時
 *   - フィードバック送信日時
 */

// ============================================================
// A2: 1 時間前リマインダー
// ============================================================

/**
 * 直近 1 時間以内に予約が始まる顧客にリマインダーを送る。
 * 15 分間隔のトリガーで動かす想定。
 *
 * 配信条件:
 *   - 進行状態 = '予約確定'
 *   - 予約日 = 今日(Asia/Phnom_Penh)
 *   - 予約時刻 = 現在から 45 分後 〜 75 分後の範囲(15分トリガーの揺れを考慮)
 *   - 1h前リマインダー送信日時 = 空(未送信)
 */
function send1HourReminders() {
  const sheet = getSheet(SHEET_NAMES.BOOKINGS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const headers = getHeaderMap(SHEET_NAMES.BOOKINGS);
  const reminderCol = headers['1h前リマインダー送信日時'];
  if (!reminderCol) {
    Logger.log('⚠️ send1HourReminders: 「1h前リマインダー送信日時」列が無い。migrateMenuV2() を再実行してください');
    return;
  }

  const tz = 'Asia/Phnom_Penh';
  const now = new Date();
  const todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const lowerMs = now.getTime() + 45 * 60 * 1000;   // 45分後
  const upperMs = now.getTime() + 75 * 60 * 1000;   // 75分後

  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  let sentCount = 0;
  data.forEach(function(row, idx) {
    const rowIndex = idx + 2;
    const status   = String(row[(headers['進行状態'] || 1) - 1] || '');
    const dateStr  = formatBookingDateCell_(row[(headers['予約日'] || 1) - 1], tz);
    const timeStr  = String(row[(headers['予約時刻'] || 1) - 1] || '');
    const chatId   = String(row[(headers['チャットID'] || 1) - 1] || '');
    const reminderSent = row[reminderCol - 1];

    if (status !== '予約確定') return;
    if (dateStr !== todayStr) return;
    if (!timeStr) return;
    if (!chatId) return;
    if (reminderSent) return; // 既送信

    // 予約時刻のミリ秒
    const hm = timeStr.split(':');
    if (hm.length < 2) return;
    const slotStart = parseDateTimePhnomPenh(dateStr, parseInt(hm[0], 10), parseInt(hm[1], 10));
    const slotMs = slotStart.getTime();
    if (slotMs < lowerMs || slotMs > upperMs) return; // 範囲外

    // 場所情報
    const mapsUrl = String(row[(headers['マップリンク'] || 1) - 1] || '');
    const bookingId = String(row[(headers['予約ID'] || 1) - 1] || '');

    // 送信
    const text =
      '⏰ <b>Arrival reminder / កំពុងមកដល់</b>\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '🚗 Ron will arrive in about 1 hour at ' + timeStr + '\n' +
      'Ron នឹងមកដល់ប្រហែល 1 ម៉ោងទៀតនៅម៉ោង ' + timeStr + '\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '📋 Booking: ' + bookingId + '\n' +
      (mapsUrl ? '📍 Location: ' + mapsUrl + '\n' : '') +
      '━━━━━━━━━━━━━━━━\n' +
      '💡 Please be ready and remove valuable items from your car.\n' +
      'សូមត្រៀមរួចរាល់ ហើយយកវត្ថុមានតម្លៃចេញពីឡានជាមុន។\n' +
      '\n' +
      'See you soon! / ជួបនឹងពេលឆាប់ៗ!';

    try {
      sendMessage(BOT_TYPE.BOOKING, chatId, text, { parse_mode: 'HTML' });
      // 送信日時を記録
      sheet.getRange(rowIndex, reminderCol).setValue(new Date());
      sentCount++;
      Logger.log('✅ 1h reminder sent: ' + bookingId + ' chat=' + chatId);
    } catch (err) {
      Logger.log('❌ 1h reminder 失敗 ' + bookingId + ': ' + err);
    }
  });

  if (sentCount > 0) {
    Logger.log('📤 send1HourReminders: ' + sentCount + ' 件送信');
  }
}

// ============================================================
// A4: 完了後 24 時間フィードバック依頼
// ============================================================

/**
 * 作業完了から 24 時間経過した顧客にフィードバックを依頼。
 * 1 時間間隔のトリガーで動かす想定。
 *
 * 配信条件:
 *   - 進行状態 = '作業完了'
 *   - 完了日時 + 24h <= 現在(つまり 24h 以上経過)
 *   - フィードバック送信日時 = 空(未送信)
 *   - 完了から 7 日以内(古すぎるものは対象外、運用切り戻し時の暴走防止)
 */
function send24HoursFeedback() {
  const sheet = getSheet(SHEET_NAMES.BOOKINGS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const headers = getHeaderMap(SHEET_NAMES.BOOKINGS);
  const feedbackCol = headers['フィードバック送信日時'];
  if (!feedbackCol) {
    Logger.log('⚠️ send24HoursFeedback: 「フィードバック送信日時」列が無い。migrateMenuV2() を再実行してください');
    return;
  }

  const completedAtCol = headers['完了日時'] || headers['作業完了日時'] || headers['入金確認日時']; // フォールバック
  // 「完了日時」列が無い場合は予約日 +1 を完了と見なす(暫定)。
  // 厳密には JOBS シートを引くべきだが、まず簡易版で運用。

  const now = new Date();
  const nowMs = now.getTime();
  const cutoffMs24h = nowMs - 24 * 60 * 60 * 1000;     // 24h 経過の境界
  const cutoffMs7d  = nowMs - 7 * 24 * 60 * 60 * 1000; // 7 日経過の境界(対象外)

  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();

  let sentCount = 0;
  data.forEach(function(row, idx) {
    const rowIndex = idx + 2;
    const status   = String(row[(headers['進行状態'] || 1) - 1] || '');
    const chatId   = String(row[(headers['チャットID'] || 1) - 1] || '');
    const bookingId = String(row[(headers['予約ID'] || 1) - 1] || '');
    const feedbackSent = row[feedbackCol - 1];

    if (status !== '作業完了') return;
    if (!chatId) return;
    if (feedbackSent) return; // 既送信

    // 完了タイミング判定(完了日時が無ければ予約登録日時を代替に使う)
    let completedAt = null;
    if (completedAtCol) {
      const v = row[completedAtCol - 1];
      if (v instanceof Date) completedAt = v;
    }
    if (!completedAt) {
      const regV = row[(headers['予約登録日時'] || 1) - 1];
      if (regV instanceof Date) completedAt = regV;
    }
    if (!completedAt) return;

    const compMs = completedAt.getTime();
    if (compMs > cutoffMs24h) return;     // まだ 24h 経過してない
    if (compMs < cutoffMs7d)  return;     // 7 日以上経過は対象外(暴走防止)

    // 送信
    const text =
      '🙏 <b>How was your service? / សេវាកម្មយ៉ាងណាដែរ?</b>\n' +
      '━━━━━━━━━━━━━━━━\n' +
      'Thank you for choosing SAMURAI MOTORS.\n' +
      'We hope your car shines beautifully!\n' +
      '\n' +
      'សូមអរគុណដែលជ្រើសរើស SAMURAI MOTORS។\n' +
      'យើងសង្ឃឹមថាឡានរបស់អ្នកភ្លឺថ្លាល្អ!\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '📋 ' + bookingId + '\n' +
      '\n' +
      '⭐ <b>Please give us 5 stars on Google Maps!</b>\n' +
      '🙏 <b>សូមផ្តល់ផ្កាយ 5 នៅ Google Maps!</b>\n' +
      '\n' +
      '👉 https://maps.app.goo.gl/KkW1CZUcUr3a4jx78\n' +
      '━━━━━━━━━━━━━━━━\n' +
      '📸 <b>Share us with your friends!</b>\n' +
      '🙏 <b>ណែនាំមិត្តរបស់អ្នកអំពីយើង!</b>\n' +
      '\n' +
      'We truly appreciate your support / យើងពិតជាដឹងគុណ 🙏';

    try {
      sendMessage(BOT_TYPE.BOOKING, chatId, text, { parse_mode: 'HTML' });
      // 送信日時を記録
      sheet.getRange(rowIndex, feedbackCol).setValue(new Date());
      sentCount++;
      Logger.log('✅ 24h feedback sent: ' + bookingId + ' chat=' + chatId);
    } catch (err) {
      Logger.log('❌ 24h feedback 失敗 ' + bookingId + ': ' + err);
    }
  });

  if (sentCount > 0) {
    Logger.log('📤 send24HoursFeedback: ' + sentCount + ' 件送信');
  }
}

// ============================================================
// トリガーセットアップ
// ============================================================

/**
 * トリガーを一括設定(冪等)
 *  - send1HourReminders   → 15 分間隔
 *  - send24HoursFeedback  → 1 時間間隔
 *
 * 既存トリガーは削除してから再作成。
 */
function setupCustomerNotifierTriggers() {
  Logger.log('⏰ CustomerNotifier トリガー設定開始');

  // 既存トリガー削除
  const targets = ['send1HourReminders', 'send24HoursFeedback'];
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (targets.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 1 時間前リマインダー: 15分間隔
  ScriptApp.newTrigger('send1HourReminders')
    .timeBased().everyMinutes(15).create();
  Logger.log('  ✅ send1HourReminders: 15分間隔');

  // 完了後 24h フィードバック: 1時間間隔
  ScriptApp.newTrigger('send24HoursFeedback')
    .timeBased().everyHours(1).create();
  Logger.log('  ✅ send24HoursFeedback: 1時間間隔');

  Logger.log('✅ CustomerNotifier トリガー設定完了');
}

// ============================================================
// 内部ヘルパー
// ============================================================

/**
 * 予約日セルを 'yyyy-MM-dd' に正規化(Asia/Phnom_Penh)
 */
function formatBookingDateCell_(val, tz) {
  if (!val) return '';
  if (val instanceof Date) {
    return Utilities.formatDate(val, tz, 'yyyy-MM-dd');
  }
  return String(val).trim().substring(0, 10);
}
