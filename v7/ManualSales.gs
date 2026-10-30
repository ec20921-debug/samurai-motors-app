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
 *   - 支払区分が ABA・提携店（紹介客 shopref／店の車 shop）・旧現金（未収・無料デモ・不明は対象外）
 *     2026-10-25 Daisuke 決定: 提携店の仕事も当社分をその場で QR で受け取るので「清算済み」で計上し、
 *     売上は当社の取り分だけ（現場アプリが 定価×(100−店の紹介料率)% を入れる）。店の取り分は割引額に入れず、
 *     管理者メモに 定価・率 を残す（割引額は ABA で定価より安くした時＝本当の割引だけ）
 */

// 提携店払いを計上するのは、この日（yyyyMMdd）以降に終わった作業だけ（毎時シンクで過去分を遡って作らない）
var MANUAL_SALES_SHOP_SINCE_ = '20261023';

// 2026-10-31（中核の表の設計 v0.1 7章）: 作った売上行（予約）の番号を作業記録に書き戻す列。
//   作業↔売上を「管理者メモの目印 MS:…」ではなく番号で結ぶ。
//   「予約ID」（お客様の予約）とは別の列にする＝「予約ID が空＝手動ジョブ」で動いている既存の処理
//   （毎時シンク・日報の未計上チェック・営業ボードの店別集計・QR連携の後追い・v2 の再送判定）を変えない
var JOBS_COL_SALE_BOOKING_ = '売上予約ID';

/** 作業記録に「売上予約ID」列を冪等確保する（失敗しても計上は続ける） */
function ensureJobsSaleBookingColumn_() {
  try {
    var sheet = getSheet(SHEET_NAMES.JOBS);
    var headers = getHeaderMap(SHEET_NAMES.JOBS);
    if (!headers[JOBS_COL_SALE_BOOKING_]) {
      sheet.getRange(1, sheet.getLastColumn() + 1).setValue(JOBS_COL_SALE_BOOKING_);
    }
  } catch (e) {
    Logger.log('⚠️ ensureJobsSaleBookingColumn_ 失敗（計上は継続）: ' + e);
  }
}

/**
 * 売上行（予約）の番号を作業記録の行に書き戻す。売上は計上済みなので、ここが失敗しても業務は止めない
 * @param {number} rowIndex - 作業記録の行番号（0・空なら何もしない）
 * @param {string} bookingId - 売上行の予約ID（作った番号・または計上済みで見つかった番号）
 * @param {string=} expectJobId - 分かっていれば、行のジョブIDがこれと一致する時だけ書く（一括読みの後に行がずれた時の取り違え防止）
 * @return {boolean} 書けた（列が無い・行が違う・例外 は false）
 */
function manualSaleLinkJob_(rowIndex, bookingId, expectJobId) {
  if (!rowIndex || !bookingId) return false;
  try {
    ensureJobsSaleBookingColumn_();
    if (!getHeaderMap(SHEET_NAMES.JOBS)[JOBS_COL_SALE_BOOKING_]) {
      Logger.log('⚠️ manualSaleLinkJob_: 作業記録に「' + JOBS_COL_SALE_BOOKING_ + '」列が無い（売上は計上済み）');
      return false;
    }
    if (expectJobId) {
      var cur = readRow(SHEET_NAMES.JOBS, rowIndex);
      if (String(cur['ジョブID'] || '') !== String(expectJobId)) {
        Logger.log('⚠️ manualSaleLinkJob_: 行' + rowIndex + ' のジョブIDが ' + expectJobId + ' ではないため書かない');
        return false;
      }
    }
    var upd = {};
    upd[JOBS_COL_SALE_BOOKING_] = String(bookingId);
    updateRow(SHEET_NAMES.JOBS, rowIndex, upd);
    return true;
  } catch (e) {
    Logger.log('⚠️ manualSaleLinkJob_ 失敗（売上は計上済み・作業記録 行' + rowIndex + ' に ' + bookingId + ' を書けず）: ' + e);
    return false;
  }
}

/** 予約シートの予約IDの集合 { id: true }（毎時シンクが「売上予約ID」の行き先がまだあるか確かめる用）。読めない時は null */
function manualSalesBookingIdSet_() {
  try {
    var sheet = getSheet(SHEET_NAMES.BOOKINGS);
    var lastRow = sheet.getLastRow();
    var col = getHeaderMap(SHEET_NAMES.BOOKINGS)['予約ID'];
    if (!col) return null;
    var set = {};
    if (lastRow >= 2) {
      sheet.getRange(2, col, lastRow - 1, 1).getValues().forEach(function(r) {
        var id = String(r[0] || '').trim();
        if (id) set[id] = true;
      });
    }
    return set;
  } catch (e) {
    Logger.log('⚠️ manualSalesBookingIdSet_: ' + e);
    return null;
  }
}

