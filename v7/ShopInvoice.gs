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
 * 【送らない時】金額 0 以下（無料）は何もしない。定価が無い・金額が定価を超える・店が分からない・
 *   店のグループが未連携・QR が無い・送れない時は、管理グループに理由を出す（請求は手で）
 * 【重複】作業記録「店への請求」列で判定（送る前に「送信中」）。作業終了の再送では送り直さない
 * 【文言】クメール語は Panha 校閲済み（2026-10-25）。英語は既存の店舗グループ通知に合わせた短文
 */

// Panha 校閲 2026-10-25（44/50・native_check_required: Run Kosal 確認待ち）。
// 店の取り分は ចំណែក（売上分配とも読める）を使わず កម្រៃជើងសារ（紹介手数料）＝ 2026-08-10 提携店プライスリストと同じ語
var SHOP_INVOICE_KM_ = {
  title:      'ការស្នើសុំទូទាត់ប្រាក់',
  price:      'តម្លៃសេវា',
  commission: 'កម្រៃជើងសារ របស់ហាង',
  due:        'ទឹកប្រាក់ត្រូវបង់',
  scan:       'សូមស្កេន QR ខាងលើ ដើម្បីបង់ប្រាក់ឱ្យ Samurai Motors។',   // 支払先を明示（QR は個人名義のため・Daisuke 2026-10-25）
  screenshot: 'បន្ទាប់ពីបង់រួច សូមផ្ញើរូបថតអេក្រង់នៃការបង់ប្រាក់ មកក្នុងក្រុមនេះ។'
};
var SHOP_INVOICE_LINE_ = '━━━━━━━━━━━━━━━━━';
var SHOP_INVOICE_COL_ = '店への請求';   // 作業記録の列（JobIdempotency.gs JOBS_V2_COLS_）

/** 金額の表示（既存の Bot と同じ「21$」形式。セントがある時は 30.10$） */
function shopInvoiceUsd_(n) {
  var cents = Math.round(Number(n) * 100);
  return (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)) + '$';
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
  lines.push('📱 Please scan the QR above to pay Samurai Motors.');
  lines.push('📸 ' + km.screenshot);
  lines.push('📸 After paying, please send a screenshot of the payment to this group.');
  return lines.join('\n');
}

/**
 * 提携店の仕事の作業終了で、店のグループへ請求（QR 画像＋本文）を送り、結果を管理グループへ出す。例外は外へ出さない
 *
 * 【自動で送る条件】現場アプリ v2 の作業終了（作業記録の行がある）・金額 > 0・店が決まっている・
 *   定価（v2.list_price）があって 金額 ≦ 定価（定価を超える／定価が無い＝古い支払い画面の時は、定価そのままを
 *   請求しかねないので送らずに管理グループへ）・店のグループが連携済・QR がある
 * 【二重防止】作業記録「店への請求」列（送信中 → 送信済 / 未送信(理由)）。作業終了の再送で値があれば送らない。
 *   「送信中」のまま残っていたら（前回が途中で止まった）送り直さずに管理グループへ確認を頼む
 *
 * @param {Object} body - job_end の本文（amount・carModel・plate・name・v2.list_price / v2.shop_rate）
 * @param {Object} opts - apiJobEnd の opts（rowIndex・rowData … 作業記録の行）
 * @param {Object} p - { shopId, pt, refId, adminOpts }
 * @return {string} sent / skip_zero / duplicate / unknown / no_row / no_shop / no_list_price / over_list / not_linked / no_qr / send_failed / error
 */
function sendShopInvoiceForJob_(body, opts, p) {
  p = p || {};
  var shopId = String(p.shopId || '');
  var due = Math.round(Number(body && body.amount) * 100) / 100;
  if (!(due > 0)) return 'skip_zero';   // 無料・未入力（管理通知もしない）
  var result = 'error';
  try {
    if (!opts || !opts.rowIndex) {
      result = 'no_row';
    } else {
      var prev = String((opts.rowData && opts.rowData[SHOP_INVOICE_COL_]) || '');
      if (prev.indexOf('送信中') === 0) {
        result = 'unknown';
      } else if (prev) {
        return 'duplicate';
      } else {
        result = shopInvoiceSend_(body, opts, p, shopId, due);
      }
    }
  } catch (err) {
    Logger.log('⚠️ sendShopInvoiceForJob_: ' + err);
    result = 'error';
  }
  if (result !== 'unknown' && opts && opts.rowIndex) {
    shopInvoiceMark_(opts.rowIndex, result === 'sent' ? '送信済' : '未送信(' + result + ')');
  }
  notifyShopInvoiceAdmin_(result, shopId, due, p.adminOpts);
  return result;
}

