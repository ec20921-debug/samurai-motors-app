/**
 * JobPhotoPre.gs — 現場アプリの写真を「撮ったそばから」先に受け取る（2026-11-13）
 *
 * 背景: 作業開始の送信は写真6枚込みで約1.4MB。現場（iPhone・ホーム画面のアイコン）は開始を押したらスマホをしまうので、
 *   送り切る前に画面が消えて止まり、次にアプリを開くまで届かなかった（10/26〜11/13 の40件中6件・43分〜3時間41分の遅れ）。
 *   お店のグループには「作業前からあった傷」の写真が作業の後に届き、作業終了と請求も後ろで待っていた。
 *
 * 直し方:
 *   1. job_photo         … 写真を1枚ずつ、撮ったその場で受け取って Drive に保存し、file_id を返す（通知はしない）
 *   2. job_start / job_end … 写真の本体ではなく file_id の一覧（photo_refs）で届く＝文字だけの軽い送信。
 *                            ここで保存済みの写真を読み、今までと同じ配信（お客様・管理・お店）をする
 *   3. job_start_notice  … 開始を押した時に写真がまだ送り切れていない時だけ、文字だけの知らせを管理グループへ先に出す
 *   4. 管理グループの通知に、時刻をプノンペンと日本の両方で書き、5分以上遅れて届いた時は遅れを書く
 *
 * 古い現場アプリ（写真の本体を beforePhotos / afterPhotos に入れて送る）は今までどおり動く。
 * 保存先の状態は持たない: file_id は端末が持ち回り、ここでは「このサーバーがこの作業のために保存した写真か」を
 *   ファイル名（pre_<作業の client_id>_<before|after>_…）で確かめる（ほかの Drive のファイルを配らせない）。
 */

var JOB_PHOTO_PHASE_RE_ = /^(before|after)$/;
var JOB_PHOTO_SLOT_RE_ = /^[A-Z0-9]{1,4}$/;
var JOB_PHOTO_FILE_ID_RE_ = /^[A-Za-z0-9_-]{10,100}$/;
var JOB_PHOTO_MAX_CHARS_ = 4000000;    // 1枚の上限（base64 の文字数・約3MB）
var JOB_PHOTO_MAX_REFS_ = 20;          // 1回の開始・終了で扱う写真の上限
var JOB_PHOTO_CACHE_SEC_ = 21600;      // 同じ写真の送り直しをまとめる時間（6時間）
var JOB_LATE_MIN_ = 5;                 // これ以上遅れて届いたら通知に遅れを書く（分）

function jobPhotoPrefix_(jcid, phase) { return 'pre_' + jcid + '_' + phase + '_'; }

// ====== 1. 写真を先に受け取る ======

function apiJobPhotoV2(body) {
  var cid = String(body.client_id || '');
  var jcid = String(body.job_client_id || '');
  var phase = String(body.phase || '');
  var slot = String(body.slot || '');
  var data = String(body.photoBase64 || '');
  if (!JOB_CLIENT_ID_RE_.test(cid)) return jobErr_(body, 'INVALID_CLIENT_ID', false);
  if (!JOB_CLIENT_ID_RE_.test(jcid)) return jobErr_(body, 'INVALID_JOB_CLIENT_ID', false);
  if (!JOB_PHOTO_PHASE_RE_.test(phase) || !JOB_PHOTO_SLOT_RE_.test(slot)) return jobErr_(body, 'INVALID_PHOTO_SLOT', false);
  if (!data) return jobErr_(body, 'NO_PHOTO', false);
  if (data.length > JOB_PHOTO_MAX_CHARS_) return jobErr_(body, 'PHOTO_TOO_LARGE', false);

  // 取り消した作業（開始が届く前の取り消しの印・JobCancel.gs）の写真は保存しない
  if (typeof jobCancelMarked_ === 'function' && jobCancelMarked_(jcid)) {
    return jobEcho_({ status: 'duplicate', result: 'cancelled' }, body);
  }

  var cache = CacheService.getScriptCache();
  var key = 'jobphoto:' + cid;
  var known = cache.get(key);
  if (known) return jobEcho_({ status: 'duplicate', file_id: known }, body);

  var file;
  try {
    var parts = data.split(',');
    var isPng = !!(parts.length > 1 && parts[0].indexOf('image/png') >= 0);
    var decoded = Utilities.base64Decode(parts.length > 1 ? parts[1] : parts[0]);
    if (!jobPhotoLooksImage_(decoded)) return jobErr_(body, 'NOT_AN_IMAGE', false);   // JPEG・PNG 以外は保存しない
    var name = jobPhotoPrefix_(jcid, phase) + slot + '_' + cid.slice(0, 8) + (isPng ? '.png' : '.jpg');
    var folder = DriveApp.getFolderById(getConfig().driveFolderWashPhotos);
    file = folder.createFile(Utilities.newBlob(decoded, isPng ? 'image/png' : 'image/jpeg', name));
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log('⚠️ apiJobPhotoV2: 保存に失敗 ' + e);
    return jobErr_(body, 'PHOTO_SAVE_FAILED', true);
  }
  var fileId = String(file.getId());
  cache.put(key, fileId, JOB_PHOTO_CACHE_SEC_);

  // 開始・終了がもう配り終わった後に届いた写真（端末が late を付ける）: 作業記録に足して、管理グループに1行知らせる
  if (body.late) {
    try { jobPhotoLate_(jcid, phase, slot, file); } catch (eLate) { Logger.log('⚠️ apiJobPhotoV2: 遅れた写真の記録に失敗 ' + eLate); }
  }
  return jobEcho_({ status: 'ok', file_id: fileId }, body);
}

