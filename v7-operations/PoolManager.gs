/**
 * PoolManager.gs — ロン君前払いプール残高管理 (P1)
 *
 * 【背景】
 *   飯泉さんが ABA でロン君に USD を前払い → ロン君が現場で使う。
 *   v6 までは「残金いくら？」を毎回聞きに行く運用だったので可視化する。
 *
 * 【入力経路】
 *   飯泉さんが LINE で「ロンに $20 振り込んだ」と鈴木さんへ通知
 *     ↓
 *   鈴木さんが Claude Code に伝える
 *     ↓
 *   Claude Code が `pool_topup` API（簡易トークン認証）を叩く
 *     ↓
 *   `前払い入金` シートに 1 行追加 + 残高を即返却
 *
 * 【残高計算】
 *   balance(USD) =
 *     入金累計(USD) + 入金累計(KHR)/4000 + 入金累計(JPY)/160
 *     − 立替支出累計(USD, 登録者=ロン)
 *     − 立替支出累計(KHR, 登録者=ロン)/4000
 *
 *   ※ 「会社直払い」分は対象外
 *   ※ 飯泉さん等の個人立替は対象外（登録者で判定）
 *
 * 【為替レート（固定）】
 *   既存「統合明細」タブの運用に合わせる：
 *     1 USD = 4000 KHR
 *     1 USD = 160  JPY
 *   ※ 為替変動の誤差は許容（USD前払い基準なので）
 *
 * 【シード】
 *   初回のみ seedRonOpeningBalance() を手動実行して期首残高を投入する。
 */

const POOL_SHEET_NAME_       = '前払い入金';
const POOL_DEFAULT_RECEIVER_ = 'ロン';
const POOL_KHR_PER_USD_      = 4000;
const POOL_JPY_PER_USD_      = 160;

const POOL_HEADERS_ = [
  '入金ID',
  '登録日時',
  '入金日',
  '入金者',
  '受領者',
  '金額',
  '通貨',
  '方法',
  'メモ',
  '登録者'
];

// 方法（method）の自由記述だが、運用上の標準値はこれ
const POOL_METHODS_ = ['ABA', '現金', '振込', 'opening', '調整'];

// ============================================================
//  セットアップ
// ============================================================

/**
 * 前払い入金シートが無ければ作成。あればヘッダーだけ整備。
 */
function ensurePoolDepositsSheet() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  let sheet = ss.getSheetByName(POOL_SHEET_NAME_);
  if (!sheet) {
    sheet = ss.insertSheet(POOL_SHEET_NAME_);
    sheet.getRange(1, 1, 1, POOL_HEADERS_.length).setValues([POOL_HEADERS_]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, POOL_HEADERS_.length)
      .setFontWeight('bold')
      .setBackground('#2b2b2b')
      .setFontColor('#e8e8e8');
    sheet.setColumnWidth(1, 170);  // 入金ID
    sheet.setColumnWidth(9, 280);  // メモ
    Logger.log('✅ 前払い入金シート作成');
    return sheet;
  }
  // ヘッダー差分があれば整備
  const lastCol = sheet.getLastColumn() || 1;
  const existing = sheet.getRange(1, 1, 1, Math.max(lastCol, POOL_HEADERS_.length)).getValues()[0];
  let needs = false;
  POOL_HEADERS_.forEach(function(h, i) { if (existing[i] !== h) needs = true; });
  if (needs) {
    sheet.getRange(1, 1, 1, POOL_HEADERS_.length).setValues([POOL_HEADERS_]);
    Logger.log('♻️ 前払い入金シート ヘッダー整備');
  }
  return sheet;
}

// ============================================================
//  入金記録
// ============================================================

/**
 * 前払い入金を 1 件記録する。
 *
 * @param {{
 *   transactionDate: string,  // 'yyyy-MM-dd'（省略時は今日）
 *   payer:           string,  // '飯泉' 等。空は不可
 *   receiver:        string,  // 省略時 'ロン'
 *   amount:          number,  // > 0
 *   currency:        string,  // 'USD' | 'KHR' | 'JPY'（省略時 USD）
 *   method:          string,  // 'ABA' | '現金' | 'opening' 等
 *   memo:            string,
 *   registeredBy:    string   // '鈴木' | 'Claude' 等
 * }} payload
 * @return {{ok:boolean, depositId?:string, balanceAfter?:object, error?:string}}
 */
