/**
 * 現場アプリの送信待ち箱（field/outbox.js）: 写真を撮ったそばから送る作り（2026-11-13）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * outbox.js の実ファイルを Node の vm に読み込み、端末の保存（IndexedDB）と通信（fetch）は偽物に置き換える。
 *   - 写真（job_photo）を先に送り、開始（job_start）は写真の file_id を付けた軽い送信で、写真のあとに送る
 *   - 文字だけの知らせ（job_start_notice）は写真より先に送る
 *   - 写真が「要確認」になっても開始・終了は止めない（その写真なしで送る）
 *   - 終了（job_end）は開始のあと・作業後の写真のあと
 *   - 取り消しは、まだ送っていない写真・知らせも捨てる。知らせを送ろうとしていたら取り消しをサーバーへ送る
 *   - 小さい送信は keepalive、写真は keepalive にしない。keepalive で失敗したら次はふつうの送信
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'field', 'outbox.js'), 'utf8');

/** 最小の IndexedDB（put / get / getAll / delete と transaction の oncomplete だけ） */
function fakeIndexedDB() {
  const stores = {};
  const req = (fn) => { const r = {}; try { r.result = fn(); } catch (e) { r.error = e; } return r; };
  return {
    open: () => {
      const r = {};
      setImmediate(() => {
        const db = {
          objectStoreNames: { contains: (n) => n in stores },
          createObjectStore: (n, o) => { stores[n] = { keyPath: o.keyPath, rows: new Map() }; },
          close: () => {},
          transaction: (name) => {
            const t = {};
            t.objectStore = () => ({
              put: (v) => req(() => { stores[name].rows.set(v[stores[name].keyPath], JSON.parse(JSON.stringify(v))); }),
              get: (k) => req(() => { const v = stores[name].rows.get(k); return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }),
              getAll: () => req(() => Array.from(stores[name].rows.values()).map((v) => JSON.parse(JSON.stringify(v)))),
              delete: (k) => req(() => { stores[name].rows.delete(k); })
            });
            setImmediate(() => { if (t.oncomplete) t.oncomplete(); });
            return t;
          }
        };
        r.result = db;
        if (r.onupgradeneeded) r.onupgradeneeded();
        if (r.onsuccess) r.onsuccess();
      });
      return r;
    }
  };
}

/** outbox.js を読み込む。handler(body) が応答（オブジェクト）を返す。throw すると通信エラー */
function loadOutbox(handler) {
  const posts = [];
  let n = 0;
  const win = {
    indexedDB: fakeIndexedDB(),
    setTimeout: () => 0, clearTimeout: () => {},     // 自動の再送は動かさない（テストから flush を呼ぶ）
    addEventListener: () => {},
    crypto: { randomUUID: () => 'uuid-' + String(++n).padStart(4, '0') + '-0000-4000-8000-000000000000' },
    fetch: (url, init) => {
      const body = JSON.parse(init.body);
      posts.push({ kind: body.action, body, keepalive: !!init.keepalive, size: init.body.length });
      return Promise.resolve().then(() => handler(body, posts.length)).then((res) => ({ json: () => Promise.resolve(res) }));
    },
    navigator: {}, console
  };
  win.window = win;
  const ctx = vm.createContext(Object.assign(win, { document: { addEventListener: () => {}, visibilityState: 'visible' }, indexedDB: win.indexedDB,
    fetch: win.fetch, crypto: win.crypto, AbortController: undefined }));
  vm.runInContext(SRC, ctx, { filename: 'outbox.js' });
  return { Outbox: ctx.Outbox, posts };
}
const okServer = (body) => {
  const res = { status: 'ok', client_id: body.client_id };
  if (body.action === 'job_photo') res.file_id = 'FILE-' + body.slot;
  return res;
};
const JOB = 'job-0001';
const photoRec = (cid, slot, phase) => ({ client_id: cid, job_client_id: JOB, phase: phase || 'before', slot, photoBase64: 'data:image/jpeg;base64,' + 'A'.repeat(3000) });
const startRec = (extra) => Object.assign({ client_id: JOB, job_client_id: JOB, beforePhotos: [], startTime: '2026-11-13T02:29:24.923Z', v2: {} }, extra || {});
// 取り消しなどが内部で始めた送信（待たずに始まる）が終わるのを待ってから、残りを送り切る
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
async function flushAll(Outbox, times) { for (let i = 0; i < (times || 4); i++) { await settle(); await Outbox.flush(); } await settle(); }
const kinds = (posts) => posts.map((p) => p.kind + (p.body.slot ? ':' + p.body.slot : ''));