/** 先頭のバイトで JPEG（FF D8）か PNG（89 50）かを確かめる（Apps Script のバイトは -128〜127） */
function jobPhotoLooksImage_(bytes) {
  if (!bytes || bytes.length < 4) return false;
  var b0 = bytes[0] & 255, b1 = bytes[1] & 255;
  return (b0 === 0xFF && b1 === 0xD8) || (b0 === 0x89 && b1 === 0x50);
}

/** 配信の後に届いた写真を作業記録の写真URLに足し、管理グループ（一般）に知らせる */
function jobPhotoLate_(jcid, phase, slot, file) {
  var row = findRow(SHEET_NAMES.JOBS, 'client_id', jcid);
  if (!row) return;
  var col = phase === 'before' ? 'Before写真URL' : 'After写真URL';
  var url = String(file.getUrl());
  var prev = String(row.data[col] || '');
  if (prev.indexOf(url) < 0) {
    var upd = {}; upd[col] = prev ? prev + '\n' + url : url;
    updateRow(SHEET_NAMES.JOBS, row.rowIndex, upd);
  }
  sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId,
    '📷 遅れて届いた写真（' + (phase === 'before' ? '作業前' : '作業後') + '・' + slot + '）\n' +
    '🆔 ' + String(row.data['ジョブID'] || '') + '\n' +
    '🚗 ' + String(row.data['車種'] || '-') + '\n' +
    url + '\n' +
    'お客様・お店のグループには自動では送っていません。必要なら転送してください', {});
}

// ====== 2. 開始・終了で、先に受け取った写真を使う ======

/**
 * photo_refs（[{slot, file_id}]）から写真を読む。
 * 戻り値 { urls, blobs, slots, missing, failed }
 *   missing = 届いていない枠（file_id なし・別の作業の写真・下の failed も含む）
 *   failed  = file_id はあるのに Drive から読めなかった枠（一時的な不調かもしれない）。
 *             呼び出し側は、これがある間は配信せず送り直してもらう（コードレビュー [H3]:
 *             一時エラーを「届いていない写真」と決めつけると、お客様・お店へ写真が出ないまま配信済みになる）
 */
function jobPrePhotos_(jcid, phase, refs) {
  var out = { urls: [], blobs: [], slots: [], missing: [], failed: [] };
  if (!Array.isArray(refs)) return out;
  var prefix = jobPhotoPrefix_(jcid, phase);
  refs.forEach(function(r, i) {
    var slot = String((r && r.slot) || '').replace(/[^A-Z0-9]/g, '').slice(0, 4) || '?';   // 通知の文面に出るので文字を絞る
    var fid = String((r && r.file_id) || '');
    if (i >= JOB_PHOTO_MAX_REFS_ || !JOB_PHOTO_FILE_ID_RE_.test(fid)) { out.missing.push(slot); return; }
    var f;
    try {
      f = DriveApp.getFileById(fid);
      if (String(f.getName()).indexOf(prefix) !== 0) { out.missing.push(slot); return; }   // 別の作業の写真・無関係のファイルは配らない
      var blob = f.getBlob();
      out.blobs.push(blob);
      out.urls.push(String(f.getUrl()));
      out.slots.push(slot);
    } catch (e) {
      out.missing.push(slot); out.failed.push(slot);
      Logger.log('⚠️ jobPrePhotos_: ' + phase + ' ' + slot + ' を Drive から読めず ' + e);
    }
  });
  return out;
}