function addPoolDeposit(payload) {
  payload = payload || {};
  const tz = OPS_TZ;
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  const txDate       = String(payload.transactionDate || todayStr).trim() || todayStr;
  const payer        = String(payload.payer        || '').trim();
  const receiver     = String(payload.receiver     || POOL_DEFAULT_RECEIVER_).trim() || POOL_DEFAULT_RECEIVER_;
  const amount       = Number(payload.amount       || 0);
  const currency     = String(payload.currency     || 'USD').trim().toUpperCase();
  const method       = String(payload.method       || 'ABA').trim();
  const memo         = String(payload.memo         || '').trim();
  const registeredBy = String(payload.registeredBy || 'Claude').trim() || 'Claude';

  if (!payer) return { ok: false, error: 'PAYER_REQUIRED' };
  if (!amount || isNaN(amount) || amount <= 0) return { ok: false, error: 'AMOUNT_INVALID' };
  if (EXPENSE_CURRENCIES_.indexOf(currency) < 0) return { ok: false, error: 'CURRENCY_INVALID' };

  ensurePoolDepositsSheet();
  const depositId = generateDateSeqId('POOL', POOL_SHEET_NAME_, '入金ID');

  appendRow(POOL_SHEET_NAME_, {
    '入金ID':   depositId,
    '登録日時': new Date(),
    '入金日':   txDate,
    '入金者':   payer,
    '受領者':   receiver,
    '金額':     amount,
    '通貨':     currency,
    '方法':     method,
    'メモ':     memo,
    '登録者':   registeredBy
  });

  return {
    ok:           true,
    depositId:    depositId,
    balanceAfter: getPoolBalance(receiver)
  };
}

// ============================================================
//  残高計算
// ============================================================

/**
 * 指定受領者のプール残高を計算（USD 一本に換算）。
 *
 * @param {string} receiver - デフォルト 'ロン'
 * @return {{
 *   receiver:    string,
 *   balanceUSD:  number,
 *   deposits:    {USD:number, KHR:number, JPY:number},
 *   depositsUSD: number,
 *   spend:       {USD:number, KHR:number},
 *   spendUSD:    number,
 *   asOf:        string
 * }}
 */
function getPoolBalance(receiver) {
  receiver = receiver || POOL_DEFAULT_RECEIVER_;
  ensurePoolDepositsSheet();

  // 入金集計
  const deposits = { USD: 0, KHR: 0, JPY: 0 };
  const depositRows = getAllRows(POOL_SHEET_NAME_);
  depositRows.forEach(function(r) {
    if (String(r['受領者']) !== receiver) return;
    const cur = String(r['通貨'] || 'USD').toUpperCase();
    const amt = Number(r['金額'] || 0);
    if (deposits[cur] === undefined) deposits[cur] = 0;
    deposits[cur] += amt;
  });

  // 立替支出集計（登録者=受領者、立替区分=立替 のみ）
  const spend = { USD: 0, KHR: 0 };
  let expenseRows = [];
  try {
    expenseRows = getAllRows(SHEET_NAMES.EXPENSES);
  } catch (e) {
    expenseRows = [];
  }
  expenseRows.forEach(function(r) {
    if (String(r['立替区分']) !== '立替') return;
    if (String(r['登録者'])   !== receiver) return;
    const cur = String(r['通貨'] || 'USD').toUpperCase();
    const amt = Number(r['金額'] || 0);
    if (spend[cur] === undefined) spend[cur] = 0;
    spend[cur] += amt;
  });

  const depositsUSD =
    (deposits.USD || 0) +
    (deposits.KHR || 0) / POOL_KHR_PER_USD_ +
    (deposits.JPY || 0) / POOL_JPY_PER_USD_;
  const spendUSD =
    (spend.USD || 0) +
    (spend.KHR || 0) / POOL_KHR_PER_USD_;
  const balanceUSD = depositsUSD - spendUSD;

  return {
    receiver:    receiver,
    balanceUSD:  Math.round(balanceUSD * 100) / 100,
    deposits:    deposits,
    depositsUSD: Math.round(depositsUSD * 100) / 100,
    spend:       spend,
    spendUSD:    Math.round(spendUSD * 100) / 100,
    asOf:        Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd HH:mm')
  };
}

/**
 * 直近 N 件の入金履歴（新しい順）。日報・ダッシュボード用。
 */
function getRecentPoolDeposits(receiver, limit) {
  receiver = receiver || POOL_DEFAULT_RECEIVER_;
  limit    = Number(limit || 5);
  ensurePoolDepositsSheet();
  const rows = getAllRows(POOL_SHEET_NAME_)
    .filter(function(r) { return String(r['受領者']) === receiver; })
    .reverse()
    .slice(0, limit);
  return rows.map(function(r) {
    return {
      depositId: String(r['入金ID'] || ''),
      txDate:    formatDateCellTz_ ? formatDateCellTz_(r['入金日'], OPS_TZ) : String(r['入金日'] || ''),
      payer:     String(r['入金者'] || ''),
      amount:    Number(r['金額']   || 0),
      currency:  String(r['通貨']   || 'USD'),
      method:    String(r['方法']   || ''),
      memo:      String(r['メモ']   || '')
    };
  });
}

// ============================================================
//  認証（簡易トークン）
// ============================================================

/**
 * リクエストのトークンを検証。
 * ScriptProperties.POOL_TOPUP_TOKEN が未設定なら必ず false。
 */
