/**
 * ManualSales.gs — 手動ジョブ（予約なし）の売上自動計上
 *
 * 【背景】2026-08-24
 *   ミニアプリの手動登録フロー（startManualEntry）で行った有償ジョブは
 *   作業記録シートに料金が残るだけで、売上集計元の「予約」シートに行が
 *   作られず売上に乗らなかった（例: 2026-08-21 の $10 WASH は手動計上）。
 *   キャンペーン売上の recordCampaignSale と同様に、完了・清算済みの1行を
 *   予約シートへ自動追加して即売上に反映する。
 *
 * 【発火点】
 *   - apiJobEnd（作業終了・主経路）
 *   - apiJobFinal（最終送信バックアップ・job_end 不達時の保険）
 *   両方から呼ばれるため、シートベースの重複キーで二重計上を防ぐ。
 *
 * 【対象条件】
 *   - bookingId が空（= 予約経由でない手動ジョブ）
 *   - 料金(amount) > 0（無料 $0 と未入力は対象外）
 */

/**
 * 手動ジョブが有償なら「予約」シートに売上1行を計上する（冪等）。
 *
 * @param {Object} body - job_end / job の受信ペイロード
 * @param {string} sourceAction - 'job_end' | 'job'（ログ用）
 * @return {string|null} 作成した予約ID（スキップ時は null）
 */
function recordManualJobSaleIfNeeded_(body, sourceAction) {
  try {
    var bookingId = String(body.bookingId || '');
    if (bookingId) return null;  // 予約経由は既存フローで売上に乗る
    var amount = Number(body.amount);
    if (!(amount > 0)) return null;  // 無料・未入力は計上しない

    var ss = getSpreadsheet();
    var tz = ss.getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
    var now = new Date();

    var name = String(body.name || '').trim();
    var carModel = String(body.carModel || '').trim();
    var plate = String(body.plate || '').trim();
    var duration = Number(body.duration || 0);

    // 重複キー: 同日・同車両（無ければ客名）・同額なら同一ジョブとみなす
    // （job_end と job の二重発火、完了ボタン連打の両方を吸収する）
    var dayKey = Utilities.formatDate(now, tz, 'yyyyMMdd');
    var dedupeKey = 'MS:' + dayKey + ':' + (plate || carModel || name || '-') + ':' + amount;

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(15 * 1000)) {
      Logger.log('⚠️ recordManualJobSaleIfNeeded_ ロック取得失敗（' + sourceAction + '）');
      return null;
    }
    try {
      if (findBookingMemoContains_(dedupeKey)) {
        Logger.log('ℹ️ 手動ジョブ売上は計上済み（' + dedupeKey + '）');
        return null;
      }

      // 開始時刻: body.startTime（job のみ）→ 無ければ 終了時刻 - 所要時間
      var startDate;
      if (body.startTime) {
        startDate = new Date(body.startTime);
      } else {
        var endDate = body.endTime ? new Date(body.endTime) : now;
        startDate = new Date(endDate.getTime() - duration * 60 * 1000);
      }

      var newBookingId = generateDateSeqId('BK', SHEET_NAMES.BOOKINGS, '予約ID');
      // 予約日は Date 型で（文字列だと売上集計の日付フィルタに乗らない既知の不具合）
      var todayDate = Utilities.parseDate(
        Utilities.formatDate(startDate, tz, 'yyyy-MM-dd'), tz, 'yyyy-MM-dd');

      appendRow(SHEET_NAMES.BOOKINGS, {
        '予約ID':         newBookingId,
        '顧客ID':         '',
        'チャットID':     '',
        '車種タイプ':     String(body.vehicleType || ''),
        '車種名':         carModel,
        'プラン':         String(body.plan || ''),
        'オプション':     String(body.glassOption || ''),
        '予約日':         todayDate,
        '予約時刻':       Utilities.formatDate(startDate, tz, 'HH:mm'),
        '所要時間(分)':   duration,
        '料金(USD)':      amount,
        '進行状態':       '作業完了',
        '予約登録日時':   now,
        '決済状態':       '清算済み',
        '請求額(USD)':    amount,
        '入金確認日時':   now,
        '催促回数':       0,
        '管理者メモ':     '客名:' + name + '｜手動ジョブ売上' +
                         (plate ? '｜No.' + plate : '') +
                         (carModel ? '｜車:' + carModel : '') +
                         '｜' + dedupeKey,
        '割引前金額(USD)': amount,
        '割引額(USD)':    0,
        // 手動登録フォームで建物名が入っていれば出張、無ければ店舗と推定
        'サービスタイプ': (String(body.building || '').trim() ? '出張' : '店舗')
      });

      // 管理者通知（best-effort）
      try {
        var cfg = getConfig();
        var text = '💰 手動ジョブ売上 記録（自動）\n' +
          '━━━━━━━━━━━━━━━━━\n' +
          '🆔 ' + newBookingId + '\n' +
          '💵 $' + amount + '（清算済み）\n' +
          '👤 ' + (name || '-') +
          (carModel ? ' / ' + carModel : '') + (plate ? ' / ' + plate : '');
        sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, text, {});
      } catch (eNotify) {
        Logger.log('⚠️ 手動ジョブ売上 通知失敗（記録は成功）: ' + eNotify);
      }

      Logger.log('✅ 手動ジョブ売上 計上: ' + newBookingId + ' $' + amount +
                 '（' + sourceAction + '・' + dedupeKey + '）');
      return newBookingId;
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('❌ recordManualJobSaleIfNeeded_ error: ' + err + ' stack=' + (err.stack || ''));
    return null;
  }
}

/**
 * 予約シートの管理者メモに指定文字列を含む行があるか（重複計上チェック用）
 *
 * @param {string} needle
 * @return {boolean}
 */
function findBookingMemoContains_(needle) {
  var sheet = getSheet(SHEET_NAMES.BOOKINGS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var headers = getHeaderMap(SHEET_NAMES.BOOKINGS);
  var memoCol = headers['管理者メモ'];
  if (!memoCol) return false;
  var memos = sheet.getRange(2, memoCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < memos.length; i++) {
    if (String(memos[i][0] || '').indexOf(needle) !== -1) return true;
  }
  return false;
}
