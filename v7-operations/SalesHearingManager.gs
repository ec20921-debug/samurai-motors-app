/**
 * SalesHearingManager.gs — 車屋提携 商談ヒアリング（その場の紹介料試算＋在庫車の記録）
 *
 * 【責務】
 *   - 営業ミニアプリ（saleslog-internal.html）の「商談計算」画面で、現場スタッフが
 *     車屋さんと話しながら入れた数字（1日の整備台数・在庫台数・黄ばみの台数など）と
 *     試算結果を、v7 Database の「商談ヒアリング」タブに1回=1行で残す
 *   - 店詳細の画面に、その店のヒアリング履歴を返す
 *   - 試算に使う料金を「メニュー」タブ（予約システムと同じ正本）から返す
 *
 * 【設計方針（2026-10-20 Daisuke 指示「営業管理のメインに・バックエンドの GSS に履歴を残す」）】
 *   - 新機能は新モジュール（CLAUDE.md 肥大化ルール）。SalesLogManager のシートヘルパーを使う
 *   - 料金はコードに書かず「メニュー」タブを読む（CLAUDE.md 絶対ルール8）
 *   - 試算はサーバー側でも計算し直して保存する（画面の数字を鵜呑みにしない）。
 *     ⚠️ saleslog-internal.html の hearingCalc_ と同じ式（変更時は両方を合わせる）
 *   - 紹介料率は店マスターの「紹介料率(%)」（空欄=30%）。在庫車の割引は 30%（2026-08-10 プライスリスト v2）
 *
 * 【試算の式】
 *   整備工場: 月の件数 = round(1日の整備台数 × 月の営業日数 ÷ N)、
 *             お客さんの支払い = 月の件数 × 平均単価、紹介料 = 支払い × 紹介料率
 *   中古車屋: 在庫 定価合計 = 軽い黄ばみ × HEADLIGHT + ひどい黄ばみ × HEADLIGHT_MAGIC + ガラス × ガラス単価、
 *             提携価格 = 定価合計 × (1 − 30%)、
 *             月の件数 = round(月の来店客数 ÷ N)、紹介料 = 月の件数 × 平均単価 × 紹介料率
 *   施設（ゴルフ場・レストラン・ホテル・モール・レジデンス。2026-10-20 追加）:
 *             毎日停まっている車 = round(駐車台数 × 埋まり具合%)、
 *             月の件数はサービス別（WASH / GLASS_3 / HEADLIGHT / HEADLIGHT_MAGIC）に画面で直接入れる
 *             （2026-10-20 Daisuke「駐車場の計算にこだわりすぎない」→ 駐車場の質問は記録用・任意）。
 *             駐車時間を答えた時だけ、選べるサービスを絞る（1時間未満 = WASH・HEADLIGHT／1〜3時間 = ＋GLASS／3時間以上 = ＋MAGIC。
 *             メニュータブの所要時間 WASH 30-45分・HEADLIGHT 40分・GLASS 60-100分・MAGIC 90分 から）、
 *             お客さんの支払い = Σ 件数 × 料金、紹介料 = 支払い × 紹介料率
 *   見込み評価（全モード・社内用）: 紹介料(月) が S 150$以上 / A 60$以上 / B 20$以上 / C それ未満
 *             （2026-10-20 Daisuke「任せる」で仮決め。1か月分のデータで見直す）
 */

