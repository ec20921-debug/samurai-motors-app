/**
 * CommissionManager.gs — 車屋提携 コミッション台帳（Phase 4・案件単位）
 *
 * 【責務】
 *   - 車屋経由の成約 1施工 = 1行 を「コミッション台帳」タブ（勤務用スプレッドシート側）に記帳
 *   - 店ごとの記帳一覧・未払い残の集計・支払済み化（ミニアプリの1タップ記帳が入口）
 *
 * 【設計方針（2026-07-25 Daisuke 意図共有 + 裁可）】
 *   - カンボジアの商習慣が未知のため「月締めバッチ」を前提にしない。
 *     案件単位の台帳が核。率・精算方向・支払状態を行単位で持ち、
 *     その場現金精算にも後日まとめ精算にもオーナー毎の条件差にも対応する
 *   - コミッション基準は「売上の30%」（2026-07-22 B2B2C 裁可・行単位で変更可）
 *   - 置き場所は新規 GSS でなく勤務用スプレッドシート（経費・勤怠と同じ管理面）。
 *     店マスター（v7 Database 側）とは shop_id で橋渡し
 *   - 月次集計は締めではなく「未払い残を見るビュー」＝ GSS 側フィルタ/ピボットで足りる
 *     （必要になったら集計タブを追加。実験版では作らない）
 *   - 汎用シートヘルパー（readSheetObjects_ 等）は SalesLogManager.gs 定義を共用
 *
 * 【シート列（コミッション台帳）】
 *   commission_id / 記録日時 / shop_id / 店名 / 施工日 / 施工内容 / 売上(USD) /
 *   率(%) / コミッション額(USD) / 精算方向 / 支払ステータス / 支払日 / 支払方法 /
 *   記録者 / メモ
 */

// ====== 定数 ======

const COMMISSION_SHEET_NAME = 'コミッション台帳';
const COMMISSION_HEADERS = [
  'commission_id', '記録日時', 'shop_id', '店名', '施工日', '施工内容',
  '売上(USD)', '率(%)', 'コミッション額(USD)', '精算方向',
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

const COMMISSION_DIRECTIONS = ['当社→店', '店→当社'];
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

  let unpaidToShop = 0, unpaidFromShop = 0;
  entries.forEach(function(c) {
    if (c.payStatus !== '未払い') return;
    if (c.direction === '店→当社') unpaidFromShop += c.amount;
    else unpaidToShop += c.amount;
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
 * @param {Object} p - { shopId, serviceDate, serviceDesc, revenue, rate, direction,
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
    '精算方向':           norm.direction,
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
    '精算方向':           norm.direction,
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
 * 入力の検証・正規化。コミッション額 = 売上 × 率 / 100（セント丸め）
 */
function normalizeCommissionInput_(p) {
  const revenue = Number(p.revenue);
  if (!isFinite(revenue) || revenue <= 0) return { error: 'INVALID_REVENUE' };

  let rate = Number(p.rate);
  if (!isFinite(rate) || rate < 0 || rate > 100) rate = COMMISSION_DEFAULT_RATE;

  const direction = COMMISSION_DIRECTIONS.indexOf(String(p.direction || '').trim()) >= 0
    ? String(p.direction).trim() : COMMISSION_DIRECTIONS[0];
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
  return {
    serviceDate: serviceDate,
    serviceDesc: String(p.serviceDesc || '').trim(),
    revenue:     revenueCents / 100,
    rate:        rate,
    amount:      commissionAmountCents_(revenueCents, rate) / 100,
    direction:   direction,
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
  }
  return sheet;
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
    direction:    String(obj['精算方向'] || ''),
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
