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
 *   最終更新日時 / 更新者 / メモ / 紹介者名 / 紹介者率(%) / 紹介者報酬(USD・売上×紹介者率)
 *   ※ 紹介料率・集金者・紹介者の条件は記帳時に店マスターから行へ「写し取る」。
 *     後から店マスターの条件を変えても過去の行は変わらない（2026-09-28 裁可）
 */

// ====== 定数 ======

const COMMISSION_SHEET_NAME = 'コミッション台帳';
const COMMISSION_HEADERS = [
  'commission_id', '記録日時', 'shop_id', '店名', '施工日', '施工内容',
  '売上(USD)', '率(%)', 'コミッション額(USD)', '当社受取額(USD)', '集金者',
  '支払ステータス', '支払日', '支払方法', '記録者', '最終更新日時', '更新者', 'メモ',
  '紹介者名', '紹介者率(%)', '紹介者報酬(USD)'
];
const COMMISSION_INTRODUCER_HEADERS = ['紹介者名', '紹介者率(%)', '紹介者報酬(USD)'];

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
const COMMISSION_DEFAULT_RATE = 30; // 売上の30%（2026-07-22 裁可）。店マスターの率が空欄の時の予備値

// 提携先ごとの紹介料条件（2026-09-28 Daisuke 裁可「紹介料の提携先別管理 v1」）
// 店マスター（v7 Database）末尾の列。空欄は既定値（率30%・店集金・紹介者なし・無期限）
//   紹介者 = 提携先を紹介してくれた人。報酬は本部から「売上の◯%」を月末払い。
//   ⚖️ 1段限り（紹介者の紹介者には払わない）— 設計書 v3 §2-3・§7-1 の反ピラミッド法リスク対策
const SHOP_TERMS_HEADERS = ['紹介料率(%)', '既定の集金者', '紹介者名', '紹介者率(%)', '紹介者報酬の期限'];

/**
 * 店マスター行 → 紹介料条件（空欄・不正値は既定値で補完）
 * @return {Object} { rate, collector, introducerName, introducerRate, introducerUntil('yyyy-MM-dd' or '') }
 */
function shopCommissionTerms_(obj) {
  const rate = parsePercentCell_(obj['紹介料率(%)']);
  const collector = String(obj['既定の集金者'] || '').trim();
  const introducerName = String(obj['紹介者名'] || '').trim();
  const introducerRate = introducerName ? (parsePercentCell_(obj['紹介者率(%)']) || 0) : 0;
  return {
    rate:            rate === null ? COMMISSION_DEFAULT_RATE : rate,
    collector:       COMMISSION_COLLECTORS.indexOf(collector) >= 0 ? collector : COMMISSION_COLLECTORS[0],
    introducerName:  introducerRate > 0 ? introducerName : '',
    introducerRate:  introducerRate,
    introducerUntil: normalizeYmd_(formatSalesLogDateCell_(obj['紹介者報酬の期限']))
  };
}

/**
 * 日付文字列を yyyy-MM-dd に正規化（'2027/3/31' 等のテキスト入力も可）。
 * 空欄は ''（無期限）。読めない値は '0000-00-00' ＝ 期限切れ扱い（払い過ぎ防止のため安全側に倒す）
 */