/** 先に受け取った写真（pre）と、本文に入ってきた写真（inline＝古いアプリ・送り直し）を1つに。順番は pre → inline */
function jobMergePhotos_(pre, inline) {
  if (!pre) return inline;
  return { urls: pre.urls.concat(inline.urls || []), blobs: pre.blobs.concat(inline.blobs || []) };
}

// ====== 3. 文字だけの知らせを先に（写真がまだ送り切れていない時だけ・端末が決める） ======

function apiJobStartNoticeV2(body) {
  var cid = String(body.client_id || '');
  var jcid = String(body.job_client_id || '');
  if (!JOB_CLIENT_ID_RE_.test(cid)) return jobErr_(body, 'INVALID_CLIENT_ID', false);
  if (!JOB_CLIENT_ID_RE_.test(jcid)) return jobErr_(body, 'INVALID_JOB_CLIENT_ID', false);

  var fieldShop = (!body.bookingId && typeof validFieldShopId_ === 'function') ? validFieldShopId_(body.v2 && body.v2.shop_id) : '';
  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return jobErr_(body, 'BUSY', true);
  var row, jobId;
  var key = 'jobdeliv:notice:' + jcid;
  try {
    try { ensureJobsV2Columns_(); } catch (eCol) {
      return jobErr_(body, 'BUSY', true, { message: 'columns not ready' });
    }
    row = findRow(SHEET_NAMES.JOBS, 'client_id', jcid);
    if (row) {
      jobId = String(row.data['ジョブID'] || '');
      // 開始がもう配り終わっている・知らせ済み・取り消した作業 → 何もしない
      if (row.data['開始配信日時'] || jobNoticeSent_(row.data) || String(row.data['作業状態'] || '') === JOB_CANCEL_STATE_) {
        return jobEcho_({ status: 'duplicate', jobId: jobId }, body);
      }
    } else if (typeof jobCancelMarked_ === 'function' && jobCancelMarked_(jcid)) {
      return jobEcho_({ status: 'duplicate', result: 'cancelled' }, body);
    } else {
      jobId = jobAppendStartRow_(body, jcid);
      SpreadsheetApp.flush();
      row = findRow(SHEET_NAMES.JOBS, 'client_id', jcid);
      if (!row) return jobErr_(body, 'BUSY', true, { message: 'row not visible yet' });
    }
    // 開始の配信が進んでいる間は出さない（全文が2回出るのを防ぐ。開始が配り終われば次の送り直しで duplicate になる）
    if (cache.get(key) || cache.get('jobdeliv:start:' + jcid)) return jobErr_(body, 'IN_PROGRESS', true, { jobId: jobId });
    cache.put(key, '1', JOB_DELIVERING_TTL_);
  } finally {
    lock.releaseLock();
  }

  var sent = false;
  try {
    var text = jobStartAdminText_(body, { fieldShopId: fieldShop }, null, '📷 写真はあとから届きます');
    var res = sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId, text, {});
    sent = !!(res && res.ok);
  } catch (e) {
    Logger.log('⚠️ apiJobStartNoticeV2: 管理通知に失敗 ' + e);
  }
  cache.remove(key);
  if (!sent) {
    // 3回届かなければあきらめる（開始の本体が届けば、そこで全文が出る）
    if (jobBumpTries_('notice', jcid)) return jobEcho_({ status: 'ok', jobId: jobId, warning: 'NOTICE_NOT_SENT' }, body);
    return jobErr_(body, 'DELIVERY_FAILED', true, { jobId: jobId });
  }
  try {
    updateRow(SHEET_NAMES.JOBS, row.rowIndex, {
      'v2記録(JSON)': jobV2Json_(row.data['v2記録(JSON)'], { start_notice: { at: new Date().toISOString(), client_id: cid } })
    });
  } catch (e2) {
    Logger.log('⚠️ apiJobStartNoticeV2: 知らせ済みの記録に失敗 ' + e2);
  }
  return jobEcho_({ status: 'ok', jobId: jobId }, body);
}