/** 条件を確かめて送る（sendShopInvoiceForJob_ の中身）。結果コードを返す */
function shopInvoiceSend_(body, opts, p, shopId, due) {
  if (!shopId) return 'no_shop';
  var listPrice = (typeof fieldListPrice_ === 'function') ? fieldListPrice_(body) : 0;
  if (!(listPrice > 0)) return 'no_list_price';
  if (due > listPrice) return 'over_list';
  var link = findShopLinkByShopId_(shopId);
  var groupChatId = (link && String(link.obj['状態']) === '連携済') ? String(link.obj['グループchat_id'] || '') : '';
  if (!groupChatId) return 'not_linked';
  var qr = getActiveQR();
  if (!qr || !qr.imageUrl) return 'no_qr';
  shopInvoiceMark_(opts.rowIndex, '送信中');   // 送る前に印（返事が取れずに再送された時、二重に請求しない）
  var text = buildShopInvoiceText_({
    pt:           p.pt,
    refId:        p.refId,
    carModel:     shopInvoiceCut_(body.carModel),
    plate:        shopInvoiceCut_(body.plate),
    services:     shopInvoiceServices_(body),
    customerName: shopInvoiceCut_(body.name),
    listPrice:    listPrice,
    rate:         body.v2 && body.v2.shop_rate,
    due:          due
  });
  var res = sendQRImage(groupChatId, qr.imageUrl, text);
  return (res && res.ok) ? 'sent' : 'send_failed';
}

/** 作業記録「店への請求」に状態と日時を書く（失敗しても請求の処理は止めない） */
function shopInvoiceMark_(rowIndex, state) {
  try {
    var at = Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm');
    var upd = {};
    upd[SHOP_INVOICE_COL_] = state + ' ' + at;
    updateRow(SHEET_NAMES.JOBS, rowIndex, upd);
  } catch (err) {
    Logger.log('⚠️ shopInvoiceMark_: ' + err);
  }
}

/** キャプションの上限（1,024字）を超えないよう、名前・車種・ナンバーは 40 字まで */
function shopInvoiceCut_(v) {
  return String(v || '').trim().slice(0, 40);
}

/** 請求の結果を管理グループへ（日本語）。トピックが消えていたら一般スレッドへ送り直す */
function notifyShopInvoiceAdmin_(result, shopId, due, adminOpts) {
  if (result === 'skip_zero' || result === 'duplicate') return;
  try {
    var name = (shopId && (typeof getShopNameById_ === 'function') && getShopNameById_(shopId)) || shopId || '（店が分からない）';
    var manual = '当社分 $' + due + ' は ' + name + ' へ手で請求してください';
    var msg;
    switch (result) {
      case 'sent':
        msg = '🧾 お店のグループへ請求を送りました: ' + name + ' $' + due + '（ABA QR 付き）';
        break;
      case 'unknown':
        msg = '⚠️ 請求の送信結果が分かりません（前回が途中で止まった）: ' + name + ' $' + due + '。お店のグループに届いているか確かめてください（自動では送り直しません）';
        break;
      case 'no_row':
        msg = '⚠️ 請求を送っていません: 旧アプリからの記録のため自動請求しません。' + manual;
        break;
      case 'no_shop':
        msg = '⚠️ 請求を送っていません: どのお店か決まりません。' + manual;
        break;
      case 'no_list_price':
        msg = '⚠️ 請求を送っていません: 定価が届いていないため（古い支払い画面）、当社分が正しいか確かめられません。' + manual;
        break;
      case 'over_list':
        msg = '⚠️ 請求を送っていません: 金額 $' + due + ' が定価より高いため。金額を確かめて、' + name + ' へ手で請求してください';
        break;
      case 'not_linked':
        msg = '⚠️ 請求を送れていません: ' + name + ' のグループが Bot とつながっていません。' + manual;
        break;
      case 'no_qr':
        msg = '⚠️ 請求を送れていません: QRコードシートに有効な QR がありません（有効=TRUE を1行）。' + manual;
        break;
      default:
        msg = '⚠️ 請求の送信に失敗しました: ' + name + ' $' + due + '。お店のグループへ手で QR を送ってください';
    }
    var cfg = getConfig();
    var res = sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, msg, adminOpts || {});
    if (!(res && res.ok) && adminOpts && adminOpts.message_thread_id) {
      sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, msg, {});
    }
  } catch (err) {
    Logger.log('⚠️ notifyShopInvoiceAdmin_: ' + err);
  }
}
