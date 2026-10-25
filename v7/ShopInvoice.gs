/**
 * ShopInvoice.gs — 提携店グループへの請求（当社の ABA QR 付き）（2026-10-25）
 *
 * 【目的】提携店の仕事（店の車・店の紹介のお客さん）が終わったら、その店の Telegram グループへ
 *   「当社に払ってほしい金額」と当社の ABA QR（QRコードシートの有効行＝飯泉さんの ABA）を予約Botから自動で送る。
 *   これまでは日本側が QR 画像を手でグループに貼っていた（2026-10-25 CRSP Garage）。
 *   Daisuke「飯泉さんのqrが表示されて請求がグループの提携先に通知されるようにしたい」（2026-10-25）
 *
 * 【いつ・いくら】現場アプリの支払区分が提携店の仕事（fieldPayIsShop_: shop＝店の車 / shopref＝紹介のお客さん）の時だけ。
 *   金額は body.amount（＝当社の取り分。現場アプリが 定価×(100−店の紹介料率)% を入れ、現場で直せる・FieldPayment.gs）。
 *   紹介のお客さんには 定価（v2.list_price）と店の取り分の内訳も添える（定価が分かる時だけ）。
 *
 * 【送らない時】金額 0 以下（無料）は何もしない。店のグループが未連携・QR が無い・送れない時は
 *   管理グループに理由を出す（請求は手で）。店が分からない時は JobManager 側が警告を出すのでここでは出さない
 * 【重複】同じ作業終了の再送では送り直さない（JobIdempotency.gs の jobCustSent_ / jobMarkCustSent_。送る前に印を付ける）
 * 【文言】クメール語は Panha 校閲済み（2026-10-25）。英語は既存の店舗グループ通知に合わせた短文
 */

// Panha 校閲 2026-10-25（44/50・native_check_required: Run Kosal 確認待ち）。
// 店の取り分は ចំណែក（売上分配とも読める）を使わず កម្រៃជើងសារ（紹介手数料）＝ 2026-08-10 提携店プライスリストと同じ語
var SHOP_INVOICE_KM_ = {
  title:      'ការស្នើសុំទូទាត់ប្រាក់',
  price:      'តម្លៃសេវា',
  commission: 'កម្រៃជើងសារ របស់ហាង',
  due:        'ទឹកប្រាក់ត្រូវបង់',
  scan:       'សូមស្កេន QR ខាងលើ ដើម្បីបង់ប្រាក់។',
  screenshot: 'បន្ទាប់ពីបង់រួច សូមផ្ញើរូបថតអេក្រង់នៃការបង់ប្រាក់ មកក្នុងក្រុមនេះ។'
};
var SHOP_INVOICE_LINE_ = '━━━━━━━━━━━━━━━━━';

/** 金額の表示（既存の Bot と同じ「21$」形式・セント未満は丸める） */
function shopInvoiceUsd_(n) {
  return String(Math.round(Number(n) * 100) / 100) + '$';
}

/** 請求に出すサービス名（英語のメニュー名）。'WASH,HEADLIGHT_MAGIC' → 'SAMURAI WASH + HEADLIGHT MAGIC' */
function shopInvoiceServices_(body) {
  var csv = (typeof jobServiceCsv_ === 'function') ? jobServiceCsv_(body) : '';
  return csv.split(',').filter(String).map(function(c) {
    return c === 'WASH' ? 'SAMURAI WASH' : c.replace(/_/g, ' ');
  }).join(' + ');
}

/**
 * 請求の本文（QR 画像のキャプション。Telegram では画像の下に出る）
 * @param {Object} p - { pt, refId, carModel, plate, services, customerName, listPrice, rate, due }
 */
