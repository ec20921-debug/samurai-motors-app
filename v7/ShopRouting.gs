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
// 予約Botのユーザー名（公開情報。店のQRリンク t.me/<これ>?start=shop_... と同じ）。管理通知の連携手順に使う
// v7-operations 側は Script Property SHOP_BOOKING_BOT_USERNAME（既定は同じ文字列）。Bot 名を変えるときは両方を直す
var SHOP_LINK_BOT_USERNAME = 'SAMURAI_MOTORS_BOOKING_BOT';

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

  // お店向けのあいさつ文（km+en）を続けて自動送信（ShopGroupGreeting.gs・2026-10-24）。失敗しても毎時の安全網が拾う
  try {
    if (typeof sendShopGroupGreetingOnce_ === 'function') sendShopGroupGreetingOnce_(shopIdHit, msg.chat.id, shopName);
  } catch (err) {
    Logger.log('⚠️ あいさつ文 送信エラー（連携完了）: ' + err);
  }

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

  // 店マスターに無い shop_id・停止中の店のリンクは店扱いにしない（2026-10-20）
  // shop_ref があると当社の決済QRを止めるため、誤植・古いQR・自作リンクで止まらないよう入口で確かめる
  var master = lookupShopMaster_(shopId);   // 読み取りエラー時は店扱いで進める（決済の判定は getValidShopRef_ で再確認）
  var link = null;
  try { link = findShopLinkByShopId_(shopId); } catch (err) { Logger.log('⚠️ Bot連携の読み取り失敗: ' + err); }
  var stopped = !!(link && String(link.obj['状態']) === '停止');
  var welcomeShopName = (link && link.obj['店名']) ? String(link.obj['店名']) : (master.found ? (master.name || shopId) : '');
  if ((!master.found && !master.error) || stopped) {
    sendWelcomeMessage(msg);
    ensureCustomerTopic(msg);
    try {
      sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId,
        '⚠️ 店QRのリンクから来たが、店として扱わなかった（' + (stopped ? '停止中の店' : '店マスターに無い shop_id') + '）\n' +
        'shop_id: ' + shopId + '\n顧客 chat_id: ' + msg.chat.id + '\n→ 通常のお客様として案内（決済QRも通常どおり）');
    } catch (err) {
      Logger.log('⚠️ 管理通知失敗（不明な店QR）: ' + err);
    }
    return true;
  }

  // 提携店専用ウェルカム: 紹介元店名を表示し、キャンペーンは非表示
  // （提携店経由は定価・キャンペーン対象外 = 2026-08-10 Daisuke裁可⑩）
  sendWelcomeMessage(msg, { skipCampaign: true, shopName: welcomeShopName });
  ensureCustomerTopic(msg);

  // 顧客→店タグ（Phase 2 で予約レコードへ転記するための参照）
  // 最後に読んだQRを優先: レジデンス等の流入元（src_ref）は外す（2026-10-20）
  try {
    var sp = PropertiesService.getScriptProperties();
    sp.setProperty('shop_ref_' + String(msg.chat.id), shopId);
    sp.deleteProperty('src_ref_' + String(msg.chat.id));
  } catch (err) {
    Logger.log('⚠️ shop_ref 保存失敗: ' + err);
  }

  // 流入分析用にファネルログへ記録（流入元QRの 'src:<コード>' と同じ形・2026-10-21）。失敗しても本処理は止めない
  if (typeof logFunnelEvent === 'function') {
    try { logFunnelEvent(msg.chat.id, 'bot_start', 'shop:' + shopId, '', null); } catch (err) { Logger.log('⚠️ ファネル記録失敗（店QR）: ' + err); }
  }

  // 店舗グループへ来店通知
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
    var linked = !!(link && String(link.obj['状態']) === '連携済');
    sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
      '🏪 提携店QR経由の新規流入\n店: ' + (welcomeShopName || shopId) + '\n顧客: ' + custName +
      (linked ? '' : '\n（店舗グループ未連携: 店への写真・月次レポートは届きません。決済QRは送りません）' +
        shopLinkGuideText_(link, welcomeShopName || shopId)));
  } catch (err) {
    Logger.log('⚠️ 管理通知失敗（QR流入）: ' + err);
  }
  return true;
}

