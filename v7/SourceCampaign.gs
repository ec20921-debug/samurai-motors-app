/**
 * SourceCampaign.gs — 流入元（専用QR）キャンペーン（2026-10-15 Picasso City Garden）
 *
 * 【目的】レジデンス等の専用QR（t.me/<予約Bot>?start=<流入元コード>）から来たお客様を見分け、
 *   - 歓迎メッセージ・予約画面・予約確定を「英語メイン＋日本語」で出す（言語=en-ja の流入元）
 *   - 期間中の予約に流入元の特典（全メニュー X%オフ・品目別の割引率）を自動適用する
 *   - 予約の記録（予約タブ 流入元/特典/部屋番号）・管理グループ通知・現場アプリに流入元を出す
 *
 * 【設定】v7 Database「流入元」タブ（1行 = 1流入元＝1つのQR）。料金・期間・割引率はコードに書かない（CLAUDE.md ルール8）。
 *   列: 流入元コード / 表示名 / チャネル / 有効 / 開始日 / 終了日 / サービス割引(%) / 個別割引 / 場所名 / マップリンク /
 *       緯度 / 経度 / 言語 / チラシURL / 期間中の日曜営業 / shop_id / メモ
 *   - 期間中の日曜営業=TRUE: 期間内の日曜（定休日）を、この流入元のお客様だけ予約可にする（2026-10-15 Picasso 11/1）
 *   - 同じ場所でも掲示物ごとに QR を分ける（例: picasso_tg / picasso_signage / picasso_poster / picasso_flyer）。
 *     表示名は共通（Picasso City Garden）、チャネルで出し分けを比べる。予約タブ「流入元」には コード を記録する
 *     （"picasso" で始まるものをまとめれば Picasso 全体の集計になる）
 *   - 個別割引: "HEADLIGHT_MAGIC:50" のように「メニューのコード:割引率」をカンマ区切り。ここに無い品目は サービス割引(%)
 *   - 割引の併用はしない（特典が効く予約では全体キャンペーンを使わない）。出張料は割り引かない
 *   - 有効=FALSE にすると歓迎・予約画面は通常版に戻る（流入元の記録は残る）
 *   - 読み取りは CacheService 60秒＋実行内メモ（OPS_LESSONS #8）
 *
 * 【顧客→流入元の紐付け】Script Properties `src_ref_<chatId>`（永続。提携店の shop_ref_ と同じ方式）
 *
 * 【呼び出し元】
 *   BookingBot.gs  : handleCustomerMessage（/start <コード>）・ensureBookingMenuButton_・sendBookingMiniApp
 *   Router.gs      : apiBookingInit（予約画面へ流入元を渡す）・apiBookingRegisterCustomer（言語）
 *   BookingLogic.gs: createBooking（特典計算・記録）・notifyBookingCreated（通知文）
 *   JobManager.gs  : apiBookingToday（現場アプリ）・apiJobStart / apiJobEnd（管理通知・作業記録）
 */

var SOURCE_SHEET_NAME = '流入元';
var SOURCE_CACHE_KEY = 'source_cfg_v1';
var SOURCE_CACHE_SEC = 60;
var SOURCE_REF_PREFIX = 'src_ref_';
var __sourceCfgMemo_ = null;

// ====== 設定の読み込み ======

/**
 * 流入元タブを { code: cfg } で返す（60秒キャッシュ）。タブが無ければ {}（機能は静かに無効）
 */
