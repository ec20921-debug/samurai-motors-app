/**
 * CampaignShopFilter.gs — 一斉配信から「提携店QR経由のお客様」を外す（2026-10-26 Daisuke「外して」）
 *
 * 【目的】店QR（start=shop_<shop_id>）から来たお客様は 定価・全体キャンペーン対象外（2026-08-10 裁可⑩）。
 *   予約画面・予約作成ではキャンペーンを外しているので、割引を書いた一斉配信が届くと予約の金額と食い違う。
 *   割引の無いお知らせも含めて、一斉配信そのものから外す（Daisuke 了承済み）。
 *
 * 【判定】決済QR・予約と同じ getValidShopRef_（ShopRouting.gs）
 *   - 店マスターに無い・Bot連携で停止中の店のリンクから来た人は外さない（通常のお客様）
 *   - 店マスターが読めない時は店扱い＝外す側に倒す（割引の配信が店のお客様に届くより安全）
 *   - レジデンス等の流入元（src_ref・Picasso 等）は対象外（当社に払うお客様なので配信する）
 *
 * 【呼び出し元】Campaign.gs buildRecipientList_（手動の一斉送信・プレビュー・予約配信 CampaignScheduler.gs の全部が通る）
 */

var CAMPAIGN_SHOP_REF_PREFIX_ = 'shop_ref_';

/**
 * 一斉配信から外す chatId → shop_id。Script Properties はまとめて1回だけ読み、shop_ref のある人だけ判定する。
 * 読めない時は例外を投げる（呼び元で送信を止める。店のお客様に割引の配信が届くのを防ぐ）
 * @return {Object<string, string>}
 */
function getShopRefChatIdsForBroadcast_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var out = {};
  Object.keys(all).forEach(function(k) {
    if (k.indexOf(CAMPAIGN_SHOP_REF_PREFIX_) !== 0 || !all[k]) return;
    var chatId = k.substring(CAMPAIGN_SHOP_REF_PREFIX_.length);
    if (chatId && getValidShopRef_(chatId)) out[chatId] = String(all[k]);
  });
  return out;
}