/**
 * 手入力ジョブの optionCodes(配列) と旧 glassOption(単一) を CSV に正規化する
 * Menu v4 (2026-09-22): job-manager.html は両方を送る(新: optionCodes / 互換: glassOption)
 * @return {string} 'GLASS_3,HEADLIGHT,BODY' / ''
 */
function manualOptionCodesCsv_(body) {
  var list = [];
  if (Array.isArray(body.optionCodes)) {
    body.optionCodes.forEach(function(c) { c = String(c || '').trim(); if (c && list.indexOf(c) < 0) list.push(c); });
  } else if (typeof body.optionCodes === 'string' && body.optionCodes.trim()) {
    body.optionCodes.split(',').forEach(function(c) { c = c.trim(); if (c && list.indexOf(c) < 0) list.push(c); });
  }
  var g = String(body.glassOption || '').trim();
  if (g && list.indexOf(g) < 0) list.push(g);
  return list.join(',');
}

/**
 * 手動ジョブが有償なら「予約」シートに売上1行を計上する（冪等）。
 *
 * @param {Object} body - job_end / job の受信ペイロード
 * @param {string} sourceAction - 'job_end' | 'job'（ログ用）
 * @param {Object=} opts - { shopId: 提携店払いの店（確かめ済みの shop_id・空なら不明）, jobId: 作業記録のジョブID,
 *                          linkRowIndex: 作業記録の行番号（あれば売上行の番号を「売上予約ID」に書き戻す。計上済みで見つかった番号も書く＝後から直る・2026-10-31）,
 *                          linkJobId: 書き戻す行のジョブID（省略時は jobId。行がずれていたら書かない） }
 * @return {string|null} 作成した予約ID（スキップ時は null。計上済みの時も null＝通知・件数の意味を変えない）
 */