function readSourceConfigs_() {
  if (__sourceCfgMemo_) return __sourceCfgMemo_;
  var cache = CacheService.getScriptCache();
  var cached = cache.get(SOURCE_CACHE_KEY);
  if (cached) {
    try { __sourceCfgMemo_ = JSON.parse(cached); return __sourceCfgMemo_; } catch (ignore) {}
  }
  var out = {};
  try {
    var ss = getSpreadsheet();
    var sheet = ss.getSheetByName(SOURCE_SHEET_NAME);
    if (sheet && sheet.getLastRow() >= 2) {
      var tz = ss.getSpreadsheetTimeZone() || BOOKING_TZ;
      var values = sheet.getDataRange().getValues();
      var headers = values.shift().map(function(h) { return String(h).trim(); });
      values.forEach(function(r) {
        var o = {};
        headers.forEach(function(h, i) { o[h] = r[i]; });
        var code = String(o['流入元コード'] || '').trim().toLowerCase();
        if (!code) return;
        out[code] = {
          code: code,
          label: String(o['表示名'] || code).trim(),
          channel: String(o['チャネル'] || '').trim(),
          active: o['有効'] === true || String(o['有効']).toUpperCase() === 'TRUE',
          start: sourceYmd_(o['開始日'], tz),
          end: sourceYmd_(o['終了日'], tz),
          servicePct: clampPct_(o['サービス割引(%)']),
          itemPct: parseItemPct_(o['個別割引']),
          placeName: String(o['場所名'] || '').trim(),
          mapsUrl: String(o['マップリンク'] || '').trim(),
          lat: String(o['緯度'] || '').trim(),
          lng: String(o['経度'] || '').trim(),
          lang: String(o['言語'] || '').trim().toLowerCase(),
          flyerUrl: String(o['チラシURL'] || '').trim(),
          openSunday: o['期間中の日曜営業'] === true || String(o['期間中の日曜営業']).toUpperCase() === 'TRUE',
          shopId: String(o['shop_id'] || '').trim()
        };
      });
    }
  } catch (err) {
    Logger.log('⚠️ readSourceConfigs_ 失敗（流入元機能を無効扱い）: ' + err);
  }
  try { cache.put(SOURCE_CACHE_KEY, JSON.stringify(out), SOURCE_CACHE_SEC); } catch (ignore) {}
  __sourceCfgMemo_ = out;
  return out;
}

function sourceYmd_(v, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  var s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.substring(0, 10) : '';
}

/** "HEADLIGHT_MAGIC:50, GLASS_ALL:30" → { HEADLIGHT_MAGIC: 50, GLASS_ALL: 30 }（全角の ：，％ も可・0〜100 に収める） */
function parseItemPct_(v) {
  var out = {};
  String(v || '').replace(/：/g, ':').replace(/[，、]/g, ',').replace(/[%％]/g, '')
    .split(',').forEach(function(part) {
      var p = part.trim();
      if (!p) return;
      var m = p.match(/^([A-Za-z0-9_]+)\s*:\s*(\d+(?:\.\d+)?)$/);
      if (m) {
        out[m[1].toUpperCase()] = clampPct_(m[2]);
      } else {
        Logger.log('⚠️ 流入元タブ「個別割引」を読めません（無視）: ' + p);
      }
    });
  return out;
}

function clampPct_(v) {
  var n = Number(v) || 0;
  return Math.min(100, Math.max(0, n));
}

function getSourceConfig_(code) {
  if (!code) return null;
  return readSourceConfigs_()[String(code).trim().toLowerCase()] || null;
}

/** 管理者向けの表示「Picasso City Garden（サイネージ）」。予約タブの値（コード）からも引ける */
function sourceDisplay_(codeOrCfg) {
  var cfg = (codeOrCfg && typeof codeOrCfg === 'object') ? codeOrCfg : getSourceConfig_(codeOrCfg);
  if (!cfg) return String(codeOrCfg || '');
  return cfg.label + (cfg.channel ? '（' + cfg.channel + '）' : '');
}

/** 現場スタッフ向けの表示（場所名だけ。チャネルは不要） */
function sourceStaffLabel_(code) {
  var cfg = getSourceConfig_(code);
  return cfg ? cfg.label : String(code || '');
}

/** 予約日(yyyy-MM-dd)が特典期間内か。期間が空欄なら期間制限なし */
function sourceInPeriod_(cfg, ymd) {
  if (!cfg || !ymd) return false;
  if (cfg.start && ymd < cfg.start) return false;
  if (cfg.end && ymd > cfg.end) return false;
  return true;
}