/**
 * 未連携の店の管理通知に添える「グループのつなぎ方」（2026-10-24 Daisuke「手順とコード等を毎回わかりやすく」）。
 * グループ名は営業アプリ（v7-operations/ShopQrSticker.gs）と同じ「店名 × SAMURAI MOTORS」。
 * Bot を先に入れる: Bot は自分が入る前のメッセージを読めない（2026-10-25 EV ហ្ការ៉ាស で /register が空振り）
 */
function shopLinkGuideText_(link, shopName) {
  var code = (link && String(link.obj['状態']) === '待機中') ? String(link.obj['ワンタイムコード'] || '').trim() : '';
  if (!code) {
    return '\n\n🔗 連携コードがまだありません → 営業アプリのお店の画面「🔗 このお店のQRを出す」で発行すると、コードが出ます';
  }
  return '\n\n🔗 グループのつなぎ方\n' +
    '① グループ名: ' + shopName + ' × SAMURAI MOTORS\n' +
    '② 先に予約Bot @' + SHOP_LINK_BOT_USERNAME + ' を入れ、お店の人・Run Kosal さんも入れる\n' +
    '③ グループでこの1行を送る: /register ' + code + '\n' +
    '→ Bot が「✅ Connected!」とあいさつ文を自動で送れば完了';
}

function findShopLinkByShopId_(shopId) {
  // 同じ shop_id の行が複数ある時は 連携済 → 待機中 → それ以外（停止など）の順に選ぶ（2026-10-20）
  var links = readShopLinks_(), best = null, rank = { '連携済': 3, '待機中': 2 };
  for (var i = 0; i < links.length; i++) {
    if (String(links[i].obj['shop_id']) !== String(shopId)) continue;
    var r = rank[String(links[i].obj['状態'])] || 1;
    if (!best || r > best.r) best = { r: r, link: links[i] };
  }
  return best ? best.link : null;
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

/**
 * shop_id → 店名。Bot連携シート（連携済・待機中）→ 店マスター の順に探す。見つからなければ ''。
 * 店マスターの読み取りは 5 分キャッシュ（OPS_LESSONS #8: 全読みをリクエスト毎に繰り返さない）
 */
var SHOP_NAME_CACHE_KEY = 'shop_master_names_v1';

/**
 * 店マスターを shop_id で引く。{found, name, error}
 *   found = 店マスターに行がある / error = 読み取りに失敗して分からない（found は false）
 * 店マスターの読み取りは 5 分キャッシュ。キャッシュに無い id だけ読み直す（キャッシュ後に登録された店）
 * Object のプロトタイプ名（constructor 等）に当たらないよう hasOwnProperty で確かめる
 */
function lookupShopMaster_(shopId) {
  var id = String(shopId || '');
  if (!id) return { found: false, name: '', error: false };
  var has = function(m) { return !!m && Object.prototype.hasOwnProperty.call(m, id) && typeof m[id] === 'string'; };
  var cache = CacheService.getScriptCache();
  var map = null;
  try { map = JSON.parse(cache.get(SHOP_NAME_CACHE_KEY) || 'null'); } catch (ignore) {}
  if (has(map)) return { found: true, name: map[id], error: false };
  try {
    map = {};
    var sh = getSpreadsheet().getSheetByName('店マスター');
    if (!sh) throw new Error('店マスター タブがありません');
    if (sh.getLastRow() >= 2) {
      var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
      var ci = head.indexOf('shop_id'), ni = head.indexOf('店名');
      if (ci < 0 || ni < 0) throw new Error('店マスターに shop_id / 店名 の列がありません');
      sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(ci, ni) + 1).getValues().forEach(function(r) {
        if (r[ci]) map[String(r[ci])] = String(r[ni] || '');
      });
    }
    try { cache.put(SHOP_NAME_CACHE_KEY, JSON.stringify(map), 300); } catch (ignore) {}
  } catch (err) {
    Logger.log('⚠️ 店マスター読み取り失敗: ' + err);
    return { found: false, name: '', error: true };
  }
  return has(map) ? { found: true, name: map[id], error: false } : { found: false, name: '', error: false };
}

