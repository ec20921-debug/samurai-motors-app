/**
 * ShopProfile.gs — 営業アプリ（SAMURAI SCOUT・saleslog-internal.html）の「お店の顔」（2026-11-08）
 *
 * Daisuke「お店の外観の写真を撮って、見れるようにして欲しい」「facebook があれば url を入れられるように」
 *          「たくさん車屋あるから、どんなお店か把握したい思いが日本側にはあります」
 *
 *   - 外観の写真: お店の画面で撮る → Drive「SamuraiMotors_ShopPhotos」に保存（リンクを知っている人が見られる）
 *                → v7 Database「店の写真」タブに1枚1行 → 店マスター「外観写真」に一番新しい写真の URL
 *                  （一覧・地図で見せる1枚／GSS を直接見る日本側もリンクで開ける）
 *   - Facebook: お店の画面の上で、URL だけを貼って保存（店の情報をまとめて保存しない・ほかの列は触らない）
 *
 * 記録の大元は v7 Database。写真は消さない（撮り直したら新しい1枚が先頭になるだけ）
 */

const SHOP_PHOTO_SHEET = '店の写真';
const SHOP_PHOTO_HEADERS = ['photo_id', '日時', 'shop_id', '店名', 'file_id', 'URL', '撮った人', 'client_id'];
const SHOP_PHOTO_COL = '外観写真';
const SHOP_PHOTO_FOLDER = 'SamuraiMotors_ShopPhotos';
const SHOP_PHOTO_MAX_BYTES = 5 * 1024 * 1024;   // アプリ側で長い辺 1280px に縮めるので普通は 0.3MB 前後
const SHOP_PHOTO_LIST_MAX = 12;                 // お店の画面に出す枚数

/** 店マスターに「外観写真」の列があることを確かめる（無ければ末尾に足す・6時間に1回） */
function ensureShopPhotoColumn_(shopSheet) {
  runAtMostEvery_(['schema', SALESLOG_SHOP_SHEET_NAME, SHOP_PHOTO_COL].join('|'), 6 * 60 * 60, function() {
    return ensureColumnsAtEnd_(shopSheet, [SHOP_PHOTO_COL]);
  });
}

/** 「店の写真」タブ（無ければヘッダー付きで作る） */
function getShopPhotoSheet_(create) {
  if (_salesLogSheetCache_[SHOP_PHOTO_SHEET]) return _salesLogSheetCache_[SHOP_PHOTO_SHEET];
  const ss = getSalesLogSs_();
  let sheet = ss.getSheetByName(SHOP_PHOTO_SHEET);
  if (!sheet && !create) return null;
  if (!sheet) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20 * 1000);
    try {
      sheet = ss.getSheetByName(SHOP_PHOTO_SHEET) || createHeaderedSheet_(ss, SHOP_PHOTO_SHEET, SHOP_PHOTO_HEADERS);
    } finally {
      lock.releaseLock();
    }
  }
  _salesLogSheetCache_[SHOP_PHOTO_SHEET] = sheet;
  return sheet;
}

/** Drive の URL（…/d/<id>/… か ?id=<id>）からファイルIDを取り出す。取れなければ空 */
function shopPhotoFileId_(url) {
  const s = String(url || '');
  const m = s.match(/\/d\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1] : '';
}

/** data URL / base64 を画像として読む。だめなら null */
function shopPhotoDecode_(image) {
  const s = String(image || '');
  const m = s.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  const mime = m ? m[1] : 'image/jpeg';
  const raw = m ? m[2] : s;
  if (!raw || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) return null;
  // base64 の長さから大きさを見積もる（デコード前に大きすぎるものを断る）
  if (Math.floor(raw.length * 3 / 4) > SHOP_PHOTO_MAX_BYTES) return { tooBig: true };
  return { mime: mime, bytes: Utilities.base64Decode(raw.replace(/\s/g, '')) };
}

/**
 * 外観の写真を1枚足す（送り直しは client_id で1回だけ）
 * @param {Object} p - { shopId, image(data URL), clientId }
 * @return {Object} { ok, shopId, photos } / { ok:false, error }
 */