const HEARING_SHEET_NAME = '商談ヒアリング';
const HEARING_HEADERS = [
  'hearing_id', '日時', 'shop_id', '店名', '記録者', '種類',
  '1日の整備台数', '月の営業日数', '月の来店客数', 'N人に1人', '平均単価(USD)',
  '月の件数', 'お客さんの支払い(月・USD)', '紹介料率(%)', '紹介料(月・USD)', '紹介料(年・USD)',
  '在庫台数', '軽い黄ばみ(台)', 'ひどい黄ばみ(台)', 'ガラス要手入れ(台)', 'ガラス単価(USD)',
  '在庫 定価合計(USD)', '在庫 提携価格(USD)', '割引額(USD)',
  '言われたこと・在庫メモ', '緯度', '経度',
  // ↓ 2026-10-20 施設モード・見込み評価（既存列の位置を動かさないよう末尾に追加）
  '見込み評価', '駐車台数', '混む時間の埋まり具合(%)', '1台あたりの駐車時間', '混む時間帯', '1日のお客さん数',
  '毎日停まっている車', 'WASH件数', 'GLASS件数', 'HEADLIGHT件数', 'MAGIC件数',
  'client_id'  // 送り直しの二重登録防止（2026-10-20 オフライン対策）
];
const HEARING_MODES = { garage: '整備工場', dealer: '中古車屋', facility: '施設' };
const HEARING_STAYS = { lt1: '1時間未満', '1to3': '1〜3時間', gt3: '3時間以上' };
const HEARING_PEAKS = { day: '昼', night: '夜', both: '両方' };
// 駐車時間ごとに、その場でできるサービス（メニュータブの所要時間から）
const HEARING_STAY_SERVICES = {
  '':    ['WASH', 'HEADLIGHT', 'GLASS_3', 'HEADLIGHT_MAGIC'],  // 駐車時間は未回答（記録用の質問なので答えなくてよい）
  lt1:   ['WASH', 'HEADLIGHT'],
  '1to3': ['WASH', 'HEADLIGHT', 'GLASS_3'],
  gt3:   ['WASH', 'HEADLIGHT', 'GLASS_3', 'HEADLIGHT_MAGIC']
};
const HEARING_COUNT_KEYS = { WASH: 'wash', GLASS_3: 'glass3', HEADLIGHT: 'headlight', HEADLIGHT_MAGIC: 'magic' };
// 見込み評価のしきい値（紹介料・月 USD）。仮決め（2026-10-20）
const HEARING_POTENTIAL = [['S', 150], ['A', 60], ['B', 20]];

function hearingPotential_(mine) {
  for (let i = 0; i < HEARING_POTENTIAL.length; i++) {
    if (mine >= HEARING_POTENTIAL[i][1]) return HEARING_POTENTIAL[i][0];
  }
  return 'C';
}
const HEARING_STOCK_DISCOUNT = 30; // 在庫車は定価の30%オフ（2026-08-10 プライスリスト v2「在庫車＝30%オフ」）
const HEARING_PRICE_CODES = ['HEADLIGHT', 'HEADLIGHT_MAGIC', 'GLASS_3', 'GLASS_ALL', 'WASH'];

// ====== 公開 API ======

/**
 * 試算に使う料金（メニュータブの有効行）。店一覧と一緒に返して画面のその場計算に使う
 * @return {Array} [{ code, nameEn, sedan, suv }]
 */
function salesHearingPrices_() {
  const sheet = getSalesLogSs_().getSheetByName('メニュー');
  if (!sheet) return [];
  return readSheetObjects_(sheet)
    .map(function(r) {
      return {
        code:   String(r.obj['コード'] || '').trim(),
        nameEn: String(r.obj['名称(英)'] || '').trim(),
        sedan:  Number(r.obj['セダン価格(USD)']) || 0,
        suv:    Number(r.obj['SUV価格(USD)']) || 0,
        active: r.obj['有効'] === true || String(r.obj['有効']).toUpperCase() === 'TRUE'
      };
    })
    .filter(function(p) { return p.active && HEARING_PRICE_CODES.indexOf(p.code) >= 0 && p.sedan > 0; })
    .map(function(p) { return { code: p.code, nameEn: p.nameEn, sedan: p.sedan, suv: p.suv }; });
}

/**
 * 商談ヒアリングを1行保存
 * @param {Object} p - { shopId, mode('garage'|'dealer'), inputs{...}, note, gps }
 * @return {Object} { ok, hearingId, hearing }
 */