test('写真を先に送り、開始は写真の file_id を付けた軽い送信で、写真のあとに送る', async () => {
  const { Outbox, posts } = loadOutbox(okServer);
  await Outbox.start({ url: 'https://gas.example/exec', appVersion: 'field-test' });
  assert.equal(Outbox.caps.deps, 1, '画面側が「写真を先に送る作り」と分かる印');
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  await Outbox.enqueue('job_photo', photoRec('p-B', 'B'));
  await Outbox.enqueue('job_start', startRec(), { deps: [{ slot: 'F', cid: 'p-F' }, { slot: 'B', cid: 'p-B' }] });
  await flushAll(Outbox);
  assert.deepEqual(kinds(posts), ['job_photo:F', 'job_photo:B', 'job_start']);
  const st = posts[2];
  assert.deepEqual(st.body.photo_refs, [{ slot: 'F', file_id: 'FILE-F' }, { slot: 'B', file_id: 'FILE-B' }]);
  assert.deepEqual(st.body.beforePhotos, []);
  assert.ok(st.size < 2000, '開始は文字だけ（' + st.size + ' 文字）');
  const all = await Outbox.all();
  assert.ok(all.every((r) => r.status === 'sent'));
  assert.ok(all.filter((r) => r.kind === 'job_photo').every((r) => !r.payload.photoBase64), '送り終えた写真は端末から消して軽くする');
});

test('写真が送っている途中の間、開始は待つ（順番を守る）', async () => {
  let photoOk = false;
  const { Outbox, posts } = loadOutbox((body) => { if (body.action === 'job_photo' && !photoOk) throw new Error('offline'); return okServer(body); });
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  await Outbox.enqueue('job_start', startRec(), { deps: [{ slot: 'F', cid: 'p-F' }] });
  await flushAll(Outbox, 2);
  assert.ok(!kinds(posts).includes('job_start'), '写真が届くまで開始は送らない');
  photoOk = true;
  await Outbox.retryAll(); await flushAll(Outbox);
  assert.deepEqual(kinds(posts).slice(-2), ['job_photo:F', 'job_start']);
});

test('文字だけの知らせは、先に入れた写真より前に送る', async () => {
  const { Outbox, posts } = loadOutbox(okServer);
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  await Outbox.enqueue('job_photo', photoRec('p-B', 'B'));
  await Outbox.enqueue('job_start_notice', startRec({ client_id: 'n-1' }));
  await Outbox.enqueue('job_start', startRec(), { deps: [{ slot: 'F', cid: 'p-F' }, { slot: 'B', cid: 'p-B' }] });
  posts.length = 0;   // enqueue 直後の自動送信は止めてあるので、ここからの順番を見る
  await flushAll(Outbox);
  assert.equal(kinds(posts)[0], 'job_start_notice');
  assert.equal(kinds(posts)[kinds(posts).length - 1], 'job_start');
});

test('写真が「要確認」になっても開始は止めない（その写真は file_id なしで送る）', async () => {
  const { Outbox, posts } = loadOutbox((body) => {
    if (body.action === 'job_photo' && body.slot === 'B') return { status: 'error', error: 'PHOTO_TOO_LARGE', retryable: false, client_id: body.client_id };
    return okServer(body);
  });
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  await Outbox.enqueue('job_photo', photoRec('p-B', 'B'));
  await Outbox.enqueue('job_start', startRec(), { deps: [{ slot: 'F', cid: 'p-F' }, { slot: 'B', cid: 'p-B' }] });
  await flushAll(Outbox);
  const st = posts.filter((p) => p.kind === 'job_start')[0];
  assert.ok(st, '開始は送られる');
  assert.deepEqual(st.body.photo_refs, [{ slot: 'F', file_id: 'FILE-F' }, { slot: 'B', file_id: '' }]);
  const all = await Outbox.all();
  assert.equal(all.filter((r) => r.client_id === 'p-B')[0].status, 'review');
  assert.equal(all.filter((r) => r.client_id === JOB)[0].status, 'sent');
});

test('終了は開始のあと・作業後の写真のあと。作業後の写真の file_id だけを付ける', async () => {
  const { Outbox, posts } = loadOutbox(okServer);
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  await Outbox.enqueue('job_start', startRec(), { deps: [{ slot: 'F', cid: 'p-F' }] });
  await Outbox.enqueue('job_photo', photoRec('a-F', 'F', 'after'));
  await Outbox.enqueue('job_end', { client_id: 'end-1', job_client_id: JOB, afterPhotos: [], v2: {} }, { deps: [{ slot: 'F', cid: 'a-F' }] });
  await flushAll(Outbox, 6);
  const order = posts.map((p) => p.kind + (p.body.phase ? ':' + p.body.phase : ''));
  assert.deepEqual(order, ['job_photo:before', 'job_photo:after', 'job_start', 'job_end']);
  assert.deepEqual(posts[3].body.photo_refs, [{ slot: 'F', file_id: 'FILE-F' }]);
  assert.ok(posts.every((p) => !p.body.late), '順番どおりに届いた写真に late は付かない');
});

