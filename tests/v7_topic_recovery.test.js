/**
 * v7: 管理グループで顧客トピックが削除された時の自動復旧（2026-10-29 ForumTopicManager.gs / CustomerChat.gs / PaymentManager.gs）の確認
 *
 * 実行: node --test "tests/*.test.js"
 *
 * .gs を Node の vm に読み込み、シート・Telegram・ロックはスタブで置き換える（本番には触れない）。
 *   - お客様のメッセージ転送: 消えたトピックに送れなかったら、トピックを作り直して挨拶文と本文を送り直す。
 *     作り直せない・閉じたトピックなどで届かない時は、誰からかを添えて General へ送る（黙って落とさない）
 *   - 管理通知（決済など）: トピックを持たないお客様はグループ直下。消えていたら作り直す。作り直しても届かなければグループ直下
 *   - 消えた番号の確認と作り直しは同じロックの中（ロック待ちの間に別の実行が作り直していたら、その番号を使う）
 *   - 決済QRの管理通知は sendPaymentQR のロックを外してから送る（ロックを入れ子にしない）
 * ※ このファイルは v7/ の外に置く（v7/ の .js は clasp push で本番に送られるため）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ADMIN = -100123;
const STALE = 'Bad Request: message thread not found';
// vm の中で作ったオブジェクトは prototype が別なので、比べる前に普通のオブジェクトにする
const plain = (o) => JSON.parse(JSON.stringify(o));

/**
 * @param {Array<Object>} customers - 顧客シートの行（data）
 * @param {Object} [opts]
 *   - failFor(method, payload, rows): 送信を失敗させる時は Telegram の応答を返す
 *   - onLock(rows): ロックを取った時に呼ぶ（ロック待ちの間に別の実行が済ませた変更を再現する）
 *   - createFails: true ならトピックを作れない
 *   - bookings: 予約シートの行（data）
 */
function setup(customers, opts) {
  opts = opts || {};
  const tables = {
    '顧客': customers.map((data, i) => ({ rowIndex: i + 2, data: Object.assign({}, data) })),
    '予約': (opts.bookings || []).map((data, i) => ({ rowIndex: i + 2, data: Object.assign({}, data) }))
  };
  const rows = tables['顧客'];
  const sent = [];
  const created = [];
  const chatLog = [];
  const events = [];   // ロックと送信の順番
  let lockDepth = 0;
  let maxLockDepth = 0;
  let nextThread = 900;
  const ctx = {
    console,
    Logger: { log: () => {} },
    SHEET_NAMES: { CUSTOMERS: '顧客', CHAT_LOG: 'チャット履歴', BOOKINGS: '予約' },
    BOT_TYPE: { BOOKING: 'booking' },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          lockDepth++;
          maxLockDepth = Math.max(maxLockDepth, lockDepth);
          events.push('lock');
          if (opts.onLock) opts.onLock(rows);
          return true;
        },
        releaseLock: () => { lockDepth--; events.push('release'); }
      })
    },
    SpreadsheetApp: { flush: () => {} },
    getConfig: () => ({ adminGroupId: ADMIN }),
    findRow: (sheet, col, value) => (tables[sheet] || []).find((r) => String(r.data[col]) === String(value)) || null,
    updateRow: (sheet, rowIndex, obj) => Object.assign(tables[sheet].find((r) => r.rowIndex === rowIndex).data, obj),
    appendRow: (sheet, obj) => {
      if (sheet === 'チャット履歴') chatLog.push(obj);
      else tables[sheet].push({ rowIndex: tables[sheet].length + 2, data: obj });
    },
    generateDateSeqId: () => 'CUST-TEST',
    createForumTopic: (bot, chatId, name) => {
      if (opts.createFails) return { ok: false, description: 'Bad Request: not enough rights to create a topic' };
      created.push(name);
      return { ok: true, result: { message_thread_id: nextThread++ } };
    },
    callTelegramApi: (bot, method, payload) => {
      const fail = opts.failFor && opts.failFor(method, payload, rows);
      const rec = Object.assign({ method, ok: !fail }, payload);
      sent.push(rec);
      events.push(rec);
      return fail || { ok: true };
    }
  };
  ctx.sendMessage = (bot, chatId, text, o) => ctx.callTelegramApi(bot, 'sendMessage', Object.assign({ chat_id: chatId, text }, o || {}));
  ctx.sendPhoto = (bot, chatId, photo, o) => ctx.callTelegramApi(bot, 'sendPhoto', Object.assign({ chat_id: chatId, photo }, o || {}));
  vm.createContext(ctx);
  ['ForumTopicManager.gs', 'CustomerChat.gs', 'PaymentManager.gs'].forEach((f) =>
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'v7', f), 'utf8'), ctx, { filename: f }));
  // PaymentManager.gs の中で定義されている QR まわりは、読み込んだあとで差し替える
  ctx.getActiveQR = () => ({ imageUrl: 'https://example.invalid/qr.png', bank: 'ABA' });
  ctx.sendQRImage = () => ({ ok: true });
  return { ctx, tables, rows, sent, created, chatLog, events, maxLockDepth: () => maxLockDepth };
}