function validatePoolToken_(token) {
  const expected = PropertiesService.getScriptProperties()
    .getProperty(CONFIG_KEYS.POOL_TOPUP_TOKEN);
  if (!expected) return false;
  if (!token)    return false;
  return String(token) === String(expected);
}

/**
 * トークンを新規生成して ScriptProperties に保存。
 * 鈴木さんが Claude Code 側に貼り付けるための値を返す。
 *
 * 注意：既存トークンは上書きされる（再生成=無効化）。
 */
function setupPoolTopupToken() {
  const bytes = [];
  for (let i = 0; i < 32; i++) bytes.push(Math.floor(Math.random() * 256));
  const token = Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
  PropertiesService.getScriptProperties().setProperty(CONFIG_KEYS.POOL_TOPUP_TOKEN, token);
  Logger.log('🔑 POOL_TOPUP_TOKEN を再生成しました（既存トークンは無効化）');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log(token);
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('↑ この値を鈴木さん Claude Code 側に保存してください');
  return token;
}

// ============================================================
//  期首残高シード
// ============================================================

/**
 * 期首残高を 1 回だけ投入する（手動実行・冪等）。
 *
 * 飯泉さん 2026-05-14 Telegram 報告：
 *   $57 期首 + $20 ABA入金 − $66.5 5月支出 = $10.5 残
 *
 * v7-ops 経費シートにロンの 5月 立替がどれだけ既に入っているか
 * 不明なので、現在の getPoolBalance() を測って差分を `opening` で投入。
 * 既存に opening があれば何もしない（冪等）。
 *
 * - 経費に 0 件入っている場合 → opening 投入額 = $10.5
 * - 経費に Ron 立替 $66.5 入っている場合 → opening 投入額 = $77 (= 10.5 + 66.5)
 * いずれにせよ最終残高は $10.5 になる。
 */
function seedRonOpeningBalance() {
  ensurePoolDepositsSheet();

  // 冪等チェック：既に opening が入っていたらスキップ
  const existing = getAllRows(POOL_SHEET_NAME_).filter(function(r) {
    return String(r['受領者']) === POOL_DEFAULT_RECEIVER_ &&
           String(r['方法'])   === 'opening';
  });
  if (existing.length > 0) {
    const cur = getPoolBalance(POOL_DEFAULT_RECEIVER_);
    Logger.log('ℹ️ 期首残高は既に投入済み（' + existing.length + '件）スキップ。現在残高: $' + cur.balanceUSD);
    return { ok: false, error: 'ALREADY_SEEDED', existing: existing.length, currentBalance: cur };
  }

  const TARGET_USD = 10.5;
  const beforeSeed = getPoolBalance(POOL_DEFAULT_RECEIVER_);
  // 現状 balance = depositsUSD - spendUSD（depositsUSD は 0 のはず）
  // 投入額 = TARGET - 現balance
  const openingAmount = Math.round((TARGET_USD - beforeSeed.balanceUSD) * 100) / 100;

  if (openingAmount <= 0) {
    Logger.log('⚠️ 既存データで balance=' + beforeSeed.balanceUSD + ' USD、目標 $' + TARGET_USD + ' に既に達しているため opening 不要');
    return { ok: false, error: 'BALANCE_ALREADY_AT_OR_ABOVE_TARGET', current: beforeSeed };
  }

  const result = addPoolDeposit({
    transactionDate: '2026-05-14',
    payer:           '期首残高',
    receiver:        POOL_DEFAULT_RECEIVER_,
    amount:          openingAmount,
    currency:        'USD',
    method:          'opening',
    memo:            'P1 期首残 reconcile（飯泉LINE 2026-05-14 報告 $10.5 に合わせて投入。既存 v7-ops 立替支出: $' + beforeSeed.spendUSD + '）',
    registeredBy:    'Claude (setup)'
  });

  const after = getPoolBalance(POOL_DEFAULT_RECEIVER_);
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ seedRonOpeningBalance 完了');
  Logger.log('  投入額:   $' + openingAmount);
  Logger.log('  事後残高: $' + after.balanceUSD + '（目標 $' + TARGET_USD + '）');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  return {
    ok:              true,
    depositId:       result.depositId,
    openingAmount:   openingAmount,
    targetBalance:   TARGET_USD,
    verifiedBalance: after.balanceUSD,
    matchesTarget:   Math.abs(after.balanceUSD - TARGET_USD) < 0.01
  };
}

// ============================================================
//  デバッグ
// ============================================================

function debugEnsurePoolSheet() {
  ensurePoolDepositsSheet();
}

function debugGetPoolBalance() {
  Logger.log(JSON.stringify(getPoolBalance(POOL_DEFAULT_RECEIVER_), null, 2));
}

function debugAddTestDeposit() {
  const r = addPoolDeposit({
    payer:    '飯泉',
    receiver: POOL_DEFAULT_RECEIVER_,
    amount:   20,
    currency: 'USD',
    method:   'ABA',
    memo:     'デバッグ入金',
    registeredBy: 'Claude (debug)'
  });
  Logger.log(JSON.stringify(r));
}
