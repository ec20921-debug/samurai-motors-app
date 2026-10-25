/**
 * FieldPayment.gs — 現場アプリ v2 の支払区分（その場での受け取り）の共通処理（2026-10-25）
 *
 * 【Daisuke 決定 2026-10-25】
 *   - 当社がお金を受け取るのは ABA の QR だけ（現金は受け取らない）
 *   - 提携店の紹介のお客さん: お客さんは店に定価 → 店は紹介料率ぶんを取り、当社分を店が QR で払う。売上は当社の取り分だけ
 *   - 提携店の車（在庫車など）: 店が当社に（定価 −紹介料率ぶん）を QR でその場で払う
 *   - 紹介客も店の車も、率は店マスター「紹介料率(%)」（空欄=30%）。現場アプリが自動で金額を入れ、現場で直せる
 *   - 予約客がその場で払った（QR・店・無料）時は、決済QRと催促を送らない
 *
 * 【支払区分】（現場アプリ v2 の v2.payment_type。作業記録「支払区分」列）
 *   aba     … お客さんが当社の ABA QR でその場で払った
 *   shopref … 提携店の紹介のお客さん（当社分を店が QR でその場で払う・店グループへ請求 ShopInvoice.gs）
 *   shop    … 提携店の車（同上）
 *   free    … 無料（デモ）
 *   later   … 未収（あとで払う）
 *   cash    … 旧（現金。v2 の画面からは外した。古い送信待ちの互換のため受け付ける）
 *
 * 【売上の持ち方】料金(USD)＝請求額(USD)＝当社が受け取った額。お店の取り分は割引額に入れず、管理者メモに 定価・率 を残す
 *   （割引額はキャンペーン等の本当の割引だけ＝割引 KPI を膨らませない）
 */

var FIELD_PAY_ON_SITE_ = { aba: true, shopref: true, shop: true, free: true, cash: true };
var FIELD_PAY_TYPES_ = { aba: true, shopref: true, shop: true, free: true, later: true, cash: true };
var FIELD_SHOP_RATE_DEFAULT_ = 30;
var FIELD_AMOUNT_MAX_ = 2000;   // 1回の作業でこれを超える金額は打ち間違いとみなす（清算済みにしない）

function fieldHas_(o, k) { return Object.prototype.hasOwnProperty.call(o, String(k)); }

/** 送られてきた支払区分（v2 か旧来の paymentType）。決まった値以外は '' */
function fieldPayType_(body) {
  var pt = String((body && (body.paymentType || (body.v2 && body.v2.payment_type))) || '');
  return fieldHas_(FIELD_PAY_TYPES_, pt) ? pt : '';
}

/** 提携店の仕事（紹介客・店の車）か */
function fieldPayIsShop_(pt) { return pt === 'shop' || pt === 'shopref'; }

/** その場で受け取り済み（または無料）で、あとから決済QRを送る必要がないか */
function fieldPaidOnSite_(pt) { return fieldHas_(FIELD_PAY_ON_SITE_, pt); }

/**
 * 店マスターの「紹介料率(%)」セルを 0〜100 の数にする。読み方は v7-operations/CommissionManager.gs parsePercentCell_ と同じ
 * （"30"・"30%"・30 → 30、シートの%書式の数値 0.3 → 30。空欄・読めない値は既定の 30）
 */
function fieldParseRate_(v) {
  if (v === '' || v === null || v === undefined) return FIELD_SHOP_RATE_DEFAULT_;
  var n = Number(String(v).replace('%', '').trim());
  if (!isFinite(n)) return FIELD_SHOP_RATE_DEFAULT_;
  if (n > 0 && n < 1 && typeof v === 'number') n = n * 100;
  n = Math.round(n * 100) / 100;
  return (n < 0 || n > 100) ? FIELD_SHOP_RATE_DEFAULT_ : n;
}

/** 店マスターの率（field_partner_shops の一覧から・60秒キャッシュ）。分からない時は null */
function fieldShopRateById_(shopId) {
  if (!shopId || typeof apiFieldPartnerShops !== 'function') return null;
  try {
    var hit = (apiFieldPartnerShops().shops || []).filter(function(s) { return s.id === String(shopId); })[0];
    return hit && hit.rate !== undefined ? Number(hit.rate) : null;
  } catch (err) { return null; }
}

/** 現場アプリが送った定価（v2.list_price）。無い・おかしい時は 0 */
function fieldListPrice_(body) {
  var n = Number(body && body.v2 && body.v2.list_price);
  return (isFinite(n) && n > 0 && n <= FIELD_AMOUNT_MAX_) ? Math.round(n * 100) / 100 : 0;
}

/** 金額が使えるか（無料は 0 でよい。それ以外は 0 より大きく上限以下） */
function fieldAmountOk_(pt, body) {
  if (pt === 'free') return true;
  var a = Number(body && body.amount);
  return isFinite(a) && a > 0 && a <= FIELD_AMOUNT_MAX_;
}