/** shop_id → 店名（Bot連携 → 店マスター）。分からなければ ''。表示用（判定には lookupShopMaster_ / getValidShopRef_） */
function getShopNameById_(shopId) {
  if (!shopId) return '';
  try {
    var link = findShopLinkByShopId_(shopId);
    if (link && link.obj['店名']) return String(link.obj['店名']);
  } catch (err) {
    Logger.log('⚠️ Bot連携の読み取り失敗（店名は店マスターから）: ' + err);
  }
  var hit = lookupShopMaster_(shopId);
  return hit.found ? (hit.name || String(shopId)) : '';
}

/**
 * 「店に支払う」お客様か（= 当社の決済QR・支払いのご案内を送らない）。該当すれば shop_id、しなければ ''。
 * shop_ref があり、その店が店マスターにあり、Bot連携で停止になっていない時だけ（2026-10-20）
 * 読み取りエラーで分からない時は店扱い（当社QRを送ると取り消せない・二重請求になるため止める側に倒す）。例外は外へ出さない
 */
function getValidShopRef_(chatId) {
  var shopId = getShopRefForCustomer(chatId);
  if (!shopId) return '';
  try {
    var hit = lookupShopMaster_(shopId);
    if (hit.error) {
      Logger.log('⚠️ getValidShopRef_: 店マスターを読めないため店扱い（shop=' + shopId + '）');
      return shopId;
    }
    if (!hit.found) return '';
    var link = findShopLinkByShopId_(shopId);
    if (link && String(link.obj['状態']) === '停止') return '';
    return shopId;
  } catch (err) {
    Logger.log('⚠️ getValidShopRef_ 判定エラー（店扱い）: ' + err);
    return shopId;
  }
}

/**
 * 紹介元の店舗グループへ作業通知＋写真アルバムを同報する（JobManager から呼ばれる）。
 * 顧客が店QR経由でない・グループ未連携の場合は何もしない。
 *
 * @param {string} customerChatId - 顧客チャットID
 * @param {string} text - 通知本文（店スタッフ向け・英語短文）
 * @param {Array} blobs - 写真Blob配列（省略可）
 * @return {string} 通知した shop_id（該当なしは ''）
 */
function notifyShopGroupJobPhotos(customerChatId, text, blobs) {
  try {
    return notifyShopGroupByShopId_(getShopRefForCustomer(customerChatId), text, blobs);
  } catch (err) {
    Logger.log('⚠️ notifyShopGroupJobPhotos エラー: ' + err);
    return '';
  }
}

/**
 * 指定の店の店舗グループ（連携済のみ）へ本文＋写真を送る。送った shop_id を返す（2026-10-22 現場アプリで店を選んだ作業用に分離）
 */
function notifyShopGroupByShopId_(shopId, text, blobs) {
  try {
    if (!shopId) return '';
    var link = findShopLinkByShopId_(shopId);
    if (!link || String(link.obj['状態']) !== '連携済') return '';
    var groupChatId = String(link.obj['グループchat_id'] || '');
    if (!groupChatId) return '';

    sendMessage(BOT_TYPE.BOOKING, groupChatId, text);
    if (blobs && blobs.length > 0 && typeof sendPhotoAlbum === 'function') {
      try {
        sendPhotoAlbum(BOT_TYPE.BOOKING, groupChatId, blobs, '', {});
      } catch (e) {
        Logger.log('⚠️ 店舗グループ写真送信失敗: ' + e);
      }
    }
    return shopId;
  } catch (err) {
    Logger.log('⚠️ notifyShopGroupByShopId_ エラー: ' + err);
    return '';
  }
}