function buildShopInvoiceText_(p) {
  var km = SHOP_INVOICE_KM_, L = SHOP_INVOICE_LINE_;
  var lines = ['🧾 ' + km.title + ' / Payment request', L];
  if (p.refId) lines.push('🆔 ' + p.refId);
  var car = [p.carModel, p.plate].map(function(s) { return String(s || '').trim(); }).filter(String).join(' / ');
  if (car) lines.push('🚗 ' + car);
  if (p.services) lines.push('✨ ' + p.services);
  if (p.pt === 'shopref') {
    if (p.customerName) lines.push('👤 ' + p.customerName);
    // 内訳は定価が当社の取り分より大きい時だけ。率は 店の手数料 と合う時だけ出す（現場で金額を直した時に食い違わせない）
    var shareCents = Math.round(Number(p.listPrice) * 100) - Math.round(Number(p.due) * 100);
    if (shareCents > 0) {
      var pct = (Number(p.rate) > 0 && Math.round(Number(p.listPrice) * Number(p.rate)) === shareCents) ? ' (' + Number(p.rate) + '%)' : '';
      lines.push('💵 ' + km.price + ' / Service price: ' + shopInvoiceUsd_(p.listPrice));
      lines.push('🤝 ' + km.commission + pct + ' / Your commission' + pct + ': ' + shopInvoiceUsd_(shareCents / 100));
    }
  }
  lines.push(L);
  lines.push('💰 ' + km.due + ' / Amount to pay: ' + shopInvoiceUsd_(p.due));
  lines.push(L);
  lines.push('📱 ' + km.scan);
  lines.push('📱 Please scan the QR above to pay.');
  lines.push('📸 ' + km.screenshot);
  lines.push('📸 After paying, please send a screenshot of the payment to this group.');
  return lines.join('\n');
}

/**
 * 提携店の仕事の作業終了で、店のグループへ請求（QR 画像＋本文）を送り、結果を管理グループへ出す。例外は外へ出さない
 * @param {Object} body - job_end の本文（amount・carModel・plate・name・v2.list_price / v2.shop_rate）
 * @param {Object} opts - apiJobEnd の opts（cid … 再送の重複防止）
 * @param {Object} p - { shopId, pt, refId, adminOpts }
 * @return {string} sent / skip_zero / no_shop / duplicate / not_linked / no_qr / send_failed / error
 */
function sendShopInvoiceForJob_(body, opts, p) {
  var shopId = String((p && p.shopId) || '');
  var due = Math.round(Number(body && body.amount) * 100) / 100;
  if (!(due > 0)) return 'skip_zero';
  if (!shopId) return 'no_shop';
  var phase = 'invoice:' + shopId;
  var result = 'error';
  try {
    if (jobCustSent_(opts, phase)) return 'duplicate';
    var link = findShopLinkByShopId_(shopId);
    var groupChatId = (link && String(link.obj['状態']) === '連携済') ? String(link.obj['グループchat_id'] || '') : '';
    var qr = groupChatId ? getActiveQR() : null;
    if (!groupChatId) {
      result = 'not_linked';
    } else if (!qr || !qr.imageUrl) {
      result = 'no_qr';
    } else {
      jobMarkCustSent_(opts, phase);   // 送る前に印（返事が取れずに再送された時、二重に請求しない）
      var text = buildShopInvoiceText_({
        pt:           p.pt,
        refId:        p.refId,
        carModel:     body.carModel,
        plate:        body.plate,
        services:     shopInvoiceServices_(body),
        customerName: body.name,
        listPrice:    (typeof fieldListPrice_ === 'function') ? fieldListPrice_(body) : 0,
        rate:         body.v2 && body.v2.shop_rate,
        due:          due
      });
      var res = sendQRImage(groupChatId, qr.imageUrl, text);
      result = (res && res.ok) ? 'sent' : 'send_failed';
    }
  } catch (err) {
    Logger.log('⚠️ sendShopInvoiceForJob_: ' + err);
    result = 'error';
  }
  notifyShopInvoiceAdmin_(result, shopId, due, p && p.adminOpts);
  return result;
}

/** 請求の結果を管理グループへ（日本語） */
function notifyShopInvoiceAdmin_(result, shopId, due, adminOpts) {
  try {
    var name = ((typeof getShopNameById_ === 'function') && getShopNameById_(shopId)) || shopId;
    var msg;
    switch (result) {
      case 'sent':
        msg = '🧾 お店のグループへ請求を送りました: ' + name + ' $' + due + '（ABA QR 付き）';
        break;
      case 'not_linked':
        msg = '⚠️ 請求を送れていません: ' + name + ' のグループが Bot とつながっていません。当社分 $' + due + ' の QR はお店へ手で送ってください';
        break;
      case 'no_qr':
        msg = '⚠️ 請求を送れていません: QRコードシートに有効な QR がありません（有効=TRUE を1行）。当社分 $' + due + ' は ' + name + ' へ手で請求してください';
        break;
      default:
        msg = '⚠️ 請求の送信に失敗しました: ' + name + ' $' + due + '。お店のグループへ手で QR を送ってください';
    }
    sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId, msg, adminOpts || {});
  } catch (err) {
    Logger.log('⚠️ notifyShopInvoiceAdmin_: ' + err);
  }
}
