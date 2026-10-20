/**
 * ShopLinkCodes.gs — 既存の shop_id のまま店舗グループ連携コードを出す（2026-10-20）
 *
 * 【背景】営業で配った店専用QR（予約Bot ?start=shop_<店マスターの既存shop_id>）は、
 *   提携店登録フォーム（ShopProvisioningManager.gs handleShopFormSubmit）を通すと新しい shop_id が
 *   採番されて食い違う。既存の shop_id のまま「Bot連携」シートに「待機中」の行（6桁コード）を作り、
 *   お店の Telegram グループで /register <コード> を送れば連携できるようにする（/register は v7/ShopRouting.gs）
 *
 * 【対象の決め方】店マスターの「QRリンク(BookingBot)」に、その行の shop_id 入りの予約Botリンクが入っている店
 *   （= 専用QRを配った店）。【サンプル】行は除く。手で指定する時は issueShopLinkCodes(['SHOP-…'])
 *
 * 【安全】同じ shop_id の行があれば作らない（待機中ならそのコードを再掲・連携済なら ✅）。
 *   コードは待機中の他の行と重ならないようにする。店マスターはロックの外で読む（ロックは Bot連携への追記だけ）
 */

/** 専用QRを配った店にまとめて連携コードを出す（エディタからそのまま実行できる・何度実行しても二重にならない） */
function issueShopLinkCodesForQrShops() {
  var ids = [], mismatch = [];
  readSheetObjects_(getShopSheet_()).forEach(function(r) {
    var sid = String(r.obj['shop_id'] || '').trim();
    var m = String(r.obj['QRリンク(BookingBot)'] || '').match(/t\.me\/[^?\s]+\?start=shop_([A-Za-z0-9_-]+)/);
    if (!sid || !m) return;
    if (sid.indexOf('SHOP-SAMPLE') === 0 || String(r.obj['店名'] || '').indexOf('【サンプル】') === 0) return;
    if (m[1] !== sid) { mismatch.push(String(r.obj['店名'] || sid) + '（行=' + sid + ' / リンク=' + m[1] + '）'); return; }
    ids.push(sid);
  });
  if (mismatch.length) Logger.log('⚠️ QRリンクの shop_id が行と違うため対象外: ' + mismatch.join(' / '));
  if (!ids.length && !mismatch.length) {
    Logger.log('ℹ️ 店マスターの「QRリンク(BookingBot)」に予約Botのリンクが入った店がありません');
    return [];
  }
  return issueShopLinkCodes(ids, mismatch);
}

/**
 * 指定した既存 shop_id に連携コードを出し、管理グループ（パートナートピック）へ一覧で通知する
 * @param {string[]|string} shopIds
 * @param {string[]} [mismatch] - 通知に載せる「リンクと行の shop_id が違う店」
 * @return {Array<{shopId:string, shopName:string, status:string, code:string}>}
 *   status: issued（今回発行）/ pending（発行済み・未連携 → 既存コード）/ linked（連携済み）/ not_found（店マスターに無い）
 */
