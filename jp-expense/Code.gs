/**
 * jp-expense — 日本側メンバーの経費入力アプリ（独立 GAS Web アプリ・2026-11-10）
 *
 * 目的: 鈴木・飯泉・五木田さんなど日本側メンバーが自分で負担した経費を、
 *       スクショ（証憑）とコメントつきでスマホから入れ、経費マスターへすぐ1行足す。
 *
 * 設計:
 *   - v7-operations（業務Bot・本番）とは別の GAS プロジェクト。本番 Bot に影響しない
 *   - リンクは1本・合言葉なし。開いたら名前を選んで入れる（2026-11-10 Daisuke「個別リンクも合言葉もいらない。名前は選べるように」）
 *     名前の選択肢＝経費GSS「スタッフマスター」の 有効=TRUE かつ 経費アプリ=TRUE の 氏名(JP)
 *     （2026-11-13 Daisuke「スタッフマスターと日本側メンバーが重複しているので1つに」で「日本側メンバー」タブを統合・削除）
 *   - 書き込み先＝経費マスター（負担先F＝本人・支払方法G＝「方法（本人）」・入力者J＝本人）
 *     出典N＝「日本側経費アプリ」、元ID O＝「JP-yyyyMMdd-HHmmss-xxx」
 *   - 証憑は Drive フォルダ「SamuraiMotors_日本側経費_証憑/yyyy-MM」に保存し H列にリンク
 *   - 前払い管理（Run Kosal の残金）には関係しない（G が「前払い金（ロン君）」にならない）
 *   - 通知は送らない（2026-11-10 Daisuke「Telegram への通知はいらない」）
 */

const PROP_SHEET_ID_ = 'SHEET_ID';
const PROP_FOLDER_ID_ = 'FOLDER_ID';
const MASTER_SHEET_ = '経費マスター';
const MEMBER_SHEET_ = 'スタッフマスター';
const SETTINGS_SHEET_ = '設定';
const SOURCE_LABEL_ = '日本側経費アプリ';
const FOLDER_NAME_ = 'SamuraiMotors_日本側経費_証憑';
const CURRENCIES_ = ['JPY', 'USD', 'KHR'];
const METHODS_ = ['クレカ', '現金', '銀行振込', '電子マネー・QR', 'その他'];
const MAX_FILES_ = 5;
const MIMES_ = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const MAX_FILE_B64_ = 6 * 1024 * 1024;   // 1ファイル（base64）の上限
const MAX_TOTAL_B64_ = 9 * 1024 * 1024;  // 1回の合計の上限

// ============================================================
//  画面
// ============================================================

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('日本側経費の入力｜Samurai Motors')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * GitHub Pages 版の画面からの呼び出し口（2026-11-10 追加）
 *   スマホで Google アカウントに複数ログインしていると script.google.com の画面が
 *   「現在、ファイルを開くことができません」になる → 画面は Pages に置き、ここへ fetch(POST) する。
 *   body: {"fn":"jpInit"|"jpRecent"|"jpSubmit","args":[...]} → {"result":...} か {"__error":"..."}
 */
