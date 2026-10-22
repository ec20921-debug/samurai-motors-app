/**
 * ShopQrSticker.gs — 営業アプリ（saleslog-internal.html）の「🔗 QRシール・お店のグループ」カード（2026-10-22）
 *
 * Daisuke「営業ボードから顧客のQR URLをスマホでコピーして、アプリにコピペで現場ではQRシールを印刷する。
 *          それを考慮して流れと記録の最適化を」→ 改善案 A（全部）で実装
 *
 * 現場の流れ（お店がOKした時）:
 *   1. お店の画面で「🔗 このお店のQRを出す」→ 店マスター「QRリンク(BookingBot)」に書き、Bot連携に6桁コードを出す（その場で・1時間待たない）
 *   2. 「📋 URLをコピー」→ ラベル印刷アプリに貼ってシールを印刷 → 自分のスマホで1回読んで確認（QRを読んだ人の数が増える）
 *   3. 「🏷 QRシールを渡した」で枚数を記録 → 「QRシール記録」タブに1行・店マスターに累計
 *   4. お店のグループを作り「📋 送る文をコピー」（/register コード）→ ✅
 *
 * 記録の大元は v7 Database（店マスター・Bot連携・QRシール記録）。営業ボードは見るだけ（ScoutBoardShopLinks.gs が読む）
 */

const SHOP_QR_COL = 'QRリンク(BookingBot)';
const SHOP_QR_STICKER_SHEET = 'QRシール記録';
const SHOP_QR_STICKER_HEADERS = ['sticker_id', '日時', 'shop_id', '店名', '枚数', '記録者', 'メモ', 'client_id'];
// 店マスターに持つ集計（QRシール記録から毎回数え直す・手で直しても次の記録で正しい値に戻る）
const SHOP_QR_SHOP_HEADERS = [SHOP_QR_COL, 'QRシール枚数', 'QRシール最終日', 'QRシール記録者'];
const SHOP_QR_STICKER_MAX = 50;

/** その店の予約QRのURL（予約Bot ?start=shop_<shop_id>） */
function shopQrUrl_(shopId) {
  return 'https://t.me/' + getShopProvProps_().botUsername + '?start=shop_' + shopId;
}

/** 店マスターに QR・シールの列があることを確かめる（無ければ末尾に足す・6時間に1回） */
function ensureShopQrColumns_(shopSheet) {
  runAtMostEvery_(['schema', SALESLOG_SHOP_SHEET_NAME].concat(SHOP_QR_SHOP_HEADERS).join('|'), 6 * 60 * 60, function() {
    return ensureColumnsAtEnd_(shopSheet, SHOP_QR_SHOP_HEADERS);
  });
}

/** 「QRシール記録」タブ（無ければヘッダー付きで作る） */
function getShopQrStickerSheet_() {
  if (_salesLogSheetCache_[SHOP_QR_STICKER_SHEET]) return _salesLogSheetCache_[SHOP_QR_STICKER_SHEET];
  const ss = getSalesLogSs_();
  let sheet = ss.getSheetByName(SHOP_QR_STICKER_SHEET);
  if (!sheet) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20 * 1000);
    try {
      sheet = ss.getSheetByName(SHOP_QR_STICKER_SHEET) || createHeaderedSheet_(ss, SHOP_QR_STICKER_SHEET, SHOP_QR_STICKER_HEADERS);
    } finally {
      lock.releaseLock();
    }
  }
  _salesLogSheetCache_[SHOP_QR_STICKER_SHEET] = sheet;
  return sheet;
}

/** Bot連携の行（同じ shop_id は 連携済 → 待機中 を優先。停止などは無い扱い） */
function shopQrLinkRow_(shopId) {
  const sheet = getSalesLogSs_().getSheetByName(SHOP_PROV_LINK_SHEET);
  if (!sheet) return null;
  const rank = { '連携済': 2, '待機中': 1 };
  let best = null;
  readSheetObjects_(sheet).forEach(function(r) {
    if (String(r.obj['shop_id'] || '').trim() !== shopId) return;
    const rk = rank[String(r.obj['状態'])] || 0;
    if (rk && (!best || rk > best.rk)) best = { rk: rk, obj: r.obj };
  });
  return best ? best.obj : null;
}

/** QRリンク欄の状態: 'empty'（未発行）/ 'ok'（この店のリンク）/ 'mismatch'（別の店のリンク・リンク以外の文字） */
function shopQrLinkState_(shopId, cell) {
  const s = String(cell || '').trim();
  if (!s) return 'empty';
  const m = s.match(/t\.me\/[^?\s]+\?start=shop_([A-Za-z0-9_-]+)/);
  return (m && m[1] === shopId) ? 'ok' : 'mismatch';
}

/**
 * 店の画面に出す QR・グループ・シールの情報
 * @param {string} shopId
 * @param {Object} shopObj - 店マスターの行（readSheetObjects_ の obj）
 */
