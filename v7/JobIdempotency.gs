/**
 * JobIdempotency.gs — 現場アプリ v2 の作業開始・終了を「同じ送信は1件にまとめる」ための入口
 *
 * 2026-10-08（FieldApp_v2_Production_Plan_v0.2 / A-1）:
 *   v2 アプリは圏外でも端末に保存して後から送り直す（送信待ち箱）。現行の apiJobStart / apiJobEnd は
 *   送るたびに行追加・写真保存・通知を行うため、そのままでは「写真が顧客に2回届く・行が2本」になる。
 *
 *   - body.client_id がある送信（v2）だけここを通す。無い送信（旧 job-manager.html）は従来どおり
 *   - ロックは「列の確認 → client_id で行を探す → ジョブID採番 → 行を書く」の短い区間だけ。
 *     ScriptLock は予約確定・決済QR・手動売上と共有なので、写真保存・通知・売上計上はロックの外で行う
 *   - 配信（顧客・管理・店舗への通知）は「開始配信日時 / 終了配信日時」列で1回だけ。
 *     管理通知が届かない・写真を1枚も保存できない場合は配信済みにせず、送り直しで再配信する
 *   - 同時に同じ送信が2本来た場合は CacheService の「配信中」印で片方だけが配信し、
 *     もう片方には IN_PROGRESS（再送してよい）を返す＝アプリは「送信済み」にしない
 *   - 応答には必ず client_id を返す（アプリはこれを見て「送信済み」にする）
 *
 * 応答 status:
 *   ok        … 今回配信まで完了
 *   duplicate … 以前に配信まで完了済み（アプリは送信済みにしてよい）
 *   error     … retryable=true なら後で再送、false なら「要確認」として本人に見せる
 */

var JOBS_V2_COLS_ = [
  'client_id',            // ジョブ単位の端末採番ID（作業開始で記録）
  '完了イベントID',        // 作業終了イベントの端末採番ID
  'アプリ版',
  '受信日時',              // 作業開始の受信時刻（サーバー）
  '終了受信日時',          // 作業終了の受信時刻（サーバー）
  '送信日時(端末)',
  'スタッフチャットID',    // Telegram 署名で確認できた送り主（確認できない時は空）
  '施工時間(分)',
  '支払区分',              // cash / aba / shop / free / later（売上の自動計上判定に使う）
  '開始配信日時',
  '終了配信日時',
  'v2記録(JSON)'
];
var JOB_DELIVERING_TTL_ = 180;          // 配信中の印（秒）
var JOB_V2_JSON_MAX_ = 40000;           // セル上限 50,000 文字に余裕を持たせる
var JOB_CLIENT_ID_RE_ = /^[A-Za-z0-9-]{8,64}$/;

/**
 * 作業記録の末尾に v2 用の列を足し、書いた後に全列そろっているか確かめる（ロック内で呼ぶ）
 * そろっていなければ例外（呼び出し側で BUSY として再送させる）
 */
function ensureJobsV2Columns_() {
  var cache = CacheService.getScriptCache();
  if (cache.get('jobs_v2_cols_ok')) return;
  var sheet = getSheet(SHEET_NAMES.JOBS);
  var headers = getHeaderMap(SHEET_NAMES.JOBS);
  var missing = JOBS_V2_COLS_.filter(function(c) { return !headers[c]; });
  if (missing.length > 0) {
    var start = sheet.getLastColumn() + 1;
    var lastNeeded = start + missing.length - 1;
    if (sheet.getMaxColumns() < lastNeeded) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), lastNeeded - sheet.getMaxColumns());
    }
    sheet.getRange(1, start, 1, missing.length).setValues([missing]);
    SpreadsheetApp.flush();
    var after = getHeaderMap(SHEET_NAMES.JOBS);
    var still = JOBS_V2_COLS_.filter(function(c) { return !after[c]; });
    if (still.length > 0) throw new Error('JOBS_V2_COLUMNS_MISSING: ' + still.join(','));
  }
  cache.put('jobs_v2_cols_ok', '1', 21600);
}

function jobEcho_(res, body) {
  res = res || {};
  res.client_id = String(body.client_id || '');
  res.request_id = String(body.request_id || body.client_id || '');
  if (res.status === 'ok' || res.status === 'duplicate') res.ok = true;
  if (res.status === 'error' && res.retryable === undefined) res.retryable = true;
  return res;
}

function jobErr_(body, code, retryable, extra) {
  var r = { status: 'error', error: code, retryable: !!retryable };
  Object.keys(extra || {}).forEach(function(k) { r[k] = extra[k]; });
  return jobEcho_(r, body);
}

/** 送り主（Telegram 署名で確認できた user.id）。Router が body._authUserId に入れる */
function jobStaffChatId_(body) {
  return String(body._authUserId || '');
}

/** 端末の日時文字列を Date に（不正なら fallback） */
function jobDate_(v, fallback) {
  if (!v) return fallback;
  var d = new Date(v);
  return isNaN(d.getTime()) ? fallback : d;
}