/** 店の仕事の内訳（定価・率・期待値）。率は端末の値ではなく店マスターの値を優先して検算する */
function fieldShopSplit_(body, shopId) {
  var list = fieldListPrice_(body), amount = Number(body && body.amount) || 0;
  var master = fieldShopRateById_(shopId);
  var sent = body && body.v2 && body.v2.shop_rate !== undefined && body.v2.shop_rate !== '' ? Number(body.v2.shop_rate) : null;
  var rate = master !== null && isFinite(master) ? master : (isFinite(sent) ? sent : null);
  var expected = (list > 0 && rate !== null) ? Math.round(list * (100 - rate)) / 100 : null;
  return { list: list, rate: rate, expected: expected, amount: amount,
           mismatch: expected !== null && Math.abs(amount - expected) > 0.5 };
}

/** 管理グループ通知の「支払い」行 */
function fieldPayAdminLine_(pt, shopName, body, shopId) {
  var sp = fieldPayIsShop_(pt) ? fieldShopSplit_(body, shopId) : null;
  var split = sp && sp.list > 0 && sp.rate !== null ? '（定価 $' + sp.list + '・お店 ' + sp.rate + '%）' : '';
  var warn = sp && sp.mismatch ? '\n⚠️ 店マスターの率だと当社分は $' + sp.expected + '（現場で金額を変えています。確認してください）' : '';
  switch (pt) {
    case 'aba':     return '💳 支払い: ABA QR で受け取り済み\n';
    case 'shopref': return '💳 支払い: 提携店の紹介のお客さん・当社分はお店がその場で QR で払う（店グループへ請求）' + split + (shopName ? '\n🏪 ' + shopName : '') + warn + '\n';
    case 'shop':    return '💳 支払い: 提携店の車・お店がその場で QR で払う（店グループへ請求）' + split + (shopName ? '\n🏪 ' + shopName : '') + warn + '\n';
    case 'free':    return '💳 支払い: 無料（デモ）\n';
    case 'later':   return '💳 支払い: ⏳ 未収（あとで払う）\n';
    case 'cash':    return '💳 支払い: 現金（旧）\n';
    default:        return '';
  }
}

/**
 * 予約客がその場で払った時（QR・店・無料）: 予約を清算済みにして、決済QR・催促が出ないようにする。
 * 料金・請求額は現場が入れた金額（＝当社が受け取った額。無料は 0）。
 * ABA で定価より安くした時だけ割引前金額・割引額に残す。店の仕事は 定価・率 を管理者メモに残す（割引額には入れない）。
 * 同じ作業の再送では何もしない（すでに「現場で受領」が書かれていれば true）。
 * @return {boolean} 清算済みにした（またはすでに清算済み）か。false の時は呼び出し側が決済QRを通常どおり扱う
 */
function markBookingPaidOnSite_(bkRow, body, pt, shopName, shopId) {
  if (!bkRow || !fieldPaidOnSite_(pt)) return false;
  var memo = String(bkRow.data['管理者メモ'] || '');
  if (String(bkRow.data['決済状態'] || '') === '清算済み' && memo.indexOf('現場で受領:') >= 0) return true;
  if (!fieldAmountOk_(pt, body)) {
    Logger.log('⚠️ markBookingPaidOnSite_: 金額が不正のため清算済みにしない amount=' + (body && body.amount));
    return false;
  }
  try {
    var amount = pt === 'free' ? 0 : Math.round(Number(body.amount) * 100) / 100;
    var label = { aba: 'ABA QR', shopref: '紹介客・店から QR', shop: '店の車・店から QR', free: '無料（デモ）', cash: '現金（旧）' }[pt] || pt;
    var add = '現場で受領: ' + label + (shopName ? '・' + shopName : '') + ' $' + amount;
    if (fieldPayIsShop_(pt)) {
      var sp = fieldShopSplit_(body, shopId);
      if (sp.list > 0) add += '（定価 $' + sp.list + (sp.rate !== null ? '・お店 ' + sp.rate + '%' : '') + '）';
    }
    var upd = {
      '決済状態':     '清算済み',
      '入金確認日時': new Date(),
      '料金(USD)':    amount,
      '請求額(USD)':  amount,
      '管理者メモ':   memo ? memo + '｜' + add : add
    };
    // 予約にもともと割引（キャンペーン等）がある時は、その割引前金額を基準にする
    var before = Number(bkRow.data['割引前金額(USD)']) || Number(bkRow.data['料金(USD)']) || 0;
    if ((pt === 'aba' || pt === 'cash') && before > amount) {
      upd['割引前金額(USD)'] = before; upd['割引額(USD)'] = Math.round((before - amount) * 100) / 100;
    }
    updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, upd);
    return true;
  } catch (err) {
    Logger.log('⚠️ markBookingPaidOnSite_ 失敗: ' + err);
    return false;
  }
}