function salesHearingCreate(chatId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };
  if (!HEARING_MODES[p.mode]) return { ok: false, error: 'INVALID_MODE' };

  const shop = findSheetRow_(getShopSheet_(), 'shop_id', p.shopId);
  if (!shop) return { ok: false, error: 'SHOP_NOT_FOUND' };

  const dup = findByClientId_(getHearingSheet_(), p.clientId);
  if (dup) return { ok: true, hearingId: String(dup.obj['hearing_id']), hearing: hearingRowToApi_(dup.obj), duplicate: true };

  const rate = shopCommissionTerms_(shop.obj).rate;
  const prices = priceMap_(salesHearingPrices_());
  if (p.mode !== 'garage' && (!prices.HEADLIGHT || !prices.HEADLIGHT_MAGIC)) {
    return { ok: false, error: 'MENU_PRICE_MISSING' }; // メニュータブにヘッドライトの料金が無い
  }
  const r = hearingCalc_(p.mode, p.inputs || {}, rate, prices);
  const gps = normalizeSalesLogGps_(p.gps);
  const hearingId = generateDateTimeId('HR') + '-' + Utilities.getUuid().slice(0, 8);

  const row = {
    'hearing_id': hearingId,
    '日時': salesLogNow_(),
    'shop_id': String(p.shopId),
    '店名': String(shop.obj['店名'] || ''),
    '記録者': staff.nameJp || staff.nameEn || '',
    '種類': HEARING_MODES[p.mode],
    '紹介料率(%)': rate,
    '月の件数': r.jobs,
    'お客さんの支払い(月・USD)': r.sales,
    '紹介料(月・USD)': r.mine,
    '紹介料(年・USD)': r.year,
    'N人に1人': r.oneIn,
    '平均単価(USD)': r.avg,
    '言われたこと・在庫メモ': String(p.note || '').substring(0, 2000),
    '緯度': gps ? gps.lat : '',
    '経度': gps ? gps.lng : '',
    '見込み評価': hearingPotential_(r.mine),
    'client_id': String(p.clientId || '').trim().substring(0, 80)
  };
  if (p.mode === 'garage') {
    row['1日の整備台数'] = r.carsDay;
    row['月の営業日数'] = r.days;
  } else if (p.mode === 'facility') {
    row['月の営業日数'] = r.days;
    row['駐車台数'] = r.spaces;
    row['混む時間の埋まり具合(%)'] = r.occ;
    row['1台あたりの駐車時間'] = HEARING_STAYS[r.stay] || '';
    row['混む時間帯'] = HEARING_PEAKS[r.peak] || '';
    row['1日のお客さん数'] = r.visitors;
    row['毎日停まっている車'] = r.parked;
    row['WASH件数'] = r.wash;
    row['GLASS件数'] = r.glass3;
    row['HEADLIGHT件数'] = r.headlight;
    row['MAGIC件数'] = r.magic;
  } else {
    row['月の来店客数'] = r.buyers;
    row['在庫台数'] = r.stock;
    row['軽い黄ばみ(台)'] = r.light;
    row['ひどい黄ばみ(台)'] = r.heavy;
    row['ガラス要手入れ(台)'] = r.glass;
    row['ガラス単価(USD)'] = r.glassPrice;
    row['在庫 定価合計(USD)'] = r.regular;
    row['在庫 提携価格(USD)'] = r.partner;
    row['割引額(USD)'] = r.save;
  }
  appendSheetRow_(getHearingSheet_(), row);
  return { ok: true, hearingId: hearingId, hearing: hearingRowToApi_(row) };
}

/**
 * 1店のヒアリング履歴（新しい順）。店詳細の応答に同梱する
 */
function salesHearingsForShop_(shopId) {
  const sheet = getSalesLogSs_().getSheetByName(HEARING_SHEET_NAME);
  if (!sheet) return [];
  const list = readSheetObjects_(sheet)
    .filter(function(r) { return String(r.obj['shop_id']) === String(shopId) && r.obj['hearing_id']; })
    .map(function(r) { return hearingRowToApi_(r.obj); });
  list.sort(function(a, b) { return String(b.datetime).localeCompare(String(a.datetime)); });
  return list;
}

/**
 * 各店の最新ヒアリングの見込み評価（店一覧・地図で「強化すべき店」を並べ替えるため）
 * @return {Object} shopId → { potential, mine, datetime }
 */
