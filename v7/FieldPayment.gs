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
 *   shopref … 提携店の紹介のお客さん（当社分を店が QR でその場で払った）
 *   shop    … 提携店の車（店が QR でその場で払った）
 *   free    … 無料（デモ）
 *   later   … 未収（あとで払う）
 *   cash    … 旧（現金。v2 の画面からは外した。古い送信待ちの互換のため受け付ける）
 */

var FIELD_PAY_ON_SITE_ = { aba: true, shopref: true, shop: true, free: true, cash: true };
var FIELD_SHOP_RATE_DEFAULT_ = 30;

/** 送られてきた支払区分（v2 か旧来の paymentType）を返す */
function fieldPayType_(body) {
  return String((body && (body.paymentType || (body.v2 && body.v2.payment_type))) || '');
}

/** 提携店の仕事（紹介客・店の車）か */
function fieldPayIsShop_(pt) { return pt === 'shop' || pt === 'shopref'; }

/** その場で受け取り済み（または無料）で、あとから決済QRを送る必要がないか */
function fieldPaidOnSite_(pt) { return !!FIELD_PAY_ON_SITE_[pt]; }

/** 店マスターの「紹介料率(%)」セルを 0〜100 の数にする（空欄・読めない値は既定の 30） */
function fieldParseRate_(v) {
  if (v === '' || v === null || v === undefined) return FIELD_SHOP_RATE_DEFAULT_;
  var n = Number(String(v).replace('%', '').trim());
  if (isNaN(n) || n < 0) return FIELD_SHOP_RATE_DEFAULT_;
  if (n > 0 && n <= 1) n = n * 100;   // 0.3 のように小数で入っている時
  return n > 100 ? FIELD_SHOP_RATE_DEFAULT_ : Math.round(n * 100) / 100;
}

/** 現場アプリが送った定価（v2.list_price）。無い・おかしい時は 0 */
function fieldListPrice_(body) {
  var n = Number(body && body.v2 && body.v2.list_price);
  return n > 0 ? Math.round(n * 100) / 100 : 0;
}

/** 管理グループ通知の「支払い」行 */
function fieldPayAdminLine_(pt, shopName, body) {
  var list = fieldListPrice_(body), rate = body && body.v2 && body.v2.shop_rate;
  var split = (list > 0 && rate !== undefined && rate !== '') ? '（定価 $' + list + '・お店 ' + rate + '%）' : '';
  switch (pt) {
    case 'aba':     return '💳 支払い: ABA QR で受け取り済み\n';
    case 'shopref': return '💳 支払い: 提携店の紹介のお客さん・当社分をお店から QR で受け取り済み' + split + (shopName ? '\n🏪 ' + shopName : '') + '\n';
    case 'shop':    return '💳 支払い: 提携店の車・お店から QR で受け取り済み' + split + (shopName ? '\n🏪 ' + shopName : '') + '\n';
    case 'free':    return '💳 支払い: 無料（デモ）\n';
    case 'later':   return '💳 支払い: ⏳ 未収（あとで払う）\n';
    case 'cash':    return '💳 支払い: 現金（旧）\n';
    default:        return '';
  }
}

/**
 * 予約客がその場で払った時（QR・店・無料）: 予約を清算済みにして、決済QR・催促が出ないようにする。
 * 請求額は現場が入れた金額（無料は 0）。定価と違えば割引前金額・割引額にも残す。
 * @return {boolean} 更新したか
 */
function markBookingPaidOnSite_(bkRow, body, pt, shopName) {
  if (!bkRow || !fieldPaidOnSite_(pt)) return false;
  try {
    var amount = pt === 'free' ? 0 : Number(body.amount) || 0;
    var list = fieldListPrice_(body) || Number(bkRow.data['料金(USD)']) || amount;
    var label = { aba: 'ABA QR', shopref: '紹介客・店から QR', shop: '店の車・店から QR', free: '無料（デモ）', cash: '現金（旧）' }[pt] || pt;
    var memo = String(bkRow.data['管理者メモ'] || '');
    var add = '現場で受領: ' + label + (shopName ? '・' + shopName : '') + ' $' + amount;
    var upd = {
      '決済状態':     '清算済み',
      '入金確認日時': new Date(),
      '請求額(USD)':  amount,
      '管理者メモ':   memo ? memo + '｜' + add : add
    };
    if (list > amount) { upd['割引前金額(USD)'] = list; upd['割引額(USD)'] = Math.round((list - amount) * 100) / 100; }
    updateRow(SHEET_NAMES.BOOKINGS, bkRow.rowIndex, upd);
    return true;
  } catch (err) {
    Logger.log('⚠️ markBookingPaidOnSite_ 失敗: ' + err);
    return false;
  }
}