// 消えたトピック（番号 111）への送信だけ失敗させる
const deletedTopic111 = (method, payload) =>
  (payload.message_thread_id === 111 ? { ok: false, description: STALE } : null);

const TEST_CUSTOMER = { 'チャットID': '555', '氏名': 'Test User', 'ユーザー名': 'tester', 'トピックID': 111 };
const MSG = { chat: { id: 555, type: 'private' }, from: { first_name: 'Test', last_name: 'User', username: 'tester' }, text: 'hello' };
const okSends = (t, text) => t.sent.filter((s) => s.ok && s.text === text);

test('お客様のメッセージ: トピックが消えていたら作り直して、挨拶文と本文を新しいトピックへ送る', () => {
  const t = setup([TEST_CUSTOMER], { failFor: deletedTopic111 });
  t.ctx.forwardCustomerMessage(MSG);

  assert.equal(t.created.length, 1);
  assert.equal(t.rows[0].data['トピックID'], 900);
  const toNew = t.sent.filter((s) => s.message_thread_id === 900);
  assert.equal(toNew.length, 2);
  assert.match(toNew[0].text, /^♻️ トピックを作り直しました/);
  assert.match(toNew[0].text, /「チャット履歴」タブ/);
  assert.equal(toNew[1].text, 'hello');
  assert.equal(t.sent.filter((s) => s.message_thread_id === undefined).length, 0);   // General には出さない
  assert.equal(t.chatLog.length, 1);
  assert.equal(t.chatLog[0]['トピックID'], 900);
  assert.equal(t.chatLog[0]['内容'], 'hello');
});

test('お客様のメッセージ: トピックがあればそのまま転送（作り直さない・挨拶文なし）', () => {
  const t = setup([TEST_CUSTOMER]);
  t.ctx.forwardCustomerMessage(MSG);

  assert.equal(t.created.length, 0);
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].message_thread_id, 111);
  assert.equal(t.sent[0].text, 'hello');
});

test('お客様のメッセージ: はじめてのお客様は今までどおり「新規顧客」の挨拶文', () => {
  const t = setup([]);
  t.ctx.forwardCustomerMessage(MSG);

  assert.equal(t.created.length, 1);
  assert.match(t.sent[0].text, /^🆕 新規顧客からの最初の連絡/);
  assert.equal(t.sent[1].text, 'hello');
});

test('お客様の写真: トピックが消えていたら作り直して写真を送り直す', () => {
  const t = setup([TEST_CUSTOMER], { failFor: deletedTopic111 });
  t.ctx.forwardCustomerMessage({ chat: MSG.chat, from: MSG.from, photo: [{ file_id: 'small' }, { file_id: 'big' }], caption: 'car' });

  const photos = t.sent.filter((s) => s.method === 'sendPhoto');
  assert.deepEqual(photos.map((p) => p.message_thread_id), [111, 900]);
  assert.equal(photos[1].photo, 'big');
});