function jobV2Json_(prevJson, part) {
  var obj = {};
  try { if (prevJson) obj = JSON.parse(prevJson); } catch (e) {}
  Object.keys(part || {}).forEach(function(k) { obj[k] = part[k]; });
  var s = JSON.stringify(obj);
  if (s.length > JOB_V2_JSON_MAX_) s = JSON.stringify({ truncated: true, size: s.length });
  return s;
}

/** セルに数式として解釈されないよう先頭の = + - @ を無害化 */
function jobSafeText_(v, maxLen) {
  var s = String(v || '').slice(0, maxLen || 100);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function jobPayType_(body) {
  var pt = String((body.v2 && body.v2.payment_type) || '');
  return /^(cash|aba|shop|free|later)$/.test(pt) ? pt : '';
}

var JOB_MAX_DELIVERY_TRIES_ = 3;   // これを超えたら「配信済み＋要確認」で先へ進める

/** v2: この送信の顧客通知がすでに済んだか（再送で重複させない）。opts.skipCustomer は送らない指定 */
function jobCustSent_(opts, phase) {
  if (!opts || !opts.cid) return false;
  if (opts.skipCustomer) return true;
  return !!CacheService.getScriptCache().get('jobcust:' + phase + ':' + opts.cid);
}
function jobMarkCustSent_(opts, phase) {
  if (opts && opts.cid) CacheService.getScriptCache().put('jobcust:' + phase + ':' + opts.cid, '1', 21600);
}

/** 配信の試行回数を数え、上限に達したら true（最後の1回＝失敗しても配信済みにする） */
function jobBumpTries_(phase, cid) {
  var cache = CacheService.getScriptCache();
  var key = 'jobtry:' + phase + ':' + cid;
  var n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 21600);
  return n >= JOB_MAX_DELIVERY_TRIES_;
}

/** 上限到達で配信済みにしたとき、要確認として記録 */
function jobFlagNeedsCheck_(rowIndex, rowJson, phase, res) {
  try {
    updateRow(SHEET_NAMES.JOBS, rowIndex, {
      'v2記録(JSON)': jobV2Json_(rowJson, (function() { var o = {}; o['delivery_warning_' + phase] = {
        at: new Date().toISOString(), adminSent: res && res.adminSent, photosSaved: res && res.photosSaved }; return o; })())
    });
  } catch (e) {}
  Logger.log('⚠️ 要確認: v2 ' + phase + ' の配信が上限回数失敗したため配信済みとして続行 row=' + rowIndex);
}

// ====== 作業開始 ======

function apiJobStartV2(body) {
  var cid = String(body.client_id || '');
  if (!cid) return apiJobStart(body);
  if (!JOB_CLIENT_ID_RE_.test(cid)) return jobErr_(body, 'INVALID_CLIENT_ID', false);

  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return jobErr_(body, 'BUSY', true);
  var row, jobId;
  try {
    try { ensureJobsV2Columns_(); } catch (eCol) {
      Logger.log('⚠️ apiJobStartV2: 列の確保に失敗 ' + eCol);
      return jobErr_(body, 'BUSY', true, { message: 'columns not ready' });
    }
    row = findRow(SHEET_NAMES.JOBS, 'client_id', cid);
    if (row) {
      jobId = String(row.data['ジョブID'] || '');
      if (row.data['開始配信日時']) {
        return jobEcho_({ status: 'duplicate', jobId: jobId }, body);
      }
      // 終了が先に届いていた（開始の遅延到着）は下で skipCustomer にする（写真保存と管理通知は行う）
    } else {
      jobId = generateDateSeqId('JOB', SHEET_NAMES.JOBS, 'ジョブID');
      appendRow(SHEET_NAMES.JOBS, {
        'ジョブID':           jobId,
        '予約ID':             jobSafeText_(body.bookingId, 40),
        '作業状態':           '作業中',
        '開始時刻':           jobDate_(body.startTime, new Date()),
        'client_id':          cid,
        'アプリ版':           jobSafeText_(body.app_version, 40),
        '受信日時':           new Date(),
        '送信日時(端末)':     jobDate_(body.sent_at, ''),
        'スタッフチャットID': jobStaffChatId_(body),
        'v2記録(JSON)':       jobV2Json_('', { start: body.v2 || null })
      });
      SpreadsheetApp.flush();
      row = findRow(SHEET_NAMES.JOBS, 'client_id', cid);
      if (!row) return jobErr_(body, 'BUSY', true, { message: 'row not visible yet' });
    }
    // 同じ送信が同時に来たとき、配信は片方だけ（もう片方は後で再送してもらう）
    var key = 'jobdeliv:start:' + cid;
    if (cache.get(key)) return jobErr_(body, 'IN_PROGRESS', true, { jobId: jobId });
    cache.put(key, '1', JOB_DELIVERING_TTL_);
  } finally {
    lock.releaseLock();
  }

  // ── ロックの外: 写真保存・行の残り項目・3方向配信（既存処理を行指定で実行） ──
  var lastChance = jobBumpTries_('start', cid);
  var res;
  try {
    res = apiJobStart(body, { rowIndex: row.rowIndex, jobId: jobId, cid: cid,
                              skipCustomer: !!(row.data && row.data['完了イベントID']), lastChance: lastChance });
  } catch (e) {
    res = { status: 'error', message: String(e) };
  }
  if (res && res.status === 'ok' && res.warning === 'DELIVERY_PARTIAL') {
    jobFlagNeedsCheck_(row.rowIndex, row.data['v2記録(JSON)'], 'start', res);
  }
  if (res && res.status === 'ok') {
    try { updateRow(SHEET_NAMES.JOBS, row.rowIndex, { '開始配信日時': new Date() }); } catch (e2) {
      Logger.log('⚠️ 開始配信日時の記録失敗: ' + e2);
    }
  }
  cache.remove('jobdeliv:start:' + cid);
  res = res || { status: 'error', message: 'unknown' };
  res.jobId = jobId;
  if (res.status === 'error') res.retryable = true;
  return jobEcho_(res, body);
}

