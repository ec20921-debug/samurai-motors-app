/**
 * JobStartPhotos.gs — 作業開始の「知らせ」と「作業前の写真」を分けて受ける（現場アプリ v2・2026-10-30）
 *
 * [なぜ]
 *   2026-10-30 BK-20261028-001: 現場で 15:27 に作業開始を押したのに、管理グループに届いたのは 16:34（プノンペン）。
 *   作業開始は写真6枚（約1.4MB）と一緒に1回で送るため、地下駐車場など電波の弱い所では送り切る前に
 *   スマホを置いてしまい、次にアプリを開くまで止まっていた（送信待ち箱はアプリが画面に出ている間だけ送る）。
 *
 * [しくみ]
 *   現場アプリは、このサーバーが対応していると知っている時だけ（booking_today の caps.startPhotos）、
 *   作業開始を2つに分けて送る:
 *     ① job_start（photos_follow: 写真の枚数・写真なし）… 数KBなのですぐ届く
 *        → 作業記録の行・予約ステータス・管理グループへ文字の通知（「写真はあとから届きます」）
 *     ② job_start_photos（写真つき・job_client_id = ①の client_id）… ①が届いたあとに送る
 *        → 写真の保存・Before写真URL・お客様へ（文と写真）・管理グループへ写真・店／提携先のグループへ（文と写真）
 *   お客様と店・提携先のグループへの届き方は今までどおり（文と写真をそろえて送る）。早くなるのは管理グループの知らせだけ。
 *   作業終了は②のあとに送る（アプリ側の送信待ち箱で順番を守る）。
 *   対応していない古いアプリ・古いサーバーの組み合わせでは、今までどおり1回で送る。
 */

var JOBS_COL_START_PHOTOS_SENT_ = 'Before写真配信日時';   // JobIdempotency.gs JOBS_V2_COLS_ に含める
var START_PHOTOS_MAX_ = 30;

/** 現場アプリに知らせる「このサーバーでできること」（booking_today の応答に入れる）。写真の上限もここから（アプリと一本化） */
function fieldAppCaps_() {
  return { startPhotos: 1, startPhotosMax: START_PHOTOS_MAX_ };
}

/** ①の本文の「写真はあとから届く」枚数。無い・おかしい値は 0（今までどおり1回で受ける） */
function startPhotosFollow_(body) {
  var n = Math.floor(Number(body && body.photos_follow) || 0);
  return (n > 0 && n <= START_PHOTOS_MAX_) ? n : 0;
}

/**
 * POST job_start_photos — ②作業前の写真
 * body: client_id（この送信の ID）・job_client_id（①の client_id）・①と同じ項目・beforePhotos
 * 予約IDと開始で選んだ店は①で記録した行の値を使う（この本文の値は使わない）
 */
function apiJobStartPhotosV2(body) {
  var cid = String(body.client_id || '');
  var jcid = String(body.job_client_id || '');
  if (!JOB_CLIENT_ID_RE_.test(cid)) return jobErr_(body, 'INVALID_CLIENT_ID', false);
  if (!JOB_CLIENT_ID_RE_.test(jcid)) return jobErr_(body, 'INVALID_JOB_CLIENT_ID', false);

  var cache = CacheService.getScriptCache();
  var key = 'jobdeliv:startphotos:' + jcid;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return jobErr_(body, 'BUSY', true);
  var row, jobId;
  try {
    try { ensureJobsV2Columns_(); } catch (eCol) {
      Logger.log('⚠️ apiJobStartPhotosV2: 列の確保に失敗 ' + eCol);
      return jobErr_(body, 'BUSY', true, { message: 'columns not ready' });
    }
    row = findRow(SHEET_NAMES.JOBS, 'client_id', jcid);
    // ①がまだ届いていない（アプリは①→②の順に送るので、①の再送を待つ）
    if (!row) return jobErr_(body, 'START_NOT_FOUND', true);
    jobId = String(row.data['ジョブID'] || '');
    if (row.data[JOBS_COL_START_PHOTOS_SENT_]) return jobEcho_({ status: 'duplicate', jobId: jobId }, body);
    // 同じ送信が同時に来たとき、配信は片方だけ（もう片方は後で再送してもらう）
    if (cache.get(key)) return jobErr_(body, 'IN_PROGRESS', true, { jobId: jobId });
    cache.put(key, '1', JOB_DELIVERING_TTL_);
  } finally {
    lock.releaseLock();
  }

  // ── ロックの外: 写真保存・配信（apiJobStart の写真の回） ──
  var res;
  try {
    startPhotosFromRow_(body, row.data);
    var fieldShop = (!body.bookingId && typeof validFieldShopId_ === 'function') ? validFieldShopId_(body.v2.shop_id) : '';
    var lastChance = jobBumpTries_('startphotos', jcid);
    // cid は①と同じ（お客様・店のグループへの「送り済み」の印を①と共有する）
    res = apiJobStart(body, { part: 'photos', rowIndex: row.rowIndex, jobId: jobId, cid: jcid,
                              skipCustomer: !!row.data['完了イベントID'], lastChance: lastChance, fieldShopId: fieldShop });
    if (res && res.status === 'ok' && res.warning === 'DELIVERY_PARTIAL') {
      jobFlagNeedsCheck_(row.rowIndex, row.data['v2記録(JSON)'], 'startphotos', res);
      warnStartPhotos_('partial', body.bookingId, body.name, res);
    }
    if (res && res.status === 'ok') {
      var sent = {};
      sent[JOBS_COL_START_PHOTOS_SENT_] = new Date();
      try { updateRow(SHEET_NAMES.JOBS, row.rowIndex, sent); } catch (e2) {
        Logger.log('⚠️ Before写真配信日時の記録失敗: ' + e2);
      }
    }
  } catch (e) {
    res = { status: 'error', message: String(e) };
  } finally {
    cache.remove(key);   // 途中で例外になっても「配信中」の印を残さない
  }
  res = res || { status: 'error', message: 'unknown' };
  res.jobId = jobId;
  if (res.status === 'error') res.retryable = true;
  return jobEcho_(res, body);
}