function shopPhotoAdd(chatId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };
  const shopId = String(p.shopId || '').trim();
  const shopSheet = getShopSheet_();
  ensureShopPhotoColumn_(shopSheet);
  const found = findSheetRow_(shopSheet, 'shop_id', shopId);
  if (!found) return { ok: false, error: 'SHOP_NOT_FOUND' };

  const sheet = getShopPhotoSheet_(true);
  const clientId = String(p.clientId || '').substring(0, 80);
  if (!findByClientId_(sheet, clientId)) {
    const img = shopPhotoDecode_(p.image);
    if (!img) return { ok: false, error: 'INVALID_IMAGE' };
    if (img.tooBig) return { ok: false, error: 'IMAGE_TOO_BIG' };
    const photoId = generateDateTimeId('PH') + '-' + Utilities.getUuid().slice(0, 8);
    const ext = img.mime === 'image/png' ? 'png' : (img.mime === 'image/webp' ? 'webp' : 'jpg');
    const blob = Utilities.newBlob(img.bytes, img.mime, shopId + '_' + photoId + '.' + ext);
    const file = getOrCreateFolder_(SHOP_PHOTO_FOLDER).createFile(blob);
    // アプリの <img> と GSS のリンクで見られるように（お店の外観＝通りから見えるもの）
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const url = file.getUrl();
    appendSheetRow_(sheet, {
      'photo_id': photoId,
      '日時': salesLogNow_(),
      'shop_id': shopId,
      '店名': String(found.obj['店名'] || ''),
      'file_id': file.getId(),
      'URL': url,
      '撮った人': staff.nameJp || staff.nameEn || '',
      'client_id': clientId
    });
    updateSheetRow_(shopSheet, found.row, { [SHOP_PHOTO_COL]: url });
  }
  return { ok: true, shopId: shopId, photos: shopPhotosForShop_(shopId) };
}

/** その店の写真（新しい順・最大 SHOP_PHOTO_LIST_MAX 枚）: [{ fileId, datetime, staff }] */
function shopPhotosForShop_(shopId) {
  const sheet = getShopPhotoSheet_(false);
  if (!sheet) return [];
  const id = String(shopId);
  return readSheetObjects_(sheet)
    .map(function(r) { return r.obj; })
    .filter(function(o) { return String(o['shop_id'] || '') === id && o['file_id']; })
    .map(function(o) {
      return { fileId: String(o['file_id']), datetime: formatSalesLogDateCell_(o['日時']), staff: String(o['撮った人'] || '') };
    })
    .sort(function(a, b) { return String(b.datetime).localeCompare(String(a.datetime)); })
    .slice(0, SHOP_PHOTO_LIST_MAX);
}

/** 写真が取れなくても店の画面は出す */
function shopPhotosForShopSafe_(shopId) {
  try { return shopPhotosForShop_(shopId); } catch (e) { Logger.log('⚠️ shopPhotosForShop_: ' + e); return []; }
}

/**
 * Facebook の URL を整える。「facebook.com/abc」のように https が無ければ付ける。
 * 空は「消す」。http(s) の URL にならないもの・長すぎるものは null（保存しない）
 */
function normalizeShopFacebook_(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) {
    if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/|$)/.test(s)) return null;
    s = 'https://' + s;
  }
  if (s.length > 300 || /\s/.test(s)) return null;
  return s;
}

/**
 * Facebook の URL だけを保存する（ほかの列は触らない）
 * @return {Object} { ok, shopId, facebook } / { ok:false, error }
 */
function shopFacebookSet(chatId, shopId, url) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };
  const fb = normalizeShopFacebook_(url);
  if (fb === null) return { ok: false, error: 'INVALID_URL' };
  const sheet = getShopSheet_();
  const found = findSheetRow_(sheet, 'shop_id', String(shopId));
  if (!found) return { ok: false, error: 'SHOP_NOT_FOUND' };
  updateSheetRow_(sheet, found.row, { 'Facebook': fb });
  return { ok: true, shopId: String(shopId), facebook: fb };
}
