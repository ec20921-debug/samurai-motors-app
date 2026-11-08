/**
 * v7-operations: SAMURAI SCOUT お店の顔（ShopProfile.gs・2026-11-08）
 *
 * 実行: node --test "tests/*.test.js"
 *
 *   - Facebook の URL: https が無ければ付ける・空は消す・URL にならないものは保存しない・Facebook の列だけを書く
 *   - Drive の URL からファイルIDを取り出す（/d/<id>/ と ?id=<id>）
 *   - 写真: スタッフでなければ断る／画像でなければ断る／保存すると「店の写真」に1行・店マスター「外観写真」に URL
 *   - 送り直し（同じ client_id）は1枚だけ
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'v7-operations', 'ShopProfile.gs'), 'utf8');

function makeCtx(opts) {
  opts = Object.assign({ staff: true }, opts || {});
  const shopRow = { row: 2, obj: { shop_id: 'S1', '店名': 'ABC Auto', Facebook: '', '外観写真': '' } };
  const photoRows = [];
  const updates = [];
  const files = [];
  const ctx = {
    console,
    Logger: { log: () => {} },
    _salesLogSheetCache_: {},
    SALESLOG_SHOP_SHEET_NAME: '店マスター',
    findStaffByChatId: () => (opts.staff ? { nameJp: '鈴木' } : null),
    getShopSheet_: () => ({ name: 'shop' }),
    getSalesLogSs_: () => ({ getSheetByName: (n) => (n === '店の写真' ? { name: 'photo' } : null) }),
    runAtMostEvery_: (k, t, fn) => fn(),
    ensureColumnsAtEnd_: () => true,
    findSheetRow_: (sheet, col, v) => (sheet.name === 'shop' && v === 'S1' ? shopRow : null),
    findByClientId_: (sheet, id) => (id && photoRows.find((r) => r.client_id === id)) || null,
    readSheetObjects_: () => photoRows.map((o, i) => ({ row: i + 2, obj: o })),
    appendSheetRow_: (sheet, d) => { photoRows.push(d); },
    updateSheetRow_: (sheet, row, u) => { updates.push(u); Object.assign(shopRow.obj, u); },
    generateDateTimeId: (p) => p + '-20261108-120000',
    salesLogNow_: () => '2026-11-08 12:00',
    formatSalesLogDateCell_: (v) => String(v || ''),
    Utilities: {
      getUuid: () => 'abcdef12-0000',
      base64Decode: (s) => Buffer.from(s, 'base64'),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name })
    },
    getOrCreateFolder_: () => ({
      createFile: (blob) => {
        const id = 'FILE' + (files.length + 1) + 'xxxxxxxxxx';
        files.push(blob);
        return { getId: () => id, getUrl: () => 'https://drive.google.com/file/d/' + id + '/view', setSharing: () => {} };
      }
    }),
    DriveApp: { Access: { ANYONE_WITH_LINK: 'A' }, Permission: { VIEW: 'V' } },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    createHeaderedSheet_: () => ({ name: 'photo' })
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, shopRow, photoRows, updates, files };
}

const JPEG = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');

test('Facebook の URL を整える', () => {
  const { ctx } = makeCtx();
  assert.equal(ctx.normalizeShopFacebook_('facebook.com/abcauto'), 'https://facebook.com/abcauto');
  assert.equal(ctx.normalizeShopFacebook_(' https://www.facebook.com/abc '), 'https://www.facebook.com/abc');
  assert.equal(ctx.normalizeShopFacebook_(''), '');
  assert.equal(ctx.normalizeShopFacebook_('ABC Auto のページ'), null);
  assert.equal(ctx.normalizeShopFacebook_('https://facebook.com/a b'), null);
});

test('Facebook は Facebook の列だけを書く／スタッフ以外・変な URL は書かない', () => {
  const { ctx, updates } = makeCtx();
  const r = ctx.shopFacebookSet('1', 'S1', 'm.facebook.com/abc');
  assert.equal(r.ok, true);
  assert.equal(r.facebook, 'https://m.facebook.com/abc');
  assert.deepEqual(Object.keys(updates[0]), ['Facebook']);
  assert.equal(ctx.shopFacebookSet('1', 'S1', 'not a url').error, 'INVALID_URL');
  assert.equal(ctx.shopFacebookSet('1', 'NOPE', 'facebook.com/x').error, 'SHOP_NOT_FOUND');
  assert.equal(makeCtx({ staff: false }).ctx.shopFacebookSet('1', 'S1', 'facebook.com/x').error, 'STAFF_NOT_FOUND');
});

test('Drive の URL からファイルIDを取り出す', () => {
  const { ctx } = makeCtx();
  assert.equal(ctx.shopPhotoFileId_('https://drive.google.com/file/d/1AbC_def-GHIJKL/view'), '1AbC_def-GHIJKL');
  assert.equal(ctx.shopPhotoFileId_('https://drive.google.com/open?id=1AbC_def-GHIJKL'), '1AbC_def-GHIJKL');
  assert.equal(ctx.shopPhotoFileId_(''), '');
  assert.equal(ctx.shopPhotoFileId_('あとで'), '');
});

test('写真を保存すると「店の写真」に1行・店マスターに URL。送り直しは1枚だけ', () => {
  const { ctx, photoRows, updates, files } = makeCtx();
  const r1 = ctx.shopPhotoAdd('1', { shopId: 'S1', image: JPEG, clientId: 'c-1' });
  assert.equal(r1.ok, true);
  assert.equal(photoRows.length, 1);
  assert.equal(photoRows[0]['撮った人'], '鈴木');
  assert.equal(photoRows[0]['店名'], 'ABC Auto');
  assert.match(updates[0]['外観写真'], /\/d\/FILE1/);
  assert.equal(r1.photos.length, 1);
  assert.equal(r1.photos[0].fileId, photoRows[0].file_id);
  const r2 = ctx.shopPhotoAdd('1', { shopId: 'S1', image: JPEG, clientId: 'c-1' });
  assert.equal(r2.ok, true);
  assert.equal(photoRows.length, 1);
  assert.equal(files.length, 1);
});

test('写真: 画像でない・店が無い・スタッフでない は断る', () => {
  const { ctx, photoRows } = makeCtx();
  assert.equal(ctx.shopPhotoAdd('1', { shopId: 'S1', image: 'data:text/html;base64,PGI+', clientId: 'x' }).error, 'INVALID_IMAGE');
  assert.equal(ctx.shopPhotoAdd('1', { shopId: 'S1', image: '', clientId: 'y' }).error, 'INVALID_IMAGE');
  assert.equal(ctx.shopPhotoAdd('1', { shopId: 'NOPE', image: JPEG, clientId: 'z' }).error, 'SHOP_NOT_FOUND');
  assert.equal(makeCtx({ staff: false }).ctx.shopPhotoAdd('1', { shopId: 'S1', image: JPEG }).error, 'STAFF_NOT_FOUND');
  assert.equal(photoRows.length, 0);
});