function doPost(e) {
  let out;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fns = { jpInit: jpInit, jpRecent: jpRecent, jpSubmit: jpSubmit };
    const f = fns[body.fn];
    if (!f) throw new Error('UNKNOWN_FN');
    out = { result: f.apply(null, Array.isArray(body.args) ? body.args : []) };
  } catch (err) {
    out = { __error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  画面から呼ぶ関数（google.script.run）
// ============================================================

/** 初期表示: 名前の選択肢・分類など */
function jpInit() {
  return {
    ok: true,
    members: readMembers_(),
    categories: readCategories_(),
    currencies: CURRENCIES_,
    methods: METHODS_,
  };
}

/** 選んだ人の最近の記録 */
function jpRecent(name) {
  const member = findMember_(name);
  return member ? readRecent_(member.name, 10) : [];
}

/**
 * 経費を1件登録
 * @param {Object} p { name, date:'yyyy-MM-dd', category, item, amount, currency, method, comment,
 *                     files:[{name, mime, data(base64)}] }
 */
function jpSubmit(p) {
  p = p || {};
  const member = findMember_(p.name);
  if (!member) return { ok: false, error: '名前を選んでください' };

  // ── 入力チェック ──
  const date = String(p.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: '日付を選んでください' };
  // 分類・支払い方法は任意（2026-11-10 Daisuke「簡便にしたいから任意に」）
  //   分類なし → 経費マスターの集計から漏れないよう「その他」で入れ、備考に「分類は未指定」と残す
  let category = String(p.category || '').trim();
  const categoryUnset = !category;
  if (categoryUnset) category = 'その他';
  else if (readCategories_().indexOf(category) < 0) return { ok: false, error: '分類が正しくありません' };
  const item = String(p.item || '').trim();
  if (!item) return { ok: false, error: '何に使ったか（項目）を書いてください' };
  const amount = Number(p.amount);
  if (!isFinite(amount) || amount <= 0) return { ok: false, error: '金額を入れてください' };
  const currency = String(p.currency || '').toUpperCase();
  if (CURRENCIES_.indexOf(currency) < 0) return { ok: false, error: '通貨を選んでください' };
  const method = String(p.method || '').trim();
  if (method && METHODS_.indexOf(method) < 0) return { ok: false, error: '支払い方法が正しくありません' };
  const comment = String(p.comment || '').trim();
  const files = Array.isArray(p.files) ? p.files.slice(0, MAX_FILES_) : [];
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    const len = String(files[i].data || '').length;
    if (!MIMES_[files[i].mime]) return { ok: false, error: '写真（JPEG・PNG）か PDF だけ送れます' };
    if (len === 0 || len > MAX_FILE_B64_) return { ok: false, error: 'ファイルが大きすぎます（1つ 4MB まで）' };
    total += len;
  }
  if (total > MAX_TOTAL_B64_) return { ok: false, error: 'ファイルの合計が大きすぎます（合計 6MB まで）' };

  // 二重送信の防止: 同じ送信ID（画面が作る）は10分間、前の結果を返す
  const reqId = String(p.reqId || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  const cache = CacheService.getScriptCache();
  if (reqId) {
    const done = cache.get('jp_req_' + reqId);
    if (done) return JSON.parse(done);
  }
  if (!openSheet_().getSheetByName(MASTER_SHEET_)) return { ok: false, error: '経費マスターが見つかりません' };

  const tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  const now = new Date();
  const oid = 'JP-' + Utilities.formatDate(now, tz, 'yyyyMMdd-HHmmss') + '-' +
    Math.random().toString(36).slice(2, 5);

  // ── 証憑を Drive に保存（シートのロックの外で先にやる） ──
  const receiptCell = saveReceipts_(files, date, member.name, oid);

  // ── 経費マスターへ1行 ──
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let row;
  try {
    const sh = openSheet_().getSheetByName(MASTER_SHEET_);
    if (!sh) return { ok: false, error: '経費マスターが見つかりません' };
    const last = sh.getLastRow();
    row = last + 1;

    // M列（ID）の最大値 + 1
    let maxId = 0;
    if (last >= 4) {
      sh.getRange(4, 13, last - 3, 1).getValues().forEach(function (r) {
        const n = Number(r[0]);
        if (isFinite(n) && n > maxId) maxId = n;
      });
    }

    const note = [SOURCE_LABEL_ + 'から入力', categoryUnset ? '分類は未指定（要振替）' : '', comment]
      .filter(String).join(' / ');
    const values = [[
      date,                                  // A 日付
      category,                              // B 分類
      safe_(item),                           // C 項目
      amount,                                // D 金額
      currency,                              // E 通貨
      member.name,                           // F 負担先
      method ? method + '（' + member.name + '）' : '', // G 支払方法（未指定は空欄）
      receiptCell,                           // H レシート
      safe_(note),                           // I 備考
      member.name,                           // J 入力者
      '=IF(P' + row + '<>"○",0,IF(Q' + row + '<>"●",0,IF(E' + row + '="USD",D' + row +
        '*設定!$B$4,IF(E' + row + '="KHR",D' + row + '*設定!$B$5,IF(E' + row + '="JPY",D' +
        row + ',0)))))',                     // K JPY換算
      '=IFERROR(TEXT(A' + row + ',"yyyy-mm"),"")', // L 月
      maxId + 1,                             // M ID
      SOURCE_LABEL_,                         // N 出典
      oid,                                   // O 元ID
      '○',                                   // P 集計対象
      '●',                                   // Q 経費計上
    ]];
    sh.getRange(row, 1, 1, 17).setValues(values);
    if (row > 4) {
      sh.getRange(row - 1, 1, 1, 17).copyTo(sh.getRange(row, 1, 1, 17),
        SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    }
    sh.setRowHeight(row, 36);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  const result = { ok: true, row: row, id: oid, recent: readRecent_(member.name, 10) };
  if (reqId) cache.put('jp_req_' + reqId, JSON.stringify(result), 600);
  return result;
}

// ============================================================
//  内部
// ============================================================

function openSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(PROP_SHEET_ID_);
  if (!id) throw new Error('SHEET_ID が未設定です（setupJpExpense を1回実行してください）');
  return SpreadsheetApp.openById(id);
}

/**
 * 名簿＝「スタッフマスター」。1行目の列名で列を探す（列の並びが変わっても動く）
 * 有効=TRUE かつ 経費アプリ=TRUE の 氏名(JP) を返す（氏名(JP) が経費マスターの負担先に入る）
 */
function readMembers_() {
  const sh = openSheet_().getSheetByName(MEMBER_SHEET_);
  if (!sh || sh.getLastRow() < 2) return [];
  const values = sh.getDataRange().getValues();
  const head = values[0].map(function (h) { return String(h).trim(); });
  const cName = head.indexOf('氏名(JP)'), cOn = head.indexOf('有効'), cApp = head.indexOf('経費アプリ');
  if (cName < 0 || cOn < 0 || cApp < 0) return [];
  const isTrue = function (v) { return v === true || String(v).toUpperCase() === 'TRUE'; };
  return values.slice(1)
    .filter(function (r) { return String(r[cName]).trim() && isTrue(r[cOn]) && isTrue(r[cApp]); })
    .map(function (r) { return String(r[cName]).trim(); });
}

function findMember_(name) {
  name = String(name || '').trim();
  return readMembers_().indexOf(name) >= 0 ? { name: name } : null;
}

/** 分類＝「設定」タブ A12:A28 の分類表（経費マスター B 列の入力規則と同じ並び） */
function readCategories_() {
  const sh = openSheet_().getSheetByName(SETTINGS_SHEET_);
  return sh.getRange('A12:A28').getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(String);
}

/** このアプリから入った本人の記録（新しい順） */
function readRecent_(name, n) {
  const sh = openSheet_().getSheetByName(MASTER_SHEET_);
  const last = sh.getLastRow();
  if (last < 4) return [];
  const from = Math.max(4, last - 400);
  const vals = sh.getRange(from, 1, last - from + 1, 15).getDisplayValues();
  const out = [];
  for (let i = vals.length - 1; i >= 0 && out.length < n; i--) {
    const r = vals[i];
    if (String(r[14]).indexOf('JP-') === 0 && String(r[5]).trim() === name) {
      out.push({ date: r[0], category: r[1], item: r[2], amount: r[3], currency: r[4], row: from + i });
    }
  }
  return out;
}

/** 証憑を保存して H 列に入れる値を返す（なし→''／1枚→ファイル／2枚以上→その件のフォルダ） */
function saveReceipts_(files, date, name, oid) {
  if (!files.length) return '';
  const root = getRootFolder_();
  const month = date.slice(0, 7);
  const mIt = root.getFoldersByName(month);
  let folder = mIt.hasNext() ? mIt.next() : root.createFolder(month);
  name = String(name).replace(/[\/"<>:|?*]/g, '');
  if (files.length > 1) folder = folder.createFolder(date.replace(/-/g, '') + '_' + name + '_' + oid);

  const saved = files.map(function (f, i) {
    const mime = String(f.mime);
    const ext = MIMES_[mime];
    const fname = date.replace(/-/g, '') + '_' + name + '_' + oid + '_' + (i + 1) + '.' + ext;
    const blob = Utilities.newBlob(Utilities.base64Decode(String(f.data || '')), mime, fname);
    return folder.createFile(blob);
  });
  if (saved.length === 1) {
    return '=HYPERLINK("' + saved[0].getUrl() + '","証憑")';
  }
  return '=HYPERLINK("' + folder.getUrl() + '","証憑（' + saved.length + '枚）")';
}

function getRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty(PROP_FOLDER_ID_);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 作り直す */ }
  }
  const it = DriveApp.getFoldersByName(FOLDER_NAME_);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME_);
  props.setProperty(PROP_FOLDER_ID_, folder.getId());
  return folder;
}

/** 先頭が = + - @ の文字は式として読まれないよう ' を付ける */
function safe_(s) {
  s = String(s || '');
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// ============================================================
//  初回セットアップ（GAS エディタで1回だけ実行・権限の許可もここで出る）
// ============================================================

function setupJpExpense() {
  // 経費・勤務関連 GSS（📒Samurai Motors 経費・勤務関連）。秘密情報ではない
  const SHEET_ID = '1-5rMJW21t4PnpXnDAYdrNXzz672kL2cd4mOSti3Yfc0';
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_SHEET_ID_, SHEET_ID);
  const ss = SpreadsheetApp.openById(SHEET_ID);
  if (!ss.getSheetByName(MEMBER_SHEET_)) throw new Error('「スタッフマスター」タブがありません');
  const folder = getRootFolder_();
  Logger.log('OK: シート=' + ss.getName() + ' / 証憑フォルダ=' + folder.getUrl());
}