/**
 * 定休日（日曜）でもこの流入元のお客様は予約できる日か。
 * 有効・期間内・「期間中の日曜営業」=TRUE・期間が入っているときだけ（期間なしで日曜を開けっぱなしにしない）
 */
function sourceOpensClosedDay_(cfg, ymd) {
  return !!(cfg && cfg.active && cfg.openSunday && cfg.start && cfg.end && sourceInPeriod_(cfg, ymd));
}

/** 品目コード（WASH / GLASS_3 / HEADLIGHT_MAGIC 等）の割引率(%) */
function sourcePctFor_(cfg, code) {
  var c = String(code || '').toUpperCase();
  if (cfg.itemPct && Object.prototype.hasOwnProperty.call(cfg.itemPct, c)) return cfg.itemPct[c];
  return cfg.servicePct || 0;
}

/** 割引設定がある流入元か（予約画面・歓迎文で特典を見せるか） */
function sourceHasPerk_(cfg) {
  return !!cfg && (cfg.servicePct > 0 || Object.keys(cfg.itemPct || {}).length > 0);
}

// ====== 顧客 → 流入元 ======

function getSourceRefForCustomer(chatId) {
  if (!chatId) return '';
  try {
    return PropertiesService.getScriptProperties().getProperty(SOURCE_REF_PREFIX + String(chatId)) || '';
  } catch (err) {
    return '';
  }
}

function setSourceRefForCustomer_(chatId, code) {
  try {
    PropertiesService.getScriptProperties().setProperty(SOURCE_REF_PREFIX + String(chatId), code);
  } catch (err) {
    Logger.log('⚠️ src_ref 保存失敗: ' + err);
  }
}

/**
 * 予約で使う流入元を決める: 顧客の紐付け（/start <コード> で保存）を優先、なければ画面から来た src。
 * src は流入元タブに有効な行があるときだけ採用する。
 */
function resolveBookingSource_(chatId, srcParam) {
  var ref = getSourceConfig_(getSourceRefForCustomer(chatId));
  if (ref && ref.active) return ref;   // 有効=FALSE の流入元は通常の流れに戻す（記録・特典・英日表示とも付けない）
  var p = getSourceConfig_(srcParam);
  return (p && p.active) ? p : null;
}

/** この顧客の予約画面 URL（有効な流入元なら ?src=<コード> を付ける） */
function bookingMiniAppUrlForChat_(chatId) {
  var base = getBookingMiniAppUrl();
  if (!base) return '';
  var cfg = getSourceConfig_(getSourceRefForCustomer(chatId));
  if (!cfg || !cfg.active) return base;
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'src=' + encodeURIComponent(cfg.code);
}

// ====== /start <流入元コード> ======

/**
 * 専用QR経由の /start を処理。流入元タブにコードが無ければ false（呼び元は通常処理へ）
 * @return {boolean}
 */
function handleSourceStart_(msg, text) {
  var m = String(text || '').match(/^\/start\s+([A-Za-z0-9_-]{1,64})$/);
  if (!m) return false;
  var cfg = getSourceConfig_(m[1]);
  if (!cfg) return false;

  var chatId = String(msg.chat.id);
  // 先に紐付けを保存（直後のメニューボタン設定で ?src= 付きの URL にするため）
  setSourceRefForCustomer_(chatId, cfg.code);
  // 最後に読んだQRを優先: 有効な流入元なら提携店の紐付け（shop_ref = 店集金・当社QRなし）は外す（2026-10-20）
  // 無効（有効=FALSE）の流入元は通常扱いに戻るだけなので、店の紐付けは残す（resolveBookingSource_ と同じ考え方）
  if (cfg.active) {
    try { PropertiesService.getScriptProperties().deleteProperty('shop_ref_' + chatId); } catch (ignore) {}
  }

  if (cfg.active && cfg.lang === 'en-ja') {
    sendSourceWelcome_(msg, cfg);
  } else {
    sendWelcomeMessage(msg);
  }
  ensureCustomerTopic(msg);

  // 顧客台帳の言語（英語メインの流入元のみ）
  if (cfg.lang === 'en-ja') {
    try {
      var row = findCustomerRow(chatId);
      if (row && row.data['言語'] !== '英語') updateRow(SHEET_NAMES.CUSTOMERS, row.rowIndex, { '言語': '英語' });
    } catch (err) {
      Logger.log('⚠️ 顧客の言語更新失敗: ' + err);
    }
  }

  // 管理グループへ流入元を通知（日本語）
  try {
    var custName = buildDisplayName(extractCustomerFromMessage(msg));
    sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId,
      '🏢 ' + sourceDisplay_(cfg) + ' の専用QRから流入\n顧客: ' + custName + ' (chat_id=' + chatId + ')' +
      (cfg.active ? '' : '\n（流入元タブで無効のため通常の歓迎を送信）'));
  } catch (err) {
    Logger.log('⚠️ 管理通知失敗（流入元QR）: ' + err);
  }
  if (typeof logFunnelEvent === 'function') {
    logFunnelEvent(chatId, 'bot_start', 'src:' + cfg.code, '', null);
  }
  return true;
}

