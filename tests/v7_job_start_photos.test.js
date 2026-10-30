/**
 * v7: 作業開始の「知らせ」と「作業前の写真」を分けて受ける（2026-10-30 JobStartPhotos.gs）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * v7 の実ファイル（JobManager.gs・JobIdempotency.gs・JobStartPhotos.gs）を Node の vm に読み込み、
 * シート・Drive・Telegram はスタブで置き換える（本番には触れない）。
 *   - 今までの1回で送る作業開始は、届き方が変わらない
 *   - ① job_start（photos_follow）: 行・予約ステータス・管理グループへ文字だけ（お客様・店のグループへは送らない）
 *   - ② job_start_photos: 写真の保存・お客様へ文と写真・管理グループへ写真（どの作業かを添える）・店のグループへ
 *   - ②の重複・①より先に届いた②・配信失敗の送り直し・予約IDと店は①の記録を使う
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');
const FILES = ['JobManager.gs', 'JobIdempotency.gs', 'JobStartPhotos.gs'];

const START_ISO = '2026-10-30T08:27:00.000Z';   // プノンペン 15:27

function loadV7(opt) {
  opt = opt || {};
  const cache = {}, sent = [], groups = [], tables = {
    jobs: [],
    bookings: [{ '予約ID': 'BK-20261028-001', 'チャットID': '555', '進行状態': '予約済み', '流入元': '' }]
  };
  const tableOf = (name) => (name === 'JOBS' ? tables.jobs : tables.bookings);
  let fileSeq = 0, albumFails = opt.albumFails || 0;
  const ctx = {
    console, sent, groups, tables,
    Logger: { log: () => {} },
    BOT_TYPE: { BOOKING: 'booking' },
    SHEET_NAMES: { JOBS: 'JOBS', BOOKINGS: 'BOOKINGS' },
    JOBS_COL_LINK_TOKEN: '連携コード',
    JOBS_COL_CUSTOMER_CHAT: '顧客チャットID',
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} }) },
    CacheService: { getScriptCache: () => ({
      get: (k) => (k in cache ? cache[k] : null), put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    SpreadsheetApp: { flush: () => {} },
    Utilities: {
      base64Decode: (s) => s,
      newBlob: (data, type, name) => ({ data, type, name }),
      formatDate: (d, tz, fmt) => {
        const p = new Date(d.getTime() + 7 * 3600 * 1000);   // プノンペン = UTC+7
        return String(p.getUTCHours()).padStart(2, '0') + ':' + String(p.getUTCMinutes()).padStart(2, '0');
      }
    },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: 1 }, Permission: { VIEW: 1 },
      getFolderById: () => ({ createFile: (blob) => {
        fileSeq++;
        return { setSharing: () => {}, getUrl: () => 'https://drive/' + fileSeq + '/' + blob.name };
      } })
    },
    getConfig: () => ({ adminGroupId: '-100', driveFolderWashPhotos: 'F' }),
    findRow: (sheet, col, val) => {
      const rows = tableOf(sheet);
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][col] || '') === String(val)) return { rowIndex: i + 2, data: Object.assign({}, rows[i]) };
      }
      return null;
    },
    readRow: (sheet, rowIndex) => Object.assign({}, tableOf(sheet)[rowIndex - 2]),
    updateRow: (sheet, rowIndex, obj) => { Object.assign(tableOf(sheet)[rowIndex - 2], obj); },
    appendRow: (sheet, obj) => { tableOf(sheet).push(Object.assign({}, obj)); },
    generateDateSeqId: () => 'JOB-20261030-00' + (tables.jobs.length + 1),
    sheetSafeText_: (v) => String(v),
    findCustomerRow: (chatId) => (chatId === '555' ? { data: { 'トピックID': 77 } } : null),
    sendMessage: (bot, chat, text, o) => { sent.push({ type: 'text', chat: String(chat), text, thread: o && o.message_thread_id }); return { ok: true }; },
    getShopNameById_: (id) => 'Shop ' + id,
    sourceAdminLineForJob_: () => '',
    validFieldShopId_: (id) => (id === 'SHOP-A' ? 'SHOP-A' : ''),
    notifyShopGroupJobPhotos: (chatId, text, blobs) => { groups.push({ kind: 'qr', chatId, blobs: (blobs || []).length }); return ''; },
    getValidShopRef_: () => '',
    notifySourceGroupJob_: (phase, p) => { groups.push({ kind: 'src', phase, blobs: (p.blobs || []).length }); return ''; },
    notifyShopGroupByShopId_: (id, text, blobs) => { groups.push({ kind: 'shop', id, blobs: (blobs || []).length }); return id; },
    shopGroupLangs_: () => ['km'],
    shopGroupJobText_: () => 'shop text',
    notifyShopDamage_: (id, body) => { groups.push({ kind: 'damage', id, damage: (body.v2 && body.v2.damage || []).length }); }
  };
  vm.createContext(ctx);
  FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(V7, f), 'utf8'), ctx, { filename: f }));
  ctx.ensureJobsAmountColumn_ = () => {};
  ctx.ensureJobsServiceColumn_ = () => {};
  ctx.ensureJobsV2Columns_ = () => {};
  ctx.sendPhotoAlbum = (bot, chat, blobs, caption, o) => {
    const isAdmin = String(chat) === '-100';
    if (isAdmin && albumFails > 0) { albumFails--; return { ok: false }; }
    sent.push({ type: 'album', chat: String(chat), n: blobs.length, caption, thread: o && o.message_thread_id });
    return { ok: true };
  };
  return { ctx, cache, sent, groups, tables };
}

const PHOTOS = ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'];

function startBody(extra) {
  return Object.assign({
    action: 'job_start', client_id: 'job-cid-0001', job_client_id: 'job-cid-0001', request_id: 'job-cid-0001',
    bookingId: 'BK-20261028-001', name: 'Sato Hirotaka', building: 'https://maps', room: '', carModel: '', plate: '',
    plan: 'SAMURAI WASH (W)', optionCodes: ['HEADLIGHT'], vehicleType: 'SUV', amount: 21,
    startTime: START_ISO, sent_at: START_ISO, app_version: 'field-test',
    beforePhotos: PHOTOS.slice(), v2: { checks: {}, damage: [], shop_id: '' }
  }, extra || {});
}
function photosBody(extra) {
  return Object.assign(startBody(), { action: 'job_start_photos', client_id: 'photo-cid-0001', request_id: 'photo-cid-0001' }, extra || {});
}
const toAdmin = (sent) => sent.filter((s) => s.chat === '-100');
const toCustomer = (sent) => sent.filter((s) => s.chat === '555');

test('今までの1回で送る作業開始は、届き方が変わらない', () => {
  const { ctx, sent, groups, tables } = loadV7();
  const res = ctx.apiJobStartV2(startBody());
  assert.equal(res.status, 'ok');
  assert.equal(res.client_id, 'job-cid-0001');
  const admin = toAdmin(sent);
  assert.equal(admin.length, 2);
  assert.ok(admin[0].text.includes('▶️ 作業開始') && admin[0].text.includes('🕐 開始: 15:27') && admin[0].text.includes('📷 Before 2枚'));
  assert.ok(!admin[0].text.includes('あとから'));
  assert.equal(admin[1].type, 'album');
  assert.equal(admin[1].n, 2);
  assert.equal(admin[1].thread, 77);
  assert.deepEqual(toCustomer(sent).map((s) => s.type), ['text', 'album']);
  assert.equal(groups.filter((g) => g.kind === 'qr').length, 1);
  assert.equal(tables.jobs[0]['Before写真URL'].split('\n').length, 2);
  assert.ok(tables.jobs[0]['開始配信日時']);
  assert.equal(tables.bookings[0]['進行状態'], '作業中');
});

test('① 写真はあとから: 管理グループへ文字だけ・お客様と店のグループへは送らない', () => {
  const { ctx, sent, groups, tables } = loadV7();
  const res = ctx.apiJobStartV2(startBody({ photos_follow: 2 }));   // 写真が混ざっていても使わない
  assert.equal(res.status, 'ok');
  assert.equal(res.client_id, 'job-cid-0001');
  const admin = toAdmin(sent);
  assert.equal(admin.length, 1);
  assert.equal(admin[0].type, 'text');
  assert.ok(admin[0].text.includes('📷 Before 2枚（写真はあとから届きます）'));
  assert.ok(admin[0].text.includes('🆔 BK-20261028-001') && admin[0].text.includes('💵 料金: $21'));
  assert.equal(admin[0].thread, 77);
  assert.equal(toCustomer(sent).length, 0, 'お客様へは②で文と写真をそろえて送る');
  assert.equal(groups.length, 0, '店・提携先のグループへは②で送る');
  assert.ok(!tables.jobs[0]['Before写真URL'], '写真は保存しない');
  assert.ok(tables.jobs[0]['開始配信日時']);
  assert.equal(tables.bookings[0]['進行状態'], '作業中', '予約ステータスはすぐ作業中に');
});

test('② 写真: 保存・お客様へ文と写真・管理グループへ写真（どの作業か添える）・店のグループへ', () => {
  const { ctx, sent, groups, tables } = loadV7();
  ctx.apiJobStartV2(startBody({ photos_follow: 2, beforePhotos: [] }));
  sent.length = 0;
  const res = ctx.apiJobStartPhotosV2(photosBody());
  assert.equal(res.status, 'ok');
  assert.equal(res.client_id, 'photo-cid-0001', 'アプリは自分の client_id が返った時だけ送信済みにする');
  const admin = toAdmin(sent);
  assert.equal(admin.length, 1);
  assert.equal(admin[0].type, 'album');
  assert.equal(admin[0].n, 2);
  assert.equal(admin[0].thread, 77);
  assert.equal(admin[0].caption, '📷 Before 2枚（作業開始 15:27）\n🆔 BK-20261028-001\n👤 Sato Hirotaka');
  assert.deepEqual(toCustomer(sent).map((s) => s.type), ['text', 'album']);
  assert.deepEqual(groups.map((g) => g.kind), ['qr', 'src']);
  assert.equal(groups[0].blobs, 2);
  assert.equal(tables.jobs[0]['Before写真URL'].split('\n').length, 2);
  assert.ok(tables.jobs[0]['Before写真配信日時']);
  assert.equal(tables.jobs.length, 1, '行は増えない');
});

test('② の送り直しは重複にする（写真もお知らせも二重にしない）', () => {
  const { ctx, sent } = loadV7();
  ctx.apiJobStartV2(startBody({ photos_follow: 2, beforePhotos: [] }));
  ctx.apiJobStartPhotosV2(photosBody());
  const n = sent.length;
  const again = ctx.apiJobStartPhotosV2(photosBody());
  assert.equal(again.status, 'duplicate');
  assert.equal(again.client_id, 'photo-cid-0001');
  assert.equal(sent.length, n);
});

test('② が①より先に届いたら、①を待つ（送り直してよい）', () => {
  const { ctx, sent } = loadV7();
  const res = ctx.apiJobStartPhotosV2(photosBody());
  assert.equal(res.status, 'error');
  assert.equal(res.error, 'START_NOT_FOUND');
  assert.equal(res.retryable, true);
  assert.equal(res.client_id, 'photo-cid-0001');
  assert.equal(sent.length, 0);
});

test('② 顧客のトピックへ送れない時は、管理グループの一般スレッドへ', () => {
  const { ctx, sent, tables } = loadV7({ albumFails: 1 });
  ctx.apiJobStartV2(startBody({ photos_follow: 2, beforePhotos: [] }));
  sent.length = 0;
  const r = ctx.apiJobStartPhotosV2(photosBody());
  assert.equal(r.status, 'ok');
  assert.equal(toAdmin(sent)[0].thread, undefined);
  assert.ok(tables.jobs[0]['Before写真配信日時']);
});

test('② 管理グループへの写真が届かなければ送り直し、3回目は配信済み＋要確認', () => {
  const { ctx, tables } = loadV7({ albumFails: 6 });   // トピック・一般スレッドの両方で3回とも失敗
  ctx.apiJobStartV2(startBody({ photos_follow: 2, beforePhotos: [] }));
  const r1 = ctx.apiJobStartPhotosV2(photosBody());
  assert.equal(r1.status, 'error');
  assert.equal(r1.retryable, true);
  assert.ok(!tables.jobs[0]['Before写真配信日時']);
  assert.equal(ctx.apiJobStartPhotosV2(photosBody()).status, 'error');
  const r3 = ctx.apiJobStartPhotosV2(photosBody());
  assert.equal(r3.status, 'ok');
  assert.equal(r3.warning, 'DELIVERY_PARTIAL');
  assert.ok(tables.jobs[0]['Before写真配信日時'], '先へ進める（作業終了を止めない）');
});

test('② 写真の保存が全部失敗したら送り直し（上限で配信済み＋要確認）', () => {
  const { ctx, tables } = loadV7();
  ctx.apiJobStartV2(startBody({ photos_follow: 2, beforePhotos: [] }));
  ctx.DriveApp.getFolderById = () => ({ createFile: () => { throw new Error('drive down'); } });
  const r1 = ctx.apiJobStartPhotosV2(photosBody());
  assert.equal(r1.status, 'error');
  ctx.apiJobStartPhotosV2(photosBody());
  const r3 = ctx.apiJobStartPhotosV2(photosBody());
  assert.equal(r3.status, 'ok');
  assert.equal(r3.warning, 'DELIVERY_PARTIAL');
  assert.ok(JSON.parse(tables.jobs[0]['v2記録(JSON)']).delivery_warning_startphotos);
});

test('② 予約IDと店は①の記録を使う（②の本文の値は使わない）', () => {
  const { ctx, sent } = loadV7();
  ctx.apiJobStartV2(startBody({ photos_follow: 2, beforePhotos: [] }));
  sent.length = 0;
  ctx.apiJobStartPhotosV2(photosBody({ bookingId: 'BK-OTHER-999' }));
  assert.ok(toAdmin(sent)[0].caption.includes('BK-20261028-001'));
  assert.ok(!toAdmin(sent)[0].caption.includes('BK-OTHER'));
});

test('お店の仕事（予約なし・開始で店を選んだ）: ①では店へ送らず、②で写真と傷の文章を送る', () => {
  const { ctx, groups } = loadV7();
  const shopV2 = { mode: 'shop', shop_id: 'SHOP-A', damage: [{ x: 1, y: 2, memo: 'dent', photo: 'D1' }] };
  const r1 = ctx.apiJobStartV2(startBody({ bookingId: '', photos_follow: 2, beforePhotos: [], v2: shopV2 }));
  assert.equal(r1.status, 'ok');
  assert.equal(groups.length, 0);
  // ②の本文の店（SHOP-B）ではなく、①で記録した店（SHOP-A）へ
  ctx.apiJobStartPhotosV2(photosBody({ bookingId: '', v2: { mode: 'shop', shop_id: 'SHOP-B', damage: [] } }));
  assert.deepEqual(groups.map((g) => g.kind + ':' + (g.id || '')), ['shop:SHOP-A', 'damage:SHOP-A']);
  assert.equal(groups[0].blobs, 2);
  assert.equal(groups[1].damage, 1);
});

test('photos_follow の値: 0・負・大きすぎ・文字は「分けない」', () => {
  const { ctx } = loadV7();
  assert.equal(ctx.startPhotosFollow_({ photos_follow: 6 }), 6);
  assert.equal(ctx.startPhotosFollow_({ photos_follow: '3' }), 3);
  [0, -1, 31, 'x', null, undefined].forEach((v) => assert.equal(ctx.startPhotosFollow_({ photos_follow: v }), 0, String(v)));
  assert.equal(ctx.startPhotosFollow_(null), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.fieldAppCaps_())), { startPhotos: 1 });
});

test('② の client_id・job_client_id がおかしい時は「要確認」（送り直さない）', () => {
  const { ctx } = loadV7();
  const r = ctx.apiJobStartPhotosV2(photosBody({ client_id: 'x' }));
  assert.equal(r.retryable, false);
  const r2 = ctx.apiJobStartPhotosV2(photosBody({ job_client_id: 'bad id!' }));
  assert.equal(r2.retryable, false);
});