test('開始を配り終えた後に送り直した写真には late を付ける（サーバーが作業記録に足して知らせる）', async () => {
  let reject = true;
  const { Outbox, posts } = loadOutbox((body) => {
    if (body.action === 'job_photo' && reject) return { status: 'error', error: 'PHOTO_SAVE_FAILED', retryable: false, client_id: body.client_id };
    return okServer(body);
  });
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  await Outbox.enqueue('job_start', startRec(), { deps: [{ slot: 'F', cid: 'p-F' }] });
  await flushAll(Outbox);
  assert.equal((await Outbox.all()).filter((r) => r.client_id === JOB)[0].status, 'sent');
  reject = false;
  await Outbox.retryAll(); await flushAll(Outbox);
  const last = posts[posts.length - 1];
  assert.equal(last.kind, 'job_photo');
  assert.equal(last.body.late, 1);
});

test('小さい送信は keepalive・写真は keepalive にしない。keepalive で通信に失敗したら次はふつうの送信', async () => {
  let fail = true;
  const { Outbox, posts } = loadOutbox((body) => { if (body.action === 'job_start' && fail) { fail = false; throw new Error('network'); } return okServer(body); });
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  await Outbox.enqueue('job_start', startRec(), { deps: [{ slot: 'F', cid: 'p-F' }] });
  await flushAll(Outbox, 2);
  await Outbox.retryAll(); await flushAll(Outbox);
  assert.equal(posts.filter((p) => p.kind === 'job_photo')[0].keepalive, false);
  const starts = posts.filter((p) => p.kind === 'job_start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].keepalive, true);
  assert.equal(starts[1].keepalive, false);
});

test('取り消し（開始の前）: まだ送っていない写真を捨てる。サーバーには何も作っていないので取り消しは送らない', async () => {
  const { Outbox, posts } = loadOutbox(() => { throw new Error('offline'); });
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  await Outbox.enqueue('job_photo', photoRec('p-B', 'B'));
  const r = await Outbox.cancelJob(JOB, { client_id: 'cancel-1', job_client_id: JOB }, { started: false });
  assert.equal(r.queued, false);
  assert.equal((await Outbox.all()).length, 0);
  assert.ok(!kinds(posts).includes('job_cancel'));
});

test('取り消し（知らせを送ろうとした後）: 取り消しをサーバーへ送り、残りの写真・開始は捨てる', async () => {
  let online = false;
  const { Outbox, posts } = loadOutbox((body) => { if (!online) throw new Error('offline'); return okServer(body); });
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  await Outbox.enqueue('job_start_notice', startRec({ client_id: 'n-1' }));
  await Outbox.enqueue('job_start', startRec(), { deps: [{ slot: 'F', cid: 'p-F' }] });
  await flushAll(Outbox, 2);   // 知らせは送ろうとして失敗（届いたかどうか端末では決めきれない）
  online = true; posts.length = 0;
  const r = await Outbox.cancelJob(JOB, { client_id: 'cancel-1', job_client_id: JOB }, { started: true });
  assert.equal(r.queued, true);
  await flushAll(Outbox);
  assert.deepEqual(kinds(posts), ['job_cancel']);
  const left = await Outbox.all();
  assert.deepEqual(left.map((x) => x.kind), ['job_cancel']);
});

test('古い形（写真を開始の本文に入れる）もそのまま送れる', async () => {
  const { Outbox, posts } = loadOutbox(okServer);
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_start', startRec({ beforePhotos: ['data:image/jpeg;base64,' + 'A'.repeat(80000)] }));
  await flushAll(Outbox);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.photo_refs, undefined);
  assert.equal(posts[0].keepalive, false, '大きい送信は keepalive にしない');
});