/** 英語メイン＋日本語の歓迎（言語=en-ja の流入元） */
function sendSourceWelcome_(msg, cfg) {
  ensureBookingMenuButton_(msg.chat.id);   // 最優先でボタン（?src= 付き）

  if (cfg.flyerUrl) {
    try {
      sendPhoto(BOT_TYPE.BOOKING, msg.chat.id, cfg.flyerUrl, {
        caption: '🚗 SAMURAI MOTORS × ' + cfg.label
      });
    } catch (e) {
      Logger.log('⚠️ 流入元チラシ送信失敗（本文は送る）: ' + e);
    }
  }

  var name = (msg.from && msg.from.first_name) || '';
  var place = cfg.placeName || cfg.label;
  var lines = [];
  lines.push((name ? 'Hello ' + name + '! 👋 ' : 'Hello! 👋 ') + 'Welcome to SAMURAI MOTORS.');
  lines.push('SAMURAI MOTORS へようこそ。日本品質の出張カーケアです。');
  lines.push('');
  lines.push('🏢 FOR ' + place.toUpperCase() + ' RESIDENTS');
  lines.push(place + ' にお住まいの皆さまへ');

  if (sourceHasPerk_(cfg)) {
    lines.push('');
    lines.push('🎁 ' + sourcePerkLineEn_(cfg));
    lines.push('   ' + sourcePerkLineJa_(cfg));
    if (cfg.start || cfg.end) {
      lines.push('📅 ' + sourcePeriodEn_(cfg));
      lines.push('   ' + sourcePeriodJa_(cfg));
    }
    lines.push('   Discounts cannot be combined. / 割引の併用はできません。');
  }

  lines.push('');
  lines.push('🚗 PARK AS USUAL. — we come to your car.');
  lines.push('   車は、いつもの場所に停めたままで。');
  lines.push('🔑 NO KEY HANDOVER NEEDED — no need to be there.');
  lines.push('   鍵の受け渡しも、立ち会いも不要です。');
  lines.push('📷 BEFORE / AFTER PHOTOS ON TELEGRAM');
  lines.push('   仕上がりは写真でお届けします。');
  lines.push('💳 Pay by ABA QR after the service. / お支払いは施工後に ABA の QR で。');
  lines.push('⏰ ' + sourceHoursEn_() + ' / ' + sourceHoursJa_());

  lines.push('');
  lines.push('👇 How to book / ご予約');
  lines.push('① 🚗 Tap the "Booking" button (bottom left) — choose a service and time, and enter your unit number.');
  lines.push('   左下の「Booking」ボタンから、メニュー・日時・部屋番号を入力してください。');
  lines.push('② 💬 Or just send us a message here — voice messages OK 🎤');
  lines.push('   このチャットへのメッセージでも受け付けます。日本語でもどうぞ。');

  var fee = sourceDispatchFee_();
  lines.push('');
  lines.push('Prices in USD per car.' + (fee > 0 ? ' Delivery fee ' + fee + '$ per booking.' : ''));
  lines.push('料金は1台あたり（米ドル）。' + (fee > 0 ? '出張料は1件 ' + fee + '$ です。' : ''));
  lines.push('');
  lines.push('📘 Facebook: ' + SAMURAI_FB_PAGE_URL);

  sendMessage(BOT_TYPE.BOOKING, msg.chat.id, lines.join('\n'), { disable_web_page_preview: true });
}