function salesHearingLatestByShop_() {
  const sheet = getSalesLogSs_().getSheetByName(HEARING_SHEET_NAME);
  if (!sheet) return {};
  const out = {};
  readSheetObjects_(sheet).forEach(function(r) {
    const id = String(r.obj['shop_id'] || '');
    if (!id || !r.obj['hearing_id']) return;
    const dt = formatSalesLogDateCell_(r.obj['日時']);
    if (out[id] && out[id].datetime > dt) return; // 同じ分なら後の行（あとから保存した方）を採る
    const mine = Number(r.obj['紹介料(月・USD)']) || 0;
    out[id] = { potential: String(r.obj['見込み評価'] || '') || hearingPotential_(mine), mine: mine, datetime: dt };
  });
  return out;
}

// ====== ヒアリングメモ（2026-10-20 Daisuke「聞いたこと・思ったことを何個でも記録したい。まとめは AI に」） ======
// 1件=1行。店ごとに何件でも足せる。訪問記録と一緒に書いた分は visit_id が入る。
// まとめは 3日ごとの自己改善タスク（docs/SALES_APP_IMPROVEMENT_LOG.md）が読んで作る

const NOTES_SHEET_NAME = 'ヒアリングメモ';
const NOTES_HEADERS = ['note_id', '日時', 'shop_id', '店名', '記録者', '内容', 'visit_id', '緯度', '経度', 'client_id'];
const NOTES_MAX_PER_SAVE = 20;
const NOTES_MAX_LEN = 1000;

/**
 * メモを足す（店の画面の「追加」・訪問記録と一緒の保存の両方から）
 * @param {Object} p - { shopId, texts: [string], visitId?, gps? }
 */
function salesNoteCreate(chatId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };
  const shop = findSheetRow_(getShopSheet_(), 'shop_id', p.shopId);
  if (!shop) return { ok: false, error: 'SHOP_NOT_FOUND' };
  // 送り直しなら書き足さない（1回目のメモは「番号#0」から始まる）
  if (p.clientId && findByClientId_(getNotesSheet_(), String(p.clientId) + '#0')) {
    return { ok: true, added: 0, duplicate: true, notes: salesNotesForShop_(p.shopId) };
  }
  const n = salesNotesAppend_(String(p.shopId), String(shop.obj['店名'] || ''), staff, p.texts, p.visitId, p.gps, p.clientId);
  if (!n) return { ok: false, error: 'EMPTY_NOTE' };
  return { ok: true, added: n, notes: salesNotesForShop_(p.shopId) };
}

/** 空でないメモだけを書き足し、足した件数を返す */
function salesNotesAppend_(shopId, shopName, staff, texts, visitId, gps, clientId) {
  const list = (Array.isArray(texts) ? texts : [texts])
    .map(function(t) { return String(t || '').trim(); })
    .filter(function(t) { return t; })
    .slice(0, NOTES_MAX_PER_SAVE);
  if (!list.length) return 0;
  const g = normalizeSalesLogGps_(gps);
  const sheet = getNotesSheet_();
  const now = salesLogNow_();
  list.forEach(function(t, i) {
    appendSheetRow_(sheet, {
      'note_id': generateDateTimeId('NT') + '-' + Utilities.getUuid().slice(0, 8),
      '日時': now,
      'shop_id': shopId,
      '店名': shopName,
      '記録者': staff.nameJp || staff.nameEn || '',
      '内容': t.substring(0, NOTES_MAX_LEN),
      'visit_id': String(visitId || ''),
      '緯度': g ? g.lat : '',
      '経度': g ? g.lng : '',
      'client_id': clientId ? String(clientId).substring(0, 80) + '#' + i : ''
    });
  });
  return list.length;
}

