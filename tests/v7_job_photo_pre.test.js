/**
 * v7: 現場アプリの写真を「撮ったそばから」先に受け取る（2026-11-13 JobPhotoPre.gs）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * v7 の実ファイル（.gs）を Node の vm に読み込み、シート・Drive・Telegram はスタブで置き換える（本番には触れない）。
 *   - job_photo: 1枚を Drive に保存して file_id を返す／同じ送信の送り直しは1枚にまとめる／取り消した作業は保存しない
 *   - 開始・終了: photo_refs の写真を読んで apiJobStart / apiJobEnd に渡す。別の作業の写真・知らないファイルは配らない
 *   - job_start_notice: 文字だけの知らせを管理グループへ1回。開始が配り終わっていれば何もしない
 *   - 管理グループの文面: 時刻はプノンペンと日本の両方・5分以上の遅れを書く
 *   - 古いアプリ（photo_refs なし）は今までどおり
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');
const JOB = '9f3b8383-7a10-4147-86df-459636f90362';
const OTHER_JOB = '11111111-2222-4333-8444-555555555555';
const P1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const P2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const NOTICE = 'bbbbbbbb-0000-4000-8000-000000000001';
const END = 'cccccccc-0000-4000-8000-000000000001';
const TINY = 'data:image/jpeg;base64,' + Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 4]).toString('base64');   // JPEG の先頭バイト
const fmt = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

function load(rows, opts) {
  opts = opts || {};
  rows = rows || [];
  const cacheStore = {}, files = {}, sent = [], updates = [], started = [], ended = [], kv = Object.assign({}, opts.kv || {});
  let seq = 0;
  const mkFile = (blob) => {
    const id = 'FILE' + String(++seq).padStart(8, '0') + 'xyz';
    const f = { id, name: blob.name, getId: () => id, getName: () => blob.name, getUrl: () => 'https://drive.example/' + id,
                getBlob: () => ({ name: blob.name, from: id }), setSharing: () => {} };
    files[id] = f; return f;
  };
  const ctx = {
    console, rows, files, sent, updates, started, ended, kv, cacheStore,
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cacheStore ? cacheStore[k] : null), put: (k, v) => { cacheStore[k] = v; }, remove: (k) => { delete cacheStore[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => opts.lockOk !== false, releaseLock: () => {} }) },
    SpreadsheetApp: { flush: () => {} },
    Logger: { log: () => {} },
    Utilities: {
      // Apps Script と同じく符号つきのバイト（-128〜127）で返す
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')).map((b) => (b > 127 ? b - 256 : b)),
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
      formatDate: (d, tz) => fmt(d, tz)
    },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 'A' }, Permission: { VIEW: 'V' },
      getFolderById: () => ({ createFile: (blob) => { if (opts.driveThrows) throw new Error('drive down'); return mkFile(blob); } }),
      getFileById: (id) => { if (opts.readThrows && opts.readThrows()) throw new Error('drive busy'); if (!files[id]) throw new Error('not found'); return files[id]; }
    },
    SHEET_NAMES: { JOBS: '作業記録' }, BOT_TYPE: { BOOKING: 'booking' },
    getConfig: () => ({ adminGroupId: '-100admin', driveFolderWashPhotos: 'FOLDER' }),
    sendMessage: (bot, chatId, text, o) => { sent.push({ chatId, text, o }); return { ok: opts.sendOk !== false }; },
    kvGet_: (k) => (k in kv ? kv[k] : null), kvSet_: (k, v) => { kv[k] = v; },
    generateDateSeqId: () => 'JOB-20261113-099',
    appendRow: (sheet, obj) => { rows.push(Object.assign({}, obj)); },
    findRow: (sheet, col, val) => { const i = rows.findIndex((r) => String(r[col]) === String(val)); return i < 0 ? null : { rowIndex: i + 2, data: Object.assign({}, rows[i]) }; },
    updateRow: (sheet, rowIndex, obj) => { updates.push({ rowIndex, obj }); Object.assign(rows[rowIndex - 2], obj); },
    sheetSafeText_: (v) => String(v),
    validFieldShopId_: (id) => (id === 'SHOP-1' ? 'SHOP-1' : ''),
    getShopNameById_: (id) => (id === 'SHOP-1' ? 'LUXE Auto' : ''),
    jobServiceLine_: () => '✨ サービス: BODY（セダン）\n',
    hasAmountValue_: (v) => v !== '' && v !== undefined && v !== null,
    apiJobStart: (b, o) => { started.push({ b, o }); return { status: 'ok' }; },
    apiJobEnd: (b, o) => { ended.push({ b, o }); return { status: 'ok' }; }
  };
  vm.createContext(ctx);
  ['JobIdempotency.gs', 'JobCancel.gs', 'JobPhotoPre.gs'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(V7, f), 'utf8'), ctx, { filename: f }));
  vm.runInContext('ensureJobsV2Columns_ = function () {};', ctx);
  return ctx;
}
const photo = (cid, extra) => Object.assign({ action: 'job_photo', client_id: cid, job_client_id: JOB, request_id: cid, phase: 'before', slot: 'F', photoBase64: TINY }, extra || {});
const startBody = (extra) => Object.assign({ action: 'job_start', client_id: JOB, job_client_id: JOB, request_id: JOB, bookingId: '', name: 'LUXE Auto',
  building: 'LUXE Auto', room: '', carModel: 'Kia Ray', plate: '', startTime: new Date().toISOString(), beforePhotos: [],
  v2: { shop_id: 'SHOP-1', mode: 'shop', photo_slots: ['F', 'B'] } }, extra || {});
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

// ── job_photo ──

test('job_photo: 1枚を保存して file_id を返す（ファイル名は pre_<作業ID>_before_<枠>_…）', () => {
  const ctx = load();
  const res = ctx.apiJobPhotoV2(photo(P1));
  assert.equal(res.status, 'ok');
  assert.equal(res.client_id, P1, '端末が送信済みにできるよう client_id を返す');
  assert.ok(res.file_id);
  assert.equal(ctx.files[res.file_id].name, 'pre_' + JOB + '_before_F_aaaaaaaa.jpg');
  assert.equal(ctx.sent.length, 0, '写真を受け取っただけでは誰にも通知しない');
});

test('job_photo: 同じ送信の送り直しは duplicate で同じ file_id（2枚保存しない）', () => {
  const ctx = load();
  const a = ctx.apiJobPhotoV2(photo(P1));
  const b = ctx.apiJobPhotoV2(photo(P1));
  assert.equal(b.status, 'duplicate');
  assert.equal(b.file_id, a.file_id);
  assert.equal(Object.keys(ctx.files).length, 1);
});

test('job_photo: 取り消した作業の写真は保存しない', () => {
  const ctx = load([], { kv: {} });
  ctx.kv[vm.runInContext('JOB_CANCEL_MARK_PREFIX_', ctx) + JOB] = '2026-11-13T00:00:00Z';
  const res = ctx.apiJobPhotoV2(photo(P1));
  assert.equal(res.status, 'duplicate');
  assert.equal(res.result, 'cancelled');
  assert.equal(Object.keys(ctx.files).length, 0);
});

test('job_photo: おかしな値は要確認（retryable=false）・Drive の失敗は送り直し（retryable=true）', () => {
  const ctx = load();
  assert.equal(ctx.apiJobPhotoV2(photo('x')).error, 'INVALID_CLIENT_ID');
  assert.equal(ctx.apiJobPhotoV2(photo(P1, { job_client_id: 'x' })).error, 'INVALID_JOB_CLIENT_ID');
  assert.equal(ctx.apiJobPhotoV2(photo(P1, { phase: 'during' })).error, 'INVALID_PHOTO_SLOT');
  assert.equal(ctx.apiJobPhotoV2(photo(P1, { slot: '../x' })).error, 'INVALID_PHOTO_SLOT');
  assert.equal(ctx.apiJobPhotoV2(photo(P1, { photoBase64: '' })).error, 'NO_PHOTO');
  const big = ctx.apiJobPhotoV2(photo(P1, { photoBase64: 'x'.repeat(4000001) }));
  assert.equal(big.error, 'PHOTO_TOO_LARGE'); assert.equal(big.retryable, false);
  const notImg = ctx.apiJobPhotoV2(photo(P1, { photoBase64: 'data:image/jpeg;base64,' + Buffer.from('<html>not an image</html>').toString('base64') }));
  assert.equal(notImg.error, 'NOT_AN_IMAGE'); assert.equal(notImg.retryable, false);
  assert.equal(Object.keys(ctx.files).length, 0, '画像でないものは保存しない');
  const png = ctx.apiJobPhotoV2(photo(P2, { photoBase64: 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4E, 0x47, 1, 2]).toString('base64') }));
  assert.equal(png.status, 'ok');
  const down = load([], { driveThrows: true }).apiJobPhotoV2(photo(P1));
  assert.equal(down.error, 'PHOTO_SAVE_FAILED'); assert.equal(down.retryable, true);
});

test('job_photo（late）: 配り終わった後に届いた写真は、作業記録に足して管理グループへ1行', () => {
  const rows = [{ 'ジョブID': 'JOB-20261113-001', 'client_id': JOB, '車種': 'Kia Ray', 'Before写真URL': 'https://drive.example/OLD', '開始配信日時': new Date() }];
  const ctx = load(rows);
  const res = ctx.apiJobPhotoV2(photo(P1, { late: 1 }));
  assert.equal(res.status, 'ok');
  assert.equal(rows[0]['Before写真URL'], 'https://drive.example/OLD\nhttps://drive.example/' + res.file_id);
  assert.equal(ctx.sent.length, 1);
  assert.ok(ctx.sent[0].text.startsWith('📷 遅れて届いた写真（作業前・F）'));
  assert.ok(ctx.sent[0].text.includes('JOB-20261113-001'));
});

// ── 開始・終了で、先に受け取った写真を使う ──

test('jobPrePhotos_: この作業のために保存した写真だけを読む（別の作業の写真・知らないIDは「届いていない」）', () => {
  const ctx = load();
  const mine = ctx.apiJobPhotoV2(photo(P1)).file_id;
  const others = ctx.apiJobPhotoV2(photo(P2, { job_client_id: OTHER_JOB })).file_id;
  const after = ctx.apiJobPhotoV2(photo('aaaaaaaa-0000-4000-8000-000000000003', { phase: 'after' })).file_id;
  const pre = ctx.jobPrePhotos_(JOB, 'before', [
    { slot: 'F', file_id: mine }, { slot: 'B', file_id: others }, { slot: 'L', file_id: after },
    { slot: 'R', file_id: '' }, { slot: 'V', file_id: 'NOSUCHFILE0001' }
  ]);
  assert.deepEqual(Array.from(pre.slots), ['F']);
  assert.deepEqual(Array.from(pre.urls), ['https://drive.example/' + mine]);
  assert.equal(pre.blobs.length, 1);
  assert.deepEqual(Array.from(pre.missing), ['B', 'L', 'R', 'V']);
  assert.deepEqual(Array.from(pre.failed), ['V'], 'file_id はあるのに Drive から読めなかった枠だけ');
});

test('作業開始: photo_refs の写真を apiJobStart に渡す（本文に写真なし＝軽い送信）', () => {
  const ctx = load();
  const f1 = ctx.apiJobPhotoV2(photo(P1)).file_id;
  const f2 = ctx.apiJobPhotoV2(photo(P2, { slot: 'B' })).file_id;
  const res = ctx.apiJobStartV2(startBody({ photo_refs: [{ slot: 'F', file_id: f1 }, { slot: 'B', file_id: f2 }] }));
  assert.equal(res.status, 'ok');
  assert.equal(ctx.started.length, 1);
  const o = ctx.started[0].o;
  assert.equal(o.prePhotos.urls.length, 2);
  assert.equal(o.prePhotos.missing.length, 0);
  assert.equal(o.noticeSent, false);
  assert.equal(o.fieldShopId, 'SHOP-1');
  assert.equal(ctx.rows[0]['client_id'], JOB);
  assert.ok(ctx.rows[0]['開始配信日時']);
});

test('作業開始: 古いアプリ（photo_refs なし）は今までどおり（prePhotos は渡さない）', () => {
  const ctx = load();
  ctx.apiJobStartV2(startBody({ beforePhotos: [TINY] }));
  assert.equal(ctx.started[0].o.prePhotos, null);
});

test('作業終了: 作業の client_id のために保存した「作業後」の写真を apiJobEnd に渡す', () => {
  const rows = [{ 'ジョブID': 'JOB-20261113-001', 'client_id': JOB, '予約ID': '', '作業状態': '作業中', '完了イベントID': '', 'v2記録(JSON)': '{"start":{"shop_id":"SHOP-1"}}' }];
  const ctx = load(rows);
  const fa = ctx.apiJobPhotoV2(photo(P1, { phase: 'after' })).file_id;
  const fb = ctx.apiJobPhotoV2(photo(P2, { phase: 'before' })).file_id;   // 作業前の写真を作業後として出させない
  const res = ctx.apiJobEndV2({ action: 'job_end', client_id: END, job_client_id: JOB, request_id: END, duration: 198, amount: 25,
    endTime: new Date().toISOString(), afterPhotos: [], v2: { payment_type: 'shop', shop_id: 'SHOP-1' },
    photo_refs: [{ slot: 'F', file_id: fa }, { slot: 'B', file_id: fb }] });
  assert.equal(res.status, 'ok');
  const o = ctx.ended[0].o;
  assert.deepEqual(Array.from(o.prePhotos.slots), ['F']);
  assert.deepEqual(Array.from(o.prePhotos.missing), ['B']);
});

test('Drive から写真を読めない間は配信しない（送り直し）。3回目は読めた写真だけで配信する', () => {
  let busy = true;
  const ctx = load([], { readThrows: () => busy });
  const f1 = ctx.apiJobPhotoV2(photo(P1)).file_id;
  const b = () => startBody({ photo_refs: [{ slot: 'F', file_id: f1 }] });
  const r1 = ctx.apiJobStartV2(b());
  assert.equal(r1.error, 'PHOTO_READ_FAILED'); assert.equal(r1.retryable, true);
  assert.equal(ctx.started.length, 0, 'お客様・お店・管理へはまだ配らない');
  assert.equal(ctx.rows[0]['開始配信日時'] || '', '');
  busy = false;
  const r2 = ctx.apiJobStartV2(b());
  assert.equal(r2.status, 'ok');
  assert.equal(ctx.started[0].o.prePhotos.urls.length, 1, '読めるようになったら写真つきで配信');
  // ずっと読めない時: 3回目であきらめて、届いていない写真として配信する（開始そのものは止めない）
  let always = true;
  const c2 = load([], { readThrows: () => always });
  always = false; const f2 = c2.apiJobPhotoV2(photo(P1)).file_id; always = true;
  const b2 = () => startBody({ photo_refs: [{ slot: 'F', file_id: f2 }] });
  assert.equal(c2.apiJobStartV2(b2()).error, 'PHOTO_READ_FAILED');
  assert.equal(c2.apiJobStartV2(b2()).error, 'PHOTO_READ_FAILED');
  assert.equal(c2.apiJobStartV2(b2()).status, 'ok');
  assert.deepEqual(Array.from(c2.started[0].o.prePhotos.missing), ['F']);
});

test('作業終了も同じ: Drive から読めない間は配信しない（売上・請求は送り直しで出る）', () => {
  let busy = true;
  const rows = [{ 'ジョブID': 'JOB-20261113-001', 'client_id': JOB, '予約ID': '', '作業状態': '作業中', '完了イベントID': '', 'v2記録(JSON)': '{}' }];
  const ctx = load(rows, { readThrows: () => busy });
  busy = false; const fa = ctx.apiJobPhotoV2(photo(P1, { phase: 'after' })).file_id; busy = true;
  const b = () => ({ action: 'job_end', client_id: END, job_client_id: JOB, request_id: END, duration: 10, amount: 25, endTime: new Date().toISOString(),
    afterPhotos: [], v2: { payment_type: 'shop' }, photo_refs: [{ slot: 'F', file_id: fa }] });
  assert.equal(ctx.apiJobEndV2(b()).error, 'PHOTO_READ_FAILED');
  assert.equal(ctx.ended.length, 0);
  busy = false;
  assert.equal(ctx.apiJobEndV2(b()).status, 'ok');
  assert.equal(ctx.ended.length, 1);
  assert.equal(ctx.ended[0].o.prePhotos.urls.length, 1);
});

test('通知の文面に出る枠の名前は、大文字と数字4文字までに絞る', () => {
  const ctx = load();
  const pre = ctx.jobPrePhotos_(JOB, 'before', [{ slot: 'F<b>\n@everyone', file_id: '' }, { slot: '', file_id: '' }]);
  assert.deepEqual(Array.from(pre.missing), ['F', '?']);
});

test('jobMergePhotos_: 先に受け取った写真 → 本文の写真 の順に1つにする', () => {
  const ctx = load();
  const m = ctx.jobMergePhotos_({ urls: ['a'], blobs: [1] }, { urls: ['b'], blobs: [2] });
  assert.deepEqual(Array.from(m.urls), ['a', 'b']);
  assert.deepEqual(Array.from(m.blobs), [1, 2]);
  const inline = { urls: ['b'], blobs: [2] };
  assert.equal(ctx.jobMergePhotos_(null, inline), inline);
});

// ── 文字だけの知らせ ──

const noticeBody = (extra) => Object.assign(startBody(), { action: 'job_start_notice', client_id: NOTICE, request_id: NOTICE }, extra || {});

test('job_start_notice: 作業記録の行を作り、管理グループ（一般）へ「写真はあとから届きます」を1回', () => {
  const ctx = load();
  const res = ctx.apiJobStartNoticeV2(noticeBody());
  assert.equal(res.status, 'ok');
  assert.equal(res.client_id, NOTICE);
  assert.equal(ctx.rows.length, 1);
  assert.equal(ctx.rows[0]['client_id'], JOB, '行は作業の client_id で作る（あとから届く開始が同じ行を使う）');
  assert.equal(ctx.sent.length, 1);
  const tx = ctx.sent[0].text;
  assert.ok(tx.startsWith('▶️ 作業開始'));
  assert.ok(tx.includes('🏪 提携店: LUXE Auto'));
  assert.ok(tx.includes('🚗 Kia Ray'));
  assert.ok(tx.endsWith('📷 写真はあとから届きます'));
  assert.ok(JSON.parse(ctx.rows[0]['v2記録(JSON)']).start_notice.at);
  assert.equal(ctx.started.length, 0, 'お客様・お店への配信（apiJobStart）はまだしない');
  assert.equal(ctx.apiJobStartNoticeV2(noticeBody()).status, 'duplicate');
  assert.equal(ctx.sent.length, 1);
});

test('知らせの後に届いた開始: 同じ行を使い、apiJobStart に noticeSent=true（長文を2回出さない）', () => {
  const ctx = load();
  ctx.apiJobStartNoticeV2(noticeBody());
  const f1 = ctx.apiJobPhotoV2(photo(P1)).file_id;
  const res = ctx.apiJobStartV2(startBody({ photo_refs: [{ slot: 'F', file_id: f1 }] }));
  assert.equal(res.status, 'ok');
  assert.equal(ctx.rows.length, 1, '行は増えない');
  assert.equal(ctx.started[0].o.noticeSent, true);
});

test('job_start_notice: 開始の配信が進んでいる間は出さない（全文が2回出ないように送り直し）', () => {
  const ctx = load();
  ctx.cacheStore['jobdeliv:start:' + JOB] = '1';
  const r = ctx.apiJobStartNoticeV2(noticeBody());
  assert.equal(r.error, 'IN_PROGRESS'); assert.equal(r.retryable, true);
  assert.equal(ctx.sent.length, 0);
});

test('job_start_notice: 開始が配り終わっていれば何もしない／取り消した作業にも出さない', () => {
  const ctx = load([{ 'ジョブID': 'JOB-1', 'client_id': JOB, '作業状態': '作業中', '開始配信日時': new Date(), 'v2記録(JSON)': '{}' }]);
  assert.equal(ctx.apiJobStartNoticeV2(noticeBody()).status, 'duplicate');
  assert.equal(ctx.sent.length, 0);
  const c2 = load([{ 'ジョブID': 'JOB-1', 'client_id': JOB, '作業状態': '中断', '開始配信日時': '', 'v2記録(JSON)': '{}' }]);
  assert.equal(c2.apiJobStartNoticeV2(noticeBody()).status, 'duplicate');
  assert.equal(c2.sent.length, 0);
});

test('job_start_notice: 管理通知が届かない時は送り直し（3回目であきらめて ok）', () => {
  const ctx = load([], { sendOk: false });
  const a = ctx.apiJobStartNoticeV2(noticeBody());
  assert.equal(a.status, 'error'); assert.equal(a.retryable, true);
  ctx.apiJobStartNoticeV2(noticeBody());
  const c = ctx.apiJobStartNoticeV2(noticeBody());
  assert.equal(c.status, 'ok'); assert.equal(c.warning, 'NOTICE_NOT_SENT');
  assert.equal(ctx.rows.length, 1);
  assert.equal(JSON.parse(ctx.rows[0]['v2記録(JSON)']).start_notice, undefined, '届いていないので「知らせ済み」にしない');
});

// ── 管理グループの文面 ──

test('時刻はプノンペンと日本の両方（09:29（日本 11:29））', () => {
  const ctx = load();
  assert.equal(ctx.jobTimeBoth_('2026-11-13T02:29:24.923Z'), '09:29（日本 11:29）');
  assert.equal(ctx.jobTimeBoth_(''), '-');
  assert.equal(ctx.jobTimeBoth_('not-a-date'), '-');
});

test('遅れの1行: 5分未満は出さない・時間と分で書く', () => {
  const ctx = load();
  const now = new Date('2026-11-13T06:10:10Z');
  assert.equal(ctx.jobDelayLine_('2026-11-13T06:06:00Z', now), '');
  assert.equal(ctx.jobDelayLine_('2026-11-13T06:05:00Z', now), '⏱ 現場の操作から 5分 遅れて届きました\n');
  assert.equal(ctx.jobDelayLine_('2026-11-13T02:29:24.923Z', now), '⏱ 現場の操作から 3時間40分 遅れて届きました\n');
  assert.equal(ctx.jobDelayLine_('', now), '');
});

test('開始の文面: すぐ届いた時は遅れを書かない・遅れた時は書く・お店向けは時刻だけ', () => {
  const ctx = load();
  const quick = ctx.jobStartAdminText_(startBody(), { fieldShopId: 'SHOP-1' }, null, '📷 Before 6枚');
  assert.ok(quick.includes('🕐 開始: '));
  assert.ok(quick.includes('（日本 '));
  assert.ok(!quick.includes('遅れて届きました'));
  const lateBody = startBody({ startTime: minutesAgo(221) });
  const late = ctx.jobStartAdminText_(lateBody, { fieldShopId: 'SHOP-1' }, null, '📷 Before 6枚');
  assert.ok(late.includes('⏱ 現場の操作から 3時間41分 遅れて届きました'));
  assert.equal(ctx.jobLateAt_(startBody().startTime), '');
  assert.match(ctx.jobLateAt_(lateBody.startTime), /^\d\d:\d\d$/);
});

test('開始の文面: 知らせを出し済みなら短い文・届かなかった写真は枚数と枠を書く', () => {
  const ctx = load();
  const tx = ctx.jobStartAdminText_(startBody(), { fieldShopId: 'SHOP-1', noticeSent: true, prePhotos: { urls: ['a'], missing: ['V'] } }, null, '📷 Before 1枚');
  assert.ok(tx.startsWith('📷 作業開始の写真（開始 '));
  assert.ok(!tx.includes('━━━'));
  assert.ok(tx.includes('⚠️ 写真 1枚がまだ届いていません（V）'));
  assert.ok(tx.endsWith('📷 Before 1枚'));
});

// ── 組み込み（ソースの確認） ──

test('受け口（Router.gs）とスタッフ限定（StaffGate.gs）に job_photo・job_start_notice がある', () => {
  const router = fs.readFileSync(path.join(V7, 'Router.gs'), 'utf8');
  assert.match(router, /case 'job_photo':\s+result = apiJobPhotoV2\(body\);/);
  assert.match(router, /case 'job_start_notice':\s+result = apiJobStartNoticeV2\(body\);/);
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(V7, 'StaffGate.gs'), 'utf8'), ctx, { filename: 'StaffGate.gs' });
  assert.equal(ctx.isStaffOnlyAction_('job_photo'), true);
  assert.equal(ctx.isStaffOnlyAction_('job_start_notice'), true);
});

test('JobManager.gs: 開始・終了とも先に受け取った写真を足す／現場アプリへ対応を知らせる（caps.pre_photo）', () => {
  const src = fs.readFileSync(path.join(V7, 'JobManager.gs'), 'utf8');
  assert.equal((src.match(/if \(opts\.prePhotos\) photoResult = jobMergePhotos_\(opts\.prePhotos, photoResult\);/g) || []).length, 2);
  assert.match(src, /var adminText = jobStartAdminText_\(body, opts, bkRow \? bkRow\.data : null, '📷 Before ' \+ photoResult\.urls\.length \+ '枚'\);/);
  assert.match(src, /'🕐 終了: ' \+ jobTimeBoth_\(body\.endTime\)/);
  assert.match(src, /caps: \{ pre_photo: 1 \}/);
});