// ====== 文言の部品（特典・期間・営業時間） ======

/** 品目コードの表示名（メニューシート連動） */
function sourceItemName_(code) {
  var c = String(code || '').toUpperCase();
  if (c === 'WASH') return 'SAMURAI WASH';
  var opt = (typeof findOptionByCode === 'function') ? findOptionByCode(c) : null;
  if (!opt) return c;
  var kind = optionKindLabel_(opt);
  var nm = String(opt.nameEn || '').trim();
  if (kind === 'HEADLIGHT') return nm.toUpperCase().indexOf('SAMURAI') === 0 ? nm + ' (headlight)' : 'SAMURAI HEADLIGHT ' + nm;
  return optionDisplayName_(opt);
}

function sourcePerkLineEn_(cfg) {
  var parts = [];
  if (cfg.servicePct > 0) parts.push(cfg.servicePct + '% OFF ALL SERVICES');
  Object.keys(cfg.itemPct || {}).forEach(function(code) {
    parts.push(sourceItemName_(code) + ' ' + cfg.itemPct[code] + '% OFF');
  });
  return parts.join(' · ');
}

function sourcePerkLineJa_(cfg) {
  var parts = [];
  if (cfg.servicePct > 0) parts.push('全メニュー' + cfg.servicePct + '%オフ');
  Object.keys(cfg.itemPct || {}).forEach(function(code) {
    var pct = cfg.itemPct[code];
    var nm = sourceItemName_(code).replace(/ \(headlight\)$/, '');
    if (String(code).toUpperCase().indexOf('HEADLIGHT') === 0) nm = 'ヘッドライト ' + nm.replace(/^SAMURAI HEADLIGHT /, '');
    parts.push(nm + (pct === 50 ? 'は半額' : 'は' + pct + '%オフ'));
  });
  return parts.join('／');
}

/** 予約タブ「特典」列・管理通知用の短い要約（日本語） */
function sourcePerkSummaryJa_(cfg) {
  return sourcePerkLineJa_(cfg) || '特典なし';
}

function sourcePeriodEn_(cfg) {
  var mon = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  function f(ymd) { var p = ymd.split('-'); return mon[Number(p[1]) - 1] + ' ' + Number(p[2]); }
  if (cfg.start && cfg.end) {
    var days = Math.round((Date.parse(cfg.end) - Date.parse(cfg.start)) / 86400000) + 1;
    return f(cfg.start) + ' – ' + f(cfg.end) + ', ' + cfg.end.substring(0, 4) + (days > 0 && days <= 31 ? ' · ' + days + ' DAYS ONLY' : '');
  }
  return cfg.end ? 'UNTIL ' + f(cfg.end) + ', ' + cfg.end.substring(0, 4) : 'FROM ' + f(cfg.start);
}

function sourcePeriodJa_(cfg) {
  var wd = ['日', '月', '火', '水', '木', '金', '土'];
  function f(ymd, withYear) {
    var p = ymd.split('-');
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    return (withYear ? p[0] + '年' : '') + Number(p[1]) + '月' + Number(p[2]) + '日（' + wd[d.getDay()] + '）';
  }
  if (cfg.start && cfg.end) return f(cfg.start, true) + '〜' + f(cfg.end, cfg.start.substring(0, 4) !== cfg.end.substring(0, 4));
  return cfg.end ? f(cfg.end, true) + 'まで' : f(cfg.start, true) + 'から';
}

/** 営業時間（料金設定シート連動）"OPEN 9AM – 6PM" */
function sourceHoursEn_() {
  var c = getBookingConfig();
  function f(h) { h = Number(h); return (h % 12 === 0 ? 12 : h % 12) + (h < 12 || h === 24 ? 'AM' : 'PM'); }
  return 'OPEN ' + f(c.businessHourStart) + ' – ' + f(c.businessHourEnd);
}

