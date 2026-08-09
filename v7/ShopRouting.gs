/**
 * ShopRouting.gs — 提携店 店舗別ルーティング（2026-08-09）
 *
 * 【目的】1ボット多店舗方式で「1対1の見える化」を実現する予約Bot側モジュール。
 *   - 店舗グループでの /register <ワンタイムコード> → グループ紐付け
 *   - 顧客の /start shop_<shop_id>（店舗専用QRのディープリンク） → 店タグ付け＋店舗グループへ来店通知
 *
 * 【データ】v7 Database の「Bot連携」シート（v7-operations/ShopProvisioningManager.gs が行を作成）。
 *   読み取りは CacheService 60秒キャッシュ（OPS_LESSONS #8: openById/全読みをリクエスト毎に繰り返さない）。
 *   顧客→店の紐付けは Script Properties `shop_ref_<chatId>`（予約成立時の shop_id 参照用・Phase 2 で予約へ記録）。
 *
 * 【呼び出し元】BookingBot.gs
 *   - dispatchBookingMessage: グループメッセージのとき handleShopGroupMessage_(msg)
 *   - handleCustomerMessage: '/start shop_' プレフィックスのとき handleShopStart_(msg, text)
 */

var SHOP_LINK_SHEET_NAME = 'Bot連携';
var SHOP_LINK_CACHE_KEY = 'shop_link_rows_v1';
var SHOP_LINK_CACHE_SEC = 60;

// ====== シート読み書き ======

function getShopLinkSheet_() {
  var cfg = getConfig();
  var ss = SpreadsheetApp.openById(cfg.spreadsheetId);
  return ss.getSheetByName(SHOP_LINK_SHEET_NAME); // 無ければ null（未セットアップ環境では機能を静かにスキップ）
}

/**
 * Bot連携シートの全行をオブジェクト配列で返す（60秒キャッシュ）
 * @return {Array<{row:number, obj:Object}>}
 */
function readShopLinks_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(SHOP_LINK_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (ignore) {}
  }
  var sheet = getShopLinkSheet_();
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getDataRange().getValues();
  var headers = values.shift();
  var out = values.map(function(r, i) {
    var obj = {};
    headers.forEach(function(h, j) { obj[h] = r[j]; });
    return { row: i + 2, obj: obj };
  });
  try { cache.put(SHOP_LINK_CACHE_KEY, JSON.stringify(out), SHOP_LINK_CACHE_SEC); } catch (ignore) {}
  return out;
}

function invalidateShopLinkCache_() {
  try { CacheService.getScriptCache().remove(SHOP_LINK_CACHE_KEY); } catch (ignore) {}
}

// ====== ① 店舗グループでの /register ======

/**
 * グループメッセージを処理。店舗紐付けコマンドなら true を返す（呼び元は return）。
 * それ以外は false（既存どおり無視）。
 *
 * /register <6桁コード> または /register@BotName <6桁コード>
 */
