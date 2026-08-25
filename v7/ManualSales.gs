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
    // 日付はジョブの完了/開始時刻基準（毎時安全網シンクが翌日以降に遡及計上しても
    // リアルタイム計上と同じキーになるよう、now ではなくジョブ側の時刻を使う）
    var refDate = now;
    if (body.endTime) refDate = new Date(body.endTime);
    else if (body.startTime) refDate = new Date(body.startTime);
    if (isNaN(refDate.getTime())) refDate = now;
    var dayKey = Utilities.formatDate(refDate, tz, 'yyyyMMdd');
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

// ============================================================
//  毎時安全網シンク（2026-08-25 Incident_2026-08-24_ManualSales_Deploy_Gap 対策）
//
//  Web アプリはデプロイ更新を忘れると旧コードのまま動き続けるが、
//  時間主導トリガーは常に最新 push コード（HEAD）で走る。
//  そのため「push はしたが deploy を忘れた」モードでも、本シンクが
//  取りこぼした手動ジョブ売上を検出して翌時間に自動回復する。
//  （経費側 syncMissingBotExpensesToMaster と同型の二段構え）
// ============================================================

// これ（yyyyMMdd）より前に完了したジョブは対象外。
// 旧データ（8/21・8/24 等）は手動遡及計上済みだが重複キーの無い行があり、
// 遡ると二重計上するため導入日で線を引く。
var MANUAL_SALES_SYNC_SINCE_ = '20260825';
var MANUAL_SALES_SYNC_LOOKBACK_DAYS_ = 7;

/**
 * 作業記録シートを走査し、「完了・料金>0・予約ID空」なのに予約シートに
 * 計上行（重複キー）が無い手動ジョブを検出して自動計上する（冪等）。
 *
 * @return {number} 今回計上した件数
 */
function syncMissingManualJobSales() {
  try {
    ensureJobsAmountColumn_();
    var ss = getSpreadsheet();
    var tz = ss.getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
    var sheet = getSheet(SHEET_NAMES.JOBS);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return 0;

    var lastCol = sheet.getLastColumn();
    var hdr = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var idx = {};
    hdr.forEach(function(h, i) { if (h) idx[String(h)] = i; });
    var need = ['ジョブID', '予約ID', '作業状態', '完了時刻', '料金(USD)'];
    for (var i = 0; i < need.length; i++) {
      if (idx[need[i]] === undefined) {
        Logger.log('⚠️ syncMissingManualJobSales: 列「' + need[i] + '」が無いためスキップ');
        return 0;
      }
    }

    var rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    var cutoff = new Date(new Date().getTime() - MANUAL_SALES_SYNC_LOOKBACK_DAYS_ * 24 * 60 * 60 * 1000);
    var count = 0;

    rows.forEach(function(r) {
      if (String(r[idx['予約ID']] || '').trim()) return;      // 予約経由は対象外
      if (String(r[idx['作業状態']] || '') !== '完了') return; // 作業中・中断は対象外
      var amount = Number(r[idx['料金(USD)']]);
      if (!(amount > 0)) return;                               // 無料・未入力は対象外

      var fin = r[idx['完了時刻']];
      if (!(fin instanceof Date)) fin = fin ? new Date(fin) : null;
      if (!fin || isNaN(fin.getTime())) return;
      if (fin < cutoff) return;
      if (Utilities.formatDate(fin, tz, 'yyyyMMdd') < MANUAL_SALES_SYNC_SINCE_) return;

      // 車種セルは「carModel / plate」形式（apiJobStart 参照）
      var carCell = idx['車種'] !== undefined ? String(r[idx['車種']] || '') : '';
      var parts = carCell.split(' / ');
      var carModel = (parts[0] || '').trim();
      var plate = (parts.length > 1 ? parts[1] : '').trim();
      var jobId = String(r[idx['ジョブID']] || '');
      if (!plate && !carModel) {
        // 車両情報が無いと重複キーが実時間計上時（客名ベース）と一致しない
        // 可能性があり二重計上リスクがあるため、自動では計上しない
        Logger.log('⚠️ sync: 車両情報なしのため自動計上スキップ（要手動確認）: ' + jobId + ' $' + amount);
        return;
      }

      var start = r[idx['開始時刻']];
      if (!(start instanceof Date) || isNaN(start.getTime())) start = null;
      var durMin = start ? Math.max(0, Math.round((fin.getTime() - start.getTime()) / 60000)) : 0;

      var created = recordManualJobSaleIfNeeded_({
        bookingId: '',
        amount: amount,
        name: '',
        carModel: carModel,
        plate: plate,
        duration: durMin,
        startTime: start ? start.toISOString() : '',
        endTime: fin.toISOString(),
        vehicleType: '',
        plan: '',
        glassOption: '',
        building: ''
      }, 'hourly_sync:' + jobId);
      if (created) count++;
    });

    if (count > 0) Logger.log('🔄 syncMissingManualJobSales: ' + count + '件を遡及計上');
    return count;
  } catch (err) {
    Logger.log('❌ syncMissingManualJobSales error: ' + err + ' stack=' + (err.stack || ''));
    return 0;
  }
}

/**
 * 毎時の安全網シンク専用トリガーを設定（既存の同名トリガーは張り替え・冪等）。
 * ※ 現在は send24HoursFeedback（毎時・登録済み）への相乗りで既に毎時実行される。
 *   本関数は相乗りを解消して独立トリガーにしたい時に GAS エディタから1回実行する。
 */
function setupManualSalesSyncTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncMissingManualJobSales') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncMissingManualJobSales').timeBased().everyHours(1).create();
  Logger.log('✅ syncMissingManualJobSales 毎時トリガー設定完了');
}

/** デバッグ: 手動で同期実行 */
function debugSyncMissingManualJobSales() {
  Logger.log('結果: ' + syncMissingManualJobSales() + '件計上');
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