function sourceHoursJa_() {
  var c = getBookingConfig();
  return Number(c.businessHourStart) + ':00〜' + Number(c.businessHourEnd) + ':00';
}

function sourceDispatchFee_() {
  try { return Number(getDispatchFee().sedan) || 0; } catch (e) { return 0; }
}

/** USD 表記（数字の後ろに $・小数は必要な桁だけ: 9.6$） */
function sourceUsd_(n) {
  return String(Math.round((Number(n) || 0) * 100) / 100) + '$';
}

// ====== 予約画面へ渡す情報（apiBookingInit） ======

function sourceInitPayload_(cfg) {
  if (!cfg || !cfg.active) return null;
  return {
    code: cfg.code,
    label: cfg.label,
    lang: cfg.lang,
    start: cfg.start,
    end: cfg.end,
    servicePct: cfg.servicePct,
    itemPct: cfg.itemPct,
    placeName: cfg.placeName,
    openSunday: !!(cfg.openSunday && cfg.start && cfg.end),
    perkEn: sourceHasPerk_(cfg) ? sourcePerkLineEn_(cfg) : '',
    perkJa: sourceHasPerk_(cfg) ? sourcePerkLineJa_(cfg) : '',
    periodEn: (cfg.start || cfg.end) ? sourcePeriodEn_(cfg) : '',
    periodJa: (cfg.start || cfg.end) ? sourcePeriodJa_(cfg) : ''
  };
}

// ====== 予約作成（createBooking） ======

/**
 * 流入元の特典を計算する。期間外・割引設定なしは null（通常の料金ルールへ）
 * @param {Array<{code:string, amount:number}>} lines - 品目ごとの金額（出張料は含めない）
 * @return {{total:number, detail:Array}|null}
 */
function computeSourceDiscount_(cfg, ymd, lines) {
  if (!cfg || !cfg.active || !sourceHasPerk_(cfg) || !sourceInPeriod_(cfg, ymd)) return null;
  var total = 0;
  var detail = [];
  (lines || []).forEach(function(l) {
    var pct = sourcePctFor_(cfg, l.code);
    var amt = Number(l.amount) || 0;
    if (pct > 0 && amt > 0) {
      var d = Math.round(amt * pct) / 100;
      total += d;
      detail.push({ code: String(l.code).toUpperCase(), pct: pct, amount: amt, discount: d });
    }
  });
  if (!detail.length) return null;   // 対象品目が無い予約は特典なし扱い（画面の srcActive と同じ判定）
  return { total: Math.round(total * 100) / 100, detail: detail };
}

/** 顧客入力（部屋番号・車種）をシートに書く前の無害化: 先頭の = + - @ を外す（数式として解釈させない） */
function sourceSafeText_(v, maxLen) {
  return String(v || '').trim().replace(/^[=+\-@\s]+/, '').substring(0, maxLen);
}

/**
 * 流入元の列が予約タブに無いと appendRow が黙って書かない（部屋番号が消える）。
 * 流入元つきの予約のときだけ確認し、欠けていれば管理グループへ知らせる（予約は止めない）。
 */
function warnIfSourceColumnsMissing_() {
  try {
    var h = getHeaderMap(SHEET_NAMES.BOOKINGS);
    var missing = ['流入元', '特典', '部屋番号'].filter(function(c) { return !h[c]; });
    if (!missing.length) return;
    sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId,
      '⚠️ 予約タブに列がありません: ' + missing.join(' / ') + '\n' +
      '専用QR（流入元）の予約の部屋番号などが記録されていません。予約タブの末尾に列を追加してください。');
  } catch (e) {
    Logger.log('⚠️ warnIfSourceColumnsMissing_: ' + e);
  }
}