test('文字だけの知らせ（now）は、写真を送っている途中でも並行してすぐ出す。届かなければ箱に残って再送に乗る', async () => {
  let release, noticeOk = false;
  const hang = new Promise((r) => { release = r; });
  const { Outbox, posts } = loadOutbox((body) => {
    if (body.action === 'job_photo') return hang.then(() => okServer(body));
    if (body.action === 'job_start_notice' && !noticeOk) throw new Error('network');
    return okServer(body);
  });
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  const flushing = Outbox.flush();            // 写真を送っている途中（応答待ち）
  await settle();
  await Outbox.enqueue('job_start_notice', startRec({ client_id: 'n-1' }), { now: true });
  await settle();
  assert.deepEqual(kinds(posts), ['job_photo:F', 'job_start_notice'], '写真の応答を待たずに知らせを出す');
  assert.equal(posts[1].keepalive, true);
  assert.equal((await Outbox.all()).filter((r) => r.client_id === 'n-1')[0].status, 'local', '届かなかった知らせは箱に残る');
  noticeOk = true; release(); await flushing;
  await flushAll(Outbox);
  assert.equal(kinds(posts).filter((k) => k === 'job_start_notice').length, 2);
  assert.ok((await Outbox.all()).every((r) => r.status === 'sent'));
});

test('[H1] 写真が3回送れなければ、開始はその写真を待たずに送る（売上・請求を写真で止めない）', async () => {
  const { Outbox, posts } = loadOutbox((body) => { if (body.action === 'job_photo' && body.slot === 'B') throw new Error('timeout'); return okServer(body); });
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  await Outbox.enqueue('job_photo', photoRec('p-B', 'B'));
  await Outbox.enqueue('job_start', startRec(), { deps: [{ slot: 'F', cid: 'p-F' }, { slot: 'B', cid: 'p-B' }] });
  await flushAll(Outbox, 1);
  assert.ok(!kinds(posts).includes('job_start'), '1回失敗しただけでは、まだ待つ');
  for (let i = 0; i < 4; i++) { await Outbox.retryAll(); await flushAll(Outbox, 2); }
  const st = posts.filter((p) => p.kind === 'job_start');
  assert.equal(st.length, 1, '開始は1回だけ送る');
  assert.deepEqual(st[0].body.photo_refs, [{ slot: 'F', file_id: 'FILE-F' }, { slot: 'B', file_id: '' }]);
  assert.equal((await Outbox.all()).filter((r) => r.client_id === 'p-B')[0].status, 'local', '送れなかった写真は箱に残り、あとで送る');
});

test('[H1] 待つのをやめた写真も、電波が戻った時は開始より先にもう一度試す（写真つきで届く）', async () => {
  let online = false;
  const { Outbox, posts } = loadOutbox((body) => { if (!online) throw new Error('offline'); return okServer(body); });
  await Outbox.start({ url: 'u', appVersion: 'v' });
  await Outbox.enqueue('job_photo', photoRec('p-F', 'F'));
  await Outbox.enqueue('job_start', startRec(), { deps: [{ slot: 'F', cid: 'p-F' }] });
  for (let i = 0; i < 5; i++) { await Outbox.retryAll(); await flushAll(Outbox, 2); }   // 圏外のまま何度も失敗（写真は wait_off・開始も送れない）
  assert.equal((await Outbox.all()).filter((r) => r.client_id === 'p-F')[0].wait_off, true);
  assert.ok((await Outbox.all()).every((r) => r.status === 'local'), '圏外の間は何も送信済みにならない');
  online = true; posts.length = 0;
  await Outbox.kick(); await flushAll(Outbox);   // 電波が戻った合図（kick）: 再送待ちの時間を待たず、開始の前に写真を先に試す
  assert.deepEqual(kinds(posts), ['job_photo:F', 'job_start']);
  assert.deepEqual(posts[1].body.photo_refs, [{ slot: 'F', file_id: 'FILE-F' }]);
});

test('[M1] 端末に保存できない時の直接送信: 写真の file_id が分からない開始は送らない（写真なしで送信済みにしない）', async () => {
  const { Outbox, posts } = loadOutbox(okServer);
  await Outbox.start({ url: 'u', appVersion: 'v' });
  const ctxWin = posts;   // 保存を失敗させる: IndexedDB の transaction を投げるようにする
  const src = fs.readFileSync(path.join(__dirname, '..', 'field', 'outbox.js'), 'utf8');
  assert.match(src, /if \(\(rec\.deps \|\| \[\]\)\.some\(function \(d\) \{ return !fileMem\[d\.cid\]; \}\)\) return false;/);
  assert.ok(ctxWin);
});

test('[H2][M2] 画面側: 開始・終了を箱に入れる時に、先送りが使えるか・写真の記録が箱にあるかを確かめ直す', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'field', 'index.html'), 'utf8');
  assert.match(html, /pre = !!c\.pre && preOn\(\), inBox = \{\}/);
  assert.match(html, /if \(pre && pcid && inBox\[pcid\]\) o\.deps\.push/);
  assert.match(html, /function queueStart\(c\) \{ return boxList\(\)\.then/);
  assert.match(html, /function queueEnd\(c\) \{ return boxList\(\)\.then/);
});