/** この作業は「文字だけの知らせ」を管理グループへ出し済みか（作業記録の行から） */
function jobNoticeSent_(rowData) {
  try { return !!JSON.parse(String((rowData && rowData['v2記録(JSON)']) || '{}')).start_notice; } catch (e) { return false; }
}

// ====== 4. 管理グループの文面（時刻は両方・遅れは書く） ======

/** 「09:29（日本 11:29）」。通知の中の時刻（プノンペン）と Telegram の表示時刻（見る人の端末）を取り違えないように */
function jobTimeBoth_(iso) {
  if (!iso) return '-';
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '-';
    return Utilities.formatDate(d, 'Asia/Phnom_Penh', 'HH:mm') + '（日本 ' + Utilities.formatDate(d, 'Asia/Tokyo', 'HH:mm') + '）';
  } catch (e) {
    return '-';
  }
}

/** 現場の操作（iso）から now まで JOB_LATE_MIN_ 分以上たっていたら「⏱ … 遅れて届きました」の1行（改行つき）。それ未満は空 */
function jobDelayLine_(iso, now) {
  if (!iso) return '';
  var t = new Date(iso).getTime();
  if (isNaN(t)) return '';
  var min = Math.floor(((now || new Date()).getTime() - t) / 60000);
  if (min < JOB_LATE_MIN_) return '';
  var h = Math.floor(min / 60), m = min % 60;
  return '⏱ 現場の操作から ' + (h > 0 ? h + '時間' : '') + m + '分 遅れて届きました\n';
}

/** お店のグループ向け: 5分以上遅れて届いた時だけ、現場で押した時刻（プノンペン）を返す。遅れていなければ空 */
function jobLateAt_(iso) {
  if (!jobDelayLine_(iso, new Date())) return '';
  try { return Utilities.formatDate(new Date(iso), 'Asia/Phnom_Penh', 'HH:mm'); } catch (e) { return ''; }
}

/** 枠が届かなかった写真の1行（改行つき）。無ければ空 */
function jobMissingLine_(pre) {
  var n = pre && pre.missing ? pre.missing.length : 0;
  return n > 0 ? '⚠️ 写真 ' + n + '枚がまだ届いていません（' + pre.missing.join('・') + '）\n' : '';
}

/**
 * 管理グループの「▶️ 作業開始」。
 *   opts.noticeSent（文字だけの知らせを出し済み）の時は、写真に添える短い文にする（同じ長文を2回出さない）
 *   bkData = 予約の行（流入元の1行に使う・無ければ null）／photoLine = 最後の1行（「📷 Before 6枚」など）
 */
function jobStartAdminText_(body, opts, bkData, photoLine) {
  opts = opts || {};
  var bookingId = body.bookingId || '';
  var shopName = opts.fieldShopId ? ((typeof getShopNameById_ === 'function' && getShopNameById_(opts.fieldShopId)) || opts.fieldShopId) : '';
  var late = jobDelayLine_(body.startTime, new Date());
  if (opts.noticeSent) {
    return '📷 作業開始の写真（開始 ' + jobTimeBoth_(body.startTime) + '）\n' +
      (bookingId ? '🆔 ' + bookingId + '\n' : '') +
      (shopName ? '🏪 提携店: ' + shopName + '\n' : '') +
      '🚗 ' + (body.carModel || '-') + ' / ' + (body.plate || '-') + '\n' +
      late + jobMissingLine_(opts.prePhotos) + photoLine;
  }
  return '▶️ 作業開始\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    (bookingId ? '🆔 ' + bookingId + '\n' : '') +
    (typeof sourceAdminLineForJob_ === 'function' && bkData ? sourceAdminLineForJob_(bkData) : '') +
    (shopName ? '🏪 提携店: ' + shopName + '\n' : '') +
    '👤 ' + (body.name || '-') + '\n' +
    '🏢 ' + (body.building || '-') + ' ' + (body.room || '') + '\n' +
    '🚗 ' + (body.carModel || '-') + ' / ' + (body.plate || '-') + '\n' +
    jobServiceLine_(body) +
    (hasAmountValue_(body.amount) ? '💵 料金: $' + body.amount + '\n' : '') +
    '🕐 開始: ' + jobTimeBoth_(body.startTime) + '\n' +
    late + jobMissingLine_(opts.prePhotos) + photoLine;
}