/** 流入元の固定の場所（予約画面の地図の代わり）を "🏢 名前 URL" で返す */
function sourceLocationString_(cfg) {
  var url = cfg.mapsUrl ||
    (cfg.lat && cfg.lng ? 'https://www.google.com/maps?q=' + cfg.lat + ',' + cfg.lng : '');
  return '🏢 ' + (cfg.placeName || cfg.label) + (url ? ' ' + url : '');
}

// ====== 通知文 ======

/** 予約確定（顧客向け・英語メイン＋日本語）。notifyBookingCreated から呼ぶ */
function buildSourceCustomerConfirm_(info) {
  var src = info.source || {};
  var disc = info.srcDiscount || null;
  var pctByCode = {};
  if (disc) disc.detail.forEach(function(d) { pctByCode[d.code] = d; });

  function priceText(code, amount) {
    var d = pctByCode[String(code).toUpperCase()];
    return d ? sourceUsd_(amount) + ' → ' + sourceUsd_(amount - d.discount) + ' (-' + d.pct + '%)' : sourceUsd_(amount);
  }

  var t = '✅ Booking confirmed! / ご予約を承りました\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '📋 ' + info.bookingId + '\n' +
    '🏢 ' + (src.placeName || src.label || '') + (info.unitNo ? ' · Unit ' + info.unitNo : '') + '\n' +
    (info.carModel ? '🚗 ' + info.carModel + '\n' : '') +
    '📅 ' + info.date + ' ' + info.startTime + ' - ' + info.endTime + '\n' +
    '━━━━━━━━━━━━━━━━\n';
  if (info.plan) t += '💰 ' + (info.plan.name || 'SAMURAI WASH') + ': ' + priceText('WASH', info.baseAmount) + '\n';
  (info.options || []).forEach(function(l) {
    var icon = (optionKindLabel_(l.opt) === 'HEADLIGHT') ? '💡' : '✨';
    t += icon + ' ' + optionDisplayName_(l.opt).replace(/^SAMURAI /, '') + ': ' + priceText(l.opt.code, l.amount) + '\n';
  });
  if (disc && disc.total > 0) {
    t += '🎁 ' + (src.label || '') + ' residents\' discount / 住民特典: -' + sourceUsd_(disc.total) + '\n';
  }
  if (Number(info.dispatchFee) > 0) t += '🚚 Delivery fee / 出張料: ' + sourceUsd_(info.dispatchFee) + '\n';
  t += '💵 Total / お支払い合計: ' + sourceUsd_(info.amount) + '\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '📋 What happens next / このあとの流れ\n' +
    '⏰ 1h before: a reminder on Telegram / 1時間前にお知らせします\n' +
    '🚗 Park as usual — no key needed / いつもどおり駐車、鍵は不要です\n' +
    '📷 Before / after photos on Telegram / 施工前後の写真をお送りします\n' +
    '💳 After the service: pay by ABA QR / 施工後に ABA の QR でお支払い\n' +
    '━━━━━━━━━━━━━━━━\n' +
    '📍 Please also send us a photo of the front of your car at its parking spot, and the floor number.\n' +
    '   駐車位置での車の正面写真と、駐車している階をお送りください。\n' +
    '\n' +
    'Thank you! / ありがとうございます！';
  return t;
}

/** 管理グループ（予約確定）に足す行 */
function sourceAdminLinesForBooking_(info) {
  var src = info.source || {};
  var t = '🏢 流入元: ' + (src.display || src.label || '') + (info.unitNo ? '・部屋 ' + info.unitNo : '') + '\n';
  if (info.carModel) t += '🚗 車: ' + info.carModel + '\n';
  t += '🎁 特典: ' + (info.srcPerkText || 'なし') + '\n';
  return t;
}

/** 作業開始・終了の管理通知に足す行（予約タブの値から）。流入元が無ければ '' */
function sourceAdminLineForJob_(bkData) {
  var code = bkData ? String(bkData['流入元'] || '') : '';
  if (!code) return '';
  var room = String(bkData['部屋番号'] || '');
  return '🏷 流入元: ' + sourceDisplay_(code) + (room ? '・部屋 ' + room : '') + '\n';
}
