/**
 * v7-operations: おそうじアプリの写真を管理グループへ届ける（OsoujiRelay.gs）と、日報の「そうじ」「日本語」欄（2026-11-21）
 *
 * 実行: node --test "tests/*.test.js"
 *
 * OsoujiRelay.gs・NihongoSection.gs・ShopProfile.gs（画像の読み取りだけ使う）を Node の vm に読み込み、
 * シート・Telegram・ロックはスタブ（本番には触れない）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPS = path.join(__dirname, '..', 'v7-operations');
const TZ = 'Asia/Phnom_Penh';

function fmt(d, tz, f) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(d).forEach((x) => { p[x.type] = x.value; });
  if (p.hour === '24') p.hour = '00';
  return f.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
    .replace('HH', p.hour).replace(/\bH\b/, String(Number(p.hour))).replace('mm', p.minute).replace('ss', p.second);
}

class FakeSheet {
  constructor(headers) { this.rows = [headers.slice()]; }
  getDataRange() { return { getValues: () => this.rows.map((r) => r.slice()) }; }
  appendRow(r) { this.rows.push(r.slice()); }
  getLastRow() { return this.rows.length; }
  getMaxRows() { return 1000; }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  getRange(r, c, nr, nc) {
    return {
      setValue: (v) => { this.rows[r - 1][c - 1] = v; },
      setNumberFormat: () => {},
      getValues: () => this.rows.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc))
    };
  }
}

function makeCtx(opts) {
  opts = Object.assign({ tgOk: true, props: { OSOUJI_THREAD_ID: '900' } }, opts || {});
  const sheets = {};
  const photos = [], texts = [];
  const cacheStore = {};
  const ss = { getSheetByName: (n) => sheets[n] || null };
  const ctx = {
    console, Logger: { log: () => {} }, OPS_TZ: TZ, BOT_TYPE: { INTERNAL: 'internal' },
    Utilities: {
      formatDate: fmt,
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, text) => Array.from(require('node:crypto').createHash('sha256').update(text, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      sleep: () => {},
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name })
    },
    CacheService: { getScriptCache: () => ({ get: (k) => (k in cacheStore ? cacheStore[k] : null), put: (k, v) => { cacheStore[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !opts.busy, releaseLock: () => {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => opts.props[k] || null, setProperty: (k, v) => { opts.props[k] = v; } }) },
    UrlFetchApp: { fetch: (url, o) => {
      photos.push({ url, payload: o.payload });
      return { getResponseCode: () => (opts.tgOk ? 200 : 500),
        getContentText: () => JSON.stringify(opts.tgOk ? { ok: true, result: { photo: [{ file_id: 'small' }, { file_id: 'FILE-BIG' }] } } : { ok: false, description: 'boom' }) };
    } },
    SpreadsheetApp: { openById: () => ({ getSheetByName: (n) => (opts.nihongo && n === '日別' ? opts.nihongo : null) }) },
    getConfig: () => ({ adminGroupId: '-100', adminDailyReportThreadId: '77' }),
    getBotToken: () => 'TOKEN',
    getOpsSs_: () => ss,
    createHeaderedSheet_: (s, name, headers) => (sheets[name] = new FakeSheet(headers)),
    sheetCellValue_: (v) => v,
    escapeHtml_: (s) => String(s),
    sendMessage: (bot, chatId, text, o) => { if (opts.textFail) return { ok: false }; texts.push({ chatId, text, o }); return { ok: true }; },
    callTelegramApi: () => ({ ok: false })
  };
  vm.createContext(ctx);
  ['ShopProfile.gs', 'OsoujiRelay.gs', 'NihongoSection.gs'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(OPS, f), 'utf8'), ctx, { filename: f }));
  // シートに名前を書く（＝認める）。認めた一覧のキャッシュが切れた後の動きを見るので、キャッシュも空にする
  const approve = (name) => {
    sheets['おそうじ端末'].rows[1][1] = name || 'Navin'; sheets['おそうじ端末'].rows[1][2] = 'STAFF-006';
    Object.keys(cacheStore).forEach((k) => delete cacheStore[k]);
  };
  return { ctx, sheets, photos, texts, approve, cacheStore };
}

const DEV = 'dev_ABCDEFGH12345678';
const IMG = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes'.repeat(20)).toString('base64');
const NOW = Date.now();
const TODAY = fmt(new Date(NOW), TZ, 'yyyy-MM-dd');
function body(o) { return Object.assign({ device: DEV, date: TODAY, room: '5-A', w: 'a', t: NOW, total: 11, done: 1, lap: 4, span: 4, img: IMG }, o || {}); }
// vm の中で作られたオブジェクトは deepEqual で型が合わないので、中身だけ比べる
function plain(o) { return JSON.parse(JSON.stringify(o)); }

test('はじめてのスマホ → 止める・端末タブに1行・グループへ1回だけ知らせる', () => {
  const { ctx, sheets, photos, texts } = makeCtx();
  const r1 = plain(ctx.osoujiPhoto_(body()));
  assert.equal(r1.ok, false); assert.equal(r1.error, 'DEVICE_PENDING'); assert.match(r1.code, /^[0-9A-F]{6}$/);
  assert.equal(plain(ctx.osoujiPhoto_(body({ room: '5-B' }))).error, 'DEVICE_PENDING');
  assert.equal(sheets['おそうじ端末'].rows.length, 2);
  assert.equal(texts.length, 1);
  assert.equal(photos.length, 0);
  assert.ok(texts[0].text.includes(r1.code), '知らせに確認コードが出る');
  const row = sheets['おそうじ端末'].rows[1];
  assert.ok(!JSON.stringify(row).includes(DEV) && !texts[0].text.includes(DEV), 'スマホの番号そのものはシートにも知らせにも出さない');
  assert.equal(row[5], r1.code);
});

test('未承認の行が上限に達したら、新しい行も知らせも作らない', () => {
  const { ctx, sheets, texts } = makeCtx();
  for (let i = 0; i < 25; i++) ctx.osoujiPhoto_(body({ device: 'spam_device_number_' + String(i).padStart(3, '0') }));
  assert.equal(sheets['おそうじ端末'].rows.length - 1, 20);
  assert.equal(texts.length, 21, '20 の知らせ＋「いっぱいです」の警告1通');
  assert.match(texts[20].text, /これ以上は受け付けません/);
});

test('認めたスマホ → 写真がトピックへ（通知なし）・記録に1行・送り直しは1回だけ', () => {
  const { ctx, sheets, photos, texts, approve } = makeCtx();
  ctx.osoujiPhoto_(body()); approve();
  assert.deepEqual(plain(ctx.osoujiPhoto_(body())), { ok: true });
  assert.equal(photos.length, 1);
  const p = photos[0].payload;
  assert.equal(p.chat_id, '-100'); assert.equal(p.message_thread_id, '900'); assert.equal(p.disable_notification, 'true');
  assert.match(p.caption, /5-A（後）/); assert.match(p.caption, /4分/); assert.match(p.caption, /1\/11/); assert.match(p.caption, /Navin/);
  const rec = sheets['おそうじ記録'].rows;
  assert.equal(rec.length, 2);
  assert.equal(rec[1][3], 'Navin'); assert.equal(rec[1][4], 'STAFF-006'); assert.equal(rec[1][6], '後'); assert.equal(rec[1][11], 'FILE-BIG');
  assert.deepEqual(plain(ctx.osoujiPhoto_(body())), { ok: true, dup: true });
  assert.equal(photos.length, 1);
  assert.equal(texts.length, 1, 'まとめはまだ送らない');
});

test('全部できたら まとめを1通だけ（撮り直しても2通目は出さない）', () => {
  const { ctx, sheets, texts, approve } = makeCtx();
  ctx.osoujiPhoto_(body()); approve();
  ctx.osoujiPhoto_(body({ room: 'ベランダ', done: 11, span: 42, t: NOW + 1000 }));
  assert.equal(texts.length, 2);
  assert.match(texts[1].text, /おそうじ完了：Navin　11\/11 か所・42分/);
  assert.equal(texts[1].o.message_thread_id, 900);
  ctx.osoujiPhoto_(body({ room: 'ベランダ', done: 11, span: 43, t: NOW + 2000 }));
  assert.equal(texts.length, 2);
});

test('Telegram が失敗 → TG_FAIL（記録しない＝アプリが後で送り直す）', () => {
  const { ctx, sheets, approve } = makeCtx({ tgOk: false });
  ctx.osoujiPhoto_(body()); approve();
  assert.deepEqual(plain(ctx.osoujiPhoto_(body())), { ok: false, error: 'TG_FAIL' });
  assert.equal(sheets['おそうじ記録'].rows.length, 1);
});

test('形のおかしい送信は断る', () => {
  const { ctx } = makeCtx();
  assert.equal(ctx.osoujiPhoto_(body({ device: 'short' })).error, 'INVALID_DEVICE');
  assert.equal(ctx.osoujiPhoto_(body({ date: '2020-01-01' })).error, 'INVALID_DATE');
  assert.equal(ctx.osoujiPhoto_(body({ room: '=HYPERLINK("x")' })).error, 'INVALID_ROOM');
  assert.equal(ctx.osoujiPhoto_(body({ w: 'x' })).error, 'INVALID_KIND');
  assert.equal(ctx.osoujiPhoto_(body({ img: 'not base64 !!' })).error, 'INVALID_IMAGE');
  assert.equal(ctx.osoujiPhoto_(body({ img: 'data:image/jpeg;base64,' + 'A'.repeat(900 * 1024) })).error, 'INVALID_IMAGE');
});

test('トピックの設定が無ければ日報トピックへ', () => {
  const { ctx, sheets, photos, approve } = makeCtx({ props: {} });
  ctx.osoujiPhoto_(body()); approve(); ctx.osoujiPhoto_(body());
  assert.equal(photos[0].payload.message_thread_id, '77');
});

test('日報の「そうじ」欄', () => {
  const { ctx, sheets, approve } = makeCtx();
  assert.equal(ctx.buildOsoujiSection_(TODAY), '', 'タブが無ければ出さない');
  ctx.osoujiPhoto_(body()); approve();
  ctx.osoujiPhoto_(body({ t: NOW, lap: 4 }));
  assert.match(ctx.buildOsoujiSection_('2000-01-01'), /今日は届いていません/, 'タブはあるがその日の行が無い');
  ctx.osoujiPhoto_(body({ room: '5-B', w: 'b', t: NOW + 60000 }));
  ctx.osoujiPhoto_(body({ room: '5-B', t: NOW + 180000, lap: 3, done: 2 }));
  const s = ctx.buildOsoujiSection_(TODAY);
  assert.match(s, /そうじ<\/b>（Navin）2\/11 か所・7分・/);
});

test('日報の「日本語」欄', () => {
  const head = ['日付', '勉強した分', '回答数', '正解数', '正答率', 'XP', 'ミッション(0-3)', 'ミッション達成', '現場で言えた', '連続日数', 'ランク', '更新'];
  const yest = fmt(new Date(new Date(TODAY + 'T12:00:00+07:00').getTime() - 864e5), TZ, 'yyyy-MM-dd');
  const sheet = new FakeSheet(head);
  const mk = (nihongo, props) => makeCtx({ nihongo, props: props || { NIHONGO_SPREADSHEET_ID: 'x' } }).ctx;
  assert.equal(mk(sheet, { NIHONGO_SPREADSHEET_ID: 'off' }).buildNihongoSection_(TODAY), '', '「off」なら出さない');
  assert.match(mk(sheet).buildNihongoSection_(TODAY), /きのう・今日とも なし/);
  sheet.appendRow([yest, 22, 48, 39, '81%', 300, 2, '', '', 5, 'x', '']);
  const s = mk(sheet).buildNihongoSection_(TODAY);
  assert.match(s, /きのう：22分・48問・正答率81%・ミッション2\/3・連続5日/);
  assert.match(s, /今日（ここまで）：まだ/);
});

test('知らないスマホは全体のロックが取れなくても固まらない・認めたスマホがロック待ちなら BUSY', () => {
  const a = makeCtx({ busy: true });
  assert.equal(plain(a.ctx.osoujiPhoto_(body())).error, 'DEVICE_PENDING');
  assert.equal(a.texts.length, 0, 'ロックが取れない時は行も知らせも作らない（次の写真でもう一度）');
  const b = makeCtx();
  b.ctx.osoujiPhoto_(body()); b.approve();
  b.ctx.LockService = { getScriptLock: () => ({ tryLock: () => false, releaseLock: () => {} }) };
  assert.equal(plain(b.ctx.osoujiPhoto_(body())).error, 'BUSY');
});

test('知らせを送れなかった時は行を作らない（次の写真でもう一度知らせる）', () => {
  const { ctx, sheets } = makeCtx({ textFail: true });
  assert.equal(plain(ctx.osoujiPhoto_(body())).error, 'DEVICE_PENDING');
  assert.equal(sheets['おそうじ端末'].rows.length, 1);
});

test('写真は届いたが記録に失敗 → 同じ写真をもう一度グループへ出さない', () => {
  const { ctx, sheets, photos, approve } = makeCtx();
  ctx.osoujiPhoto_(body()); approve();
  ctx.osoujiPhoto_(body({ room: '5-B' }));            // 記録タブを作っておく
  sheets['おそうじ記録'].appendRow = () => { throw new Error('quota'); };
  assert.deepEqual(plain(ctx.osoujiPhoto_(body())), { ok: true });
  assert.deepEqual(plain(ctx.osoujiPhoto_(body())), { ok: true, dup: true });
  assert.equal(photos.length, 2);
});

test('思わぬ例外は SERVER に丸める（中の文を外へ出さない）・変な時刻は断る', () => {
  const { ctx, approve } = makeCtx();
  ctx.osoujiPhoto_(body()); approve();
  ctx.osoujiSendPhotoBlob_ = () => { throw new Error('secret detail'); };
  assert.deepEqual(plain(ctx.osoujiPhoto_(body())), { ok: false, error: 'SERVER' });
  assert.equal(ctx.osoujiPhoto_(body({ t: 1e300 })).error, 'INVALID_TIME');
  assert.equal(ctx.osoujiPhoto_(body({ t: Infinity })).error, 'INVALID_TIME');
});