function issueShopLinkCodes(shopIds, mismatch) {
  if (typeof shopIds === 'string') shopIds = [shopIds];
  var shopById = {};
  readSheetObjects_(getShopSheet_()).forEach(function(r) { shopById[String(r.obj['shop_id'])] = r.obj; });
  var sheet = ensureShopLinkSheet_();
  var props = getShopProvProps_();
  var results = [];

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20 * 1000)) {
    Logger.log('❌ issueShopLinkCodes: ロックを取れませんでした。少し待って再実行してください');
    return results;
  }
  try {
    var byShop = {}, usedCodes = {}, rank = { '連携済': 3, '待機中': 2 };
    readSheetObjects_(sheet).forEach(function(r) {
      var sid = String(r.obj['shop_id'] || ''), st = String(r.obj['状態'] || '');
      if (st === '待機中') usedCodes[String(r.obj['ワンタイムコード'])] = true;
      if (!sid || !rank[st]) return;                       // 停止などの行は「無い」扱い（新しく出す）
      if (!byShop[sid] || rank[st] > rank[String(byShop[sid]['状態'])]) byShop[sid] = r.obj;
    });
    (shopIds || []).forEach(function(raw) {
      var sid = String(raw || '').trim();
      if (!sid) return;
      var shop = shopById[sid];
      if (!shop) { results.push({ shopId: sid, shopName: '', status: 'not_found', code: '' }); return; }
      var name = String(shop['店名'] || sid);
      var ex = byShop[sid];
      if (ex) {
        var linked = String(ex['状態']) === '連携済';
        results.push({ shopId: sid, shopName: name, status: linked ? 'linked' : 'pending', code: linked ? '' : String(ex['ワンタイムコード'] || '') });
        return;
      }
      var otc;
      do { otc = String(Math.floor(100000 + Math.random() * 900000)); } while (usedCodes[otc]);
      usedCodes[otc] = true;
      appendSheetRow_(sheet, {
        'shop_id': sid, '店名': name, 'ワンタイムコード': otc, '状態': '待機中',
        'QRリンク': 'https://t.me/' + props.botUsername + '?start=shop_' + sid,
        '登録日時': formatOpsDateTime_(new Date())
      });
      byShop[sid] = { '状態': '待機中', 'ワンタイムコード': otc };
      results.push({ shopId: sid, shopName: name, status: 'issued', code: otc });
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  results.forEach(function(r) { Logger.log([r.status, r.shopName, r.shopId, r.code].join(' / ')); });
  try { notifyShopLinkCodes_(results, mismatch || []); } catch (err) { Logger.log('⚠️ 連携コード一覧の通知失敗: ' + err); }
  return results;
}

/** 連携コードの一覧と残りの手順を管理グループ（パートナートピック）へ送る（長い時は分けて送る） */
function notifyShopLinkCodes_(results, mismatch) {
  var open = results.filter(function(r) { return r.status === 'issued' || r.status === 'pending'; });
  var linked = results.filter(function(r) { return r.status === 'linked'; });
  var missing = results.filter(function(r) { return r.status === 'not_found'; });
  if (!open.length && !missing.length && !mismatch.length) return;
  var lines = ['🔗 店舗グループ連携コード（配った店専用QRのまま連携）', ''];
  open.forEach(function(r) { lines.push((r.status === 'issued' ? '🆕 ' : '⏳ ') + r.shopName + ' : ' + r.code); });
  if (linked.length) lines.push('', '✅ 連携済み: ' + linked.map(function(r) { return r.shopName; }).join(' / '));
  if (missing.length) lines.push('', '❓ 店マスターに無い shop_id: ' + missing.map(function(r) { return r.shopId; }).join(' / '));
  if (mismatch.length) lines.push('', '⚠️ QRリンクの shop_id が行と違う（対象外・店マスターを確認）: ' + mismatch.join(' / '));
  lines.push('', '【手順（店ごと）】');
  lines.push('1. お店の人と Telegram グループを作り、予約Botを招待する');
  lines.push('2. そのグループで「/register <上のコード>」と送る → Botが✅を返したら完了');
  lines.push('→ 以後、その店のQRから来たお客様の作業開始・完了・写真と月次レポートがグループに届く');

  var cfg = getConfig();
  var opts = { disable_web_page_preview: true };
  if (cfg.adminPartnerThreadId) opts.message_thread_id = Number(cfg.adminPartnerThreadId);
  var chunk = '';
  lines.forEach(function(l) {   // Telegram の上限（4096文字）を超えないよう行単位で分ける。1行が長すぎる時は切り詰める
    if (l.length > 3400) l = l.substring(0, 3400) + '…（以下略・実行ログを確認）';
    if (chunk && (chunk + '\n' + l).length > 3500) { sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, chunk, opts); chunk = l; }
    else chunk = chunk ? chunk + '\n' + l : l;
  });
  if (chunk) sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, chunk, opts);
}
