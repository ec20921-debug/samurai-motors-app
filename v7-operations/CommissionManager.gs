/**
 * CommissionManager.gs — 車屋提携 コミッション台帳（Phase 4・案件単位）
 *
 * 【責務】
 *   - 車屋経由の成約 1施工 = 1行 を「コミッション台帳」タブ（勤務用スプレッドシート側）に記帳
 *   - 店ごとの記帳一覧・未払い残の集計・支払済み化（ミニアプリの1タップ記帳が入口）
 *
 * 【設計方針（2026-07-25 Daisuke 意図共有 + 裁可）】
 *   - カンボジアの商習慣が未知のため「月締めバッチ」を前提にしない。
 *     案件単位の台帳が核。率・集金者・支払状態を行単位で持ち、
 *     その場精算にも後日まとめ精算にもオーナー毎の条件差にも対応する
 *   - コミッション基準は「売上の30%」（2026-07-22 B2B2C 裁可・行単位で変更可）
 *   - 置き場所は新規 GSS でなく勤務用スプレッドシート（経費・勤怠と同じ管理面）。
 *     店マスター（v7 Database 側）とは shop_id で橋渡し
 *   - 月次集計は締めではなく「未払い残を見るビュー」＝ GSS 側フィルタ/ピボットで足りる
 *     （必要になったら集計タブを追加。実験版では作らない）
 *   - 汎用シートヘルパー（readSheetObjects_ 等）は SalesLogManager.gs 定義を共用
 *
 * 【シート列（コミッション台帳）】
 *   commission_id / 記録日時 / shop_id / 店名 / 施工日 / 施工内容 / 売上(USD) /
 *   率(%) / コミッション額(USD・店の取り分) / 当社受取額(USD・売上−コミッション額) /
 *   集金者(店/当社) / 支払ステータス / 支払日 / 支払方法 / 記録者 /
 *   最終更新日時 / 更新者 / メモ
 */

// ====== 定数 ======

const COMMISSION_SHEET_NAME = 'コミッション台帳';
const COMMISSION_HEADERS = [
  'commission_id', '記録日時', 'shop_id', '店名', '施工日', '施工内容',
  '売上(USD)', '率(%)', 'コミッション額(USD)', '当社受取額(USD)', '集金者',
  '支払ステータス', '支払日', '支払方法', '記録者', '最終更新日時', '更新者', 'メモ'
];

/**
 * コミッション額の計算（セント単位の整数演算）
 * ⚠️ saleslog-internal.html の updateCmAmount と同一ロジック（変更時は両方同期必須）
 * 浮動小数点のまま revenue*rate を丸めると 0.5 セント境界（例: 12.35×30%）で
 * 系統的な1セント誤差が出るため、先にセント整数化してから演算する
 */
function commissionAmountCents_(revenueCents, rate) {
  return Math.round(revenueCents * rate / 100);
}

// 集金者モデル（2026-07-26 Daisuke 裁可）: 「だれがお客から集金したか」の事実を記録し、
// 精算は自動導出 — 店集金(基本・既定) → 店がうちに 70%(売上−コミッション額) を払う /
// 当社集金 → うちが店に 30%(コミッション額) を渡す。売上は当社定価ベース（7/22 裁可）
const COMMISSION_COLLECTORS = ['店', '当社'];
const COMMISSION_PAY_STATUSES = ['未払い', '支払済み'];
const COMMISSION_PAY_METHODS = ['現金', 'ABA', 'その他'];
const COMMISSION_DEFAULT_RATE = 30; // 売上の30%（2026-07-22 裁可）

// ====== 公開 API（Router からディスパッチ） ======

/**
 * 店のコミッション記帳一覧＋未払い残
 * @return {Object} { ok, entries: [...], unpaidToShop, unpaidFromShop }
 */
function commissionList(chatId, shopId) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const entries = readSheetObjects_(getCommissionSheet_())
    .map(function(r) { return commissionRowToApi_(r.obj); })
    .filter(function(c) { return c.commissionId && c.shopId === String(shopId); });
  entries.sort(function(a, b) { return String(b.serviceDate).localeCompare(String(a.serviceDate)); });

  // 未払い残: 店集金 → 店がうちに払う分(当社受取額) / 当社集金 → うちが店に払う分(コミッション額)
  let unpaidToShop = 0, unpaidFromShop = 0;
  entries.forEach(function(c) {
    if (c.payStatus !== '未払い') return;
    if (c.collector === '当社') unpaidToShop += c.amount;
    else unpaidFromShop += c.ourAmount;
  });

  return {
    ok: true,
    entries: entries,
    unpaidToShop: Math.round(unpaidToShop * 100) / 100,
    unpaidFromShop: Math.round(unpaidFromShop * 100) / 100
  };
}

/**
 * コミッション記帳（1施工=1行）
 * @param {Object} p - { shopId, serviceDate, serviceDesc, revenue, rate, collector,
 *                       payStatus, payDate, payMethod, memo }
 */