/**
 * ②の本文のうち、①で記録した値で置き換えるもの（②の本文の値は信じない）
 *   予約ID・開始時刻（キャプション）・v2（開始で選んだ店・傷の文章）。①の記録が読めない時は店へ送らない側に倒す
 *   写真は上限まで（①の宣言の上限と同じ）
 */
function startPhotosFromRow_(body, rowData) {
  body.bookingId = String(rowData['予約ID'] || '').replace(/^'/, '');
  var rowStart = rowData['開始時刻'];
  if (rowStart && typeof rowStart.getTime === 'function' && !isNaN(rowStart.getTime())) body.startTime = rowStart.toISOString();
  var startV2 = null;
  try {
    startV2 = JSON.parse(String(rowData['v2記録(JSON)'] || '{}')).start || null;
  } catch (eJson) {
    Logger.log('⚠️ apiJobStartPhotosV2: 開始の記録を読めず（店へは送らない） ' + eJson);
  }
  body.v2 = startV2 || { damage: [] };
  body.beforePhotos = (body.beforePhotos || []).slice(0, START_PHOTOS_MAX_);
}

/**
 * 「写真はあとから届きます」と知らせた作業で、写真がそろわなかった時に管理グループへ一言（一般スレッド）
 * @param {string} why - 'partial'（送り直しの上限で先へ進めた）/ 'missing'（作業終了の時点で写真がまだ届いていない）
 */
function warnStartPhotos_(why, bookingId, name, res) {
  try {
    var who = [bookingId ? '🆔 ' + bookingId : '', '👤 ' + (name || '-')].filter(String).join(' ／ ');
    var text = why === 'missing'
      ? '⚠️ 作業前の写真がまだ届いていません（' + who + '）\n現場アプリに「未送信」が残っていないか、Run Kosal さんに確認してください'
      : '⚠️ 作業前の写真を送り切れませんでした（' + who + '・保存 ' + ((res && res.photosSaved) || 0) + '/' + ((res && res.photosExpected) || 0) + '枚）\n作業記録の Before写真URL と Drive を確認してください';
    sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId, text);
  } catch (e) {
    Logger.log('⚠️ warnStartPhotos_(' + why + '): ' + e);
  }
}

/**
 * 作業終了の時（apiJobEndV2）: ①で「写真はあとから」と知らせたのに②がまだ届いていなければ管理グループへ知らせる
 * （現場アプリは②が「要確認」になっても作業終了を止めない＝売上を止めないため・2026-10-30）
 */
function warnIfStartPhotosMissing_(rowData, bookingId, name) {
  try {
    if (!rowData || rowData[JOBS_COL_START_PHOTOS_SENT_]) return false;
    var follow = 0;
    try { follow = Number(JSON.parse(String(rowData['v2記録(JSON)'] || '{}')).start_photos_follow) || 0; } catch (e) {}
    if (follow <= 0) return false;
    warnStartPhotos_('missing', bookingId, name, null);
    return true;
  } catch (err) {
    Logger.log('⚠️ warnIfStartPhotosMissing_: ' + err);
    return false;
  }
}

/**
 * ②の管理グループへの写真（文字の通知は①で送り済み）。どの作業の写真かをキャプションに添える
 * @return {boolean} 届いたか（送る写真がもともと無い時も true）
 */
function sendStartPhotosToAdmin_(adminGroupId, threadId, photoResult, body, bookingId) {
  try {
    if (photoResult.blobs.length === 0) return !(body.beforePhotos || []).length;
    var caption = '📷 Before ' + photoResult.urls.length + '枚（作業開始 ' + formatISOtoPhnomPenh(body.startTime) + '）\n' +
      (bookingId ? '🆔 ' + bookingId + '\n' : '') +
      '👤 ' + (body.name || '-');
    var opts = threadId ? { message_thread_id: threadId } : {};
    var res = sendPhotoAlbum(BOT_TYPE.BOOKING, adminGroupId, photoResult.blobs, caption, opts);
    if (!(res && res.ok) && opts.message_thread_id) {
      res = sendPhotoAlbum(BOT_TYPE.BOOKING, adminGroupId, photoResult.blobs, caption, {});   // トピックが消えている等 → 一般スレッド
    }
    return !!(res && res.ok);
  } catch (e) {
    Logger.log('⚠️ 管理グループ写真送信失敗(start photos): ' + e);
    return false;
  }
}