// ====== 作業終了 ======

function apiJobEndV2(body) {
  var cid = String(body.client_id || '');
  var jcid = String(body.job_client_id || '');
  if (!cid) return apiJobEnd(body);
  if (!JOB_CLIENT_ID_RE_.test(cid)) return jobErr_(body, 'INVALID_CLIENT_ID', false);
  if (!JOB_CLIENT_ID_RE_.test(jcid)) return jobErr_(body, 'INVALID_JOB_CLIENT_ID', false);

  var cache = CacheService.getScriptCache();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return jobErr_(body, 'BUSY', true);
  var row, jobId;
  try {
    try { ensureJobsV2Columns_(); } catch (eCol) {
      Logger.log('⚠️ apiJobEndV2: 列の確保に失敗 ' + eCol);
      return jobErr_(body, 'BUSY', true, { message: 'columns not ready' });
    }
    row = findRow(SHEET_NAMES.JOBS, 'client_id', jcid);
    if (!row) {
      // 作業開始がまだ届いていない（アプリは開始→終了の順に送るので、開始の再送を待つ）
      return jobErr_(body, 'START_NOT_FOUND', true);
    }
    jobId = String(row.data['ジョブID'] || '');
    var prevEnd = String(row.data['完了イベントID'] || '');
    if (prevEnd && prevEnd !== cid) {
      Logger.log('⚠️ END_CONFLICT job=' + jobId + ' prev=' + prevEnd + ' new=' + cid);
      return jobErr_(body, 'END_CONFLICT', false, { jobId: jobId });
    }
    if (prevEnd === cid && row.data['終了配信日時']) {
      return jobEcho_({ status: 'duplicate', jobId: jobId }, body);
    }
    var key = 'jobdeliv:end:' + cid;
    if (cache.get(key)) return jobErr_(body, 'IN_PROGRESS', true, { jobId: jobId });
    var endUpd = {
      '完了イベントID': cid,
      '終了受信日時':   new Date(),
      '施工時間(分)':   Number(body.duration) || 0,
      'v2記録(JSON)':   jobV2Json_(row.data['v2記録(JSON)'], { end: body.v2 || null })
    };
    var pt = jobPayType_(body);
    if (!pt && !body.bookingId && Number(body.amount) > 0) {
      pt = 'unknown';               // 現金扱いで自動計上しない（fail-closed）
      body.paymentType = 'unknown';
    }
    if (pt) endUpd['支払区分'] = pt;
    updateRow(SHEET_NAMES.JOBS, row.rowIndex, endUpd);
    SpreadsheetApp.flush();
    cache.put(key, '1', JOB_DELIVERING_TTL_);
  } finally {
    lock.releaseLock();
  }

  // ── ロックの外: 写真保存・行更新・3方向配信・売上計上・QR（既存処理を行指定で実行） ──
  var lastChanceEnd = jobBumpTries_('end', cid);
  var res;
  try {
    res = apiJobEnd(body, { rowIndex: row.rowIndex, jobId: jobId, rowData: row.data, cid: cid, lastChance: lastChanceEnd });
  } catch (e) {
    res = { status: 'error', message: String(e) };
  }
  if (res && res.status === 'ok' && res.warning === 'DELIVERY_PARTIAL') {
    jobFlagNeedsCheck_(row.rowIndex, row.data['v2記録(JSON)'], 'end', res);
  }
  if (res && res.status === 'ok') {
    try { updateRow(SHEET_NAMES.JOBS, row.rowIndex, { '終了配信日時': new Date() }); } catch (e2) {
      Logger.log('⚠️ 終了配信日時の記録失敗: ' + e2);
    }
  }
  cache.remove('jobdeliv:end:' + cid);
  res = res || { status: 'error', message: 'unknown' };
  res.jobId = jobId;
  if (res.status === 'error') res.retryable = true;
  return jobEcho_(res, body);
}