function handleShopGroupMessage_(msg) {
  var text = (msg.text || '').trim();
  if (text.indexOf('/register') !== 0) return false;

  var m = text.match(/^\/register(?:@\w+)?\s+(\d{6})\s*$/);
  if (!m) {
    sendMessage(BOT_TYPE.BOOKING, msg.chat.id,
      'ℹ️ Usage: /register <6-digit code>\n(コードは管理グループの登録通知に記載されています)');
    return true;
  }
  var code = m[1];

  // 総当たり対策: 同一グループで5回失敗したら10分ブロック
  var cache = CacheService.getScriptCache();
  var failKey = 'shop_reg_fail_' + String(msg.chat.id);
  var fails = Number(cache.get(failKey) || 0);
  if (fails >= 5) {
    sendMessage(BOT_TYPE.BOOKING, msg.chat.id,
      '⏳ Too many attempts. Please try again in 10 minutes.');
    return true;
  }

  // 競合対策: ロックを取り、キャッシュではなくシートを直接再確認してから書き込む
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10 * 1000);
  } catch (err) {
    Logger.log('⚠️ /register lock 取得失敗: ' + err);
    sendMessage(BOT_TYPE.BOOKING, msg.chat.id, '⏳ Busy, please try again in 1 minute.');
    return true;
  }

  var hit = null, shopName = '', shopIdHit = '';
  try {
    var sheet = getShopLinkSheet_();
    if (!sheet || sheet.getLastRow() < 2) {
      sendMessage(BOT_TYPE.BOOKING, msg.chat.id, '❌ Not ready. Please contact Samurai Motors staff.');
      return true;
    }
    var values = sheet.getDataRange().getValues();
    var headers = values.shift();
    var col = {};
    headers.forEach(function(h, i) { col[h] = i; });
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][col['ワンタイムコード']]) === code &&
          String(values[i][col['状態']]) === '待機中') {
        hit = { row: i + 2 };
        shopName = String(values[i][col['店名']] || '');
        shopIdHit = String(values[i][col['shop_id']] || '');
        break;
      }
    }

    if (!hit) {
      try { cache.put(failKey, String(fails + 1), 600); } catch (ignore) {}
      sendMessage(BOT_TYPE.BOOKING, msg.chat.id,
        '❌ Code not found or already used. / コードが見つからないか、使用済みです。\n' +
        'Please check with Samurai Motors staff.');
      return true;
    }

    // 紐付け書き込み（コードは使い捨て: 状態を連携済にして無効化）
    sheet.getRange(hit.row, col['グループchat_id'] + 1).setValue(String(msg.chat.id));
    sheet.getRange(hit.row, col['グループ名'] + 1).setValue(msg.chat.title || '');
    sheet.getRange(hit.row, col['紐付け日時'] + 1).setValue(
      Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss'));
    sheet.getRange(hit.row, col['状態'] + 1).setValue('連携済');
    SpreadsheetApp.flush();
    invalidateShopLinkCache_();
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }

  sendMessage(BOT_TYPE.BOOKING, msg.chat.id,
    '✅ Connected! / 連携完了！\n' +
    'Shop: ' + shopName + '\n\n' +
    'Orders from your QR code will appear in this group.\n' +
    'このグループに、お店のQR経由のご注文が届くようになりました。');

  // 管理グループにも成功を通知（顧客トピック外・通常投稿）
  try {
    var cfg = getConfig();
    sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
      '🔗 店舗グループ連携完了: ' + shopName + '\n' +
      'shop_id: ' + shopIdHit + '\n' +
      'グループ: ' + (msg.chat.title || msg.chat.id));
  } catch (err) {
    Logger.log('⚠️ 管理通知失敗（連携完了）: ' + err);
  }
  return true;
}

// ====== ② 顧客のディープリンク /start shop_... ======

/**
 * 店舗専用QR経由の /start を処理。
 *   1. 顧客に通常どおり歓迎メッセージ（既存フローを再利用）
 *   2. 顧客→店の参照タグを Script Properties に保存（予約成立時に利用）
 *   3. 店舗グループへ「QR経由でお客様が来ました」通知（見える化の第一歩）
 *
 * @return {boolean} 処理した場合 true
 */
function handleShopStart_(msg, text) {
  var m = text.match(/^\/start\s+shop_(\S+)$/);
  if (!m) return false;
  var shopId = m[1];

  // 通常の歓迎フロー（既存 /start と同一体験にする）
  sendWelcomeMessage(msg);
  ensureCustomerTopic(msg);

  // 顧客→店タグ（Phase 2 で予約レコードへ転記するための参照）
  try {
    PropertiesService.getScriptProperties()
      .setProperty('shop_ref_' + String(msg.chat.id), shopId);
  } catch (err) {
    Logger.log('⚠️ shop_ref 保存失敗: ' + err);
  }

  // 店舗グループへ来店通知
  var link = findShopLinkByShopId_(shopId);
  var custName = ((msg.from && msg.from.first_name) || '') + ' ' + ((msg.from && msg.from.last_name) || '');
  custName = custName.trim() || 'Customer';

  if (link && String(link.obj['状態']) === '連携済' && String(link.obj['グループchat_id'])) {
    try {
      sendMessage(BOT_TYPE.BOOKING, String(link.obj['グループchat_id']),
        '🔔 New customer from your QR! / お店のQRからお客様が来ました！\n' +
        'Name: ' + custName + '\n' +
        'They just opened our booking bot. We will follow up!');
    } catch (err) {
      Logger.log('⚠️ 店舗グループ来店通知失敗: ' + err);
    }
  }

  // 管理グループへも流入元を通知
  try {
    var cfg = getConfig();
    var shopName = link ? String(link.obj['店名'] || shopId) : shopId;
    sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
      '🏪 提携店QR経由の新規流入\n店: ' + shopName + '\n顧客: ' + custName);
  } catch (err) {
    Logger.log('⚠️ 管理通知失敗（QR流入）: ' + err);
  }
  return true;
}

function findShopLinkByShopId_(shopId) {
  var links = readShopLinks_();
  for (var i = 0; i < links.length; i++) {
    if (String(links[i].obj['shop_id']) === String(shopId)) return links[i];
  }
  return null;
}

/**
 * 顧客チャットIDから紹介元 shop_id を返す（予約成立処理から参照する公開ヘルパー・Phase 2）
 */
function getShopRefForCustomer(chatId) {
  try {
    return PropertiesService.getScriptProperties().getProperty('shop_ref_' + String(chatId)) || '';
  } catch (err) {
    return '';
  }
}
