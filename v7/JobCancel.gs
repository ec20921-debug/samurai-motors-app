/**
 * JobCancel.gs — 現場アプリの「この作業を取り消す（アプリのテスト・押し間違い）」（2026-11-05）
 *
 * 2026-11-05: アプリのテストで始めた「お店の仕事」が、本物の提携店（LUXE Auto）のグループに「作業開始」として届いた。
 *   アプリには作業をやめる方法が無く、作業記録の行はクラウドから手で消した（3回目: 10/29 City Golf・11/1 STAREX）。
 *   Daisuke「両方直して」で、現場アプリに取り消しボタンを足し、その送り先をここに置く。
 *
 *   - 対象は予約のない作業だけ（お店の仕事・予約なしのお客さん）。予約つきは HAS_BOOKING で受け付けない
 *     （作業開始で予約の進行状態を「作業中」にし、お客様にも開始を知らせているため、戻し方は別の判断が要る）
 *   - 作業記録の行（client_id = 作業開始の端末採番ID）の 作業状態 を「中断」にする。行は消さない（経緯をたどれるように）。
 *     「中断」は 売上の自動計上（ManualSales.gs）・日報（v7-operations DailyReport.gs）・提携店の集計
 *     （v7-operations ScoutBoardShopLinks.gs）・QR連携（ManualCustomerLink.gs）のどれにも入らない（どれも 作業状態=完了 だけ）
 *   - 作業終了がもう届いた行は取り消さない（ALREADY_ENDED。売上・請求が出たあと）
 *   - 作業開始が届いていない（行が無い）時は ok（取り消すものが無い。端末は送信済みにしてよい）
 *   - 管理グループ（一般）に1回だけ知らせる。開始の知らせ（管理グループ・お店や建物のグループ）は
 *     ボットが送ったメッセージの ID を残していないので自動では消せない → 手で消す案内を添える
 *
 * 応答は JobIdempotency.gs と同じ形（client_id を必ず返す）:
 *   ok / duplicate … 端末は送信済みにする
 *   error          … retryable=false は端末で「要確認」（ALREADY_ENDED・HAS_BOOKING・不正なID）
 */

var JOB_CANCEL_STATE_ = '中断';

function apiJobCancelV2(body) {
  var cid = String(body.client_id || '');
  var jcid = String(body.job_client_id || '');
  if (!JOB_CLIENT_ID_RE_.test(cid)) return jobErr_(body, 'INVALID_CLIENT_ID', false);
  if (!JOB_CLIENT_ID_RE_.test(jcid) || jcid === cid) return jobErr_(body, 'INVALID_JOB_CLIENT_ID', false);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return jobErr_(body, 'BUSY', true);
  var d, jobId;
  try {
    var row = findRow(SHEET_NAMES.JOBS, 'client_id', jcid);
    if (!row) return jobEcho_({ status: 'ok', result: 'not_started' }, body);
    d = row.data || {};
    jobId = String(d['ジョブID'] || '');
    var state = String(d['作業状態'] || '');
    if (state === JOB_CANCEL_STATE_) return jobEcho_({ status: 'duplicate', jobId: jobId }, body);
    if (String(d['予約ID'] || '').replace(/^'/, '')) return jobErr_(body, 'HAS_BOOKING', false, { jobId: jobId });
    if (state === '完了' || d['完了イベントID']) return jobErr_(body, 'ALREADY_ENDED', false, { jobId: jobId });
    updateRow(SHEET_NAMES.JOBS, row.rowIndex, {
      '作業状態':     JOB_CANCEL_STATE_,
      'v2記録(JSON)': jobV2Json_(d['v2記録(JSON)'], { cancel: {
        client_id: cid, at: new Date().toISOString(), by: String(body._staffUserId || body._authUserId || ''),
        reason: 'test_or_mistake', app_version: jobSafeText_(body.app_version, 40) } })
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  // ── ロックの外: 管理グループへ（届かなくても取り消しは済んでいる＝ok を返す） ──
  try {
    jobCancelNotifyAdmin_(jobId, d, body);
  } catch (e) {
    Logger.log('⚠️ 作業の取り消し: 管理グループへの通知に失敗（取り消しは済み）job=' + jobId + ' ' + e);
  }
  return jobEcho_({ status: 'ok', jobId: jobId }, body);
}

/** 管理グループ（一般）への知らせ。開始の知らせを送った先（お店・建物のグループ）を手で消す案内つき */
function jobCancelNotifyAdmin_(jobId, d, body) {
  var cfg = getConfig();
  if (!cfg || !cfg.adminGroupId) return;
  var st = {};
  try { st = (JSON.parse(String(d['v2記録(JSON)'] || '{}')) || {}).start || {}; } catch (e) { st = {}; }

  var shopId = String(st.shop_id || ''), shopName = '';
  if (shopId) {
    try { shopName = (typeof getShopNameById_ === 'function' && getShopNameById_(shopId)) || shopId; } catch (e1) { shopName = shopId; }
  }
  var resName = '';
  if (st.residence_id) {
    try {
      var res = (typeof fieldResidenceById_ === 'function') ? fieldResidenceById_(st.residence_id, st.residence_who) : null;
      resName = res ? String(res.name || '') : String(st.residence_id);
    } catch (e2) { resName = String(st.residence_id); }
  }
  var groups = [shopName, resName].filter(function(g) { return !!g; });

  var text = '🗑 作業の取り消し（アプリのテスト・押し間違い）\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    '🆔 ' + (jobId || '-') + '\n' +
    (shopName ? '🏪 提携店: ' + shopName + '\n' : '') +
    (!shopId && st.new_shop_name ? '🏪 新しいお店: ' + String(st.new_shop_name) + '\n' : '') +
    (resName ? '🏢 ' + resName + '\n' : '') +
    '🚗 ' + (String(d['車種'] || '') || '-') + '\n' +
    '🕐 開始: ' + jobCancelTime_(d['開始時刻']) + '\n' +
    '👤 取り消した人: ' + jobCancelWho_(body) + '\n' +
    '作業記録は「中断」にしました（売上・請求は出ません）。\n' +
    '📌 このグループ' + (groups.length ? 'と「' + groups.join('」「') + '」のグループ' : '') +
    'に届いた「▶️ 作業開始」は自動では消えません。必要なら長押し →「削除」してください';
  sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, text, {});
}

/** 取り消した人（スタッフマスターの名前。確かめられない時は「スタッフ不明」） */
function jobCancelWho_(body) {
  try {
    var st = (typeof staffByChatId_ === 'function') ? staffByChatId_((body && (body._staffUserId || body._authUserId)) || '') : null;
    if (st && (st.nameJp || st.nameEn)) return String(st.nameJp || st.nameEn);
  } catch (e) { /* 名前は無くても続ける */ }
  return '（スタッフ不明）';
}

/** 開始時刻（シートの日時）→ プノンペンの「M/d HH:mm」 */
function jobCancelTime_(v) {
  if (!v) return '-';
  try {
    var dt = (v instanceof Date) ? v : new Date(v);
    if (isNaN(dt.getTime())) return String(v);
    return Utilities.formatDate(dt, 'Asia/Phnom_Penh', 'M/d HH:mm');
  } catch (e) {
    return String(v);
  }
}