/**
 * GET field_partner_shops — 現場アプリの「どの提携店？」の選択肢（2026-10-22）
 * 店マスターで専用QRを配った店（QRリンク(BookingBot) あり）＋Bot連携にある店。【サンプル】・停止中は除く
 * 2026-10-25: 店ごとの率（店マスター「紹介料率(%)」・空欄=30）を rate で返す。現場アプリが 当社の受け取り＝定価×(100−rate)% を自動で入れる
 * @return {{status:string, shops:Array<{id:string, name:string, rate:number}>}}
 */
function apiFieldPartnerShops() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('field_partner_shops_v2');
  if (hit) {
    try { return { status: 'ok', shops: JSON.parse(hit) }; } catch (ignore) {}
  }
  var out = [], seen = {}, rates = {};
  var stopped = {};
  readShopLinks_().forEach(function(l) {
    var id = String(l.obj['shop_id'] || '');
    if (String(l.obj['状態']) === '停止') { if (!stopped.hasOwnProperty(id)) stopped[id] = true; }
    else stopped[id] = false;
  });
  var add = function(id, name) {
    id = String(id || '').trim();
    if (!id || seen[id] || stopped[id] === true || id.indexOf('SHOP-SAMPLE') === 0 || String(name || '').indexOf('【サンプル】') === 0) return;
    seen[id] = true;
    out.push({ id: id, name: String(name || id),
               rate: rates.hasOwnProperty(id) ? rates[id] : (typeof FIELD_SHOP_RATE_DEFAULT_ !== 'undefined' ? FIELD_SHOP_RATE_DEFAULT_ : 30) });
  };
  try {
    var sh = getSpreadsheet().getSheetByName('店マスター');
    if (sh && sh.getLastRow() >= 2) {
      var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
      var ci = head.indexOf('shop_id'), ni = head.indexOf('店名'), qi = head.indexOf('QRリンク(BookingBot)'), ri = head.indexOf('紹介料率(%)');
      if (ci >= 0 && ni >= 0 && qi >= 0) {
        var vals = sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(ci, ni, qi, ri) + 1).getValues();
        // 先に全店の率を拾う（Bot連携だけにある店にも使う）
        if (ri >= 0) vals.forEach(function(r) {
          var id = String(r[ci] || '').trim();
          if (id && typeof fieldParseRate_ === 'function') rates[id] = fieldParseRate_(r[ri]);
        });
        vals.forEach(function(r) {
          if (/t\.me\/[^?\s]+\?start=shop_/.test(String(r[qi] || ''))) add(r[ci], r[ni]);
        });
      }
    }
  } catch (err) {
    Logger.log('⚠️ apiFieldPartnerShops 店マスター: ' + err);
  }
  readShopLinks_().forEach(function(l) { if (String(l.obj['状態']) !== '停止') add(l.obj['shop_id'], l.obj['店名']); });
  out.sort(function(a, b) { return a.name.localeCompare(b.name); });
  try { cache.put('field_partner_shops_v2', JSON.stringify(out), 60); } catch (ignore) {}   // アプリの起動ごとにシートを読まない
  return { status: 'ok', shops: out };
}

/**
 * 現場アプリから来た shop_id を確かめる（店マスターかBot連携にあり、停止・サンプルでない）。だめなら ''
 * 端末から来る値なので、シートが読めない時も通さない（元の値は 作業記録の v2記録(JSON) に残るので後から直せる）
 */
function validFieldShopId_(shopId) {
  var id = String(shopId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(id) || id.indexOf('SHOP-SAMPLE') === 0) return '';
  try {
    var link = findShopLinkByShopId_(id);
    if (link && String(link.obj['状態']) === '停止') return '';
    if (link) return id;
    return lookupShopMaster_(id).found ? id : '';
  } catch (err) {
    Logger.log('⚠️ validFieldShopId_ 確認できず shop_id=' + id + ': ' + err);
    return '';
  }
}