/** 1店のメモ（新しい順） */
function salesNotesForShop_(shopId) {
  const sheet = getSalesLogSs_().getSheetByName(NOTES_SHEET_NAME);
  if (!sheet) return [];
  const list = readSheetObjects_(sheet)
    .filter(function(r) { return String(r.obj['shop_id']) === String(shopId) && r.obj['note_id']; })
    .map(function(r) {
      return { noteId: String(r.obj['note_id']), datetime: formatSalesLogDateCell_(r.obj['日時']),
               staff: String(r.obj['記録者'] || ''), text: String(r.obj['内容'] || ''), visitId: String(r.obj['visit_id'] || '') };
    });
  // 同じ分に書いた複数件は書いた順に並べたいので、行番号の逆順（新しい行が先）
  return list.reverse();
}

function getNotesSheet_() {
  if (_salesLogSheetCache_[NOTES_SHEET_NAME]) return _salesLogSheetCache_[NOTES_SHEET_NAME];
  const ss = getSalesLogSs_();
  let sheet = ss.getSheetByName(NOTES_SHEET_NAME);
  if (!sheet) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20 * 1000);
    try {
      sheet = ss.getSheetByName(NOTES_SHEET_NAME) || createHeaderedSheet_(ss, NOTES_SHEET_NAME, NOTES_HEADERS);
    } finally {
      lock.releaseLock();
    }
  } else {
    runAtMostEvery_(['schema', NOTES_SHEET_NAME].concat(NOTES_HEADERS).join('|'), 6 * 60 * 60, function() {
      return ensureColumnsAtEnd_(sheet, NOTES_HEADERS);
    });
  }
  _salesLogSheetCache_[NOTES_SHEET_NAME] = sheet;
  return sheet;
}

// ====== 試算（⚠️ saleslog-internal.html の hearingCalc_ と同じ式） ======

function hearingCalc_(mode, inp, rate, prices) {
  const n = function(v, max) {
    const x = Number(v);
    return isFinite(x) && x > 0 ? Math.min(x, max) : 0;
  };
  const money = function(v) { return Math.round(v * 100) / 100; };
  const oneIn = Math.max(1, Math.round(n(inp.oneIn, 100)) || 1);
  const avg = n(inp.avg, 1000);
  const out = { oneIn: oneIn, avg: avg };
  if (mode === 'garage') {
    out.carsDay = n(inp.carsDay, 1000);
    out.days = Math.min(31, n(inp.days, 31));
    out.jobs = Math.round(out.carsDay * out.days / oneIn);
  } else if (mode === 'facility') {
    out.days = Math.min(31, n(inp.days, 31));
    out.spaces = Math.round(n(inp.spaces, 10000));
    out.occ = [30, 50, 80].indexOf(Number(inp.occ)) >= 0 ? Number(inp.occ) : 50;
    out.stay = HEARING_STAY_SERVICES[inp.stay] ? inp.stay : '';
    out.peak = HEARING_PEAKS[inp.peak] ? inp.peak : '';
    out.visitors = Math.round(n(inp.visitors, 100000));
    out.parked = Math.round(out.spaces * out.occ / 100);
    const allowed = HEARING_STAY_SERVICES[out.stay];
    let sales = 0, jobs = 0;
    Object.keys(HEARING_COUNT_KEYS).forEach(function(code) {
      const k = HEARING_COUNT_KEYS[code];
      const c = allowed.indexOf(code) >= 0 ? Math.round(n(inp[k], 10000)) : 0; // 駐車時間に合わないサービスは数えない
      out[k] = c;
      jobs += c;
      sales += c * (prices[code] || 0);
    });
    out.jobs = jobs;
    out.sales = money(sales);
    out.mine = money(out.sales * rate / 100);
    out.year = money(out.mine * 12);
    out.potential = hearingPotential_(out.mine);
    return out;
  } else {
    out.buyers = n(inp.buyers, 10000);
    out.stock = Math.round(n(inp.stock, 5000));
    out.light = Math.round(n(inp.light, 5000));
    out.heavy = Math.round(n(inp.heavy, 5000));
    out.glass = Math.round(n(inp.glass, 5000));
    out.glassPrice = n(inp.glassPrice, 1000);
    out.regular = money(out.light * (prices.HEADLIGHT || 0) + out.heavy * (prices.HEADLIGHT_MAGIC || 0) + out.glass * out.glassPrice);
    out.partner = money(out.regular * (100 - HEARING_STOCK_DISCOUNT) / 100);
    out.save = money(out.regular - out.partner);
    out.jobs = Math.round(out.buyers / oneIn);
  }
  out.sales = money(out.jobs * avg);
  out.mine = money(out.sales * rate / 100);
  out.year = money(out.mine * 12);
  out.potential = hearingPotential_(out.mine);
  return out;
}