function shopQrInfo_(shopId, shopObj) {
  const state = shopQrLinkState_(shopId, shopObj[SHOP_QR_COL]);
  const name = String(shopObj['店名'] || shopId);
  const info = {
    issued: state === 'ok',
    mismatch: state === 'mismatch',
    url: state === 'ok' ? shopQrUrl_(shopId) : '',
    groupName: name + ' × SAMURAI MOTORS',
    linkStatus: '', code: '', command: '', linkedGroup: '',
    scans: 0,
    stickerTotal: Number(shopObj['QRシール枚数']) || 0,
    stickerLast: formatSalesLogDateCell_(shopObj['QRシール最終日']).substring(0, 10)
  };
  if (state !== 'ok') return info;
  const link = shopQrLinkRow_(shopId);
  if (link) {
    info.linkStatus = String(link['状態']);
    if (info.linkStatus === '連携済') info.linkedGroup = String(link['グループ名'] || '');
    else { info.code = String(link['ワンタイムコード'] || ''); info.command = info.code ? '/register ' + info.code : ''; }
  }
  try {   // 印刷したシールを自分のスマホで読んだ確認にも使う（ファネルログ bot_start / shop:<id>）
    info.scans = Object.keys(scoutLinksFunnel_(getSalesLogSs_()).scans[shopId] || {}).length;
  } catch (e) { Logger.log('⚠️ shopQrInfo_ scans: ' + e); }
  return info;
}

/** 店の画面を開いた時（salesLogShopDetail から呼ぶ）。失敗しても店の画面は出す */
function shopQrInfoSafe_(shopId, shopObj) {
  try { return shopQrInfo_(shopId, shopObj); }
  catch (e) { Logger.log('⚠️ shopQrInfoSafe_: ' + e); return null; }
}

/**
 * 「このお店のQRを出す」: 店マスターに QR リンクを書き、Bot連携に連携コードを出す（何度押しても二重にならない）
 * @return {Object} { ok, qr }
 */
function shopQrIssue(chatId, shopId) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };
  shopId = String(shopId || '').trim();
  if (shopId.indexOf('SHOP-SAMPLE') === 0) return { ok: false, error: 'SAMPLE_SHOP' };
  const shopSheet = getShopSheet_();
  ensureShopQrColumns_(shopSheet);
  const found = findSheetRow_(shopSheet, 'shop_id', shopId);
  if (!found) return { ok: false, error: 'SHOP_NOT_FOUND' };

  const state = shopQrLinkState_(shopId, found.obj[SHOP_QR_COL]);
  if (state === 'mismatch') return { ok: false, error: 'QR_MISMATCH', qr: shopQrInfo_(shopId, found.obj) };
  if (state === 'empty') {
    const url = shopQrUrl_(shopId);
    updateSheetRow_(shopSheet, found.row, { [SHOP_QR_COL]: url });
    found.obj[SHOP_QR_COL] = url;
    Logger.log('🔗 QR発行: ' + found.obj['店名'] + ' / ' + shopId + ' / ' + (staff.nameJp || staff.nameEn || ''));
  }
  // 連携コード（Bot連携の行が無い時だけ出す。出した時は管理グループのパートナートピックに通知される）
  if (!shopQrLinkRow_(shopId)) issueShopLinkCodes([shopId]);
  return { ok: true, qr: shopQrInfo_(shopId, found.obj) };
}

/**
 * 「QRシールを渡した」: QRシール記録に1行・店マスターに累計（送り直しは client_id で1回だけ）
 * @param {Object} p - { shopId, count, memo, clientId }
 * @return {Object} { ok, qr }
 */
function shopQrStickerLog(chatId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };
  const shopId = String(p.shopId || '').trim();
  const count = Math.floor(Number(p.count));
  if (!(count >= 1 && count <= SHOP_QR_STICKER_MAX)) return { ok: false, error: 'INVALID_COUNT' };
  const shopSheet = getShopSheet_();
  ensureShopQrColumns_(shopSheet);
  const found = findSheetRow_(shopSheet, 'shop_id', shopId);
  if (!found) return { ok: false, error: 'SHOP_NOT_FOUND' };
  if (shopQrLinkState_(shopId, found.obj[SHOP_QR_COL]) !== 'ok') return { ok: false, error: 'QR_NOT_ISSUED' };

  const sheet = getShopQrStickerSheet_();
  const clientId = String(p.clientId || '').substring(0, 80);
  if (!findByClientId_(sheet, clientId)) {
    appendSheetRow_(sheet, {
      'sticker_id': generateDateTimeId('QS') + '-' + Utilities.getUuid().slice(0, 8),
      '日時': salesLogNow_(),
      'shop_id': shopId,
      '店名': String(found.obj['店名'] || ''),
      '枚数': count,
      '記録者': staff.nameJp || staff.nameEn || '',
      'メモ': String(p.memo || '').substring(0, 300),
      'client_id': clientId
    });
  }
  const sum = shopQrStickerSummary_(sheet, shopId);
  const upd = { 'QRシール枚数': sum.total, 'QRシール最終日': sum.last, 'QRシール記録者': sum.by };
  updateSheetRow_(shopSheet, found.row, upd);
  Object.keys(upd).forEach(function(k) { found.obj[k] = upd[k]; });
  return { ok: true, qr: shopQrInfo_(shopId, found.obj) };
}

/** その店のシール記録を数え直す（累計枚数・最後の日・最後に記録した人） */
function shopQrStickerSummary_(sheet, shopId) {
  const out = { total: 0, last: '', by: '' };
  readSheetObjects_(sheet).forEach(function(r) {
    if (String(r.obj['shop_id'] || '').trim() !== shopId) return;
    out.total += Number(r.obj['枚数']) || 0;
    const at = formatSalesLogDateCell_(r.obj['日時']);
    if (at >= out.last) { out.last = at; out.by = String(r.obj['記録者'] || ''); }
  });
  out.last = out.last.substring(0, 10);
  return out;
}
