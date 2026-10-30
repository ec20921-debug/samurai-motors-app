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

/** 現場アプリに知らせる「このサーバーでできること」（booking_today の応答に入れる） */
function fieldAppCaps_() {
  return { startPhotos: 1 };
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
  if (row.data['予約ID'] !== undefined) body.bookingId = String(row.data['予約ID'] || '').replace(/^'/, '');
  try {
    var startV2 = JSON.parse(String(row.data['v2記録(JSON)'] || '{}')).start;
    if (startV2) body.v2 = startV2;   // 傷・へこみの文章と開始で選んだ店は①の記録から
  } catch (eJson) {
    Logger.log('⚠️ apiJobStartPhotosV2: 開始の記録を読めず ' + eJson);
  }
  var fieldShop = (!body.bookingId && typeof validFieldShopId_ === 'function') ? validFieldShopId_(body.v2 && body.v2.shop_id) : '';
  var lastChance = jobBumpTries_('startphotos', jcid);
  var res;
  try {
    // cid は①と同じ（お客様・店のグループへの「送り済み」の印を①と共有する）
    res = apiJobStart(body, { part: 'photos', rowIndex: row.rowIndex, jobId: jobId, cid: jcid,
                              skipCustomer: !!row.data['完了イベントID'], lastChance: lastChance, fieldShopId: fieldShop });
  } catch (e) {
    res = { status: 'error', message: String(e) };
  }
  if (res && res.status === 'ok' && res.warning === 'DELIVERY_PARTIAL') {
    jobFlagNeedsCheck_(row.rowIndex, row.data['v2記録(JSON)'], 'startphotos', res);
  }
  if (res && res.status === 'ok') {
    var sent = {};
    sent[JOBS_COL_START_PHOTOS_SENT_] = new Date();
    try { updateRow(SHEET_NAMES.JOBS, row.rowIndex, sent); } catch (e2) {
      Logger.log('⚠️ Before写真配信日時の記録失敗: ' + e2);
    }
  }
  cache.remove(key);
  res = res || { status: 'error', message: 'unknown' };
  res.jobId = jobId;
  if (res.status === 'error') res.retryable = true;
  return jobEcho_(res, body);
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