function recordManualJobSaleIfNeeded_(body, sourceAction, opts) {
  try {
    opts = opts || {};
    var bookingId = String(body.bookingId || '');
    if (bookingId) return null;  // 予約経由は既存フローで売上に乗る
    // 2026-10-08 D4: 現場アプリ v2 の支払区分が ABA・提携店・旧現金 以外（未収・無料デモ・不明）は自動計上しない
    var payType = String(body.paymentType || (body.v2 && body.v2.payment_type) || '');
    var shopPays = payType === 'shop' || payType === 'shopref';   // 2026-10-25: 紹介客（shopref）も提携店の仕事
    if (payType && payType !== 'cash' && payType !== 'aba' && !shopPays) {
      Logger.log('ℹ️ 手動ジョブ売上: 支払区分=' + payType + ' のため自動計上しない (' + sourceAction + ')');
      return null;
    }
    var amount = Number(body.amount);
    if (!(amount > 0)) return null;  // 無料・未入力は計上しない
    if (typeof FIELD_AMOUNT_MAX_ !== 'undefined' && amount > FIELD_AMOUNT_MAX_) {   // 打ち間違い（2026-10-25）
      Logger.log('⚠️ 手動ジョブ売上: 金額が大きすぎるため自動計上しない $' + amount + ' (' + sourceAction + ')');
      // 毎時シンクは同じ作業を何度も見直すので、知らせるのは作業終了の時だけ
      if (String(sourceAction).indexOf('hourly_sync') !== 0) try { sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId, '⚠️ 手動ジョブ売上: 金額 $' + amount + ' が大きすぎるため自動計上していません。金額を確かめて手で記録してください（' + sourceAction + '）', {}); } catch (eW) {}
      return null;
    }

    var ss = getSpreadsheet();
    var tz = ss.getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
    var now = new Date();

    var name = String(body.name || '').trim();
    var carModel = String(body.carModel || '').trim();
    var plate = String(body.plate || '').trim();
    var duration = Number(body.duration || 0);

    // QR連携済み（ManualCustomerLink.gs）なら チャットID/顧客ID を売上行へ引き継ぐ
    // （2026-08-28 台帳一元化: リマインダー・フィードバック・リピート判定に乗る）
    var linkedChatId = String(body.chatId || '');
    if (!linkedChatId && body.linkToken && typeof findJobsRowsByLinkToken_ === 'function') {
      try {
        var linkRows = findJobsRowsByLinkToken_(String(body.linkToken));
        for (var li = linkRows.length - 1; li >= 0; li--) {
          var lc = String(linkRows[li].data['顧客チャットID'] || '');
          if (lc) { linkedChatId = lc; break; }
        }
      } catch (eLink) {
        Logger.log('⚠️ linkToken 解決失敗(sale): ' + eLink);
      }
    }
    var linkedCustomerId = '';
    if (linkedChatId) {
      try {
        var linkedCust = findCustomerRow(linkedChatId);
        if (linkedCust && linkedCust.data['顧客ID']) {
          linkedCustomerId = String(linkedCust.data['顧客ID']);
        }
      } catch (eCust) { /* best-effort */ }
    }

    // 重複キー: 同日・同車両（無ければ客名）・同額なら同一ジョブとみなす
    // （job_end と job の二重発火、完了ボタン連打の両方を吸収する）
    // 日付はジョブの完了/開始時刻基準（毎時安全網シンクが翌日以降に遡及計上しても
    // リアルタイム計上と同じキーになるよう、now ではなくジョブ側の時刻を使う）
    var refDate = now;
    if (body.endTime) refDate = new Date(body.endTime);
    else if (body.startTime) refDate = new Date(body.startTime);
    if (isNaN(refDate.getTime())) refDate = now;
    var dayKey = Utilities.formatDate(refDate, tz, 'yyyyMMdd');
    if (shopPays && dayKey < MANUAL_SALES_SHOP_SINCE_) {
      Logger.log('ℹ️ 手動ジョブ売上: 店払いの導入日より前の作業のため計上しない (' + sourceAction + '・' + dayKey + ')');
      return null;
    }
    var dedupeKey = 'MS:' + dayKey + ':' + (plate || carModel || name || '-') + ':' + amount;
    // 店払い（在庫車）は同じ日に同じ車種・同じ金額が何台も来るので、ジョブIDまで入れて1台ずつ計上する
    // （実時間の job_end と毎時シンクは同じ作業記録の行なので同じジョブIDになる）
    if (shopPays && opts.jobId) dedupeKey += ':' + String(opts.jobId);
    // 提携店払いは管理者メモと通知に店名を出す（店が分からない時もそのまま計上し、店未選択と書く）
    var shopLabel = '';
    if (shopPays) {
      var shopId = String(opts.shopId || '');
      shopLabel = (shopId && typeof getShopNameById_ === 'function' && getShopNameById_(shopId)) || shopId || '店未選択';
    }
    // 2026-10-25: 現場アプリが送った定価（無い・取り分以下の時は取り分と同じ）と店の率（店マスターの値を優先）
    var listPrice = (typeof fieldListPrice_ === 'function') ? fieldListPrice_(body) : 0;
    if (!(listPrice > amount)) listPrice = amount;
    var shopRate = '';
    if (shopPays && typeof fieldShopSplit_ === 'function') {
      var sp = fieldShopSplit_(body, opts.shopId);
      if (sp.rate !== null) shopRate = String(sp.rate);
    }
    var shopKind = payType === 'shopref' ? '紹介:' : '店払い:';
    // 現場アプリ「お店の仕事」の店の車は、お店と決めた金額（定価×率ではない・2026-10-28 FieldShopMode.gs）
    var agreed = payType === 'shop' && typeof fieldIsAgreedPrice_ === 'function' && fieldIsAgreedPrice_(body);
    var realDiscount = !shopPays && listPrice > amount;   // ABA 等で定価より安くした時だけ割引として残す

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(15 * 1000)) {
      Logger.log('⚠️ recordManualJobSaleIfNeeded_ ロック取得失敗（' + sourceAction + '）');
      return null;
    }
    var linkRowIndex = Number(opts.linkRowIndex) || 0;
    var linkJobId = String(opts.linkJobId || opts.jobId || '');
    try {
      var existingId = findBookingIdByMemoKey_(dedupeKey);
      if (existingId) {
        Logger.log('ℹ️ 手動ジョブ売上は計上済み（' + dedupeKey + ' → ' + existingId + '）');
        // 2026-10-31: 以前の書き戻しが失敗した行・導入前の行は、ここで番号を結ぶ（ロックの外で）
        lock.releaseLock(); lock = null;
        if (linkRowIndex && existingId.indexOf('BK-') === 0) manualSaleLinkJob_(linkRowIndex, existingId, linkJobId);
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

      // 2026-10-26: 個人提携の紹介のお客様（QR連携済み）は紹介元を残す（紹介料の月次集計・v7-operations/IndividualPartnerOps.gs）
      var indivRef = (!shopPays && linkedChatId && typeof individualReferralFor_ === 'function') ? individualReferralFor_(linkedChatId) : '';
      var manualRow = {
        '予約ID':         newBookingId,
        '顧客ID':         linkedCustomerId,
        'チャットID':     linkedChatId,
        '車種タイプ':     String(body.vehicleType || ''),
        '車種名':         carModel,
        'プラン':         String(body.plan || ''),
        'オプション':     manualOptionCodesCsv_(body),   // Menu v4: 'GLASS_3,HEADLIGHT,BODY' 等(glassOption 互換)
        '予約日':         todayDate,
        '予約時刻':       Utilities.formatDate(startDate, tz, 'HH:mm'),
        '所要時間(分)':   duration,
        '料金(USD)':      amount,
        '進行状態':       '作業完了',
        '予約登録日時':   now,
        '決済状態':       '清算済み',   // 2026-10-25: 提携店の仕事も当社分をその場で QR で受け取る
        '請求額(USD)':    amount,
        '入金確認日時':   now,
        '催促回数':       0,
        '管理者メモ':     '客名:' + name + '｜手動ジョブ売上' +
                         (shopPays ? '｜' + shopKind + shopLabel + (agreed ? '（お店と決めた金額）' : listPrice > amount ? '（定価$' + listPrice + (shopRate ? '・お店' + shopRate + '%' : '') + '）' : '') : '') +
                         (plate ? '｜No.' + plate : '') +
                         (carModel ? '｜車:' + carModel : '') +
                         '｜' + dedupeKey,
        '割引前金額(USD)': realDiscount ? listPrice : amount,
        '割引額(USD)':    realDiscount ? Math.round((listPrice - amount) * 100) / 100 : 0,
        // 手動登録フォームで建物名が入っていれば出張、無ければ店舗と推定
        'サービスタイプ': (String(body.building || '').trim() ? '出張' : '店舗'),
        '紹介元shop_id':  indivRef
      };
      // 予約した時（記録した時）の紹介料率を写す（配分を月の途中で変えても率が変わらない・2026-10-27 ReferralAttribution.gs）
      var indivInfo = (indivRef && typeof individualPartnerInfo_ === 'function') ? individualPartnerInfo_(indivRef) : null;
      if (indivInfo) manualRow[BOOKING_REFERRAL_RATE_COL] = indivInfo.rate;
      appendRow(SHEET_NAMES.BOOKINGS, manualRow);

      // 管理者通知（best-effort）
      try {
        var cfg = getConfig();
        var text = '💰 手動ジョブ売上 記録（自動）\n' +
          '━━━━━━━━━━━━━━━━━\n' +
          '🆔 ' + newBookingId + '\n' +
          '💵 $' + amount + (shopPays
            ? '（清算済み・' + (payType === 'shopref' ? '紹介のお客さん' : 'お店の車') + '・お店から QR: ' + shopLabel +
              (agreed ? '・お店と決めた金額' : listPrice > amount ? '・定価 $' + listPrice + (shopRate ? '・お店 ' + shopRate + '%' : '') : '') + '）'
            : '（清算済み）') + '\n' +
          '👤 ' + (name || '-') +
          (carModel ? ' / ' + carModel : '') + (plate ? ' / ' + plate : '');
        sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, text, {});
      } catch (eNotify) {
        Logger.log('⚠️ 手動ジョブ売上 通知失敗（記録は成功）: ' + eNotify);
      }

      Logger.log('✅ 手動ジョブ売上 計上: ' + newBookingId + ' $' + amount +
                 '（' + sourceAction + '・' + dedupeKey + '）');
      // 2026-10-31: 作った売上行の番号を作業記録「売上予約ID」へ（作業↔売上を番号で結ぶ。ロックの外で・失敗しても売上は計上済み）
      lock.releaseLock(); lock = null;
      if (linkRowIndex) manualSaleLinkJob_(linkRowIndex, newBookingId, linkJobId);
      return newBookingId;
    } finally {
      if (lock) lock.releaseLock();
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
    // 2026-10-31: 「売上予約ID」が書いてある行は、その予約がまだあれば計上済み（管理者メモの走査を省く）。
    //   売上行を手で消していたら（番号の行き先が無い）従来どおり見直す
    var bkIds = (idx[JOBS_COL_SALE_BOOKING_] !== undefined) ? manualSalesBookingIdSet_() : null;

    rows.forEach(function(r, ri) {
      if (String(r[idx['予約ID']] || '').trim()) return;      // 予約経由は対象外
      var linked = idx[JOBS_COL_SALE_BOOKING_] !== undefined ? String(r[idx[JOBS_COL_SALE_BOOKING_]] || '').trim() : '';
      if (linked && (!bkIds || bkIds[linked])) return;
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

      // QR連携済みなら顧客チャットIDを引き継ぐ（列が無い環境では空のまま）
      var linkedChat = idx['顧客チャットID'] !== undefined
        ? String(r[idx['顧客チャットID']] || '').trim() : '';
      // 2026-10-08 D4: v2 の支払区分（列が無い環境・旧アプリの行は空＝従来どおり）
      var payTypeCell = idx['支払区分'] !== undefined ? String(r[idx['支払区分']] || '').trim() : '';
      var v2End = syncV2EndOf_(idx['v2記録(JSON)'] !== undefined ? r[idx['v2記録(JSON)']] : '');
      // 列が空でも v2記録(JSON) に支払区分があれば使う（決まった値だけ・2026-10-25）
      if (!payTypeCell && v2End.payment_type && typeof fieldPayType_ === 'function') payTypeCell = fieldPayType_({ v2: v2End });
      // 2026-10-23: 提携店払いの店（現場アプリで選んだ・確かめ済みの shop_id）
      var shopCell = idx['提携店ID'] !== undefined ? String(r[idx['提携店ID']] || '').trim() : '';
      // 現場で選んでいない時は、お客様の店QR（shop_ref）から（実時間の job_end と同じ店になる）
      if (!shopCell && (payTypeCell === 'shop' || payTypeCell === 'shopref') && linkedChat && typeof getValidShopRef_ === 'function') {
        try { shopCell = getValidShopRef_(linkedChat) || ''; } catch (eShop) { shopCell = ''; }
      }

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
        building: '',
        chatId: linkedChat,
        paymentType: payTypeCell,
        v2: v2End   // 定価・店の率（2026-10-25）
      }, 'hourly_sync:' + jobId, { shopId: shopCell, jobId: jobId, linkRowIndex: ri + 2 });   // 2026-10-31: 作業↔売上を番号で結ぶ（rows は2行目から・ジョブIDを確かめて書く）
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
 * 作業記録「v2記録(JSON)」の作業終了の部分（定価 list_price・店の率 shop_rate）。読めない時は {}
 * 2026-10-30: お店と決めた金額（price_mode）も渡す。渡さないと毎時シンクで作り直した行だけ
 *   「定価・お店の率」と出て、実時間の job_end（お店と決めた金額）と表示が食い違っていた
 */
function syncV2EndOf_(cell) {
  try {
    var o = JSON.parse(String(cell || '{}'));
    var e = (o && o.end) || {};
    return { list_price: e.list_price, shop_rate: e.shop_rate, payment_type: e.payment_type, price_mode: e.price_mode };
  } catch (err) { return {}; }
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
  return !!findBookingIdByMemoKey_(needle);
}

/**
 * 管理者メモに重複キーが「そのまま」入っている予約行の予約ID（無ければ ''）。2026-10-31: 計上済みの行の番号を作業記録へ結ぶ用
 * @param {string} needle
 * @return {string}
 */
function findBookingIdByMemoKey_(needle) {
  var sheet = getSheet(SHEET_NAMES.BOOKINGS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return '';
  var headers = getHeaderMap(SHEET_NAMES.BOOKINGS);
  var memoCol = headers['管理者メモ'];
  var idCol = headers['予約ID'];
  if (!memoCol) return '';
  var memos = sheet.getRange(2, memoCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < memos.length; i++) {
    if (memoHasKey_(String(memos[i][0] || ''), needle)) {
      var id = idCol ? String(sheet.getRange(i + 2, idCol).getValue() || '').trim() : '';
      return id || '(計上済み)';   // 予約IDが読めなくても「計上済み」は伝える（書き戻しは行わない）
    }
  }
  return '';
}

/**
 * メモにキーが「そのまま」入っているか（2026-10-23）。キーの直後が続きの文字なら別のキーとみなす
 * 例: MS:…:Camry:10 は MS:…:Camry:100 や MS:…:Camry:10:JOB-… の中では一致にしない
 */
function memoHasKey_(memo, needle) {
  var i = memo.indexOf(needle);
  while (i !== -1) {
    if (!/[0-9A-Za-z.:_-]/.test(memo.charAt(i + needle.length))) return true;
    i = memo.indexOf(needle, i + 1);
  }
  return false;
}