test('お客様の音声・位置情報なども、作り直したトピックへ送り直す（種別ごとの応答を見ている）', () => {
  const kinds = [
    { voice: { file_id: 'v', duration: 3 }, method: 'sendVoice' },
    { video: { file_id: 'vd' }, method: 'sendVideo' },
    { document: { file_id: 'd', file_name: 'a.pdf' }, method: 'sendDocument' },
    { video_note: { file_id: 'vn' }, method: 'sendVideoNote' },
    { location: { latitude: 11.5, longitude: 104.9 }, method: 'sendLocation' },
    { sticker: { file_id: 's', emoji: '👍' }, method: 'sendSticker' }
  ];
  kinds.forEach((k) => {
    const t = setup([TEST_CUSTOMER], { failFor: deletedTopic111 });
    const msg = Object.assign({ chat: MSG.chat, from: MSG.from }, k);
    delete msg.method;
    t.ctx.forwardCustomerMessage(msg);
    assert.deepEqual(t.sent.filter((s) => s.method === k.method).map((s) => s.message_thread_id), [111, 900], k.method);
  });
});

test('お客様のメッセージ: トピックを作り直せない時は General へ「誰から」を添えて送り、キューは止めない', () => {
  const t = setup([TEST_CUSTOMER], { failFor: deletedTopic111, createFails: true });
  assert.doesNotThrow(() => t.ctx.forwardCustomerMessage(MSG));

  const general = t.sent.filter((s) => s.message_thread_id === undefined);
  assert.equal(general.length, 2);
  assert.match(general[0].text, /^⚠️ お客様のメッセージをトピックに転送できませんでした/);
  assert.match(general[0].text, /Chat ID: 555/);
  assert.equal(general[1].text, 'hello');
  assert.equal(t.rows[0].data['トピックID'], 111);   // 作れなかったので番号はそのまま（次の連絡でまた作り直しを試す）
  assert.match(t.chatLog[0]['内容'], /^\(トピックへの転送失敗・General へ\) hello$/);
});

test('お客様のメッセージ: 閉じたトピックなど、消えた以外の理由で届かない時も General へ送る（作り直さない）', () => {
  const t = setup([TEST_CUSTOMER], { failFor: (m, p) => (p.message_thread_id === 111 ? { ok: false, description: 'Bad Request: TOPIC_CLOSED' } : null) });
  t.ctx.forwardCustomerMessage(MSG);

  assert.equal(t.created.length, 0);
  assert.equal(okSends(t, 'hello').length, 1);
  assert.equal(okSends(t, 'hello')[0].message_thread_id, undefined);
});

test('管理通知: トピックが消えていたら作り直し、案内文のあとに通知を1回だけ届ける', () => {
  const t = setup([TEST_CUSTOMER], { failFor: deletedTopic111 });
  const r = t.ctx.sendAdminNoticeToCustomerTopic_('555', (o) => t.ctx.sendMessage('booking', ADMIN, '💰 QR 送信完了', o));

  assert.deepEqual(plain(r), { ok: true, threadId: 900 });
  assert.equal(okSends(t, '💰 QR 送信完了').length, 1);
  assert.equal(okSends(t, '💰 QR 送信完了')[0].message_thread_id, 900);
  const toNew = t.sent.filter((s) => s.message_thread_id === 900);
  assert.match(toNew[0].text, /^♻️ トピックを作り直しました/);
});

test('管理通知: トピックを持たないお客様はグループ直下へ（トピックも顧客行も作らない）', () => {
  const t = setup([{ 'チャットID': '777', '氏名': 'No Topic', 'トピックID': '' }]);
  const r = t.ctx.sendAdminNoticeToCustomerTopic_('777', (o) => t.ctx.sendMessage('booking', ADMIN, 'x', o));
  const r2 = t.ctx.sendAdminNoticeToCustomerTopic_('', (o) => t.ctx.sendMessage('booking', ADMIN, 'y', o));

  assert.deepEqual(plain(r), { ok: true, threadId: null });
  assert.deepEqual(plain(r2), { ok: true, threadId: null });
  assert.equal(t.created.length, 0);
  assert.equal(t.rows.length, 1);
  assert.ok(t.sent.every((s) => s.message_thread_id === undefined));
});