function priceMap_(list) {
  const m = {};
  list.forEach(function(p) { m[p.code] = p.sedan; });
  return m;
}

// ====== シート ======

function getHearingSheet_() {
  if (_salesLogSheetCache_[HEARING_SHEET_NAME]) return _salesLogSheetCache_[HEARING_SHEET_NAME];
  const ss = getSalesLogSs_();
  let sheet = ss.getSheetByName(HEARING_SHEET_NAME);
  if (!sheet) {
    const lock = LockService.getScriptLock();
    lock.waitLock(20 * 1000);
    try {
      sheet = ss.getSheetByName(HEARING_SHEET_NAME) || createHeaderedSheet_(ss, HEARING_SHEET_NAME, HEARING_HEADERS);
      Logger.log('🆕 v7 Database に「' + HEARING_SHEET_NAME + '」タブを作成');
    } finally {
      lock.releaseLock();
    }
  } else {
    runAtMostEvery_(['schema', HEARING_SHEET_NAME].concat(HEARING_HEADERS).join('|'), 6 * 60 * 60, function() {
      return ensureColumnsAtEnd_(sheet, HEARING_HEADERS);
    });
  }
  _salesLogSheetCache_[HEARING_SHEET_NAME] = sheet;
  return sheet;
}

function hearingRowToApi_(obj) {
  const num = function(v) { return v === '' || v === null || v === undefined ? null : Number(v); };
  return {
    hearingId:  String(obj['hearing_id'] || ''),
    datetime:   formatSalesLogDateCell_(obj['日時']),
    shopId:     String(obj['shop_id'] || ''),
    staff:      String(obj['記録者'] || ''),
    mode:       obj['種類'] === HEARING_MODES.dealer ? 'dealer' : (obj['種類'] === HEARING_MODES.facility ? 'facility' : 'garage'),
    potential:  String(obj['見込み評価'] || ''),
    spaces:     num(obj['駐車台数']),
    occ:        num(obj['混む時間の埋まり具合(%)']),
    stayLabel:  String(obj['1台あたりの駐車時間'] || ''),
    peakLabel:  String(obj['混む時間帯'] || ''),
    visitors:   num(obj['1日のお客さん数']),
    parked:     num(obj['毎日停まっている車']),
    wash:       num(obj['WASH件数']),
    glass3:     num(obj['GLASS件数']),
    headlight:  num(obj['HEADLIGHT件数']),
    magic:      num(obj['MAGIC件数']),
    carsDay:    num(obj['1日の整備台数']),
    days:       num(obj['月の営業日数']),
    buyers:     num(obj['月の来店客数']),
    oneIn:      num(obj['N人に1人']),
    avg:        num(obj['平均単価(USD)']),
    jobs:       num(obj['月の件数']),
    sales:      num(obj['お客さんの支払い(月・USD)']),
    rate:       num(obj['紹介料率(%)']),
    mine:       num(obj['紹介料(月・USD)']),
    year:       num(obj['紹介料(年・USD)']),
    stock:      num(obj['在庫台数']),
    light:      num(obj['軽い黄ばみ(台)']),
    heavy:      num(obj['ひどい黄ばみ(台)']),
    glass:      num(obj['ガラス要手入れ(台)']),
    glassPrice: num(obj['ガラス単価(USD)']),
    regular:    num(obj['在庫 定価合計(USD)']),
    partner:    num(obj['在庫 提携価格(USD)']),
    save:       num(obj['割引額(USD)']),
    note:       String(obj['言われたこと・在庫メモ'] || '')
  };
}

// ====== デバッグ用 ======

function debugSalesHearingPrices() {
  Logger.log(JSON.stringify(salesHearingPrices_(), null, 2));
}
