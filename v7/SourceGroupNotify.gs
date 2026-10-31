/**
 * SourceGroupNotify.gs — 流入元（レジデンス等）の提携先グループへの通知（2026-10-26 Picasso City Garden）
 *
 * 【目的】専用QR（流入元）から予約したお客様の
 *   ① 予約が入った ② 作業開始（Before 写真）③ 作業完了（After 写真）
 *   を、流入元タブ「shop_id」の店舗グループ（Bot連携=連携済）へ英語で送る。部屋番号と車種も載せる。
 *   Daisuke「ピカソがつくってくれたTelegramグループに通知が各種されるようにしたい」（2026-10-26。月次のまとめは送らない）
 *
 * 【送る予約】予約確定の時点で ①流入元が英日（en-ja）②その提携先グループが連携済み のもの＝
 *   予約確定文に「管理側にも共有されます」を出した予約だけ（SourceCampaign.gs buildSourceCustomerConfirm_）。
 *   その予約の印を Script Properties `srcgrp_<予約ID>`（JSON: shopId・表示名・部屋番号・車種・日時）に残し、作業の通知はこの印がある予約だけ。
 *   印は作業完了の通知が届いたら消し、届かないまま30日たったもの（キャンセル等）は次の予約の時に消す。
 *   部屋番号は予約時の入力をそのまま使う（予約タブから読み直すと "0501" が 501 や日付に化けるため）
 *
 * 【集金には一切関係しない】提携店の shop_ref（店集金）とは別物。流入元の提携先は、現場アプリの店の選択肢・
 *   店グループへの請求・店QR・月次レポートから外す（ShopRouting.gs / ShopInvoice.gs / v7-operations ShopProvisioningManager.gs）。
 *   お客様の名前とナンバーは本文に載せない（写真には写ることがある）
 *
 * 【流入元タブが読めない時】提携先か判定できない（sourcePartnerState_ = null）→ 請求・あいさつ文は送らない側に倒す
 */

var SOURCE_GROUP_PROP_PREFIX = 'srcgrp_';

/**
 * shop_id が流入元タブのどこかの行に書かれた提携先か（有効=FALSE の行も含む）。
 * @return {boolean|null} 流入元タブが読めない時は null（判定できない）
 */
function sourcePartnerState_(shopId) {
  var sid = String(shopId || '').trim();
  var cfgs = readSourceConfigs_();
  if (!sourceConfigsReadable_()) return null;
  if (!sid) return false;
  return Object.keys(cfgs).some(function(code) { return cfgs[code].shopId === sid; });
}

/** 流入元の提携先と確かに分かる時だけ true（読めない時は false） */
function isSourcePartnerShop_(shopId) {
  return sourcePartnerState_(shopId) === true;
}

/** その流入元の提携先グループが連携済みか（お客様への「共有されます」の一言を出すか） */
function sourceGroupLinked_(cfg) {
  if (!cfg || !cfg.shopId) return false;
  try {
    var link = findShopLinkByShopId_(cfg.shopId);
    return !!(link && String(link.obj['状態']) === '連携済' && String(link.obj['グループchat_id'] || ''));
  } catch (err) {
    Logger.log('⚠️ sourceGroupLinked_: ' + err);
    return false;
  }
}

/** 予約確定文に「共有されます」を出し、提携先グループに流す予約か（createBooking のロック内で判定） */
function sourceGroupSharesBooking_(srcCfg) {
  return !!(srcCfg && srcCfg.lang === 'en-ja' && sourceGroupLinked_(srcCfg));
}

/** 「Picasso City Garden resident」 */
function sourceGroupWho_(label) {
  return (label || 'Partner') + ' resident';
}

/** 予約の車種区分（'セダン以下' / 'SUV以上'）→ 英語 */
function sourceGroupVehicleEn_(vt) {
  return normalizeVehicleType(String(vt || '')) === 'SUV' ? 'SUV' : 'Sedan';
}