function normalizeYmd_(s) {
  s = String(s || '').trim();
  if (!s) return '';
  const m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (!m) {
    Logger.log('⚠️ 紹介者報酬の期限を日付として読めません（期限切れ扱い）: ' + s);
    return '0000-00-00';
  }
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

/**
 * 施工日に紹介者報酬が付くか（期限が空欄なら無期限。期限日当日までを含む）
 */
function introducerAppliesOn_(terms, serviceDate) {
  if (!(terms.introducerRate > 0)) return false;
  return !terms.introducerUntil || String(serviceDate) <= terms.introducerUntil;
}

/**
 * 率セルの読み取り。空欄・範囲外は null。
 * GSS で「20%」と入力されたセルは 0.2 になるため、0〜1 未満は百分率に戻す
 */
function parsePercentCell_(v) {
  if (v === '' || v === null || v === undefined) return null;
  let n = Number(String(v).replace('%', '').trim());
  if (!isFinite(n)) return null;
  if (n > 0 && n < 1 && typeof v === 'number') n = n * 100;
  n = Math.round(n * 100) / 100;
  return (n < 0 || n > 100) ? null : n;
}

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
  // ⚠️ 集金者→支払の向きの判定は PartnerSettlement.aggregateSettlementRows_ /
  //    ShopProvisioningManager.aggregateCommissionsByShop_ と同一（変更時は3箇所同期必須）
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

  // 率・集金者は画面入力を優先し、未入力なら店マスターの条件（それも空なら 30%・店集金）
  const terms = shopCommissionTerms_(shop.obj);
  const norm = normalizeCommissionInput_(p, { rate: terms.rate, collector: terms.collector });
  if (norm.error) return { ok: false, error: norm.error };

  // 紹介者報酬: 施工日が期限内なら店マスターから写し取る（本部→紹介者・売上×紹介者率）
  const intro = introducerAppliesOn_(terms, norm.serviceDate)
    ? { name: terms.introducerName, rate: terms.introducerRate,
        amount: commissionAmountCents_(Math.round(norm.revenue * 100), terms.introducerRate) / 100 }
    : { name: '', rate: '', amount: '' };

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
    'メモ':               String(p.memo || ''),
    '紹介者名':           intro.name,
    '紹介者率(%)':        intro.rate,
    '紹介者報酬(USD)':    intro.amount
  });

  return { ok: true, commissionId: commissionId, amount: norm.amount,
           introducerAmount: intro.amount === '' ? 0 : intro.amount };
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

  // 未入力時は行に保存済みの値を維持（店マスターの現在の条件では上書きしない）
  const norm = normalizeCommissionInput_(p, {
    rate:      found.obj['率(%)'] === '' ? null : Number(found.obj['率(%)']),
    collector: String(found.obj['集金者'] || '')
  });
  if (norm.error) return { ok: false, error: norm.error };

  // 紹介者名・率は記帳時の写しを保持し、報酬額だけ売上に合わせて再計算
  const introRate = Number(found.obj['紹介者率(%)']) || 0;
  const updates = {
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
  };
  if (String(found.obj['紹介者名'] || '') && introRate > 0) {
    updates['紹介者報酬(USD)'] = commissionAmountCents_(Math.round(norm.revenue * 100), introRate) / 100;
  }
  updateSheetRow_(sheet, found.row, updates);

  return { ok: true, commissionId: String(commissionId), amount: norm.amount };
}

// ====== 内部実装 ======

/**
 * 入力の検証・正規化。
 * コミッション額(店の取り分) = 売上 × 率 / 100（セント整数演算）
 * 当社受取額 = 売上 − コミッション額（店集金時に店がうちへ払う金額）
 */
function normalizeCommissionInput_(p, defaults) {
  const revenue = Number(p.revenue);
  if (!isFinite(revenue) || revenue <= 0) return { error: 'INVALID_REVENUE' };

  // 未入力・不正値 → defaults（店マスターの条件 or 行の保存値）→ それも無ければ 30%・店集金
  const d = defaults || {};
  const fallbackRate = (d.rate === null || d.rate === undefined) ? COMMISSION_DEFAULT_RATE : d.rate;
  let rate = (p.rate === '' || p.rate === null || p.rate === undefined) ? NaN : Number(p.rate);
  if (!isFinite(rate) || rate < 0 || rate > 100) rate = fallbackRate;

  const fallbackCollector = COMMISSION_COLLECTORS.indexOf(String(d.collector || '')) >= 0
    ? String(d.collector) : COMMISSION_COLLECTORS[0]; // 既定 = 店集金
  const collector = COMMISSION_COLLECTORS.indexOf(String(p.collector || '').trim()) >= 0
    ? String(p.collector).trim() : fallbackCollector;
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
    ensureColumnsAtEnd_(sheet, COMMISSION_INTRODUCER_HEADERS);
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
    memo:         String(obj['メモ'] || ''),
    introducerName:   String(obj['紹介者名'] || ''),
    introducerRate:   Number(obj['紹介者率(%)']) || 0,
    introducerAmount: Number(obj['紹介者報酬(USD)']) || 0
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