function commissionCreate(chatId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const shop = findSheetRow_(getShopSheet_(), 'shop_id', String(p.shopId || ''));
  if (!shop) return { ok: false, error: 'SHOP_NOT_FOUND' };

  const norm = normalizeCommissionInput_(p);
  if (norm.error) return { ok: false, error: norm.error };

  const commissionId = generateDateTimeId('CM') + '-' + Utilities.getUuid().slice(0, 8);
  const nowStr = salesLogNow_();
  appendSheetRow_(getCommissionSheet_(), {
    'commission_id':      commissionId,
    '記録日時':           nowStr,
    'shop_id':            String(p.shopId),
    '店名':               String(shop.obj['店名'] || ''),
    '施工日':             norm.serviceDate,
    '施工内容':           norm.serviceDesc,
    '売上(USD)':          norm.revenue,
    '率(%)':              norm.rate,
    'コミッション額(USD)': norm.amount,
    '当社受取額(USD)':     norm.ourAmount,
    '集金者':             norm.collector,
    '支払ステータス':      norm.payStatus,
    '支払日':             norm.payDate,
    '支払方法':           norm.payMethod,
    '記録者':             staff.nameJp,
    '最終更新日時':        nowStr,
    '更新者':             staff.nameJp,
    'メモ':               String(p.memo || '')
  });

  return { ok: true, commissionId: commissionId, amount: norm.amount };
}

/**
 * コミッション記帳の修正（支払済み化・金額訂正・メモ追記）
 * ⚠️ 全項目上書き方式（呼び出し元は全フィールドを持つ編集フォームに限る）。
 *   将来「1タップ支払済み化」等のクイックアクションを足す場合は、この関数に
 *   部分ペイロードを送らず、変更列を絞った専用アクションを別途用意すること
 */
function commissionUpdate(chatId, commissionId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const sheet = getCommissionSheet_();
  const found = findSheetRow_(sheet, 'commission_id', String(commissionId));
  if (!found) return { ok: false, error: 'COMMISSION_NOT_FOUND' };

  const norm = normalizeCommissionInput_(p);
  if (norm.error) return { ok: false, error: norm.error };

  updateSheetRow_(sheet, found.row, {
    '施工日':             norm.serviceDate,
    '施工内容':           norm.serviceDesc,
    '売上(USD)':          norm.revenue,
    '率(%)':              norm.rate,
    'コミッション額(USD)': norm.amount,
    '当社受取額(USD)':     norm.ourAmount,
    '集金者':             norm.collector,
    '支払ステータス':      norm.payStatus,
    '支払日':             norm.payDate,
    '支払方法':           norm.payMethod,
    '最終更新日時':        salesLogNow_(),
    '更新者':             staff.nameJp,
    'メモ':               String(p.memo || '')
  });

  return { ok: true, commissionId: String(commissionId), amount: norm.amount };
}

// ====== 内部実装 ======

/**
 * 入力の検証・正規化。
 * コミッション額(店の取り分) = 売上 × 率 / 100（セント整数演算）
 * 当社受取額 = 売上 − コミッション額（店集金時に店がうちへ払う金額）
 */
function normalizeCommissionInput_(p) {
  const revenue = Number(p.revenue);
  if (!isFinite(revenue) || revenue <= 0) return { error: 'INVALID_REVENUE' };

  let rate = Number(p.rate);
  if (!isFinite(rate) || rate < 0 || rate > 100) rate = COMMISSION_DEFAULT_RATE;

  const collector = COMMISSION_COLLECTORS.indexOf(String(p.collector || '').trim()) >= 0
    ? String(p.collector).trim() : COMMISSION_COLLECTORS[0]; // 既定 = 店集金
  const payStatus = COMMISSION_PAY_STATUSES.indexOf(String(p.payStatus || '').trim()) >= 0
    ? String(p.payStatus).trim() : COMMISSION_PAY_STATUSES[0];
  const payMethod = COMMISSION_PAY_METHODS.indexOf(String(p.payMethod || '').trim()) >= 0
    ? String(p.payMethod).trim() : '';

  const todayStr = salesLogNow_().substring(0, 10);
  let serviceDate = String(p.serviceDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(serviceDate)) serviceDate = todayStr;

  // 支払済みなら支払日を必ず持つ（未指定は当日）。未払いなら支払情報は空
  let payDate = String(p.payDate || '').trim();
  if (payStatus === '支払済み') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payDate)) payDate = todayStr;
  } else {
    payDate = '';
  }

  const revenueCents = Math.round(revenue * 100);
  const commissionCents = commissionAmountCents_(revenueCents, rate);
  return {
    serviceDate: serviceDate,
    serviceDesc: String(p.serviceDesc || '').trim(),
    revenue:     revenueCents / 100,
    rate:        rate,
    amount:      commissionCents / 100,
    ourAmount:   (revenueCents - commissionCents) / 100,
    collector:   collector,
    payStatus:   payStatus,
    payDate:     payDate,
    payMethod:   payStatus === '支払済み' ? payMethod : ''
  };
}