test('管理通知: トピック以外の理由で失敗したら作り直さずグループ直下へ', () => {
  const t = setup([TEST_CUSTOMER], { failFor: (method, payload) =>
    (payload.message_thread_id ? { ok: false, description: 'Bad Request: not enough rights' } : null) });
  const r = t.ctx.sendAdminNoticeToCustomerTopic_('555', (o) => t.ctx.sendMessage('booking', ADMIN, 'x', o));

  assert.deepEqual(plain(r), { ok: true, threadId: null });
  assert.equal(t.created.length, 0);
  assert.equal(t.rows[0].data['トピックID'], 111);
});

test('管理通知: 作り直せない時はグループ直下へ届ける', () => {
  const t = setup([TEST_CUSTOMER], { failFor: deletedTopic111, createFails: true });
  const r = t.ctx.sendAdminNoticeToCustomerTopic_('555', (o) => t.ctx.sendMessage('booking', ADMIN, 'x', o));

  assert.deepEqual(plain(r), { ok: true, threadId: null });
  assert.equal(okSends(t, 'x').length, 1);
  assert.equal(okSends(t, 'x')[0].message_thread_id, undefined);
});

test('ロック待ちの間に別の実行が作り直していたら、その番号を使う（トピックを二重に作らない）', () => {
  // 111 が消えていると気づいてロックを待つ間に、別の実行がすでに 333 へ作り直していた
  const t = setup([TEST_CUSTOMER], {
    failFor: deletedTopic111,
    onLock: (rows) => { if (rows[0].data['トピックID'] === 111) rows[0].data['トピックID'] = 333; }
  });
  const r = t.ctx.sendAdminNoticeToCustomerTopic_('555', (o) => t.ctx.sendMessage('booking', ADMIN, 'x', o));

  assert.deepEqual(plain(r), { ok: true, threadId: 333 });
  assert.equal(t.created.length, 0);
  assert.equal(t.rows[0].data['トピックID'], 333);
  assert.ok(!t.sent.some((s) => /^♻️/.test(s.text || '')));   // 作り直したのは別の実行なので案内文も出さない
});

test('予約通知（sendToCustomerTopicWithRecovery）は今までどおり作り直して届ける', () => {
  const t = setup([TEST_CUSTOMER], { failFor: deletedTopic111 });
  const r = t.ctx.sendToCustomerTopicWithRecovery({ chatId: '555', firstName: 'Test User' }, '🆕 新規予約');

  assert.deepEqual(plain(r), { ok: true, threadId: 900, recreated: true });
  assert.equal(okSends(t, '🆕 新規予約').length, 1);
  assert.equal(okSends(t, '🆕 新規予約')[0].message_thread_id, 900);
});

test('決済QR: 管理通知は sendPaymentQR のロックを外してから送る（トピックの作り直しでロックを入れ子にしない）', () => {
  const t = setup([TEST_CUSTOMER], {
    failFor: deletedTopic111,
    bookings: [{ '予約ID': 'BK-1', 'チャットID': '555', '請求額(USD)': 15, 'QR送信日時': '', '決済状態': '未清算' }]
  });
  const res = t.ctx.sendPaymentQR('BK-1');

  assert.equal(plain(res).ok, true);
  assert.equal(t.maxLockDepth(), 1);
  const firstRelease = t.events.indexOf('release');
  const noticeAt = t.events.findIndex((e) => e.ok && /^💰 QR 送信完了/.test(e.text || ''));
  assert.ok(firstRelease >= 0 && noticeAt > firstRelease);
  assert.equal(t.events[noticeAt].message_thread_id, 900);
  assert.equal(t.tables['予約'][0].data['決済状態'], 'QR送信済み');
});

test('決済QR: 失敗の緊急通知もロックを外してから送る', () => {
  const t = setup([TEST_CUSTOMER]);
  const res = t.ctx.sendPaymentQR('BK-NONE');

  assert.equal(plain(res).reason, 'BOOKING_NOT_FOUND');
  const firstRelease = t.events.indexOf('release');
  const alertAt = t.events.findIndex((e) => /^🚨 QR送信失敗/.test(e.text || ''));
  assert.ok(firstRelease >= 0 && alertAt > firstRelease);
});