var SOURCE_GROUP_DAYS_ = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
var SOURCE_GROUP_MONTHS_ = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-27' → 'Tue 27 Oct 2026'（読めなければそのまま）。スクリプトの言語設定に左右されないよう自前で組む */
function sourceGroupDate_(ymd) {
  var s = String(ymd || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  var d = parseDateTimePhnomPenh(s, 12, 0);   // プノンペン 12:00 = UTC 05:00（UTC でも同じ日付）
  return SOURCE_GROUP_DAYS_[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + SOURCE_GROUP_MONTHS_[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
}

var SOURCE_GROUP_MARK_KEEP_DAYS = 30;   // 作業完了の通知が届かなかった印（キャンセル等）を消すまでの日数

/**
 * 予約の印を残す（createBooking のロック内・確定文に「共有されます」を出したのと同じ時点）。
 * 印は送信の成否に関係なく残す（お客様には「共有されます」をもう伝えている）
 */
function markSourceGroupBooking_(srcCfg, info) {
  try {
    if (!srcCfg || !srcCfg.shopId || !info || !info.bookingId) return;
    kvSet_(SOURCE_GROUP_PROP_PREFIX + info.bookingId, JSON.stringify({
      shopId: srcCfg.shopId, label: srcCfg.label, unitNo: info.unitNo || '', carModel: info.carModel || '',
      at: new Date().toISOString()
    }));
  } catch (err) {
    Logger.log('⚠️ markSourceGroupBooking_: ' + err);
  }
}

/** 古い印（SOURCE_GROUP_MARK_KEEP_DAYS 日より前）を消す。予約が入った時（ロックの外）に呼ぶ */
function pruneSourceGroupMarks_() {
  try {
    var all = kvGetAll_(SOURCE_GROUP_PROP_PREFIX);   // 状態タブ（KvStore.gs）
    var limit = Date.now() - SOURCE_GROUP_MARK_KEEP_DAYS * 24 * 60 * 60 * 1000;
    Object.keys(all).forEach(function(k) {
      var at = 0;
      try { at = Date.parse(JSON.parse(all[k]).at) || 0; } catch (ignore) {}
      if (at && at < limit) kvDelete_(k);
    });
  } catch (err) {
    Logger.log('⚠️ pruneSourceGroupMarks_: ' + err);
  }
}

/** 予約の印（作業の通知に使う）。無ければ null */
function getSourceGroupBooking_(bookingId) {
  if (!bookingId) return null;
  try {
    var raw = kvGet_(SOURCE_GROUP_PROP_PREFIX + bookingId);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    Logger.log('⚠️ getSourceGroupBooking_: ' + err);
    return null;
  }
}

/**
 * 提携先グループへ本文（＋写真）を送る。本文が届けば true。届かなければ管理グループへ知らせて false
 * （写真だけ失敗した時は true を返し、管理グループへ知らせる＝本文を二重に送らない）
 */
function sendSourceGroup_(shopId, text, blobs, what) {
  var link = findShopLinkByShopId_(shopId);
  var chatId = (link && String(link.obj['状態']) === '連携済') ? String(link.obj['グループchat_id'] || '') : '';
  if (!chatId) {
    // 予約の時は連携済みだった（印がある）のに、今はつながっていない（停止・行の削除など）
    warnSourceGroupFailed_(link || { obj: { shop_id: shopId } }, what, { description: 'Bot連携が「連携済」になっていません' });
    return false;
  }
  var res = sendMessage(BOT_TYPE.BOOKING, chatId, text);
  if (!(res && res.ok)) {
    warnSourceGroupFailed_(link, what, res);
    return false;
  }
  if (blobs && blobs.length > 0 && typeof sendPhotoAlbum === 'function') {
    try {
      var album = sendPhotoAlbum(BOT_TYPE.BOOKING, chatId, blobs, '', {});
      if (!(album && album.ok)) warnSourceGroupFailed_(link, what + 'の写真', album);
    } catch (err) {
      warnSourceGroupFailed_(link, what + 'の写真', { description: String(err) });
    }
  }
  return true;
}

/** 送れなかった時の管理グループへの知らせ（日本語）。グループの ID が変わった時はその旨も */
function warnSourceGroupFailed_(link, what, res) {
  try {
    var name = String((link && link.obj['店名']) || (link && link.obj['shop_id']) || '提携先');
    var migrated = res && res.parameters && res.parameters.migrate_to_chat_id;
    sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId,
      '⚠️ 提携先グループへの通知が届きませんでした: ' + name + '（' + what + '）\n' +
      (res && res.description ? String(res.description) + '\n' : '') +
      (migrated ? '→ グループの ID が変わっています（' + migrated + '）。Bot連携の「グループchat_id」を直してください'
                : '→ 予約Botがグループに入っているか確かめてください（自動では送り直しません）'));
  } catch (err) {
    Logger.log('⚠️ warnSourceGroupFailed_: ' + err);
  }
}

/**
 * ① 予約が入った（createBooking がロックを外したあと。印はロック内で markSourceGroupBooking_ が付け済み）
 * @param {Object} srcCfg - resolveBookingSource_ の結果
 * @param {Object} info - { bookingId, plan, options, vehicleType, carModel, date, startTime, endTime, unitNo }
 * @return {boolean} 送れたか
 */
function notifySourceGroupBooking_(srcCfg, info) {
  try {
    if (!srcCfg || !srcCfg.shopId || !info || !info.bookingId) return false;
    pruneSourceGroupMarks_();
    var services = [];
    if (info.plan) services.push(info.plan.name || info.plan.planFull || 'SAMURAI WASH');
    (info.options || []).forEach(function(l) {
      if (l && l.opt) services.push(optionDisplayName_(l.opt));
    });
    var car = [info.carModel, sourceGroupVehicleEn_(info.vehicleType)].filter(Boolean).join(' / ');
    var lines = [
      '📅 New booking — ' + sourceGroupWho_(srcCfg.label),
      '🗓 ' + sourceGroupDate_(info.date) + ', ' + info.startTime + '–' + info.endTime,
      '🚪 Unit: ' + (info.unitNo || '-'),
      '🚗 ' + car,
      '🧽 ' + (services.join(' + ') || '-')
    ];
    return sendSourceGroup_(srcCfg.shopId, lines.join('\n'), null, '予約 ' + info.bookingId);
  } catch (err) {
    Logger.log('⚠️ notifySourceGroupBooking_: ' + err);
    return false;
  }
}

/**
 * ② 作業開始 / ③ 作業完了（apiJobStart / apiJobEnd。提携店 QR のお客様でないときだけ呼ばれる）
 * @param {string} phase - 'start' | 'end'
 * @param {Object} p - { bookingId, carModel, duration, blobs, opts }
 * @return {string} 送った（または同じ送信の再実行で送り済みの）shop_id。送らなければ ''
 */
function notifySourceGroupJob_(phase, p) {
  try {
    p = p || {};
    // 予約なしの作業（現場アプリで始める前に選んだレジデンス等・2026-10-31）は p.rec を使う。予約は予約時の印
    var rec = p.rec || getSourceGroupBooking_(p.bookingId);
    if (!rec || !rec.shopId) return '';
    // 同じ送信の再実行では送り直さない（JobIdempotency.gs と同じ印。届いた後にだけ付ける）
    var key = (phase === 'start' ? 'startsrc:' : 'endsrc:') + rec.shopId;
    if (jobCustSent_(p.opts, key)) return rec.shopId;

    var blobs = p.blobs || [];
    var lines = [
      (phase === 'start' ? '▶️ Job started — ' : '✅ Job finished — ') + (rec.who || sourceGroupWho_(rec.label))
    ];
    if (!rec.noUnit) lines.push('🚪 Unit: ' + (rec.unitNo || '-'));   // スタッフの車は部屋番号の行を出さない
    lines.push('🚗 ' + (p.carModel || rec.carModel || '-'));
    if (phase !== 'start' && Number(p.duration) > 0) lines.push('⏱ ' + p.duration + ' min');
    if (blobs.length > 0) lines.push(phase === 'start' ? '📷 Before photos ↓' : '📷 After photos ↓');

    if (!sendSourceGroup_(rec.shopId, lines.join('\n'), blobs, (phase === 'start' ? '作業開始 ' : '作業完了 ') + p.bookingId)) return '';
    jobMarkCustSent_(p.opts, key);
    // 完了まで届いたら印は役目を終える（状態タブを増やし続けない）。予約なしの作業は印が無い
    if (phase !== 'start' && !p.rec) {
      try { kvDelete_(SOURCE_GROUP_PROP_PREFIX + p.bookingId); } catch (ignore) {}
    }
    return rec.shopId;
  } catch (err) {
    Logger.log('⚠️ notifySourceGroupJob_(' + phase + '): ' + err);
    return '';
  }
}

/**
 * 現場アプリの「車屋以外のお客さん（予約なし）」で、始める前に選べるレジデンス等（2026-10-31 Daisuke
 * 「ピカソのグループに BeforeAfter は届くようにしてほしい。金額はいれなくてもいい」。Picasso のスタッフの車など予約のない作業）
 * 流入元タブの有効な行の shop_id のうち、提携先グループが連携済みのもの（1つの shop_id に流入元が何行あっても1つ）。
 * 集金には関係しない（請求・店集金の一覧には今までどおり出さない）
 * @return {Array<{id:string, name:string}>} 流入元タブが読めない時は空
 */
function fieldResidences_() {
  var out = [], seen = {};
  try {
    var cfgs = readSourceConfigs_();
    if (!sourceConfigsReadable_()) return [];
    Object.keys(cfgs).forEach(function(code) {
      var c = cfgs[code];
      if (!c || !c.active || !c.shopId || seen[c.shopId]) return;
      seen[c.shopId] = true;
      if (sourceGroupLinked_(c)) out.push({ id: c.shopId, name: c.placeName || c.label || c.shopId });
    });
  } catch (err) {
    Logger.log('⚠️ fieldResidences_: ' + err);
    return [];
  }
  out.sort(function(a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
  return out;
}

/**
 * 現場アプリから来た residence_id を確かめる。選べるレジデンスでなければ null
 * @param {string} who - 'resident'（住人）/ 'staff'（その建物のスタッフ）/ それ以外は空（2026-10-31 Daisuke）
 * @return {{id:string, name:string, who:string}|null}
 */
function fieldResidenceById_(id, who) {
  var sid = String(id || '').trim();
  if (!sid) return null;
  var hit = fieldResidences_().filter(function(r) { return r.id === sid; })[0];
  if (!hit) return null;
  var w = String(who || '');
  return { id: hit.id, name: hit.name, who: (w === 'resident' || w === 'staff') ? w : '' };
}

/** 予約なしの作業の通知に使う印（notifySourceGroupJob_ の p.rec）。部屋番号は住人の時だけ（現場で入れた値・任意） */
function sourceGroupWalkinRec_(res, room) {
  var staff = res.who === 'staff';
  var unit = staff ? '' : String(room || '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, ' ').trim();
  return { shopId: res.id, label: res.name, who: res.name + (staff ? ' staff' : (res.who === 'resident' ? ' resident' : '')),
           unitNo: Array.from(unit).slice(0, 20).join(''), noUnit: staff };
}

/** 流入元の提携先グループのあいさつ文（英語のみ・連携直後に1回） */
function buildSourceGroupGreeting_(shopName) {
  var name = String(shopName || '').trim() || 'your building';
  return 'This is the group for ' + name + ' × SAMURAI MOTORS.\n' +
    'When a resident books with us, you\'ll see the booking here (date, time, unit number and car), ' +
    'and on the day, start and finish updates with Before/After photos.\n' +
    'Thank you for working with us!';
}

/** お客様向けの一言（英語＋日本語・歓迎文と予約確定文に入れる） */
function sourceGroupShareNotice_(cfg) {
  var place = cfg.placeName || cfg.label;
  return '📢 Your booking details (date, time, unit number, car) and Before/After photos are also shared with ' + place + ' management.\n' +
    '   ご予約の内容（日時・部屋番号・車種）と作業前後の写真は、' + place + ' の管理側にも共有されます。';
}