/**
 * 「コミッション台帳」タブ（勤務用スプレッドシート側・無ければ自動作成）
 */
function getCommissionSheet_() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  let sheet = ss.getSheetByName(COMMISSION_SHEET_NAME);
  if (!sheet) {
    sheet = createHeaderedSheet_(ss, COMMISSION_SHEET_NAME, COMMISSION_HEADERS);
    Logger.log('🆕 勤務用スプレッドシートに「' + COMMISSION_SHEET_NAME + '」タブを新規作成');
  } else {
    ensureCommissionCollectorSchema_(sheet);
  }
  return sheet;
}

/**
 * 旧「精算方向」スキーマ → 「集金者」モデルへの自動移行（冪等）
 * ①ヘッダー改名 精算方向→集金者 ②既存値変換（当社→店 ⇒ 当社 / 店→当社 ⇒ 店）
 * ③「当社受取額(USD)」列をコミッション額の隣に挿入 ④既存行の受取額を補完
 */
function ensureCommissionCollectorSchema_(sheet) {
  let headers = getSheetHeaders_(sheet);
  const dirIdx = headers.indexOf('精算方向');
  if (dirIdx >= 0 && headers.indexOf('集金者') < 0) {
    sheet.getRange(1, dirIdx + 1).setValue('集金者');
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const vals = sheet.getRange(2, dirIdx + 1, lastRow - 1, 1).getValues();
      const conv = vals.map(function(r) {
        const v = String(r[0] || '');
        if (v === '当社→店') return ['当社']; // 旧: 当社が集金し店へ支払う
        if (v === '店→当社') return ['店'];   // 旧: 店が集金し当社へ支払う
        return [v];
      });
      sheet.getRange(2, dirIdx + 1, lastRow - 1, 1).setValues(conv);
    }
  }
  ensureColumnAfter_(sheet, 'コミッション額(USD)', '当社受取額(USD)');

  // 既存行の当社受取額を補完（売上 − コミッション額）
  const rows = readSheetObjects_(sheet);
  const targets = rows.filter(function(r) {
    return String(r.obj['commission_id'] || '') &&
           r.obj['売上(USD)'] !== '' && r.obj['当社受取額(USD)'] === '';
  });
  if (targets.length) {
    headers = getSheetHeaders_(sheet);
    const col = headers.indexOf('当社受取額(USD)') + 1;
    const colVals = sheet.getRange(2, col, rows.length, 1).getValues();
    targets.forEach(function(r) {
      const cents = Math.round(Number(r.obj['売上(USD)']) * 100) -
                    Math.round((Number(r.obj['コミッション額(USD)']) || 0) * 100);
      if (r.row - 2 >= 0 && r.row - 2 < rows.length) colVals[r.row - 2][0] = cents / 100;
    });
    sheet.getRange(2, col, rows.length, 1).setValues(colVals);
    Logger.log('🔄 コミッション台帳: 当社受取額を ' + targets.length + '行補完');
  }
}

function commissionRowToApi_(obj) {
  return {
    commissionId: String(obj['commission_id'] || ''),
    recordedAt:   formatSalesLogDateCell_(obj['記録日時']),
    shopId:       String(obj['shop_id'] || ''),
    shopName:     String(obj['店名'] || ''),
    serviceDate:  formatSalesLogDateCell_(obj['施工日']).substring(0, 10),
    serviceDesc:  String(obj['施工内容'] || ''),
    revenue:      Number(obj['売上(USD)']) || 0,
    rate:         Number(obj['率(%)']) || 0,
    amount:       Number(obj['コミッション額(USD)']) || 0,
    ourAmount:    Number(obj['当社受取額(USD)']) || 0,
    collector:    String(obj['集金者'] || ''),
    payStatus:    String(obj['支払ステータス'] || ''),
    payDate:      formatSalesLogDateCell_(obj['支払日']).substring(0, 10),
    payMethod:    String(obj['支払方法'] || ''),
    recordedBy:   String(obj['記録者'] || ''),
    updatedAt:    formatSalesLogDateCell_(obj['最終更新日時']),
    updatedBy:    String(obj['更新者'] || ''),
    memo:         String(obj['メモ'] || '')
  };
}

// ====== デバッグ用 ======

function debugCommissionList() {
  // ロンの chatId + 既存店の shop_id を指定して実行
  const shops = salesLogShops('7500384947');
  if (!shops.ok || !shops.shops.length) { Logger.log('店なし'); return; }
  const res = commissionList('7500384947', shops.shops[0].shopId);
  Logger.log(JSON.stringify(res, null, 2));
}
