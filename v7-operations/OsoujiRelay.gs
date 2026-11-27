/**
 * OsoujiRelay.gs — 「おそうじ」アプリの写真を管理グループへ届ける（2026-11-21）
 *
 * Daisuke「おそうじアプリにしたがって写真をとれば、その写真がテレグラムに届くようにしてほしい」
 *
 * 【流れ】
 *   おそうじアプリ（samurai-osouji・ログインなしの公開ページ）が、写真を撮るたびに action=osouji_photo で送る
 *   → 認めたスマホの分だけ、管理グループの「おそうじ」トピックへ写真を送り、「おそうじ記録」タブに1行残す
 *   → 全部の場所が終わったら、まとめを1通（通知あり。写真は通知なし）
 *
 * 【知らない人に送らせない】
 *   アプリにログインが無いので、スマホごとの番号（アプリが最初に作る乱数）で見分ける。
 *   - シートに残すのは番号そのものではなく、番号から作った照合用の文字（SHA-256 の頭 32 文字）だけ。
 *     シートを見られる人が、その番号を名乗って送ることはできない
 *   - はじめてのスマホは「おそうじ端末」タブに行を作って止め、管理グループへ1回だけ知らせる。
 *     知らせとアプリの画面には同じ「確認コード」（6文字）が出る → 画面と見比べてから、その行の「名前」に名前を書く
 *   - 名前を書いたスマホだけが送れる。止める時は名前を消す（行ごと消すと、次の写真でまた新しい行と知らせができる）
 *   - 名前が空のまま 7 日たった行は自動で消す。空の行は 20 まで
 *
 * 【ほかの機能を巻き込まない】
 *   認めていないスマホからの送信は、全体のロック（出勤の打刻・経費と共用）を取らずに返す。
 *   認めたスマホの一覧はキャッシュ（2分）。名前を書いてから届き始めるまで、長くて2分ほど
 *
 * 【設定】
 *   トピック: Script Property「OSOUJI_THREAD_ID」。無ければ日報トピックへ送る
 */

const OSOUJI_REC_SHEET_ = 'おそうじ記録';
const OSOUJI_REC_HEADERS_ = ['受信日時', '日付', '端末', '名前', 'スタッフID', '場所', '種類', '時刻', '分', 'できた数', '全部の数', '写真ID', '記録ID'];
const OSOUJI_DEV_SHEET_ = 'おそうじ端末';
const OSOUJI_DEV_HEADERS_ = ['端末（照合用）', '名前', 'スタッフID', 'はじめて届いた日時', '最後に届いた日時', '確認コード', 'メモ'];
const OSOUJI_THREAD_PROP_ = 'OSOUJI_THREAD_ID';
const OSOUJI_MAX_BYTES_ = 600 * 1024;     // 写真1枚の上限（アプリは長辺640pxに縮めて送る＝ふつう 100KB 以下）
const OSOUJI_MAX_PER_DAY_ = 80;           // 1台が1日に送れる枚数（11か所×前後＋撮り直し）
const OSOUJI_MAX_PENDING_ = 20;           // 名前が空（未承認）の行の上限。超えたら新しい行も知らせも作らない
const OSOUJI_PENDING_DAYS_ = 7;           // 名前が空のまま、この日数たった行は消す
const OSOUJI_RECENT_ROWS_ = 600;          // 送り直しの判定と1日の枚数は、記録の下からこの行数だけ見る
const OSOUJI_ALLOW_TTL_ = 120;            // 認めたスマホの一覧のキャッシュ（秒）

function osoujiSheet_(name, headers) {
  const ss = getOpsSs_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = createHeaderedSheet_(ss, name, headers);
    // 日付・時刻・番号を勝手に変換させない（日付が1日ずれる・時刻が1分ずれるのを防ぐ）
    sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
  }
  return sheet;
}

/** スマホの番号 → 照合用の文字（シートとキャッシュにはこれだけを置く） */
function osoujiDeviceHash_(device) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'osouji-device-v1:' + device, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').substring(0, 32);
}
function osoujiCode_(hash) { return hash.substring(0, 6).toUpperCase(); }

/** 送り先（管理グループ＋トピック） */
function osoujiSendTarget_() {
  const cfg = getConfig();
  const thread = PropertiesService.getScriptProperties().getProperty(OSOUJI_THREAD_PROP_) || cfg.adminDailyReportThreadId;
  return { chatId: cfg.adminGroupId, threadId: thread ? Number(thread) : 0 };
}

/** 写真をファイルとして送る（既存の sendPhoto は URL / file_id 用なので、ここだけ multipart） */
function osoujiSendPhotoBlob_(blob, caption, silent) {
  const token = getBotToken(BOT_TYPE.INTERNAL);
  const tg = osoujiSendTarget_();
  if (!token || !tg.chatId) return { ok: false, error: 'NO_TARGET' };
  const payload = { chat_id: String(tg.chatId), caption: caption, photo: blob };
  if (tg.threadId) payload.message_thread_id = String(tg.threadId);
  if (silent) payload.disable_notification = 'true';
  try {
    const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendPhoto', { method: 'post', payload: payload, muteHttpExceptions: true });
    const data = JSON.parse(res.getContentText());
    if (!data.ok) Logger.log('⚠️ おそうじ: sendPhoto 失敗 code=' + res.getResponseCode() + ' ' + String(data.description || ''));
    return data;
  } catch (err) {
    Logger.log('❌ おそうじ: sendPhoto 例外 ' + String(err).replace(/bot[^/]+\//g, 'bot***/').substring(0, 200));
    return { ok: false, error: 'TG_FAIL' };
  }
}

function osoujiSendText_(text, silent) {
  const tg = osoujiSendTarget_();
  const opts = { disable_web_page_preview: true };
  if (tg.threadId) opts.message_thread_id = tg.threadId;
  if (silent) opts.disable_notification = true;
  return sendMessage(BOT_TYPE.INTERNAL, tg.chatId, text, opts);
}

/** アプリから届く文字を、決めた形だけ通す */
function osoujiClean_(body) {
  const device = String(body.device || '');
  const date = String(body.date || '');
  const room = String(body.room || '').trim();
  const w = String(body.w || '');
  const t = Number(body.t || 0);
  const dayMs = 24 * 3600 * 1000;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(device)) return { error: 'INVALID_DEVICE' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'INVALID_DATE' };
  if (!room || room.length > 20 || /[<>=\n\r]/.test(room)) return { error: 'INVALID_ROOM' };
  if (w !== 'a' && w !== 'b') return { error: 'INVALID_KIND' };
  if (!isFinite(t) || Math.abs(Date.now() - t) > 3 * dayMs) return { error: 'INVALID_TIME' };
  // 日付は今日の前後2日まで（古い・先の日付を名乗る送信は受けない）
  const sent = new Date(date + 'T12:00:00+07:00').getTime();
  if (!(Math.abs(Date.now() - sent) <= 2.5 * dayMs)) return { error: 'INVALID_DATE' };
  const total = Math.max(0, Math.min(99, Math.floor(Number(body.total) || 0)));
  const done = Math.max(0, Math.min(total, Math.floor(Number(body.done) || 0)));
  const lap = Math.max(0, Math.min(600, Math.floor(Number(body.lap) || 0)));
  const span = Math.max(0, Math.min(1440, Math.floor(Number(body.span) || 0)));
  const hash = osoujiDeviceHash_(device);
  return { hash: hash, date: date, room: room, w: w, t: t, total: total, done: done, lap: lap, span: span,
           recId: hash.substring(0, 8) + '_' + date + '_' + room + '_' + w + '_' + Math.floor(t) };
}

/** 認めたスマホの一覧 { 照合用の文字: { name, staffId } }。ロックは取らない（読むだけ） */
function osoujiAllowed_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('osj_allow');
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* 読み直す */ } }
  const map = {};
  const sheet = getOpsSs_().getSheetByName(OSOUJI_DEV_SHEET_);
  if (sheet) {
    const vals = sheet.getDataRange().getValues();
    for (let r = 1; r < vals.length; r++) {
      const h = String(vals[r][0]).trim(), name = String(vals[r][1]).trim();
      if (h && name) map[h] = { name: name, staffId: String(vals[r][2]).trim() };
    }
  }
  cache.put('osj_allow', JSON.stringify(map), OSOUJI_ALLOW_TTL_);
  return map;
}

/**
 * はじめてのスマホ: 行を作って知らせる（ここだけ短いロック）。もう知らせてある・枠がいっぱいの時は何もしない
 */
function osoujiRegisterPending_(hash) {
  const cache = CacheService.getScriptCache();
  const code = osoujiCode_(hash);
  const pending = { ok: false, error: 'DEVICE_PENDING', code: code };
  if (cache.get('osj_p_' + hash) || cache.get('osj_full')) return pending;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return pending;
  try {
    const sheet = osoujiSheet_(OSOUJI_DEV_SHEET_, OSOUJI_DEV_HEADERS_);
    const vals = sheet.getDataRange().getValues();
    const limit = Date.now() - OSOUJI_PENDING_DAYS_ * 24 * 3600 * 1000;
    let count = 0, found = false;
    for (let r = vals.length - 1; r >= 1; r--) {
      const h = String(vals[r][0]).trim(), name = String(vals[r][1]).trim();
      if (!h || name) { if (h === hash) found = true; continue; }
      const first = new Date(String(vals[r][3]).replace(' ', 'T') + '+07:00').getTime();
      if (h !== hash && first && first < limit) { sheet.deleteRow(r + 1); continue; }   // 古い空の行を片付ける
      if (h === hash) found = true;
      count++;
    }
    if (!found) {
      if (count >= OSOUJI_MAX_PENDING_) {
        cache.put('osj_full', '1', 300);
        if (!cache.get('osj_fullwarn')) {
          cache.put('osj_fullwarn', '1', 21600);
          osoujiSendText_('⚠️ おそうじアプリ：名前の入っていないスマホの行が ' + OSOUJI_MAX_PENDING_ + ' になりました。' +
            'これ以上は受け付けません。シート「' + OSOUJI_DEV_SHEET_ + '」で、知らない行を消してください。', false);
        }
        return pending;
      }
      // 先に知らせる（知らせに失敗したら行を作らない＝次の写真でもう一度）
      const res = osoujiSendText_('🧹 おそうじアプリ：はじめてのスマホから写真が届きました（まだ止めています）。\n' +
        '確認コード: ' + code + '（アプリの画面の左下にも同じ文字が出ます）\n' +
        'シート「' + OSOUJI_DEV_SHEET_ + '」で、確認コードが同じ行の「名前」に名前を書くと、2分ほどで写真が届き始めます。', false);
      if (!res || !res.ok) return pending;
      const nowStr = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd HH:mm:ss');
      sheet.appendRow([hash, '', '', nowStr, nowStr, code, '']);
    }
    cache.put('osj_p_' + hash, '1', 600);
    return pending;
  } finally {
    lock.releaseLock();
  }
}

/**
 * 写真を1枚受け取る
 * @return {{ok:boolean, error?:string, dup?:boolean, code?:string}}
 *   DEVICE_PENDING・TG_FAIL・BUSY・SERVER はアプリが後で送り直す。INVALID_*・RATE_LIMIT は送り直さない
 */
function osoujiPhoto_(body) {
  try {
    const c = osoujiClean_(body || {});
    if (c.error) return { ok: false, error: c.error };
    const img = shopPhotoDecode_(body.img);
    if (!img || img.tooBig || !img.bytes || img.bytes.length > OSOUJI_MAX_BYTES_ || img.bytes.length < 100) return { ok: false, error: 'INVALID_IMAGE' };

    // ① このスマホは認めてあるか（ロックなし）
    const who = osoujiAllowed_()[c.hash];
    if (!who) return osoujiRegisterPending_(c.hash);

    const cache = CacheService.getScriptCache();
    if (cache.get('osj_r_' + c.recId)) return { ok: true, dup: true };

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(15000)) return { ok: false, error: 'BUSY' };
    try {
      // ② 同じ写真の送り直しは1回だけ・1日の枚数の上限（記録の下のほうだけ読む）
      const recSheet = osoujiSheet_(OSOUJI_REC_SHEET_, OSOUJI_REC_HEADERS_);
      const last = recSheet.getLastRow();
      const from = Math.max(2, last - OSOUJI_RECENT_ROWS_ + 1);
      const recVals = last >= 2 ? recSheet.getRange(from, 1, last - from + 1, OSOUJI_REC_HEADERS_.length).getValues() : [];
      let today = 0, finishedBefore = false;
      for (let r = 0; r < recVals.length; r++) {
        if (String(recVals[r][12]) === c.recId) return { ok: true, dup: true };
        if (String(recVals[r][2]) === c.hash && osoujiDateStr_(recVals[r][1]) === c.date) {
          today++;
          if (Number(recVals[r][10]) > 0 && Number(recVals[r][9]) >= Number(recVals[r][10])) finishedBefore = true;
        }
      }
      if (today >= OSOUJI_MAX_PER_DAY_) return { ok: false, error: 'RATE_LIMIT' };

      // ③ 写真を送る
      const hm = Utilities.formatDate(new Date(c.t), OPS_TZ, 'H:mm');
      const kind = c.w === 'a' ? '後' : '前';
      const caption = '🧹 ' + c.room + '（' + kind + '）' + hm +
        (c.w === 'a' && c.lap ? '・' + c.lap + '分' : '') +
        (c.w === 'a' && c.total ? '　' + c.done + '/' + c.total : '') + '\n' + who.name;
      const blob = Utilities.newBlob(img.bytes, img.mime, 'osouji_' + c.date + '_' + c.w + '.jpg');
      const res = osoujiSendPhotoBlob_(blob, caption, true);
      if (!res || !res.ok) return { ok: false, error: 'TG_FAIL' };
      // ここから先は「もう送った」。記録に失敗しても、同じ写真をもう一度グループへ出さない
      cache.put('osj_r_' + c.recId, '1', 21600);
      let fileId = '';
      try { const ph = res.result.photo; fileId = ph[ph.length - 1].file_id; } catch (e) { /* 無くても続ける */ }

      // ④ 記録
      const nowStr = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd HH:mm:ss');
      const row = [nowStr, c.date, c.hash, sheetCellValue_(who.name), sheetCellValue_(who.staffId),
        sheetCellValue_(c.room), kind, hm, c.w === 'a' ? c.lap : '', c.done, c.total, sheetCellValue_(fileId), sheetCellValue_(c.recId)];
      try {
        recSheet.appendRow(row);
      } catch (e1) {
        try { Utilities.sleep(800); recSheet.appendRow(row); } catch (e2) {
          Logger.log('❌ おそうじ: 記録に失敗（写真は送信済み）' + String(e2).substring(0, 200));
          osoujiSendText_('⚠️ おそうじ：写真は届きましたが、シート「' + OSOUJI_REC_SHEET_ + '」に記録できませんでした（' + c.room + '・' + hm + '）', true);
        }
      }

      // ⑤ 全部できたら、まとめを1通（その日1回だけ）
      if (c.w === 'a' && c.total > 0 && c.done >= c.total && !finishedBefore) {
        osoujiSendText_('✅ おそうじ完了：' + who.name + '　' + c.done + '/' + c.total + ' か所' +
          (c.span ? '・' + c.span + '分' : '') + '（' + hm + ' まで）', false);
      }
      return { ok: true };
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    Logger.log('❌ おそうじ: ' + String(err).replace(/bot[^/]+\//g, 'bot***/').substring(0, 200));
    return { ok: false, error: 'SERVER' };
  }
}

function osoujiDateStr_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, OPS_TZ, 'yyyy-MM-dd');
  return String(v || '').trim().substring(0, 10);
}
function osoujiTimeStr_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, OPS_TZ, 'H:mm');
  return String(v || '').trim().substring(0, 5);
}

/**
 * 日報の「そうじ」欄（その日の記録を人ごとに1行・多くても5人まで）。読めない時・タブが無い時は ''
 */
function buildOsoujiSection_(ppToday) {
  try {
    const sheet = getOpsSs_().getSheetByName(OSOUJI_REC_SHEET_);
    if (!sheet) return '';
    const last = sheet.getLastRow();
    const from = Math.max(2, last - OSOUJI_RECENT_ROWS_ + 1);
    const vals = last >= 2 ? sheet.getRange(from, 1, last - from + 1, OSOUJI_REC_HEADERS_.length).getValues() : [];
    const by = {};
    for (let r = 0; r < vals.length; r++) {
      if (osoujiDateStr_(vals[r][1]) !== ppToday) continue;
      const name = (String(vals[r][3]).trim() || '?').substring(0, 30);
      const o = by[name] || (by[name] = { rooms: {}, total: 0, first: '', last: '' });
      const tm = osoujiTimeStr_(vals[r][7]);
      const key = ('0' + tm).slice(-5);
      if (!o.first || key < ('0' + o.first).slice(-5)) o.first = tm;
      if (!o.last || key > ('0' + o.last).slice(-5)) o.last = tm;
      o.total = Math.max(o.total, Number(vals[r][10]) || 0);
      if (String(vals[r][6]) === '後') o.rooms[String(vals[r][5])] = Number(vals[r][8]) || 0;   // 撮り直しは最後の分を使う
    }
    const names = Object.keys(by);
    // 記録が無い日は欄ごと出さない（新人に iPhone を渡すまでは毎日「届いていません」になるため・2026-11-27 Daisuke 指示）
    if (!names.length) return '';
    return names.slice(0, 5).map(function (n) {
      const o = by[n];
      const rooms = Object.keys(o.rooms);
      const min = rooms.reduce(function (s, k) { return s + o.rooms[k]; }, 0);
      return '🧹 <b>そうじ</b>（' + escapeHtml_(n) + '）' + rooms.length + (o.total ? '/' + o.total : '') + ' か所' +
        (min ? '・' + min + '分' : '') + (o.first ? '・' + o.first + '〜' + o.last : '');
    }).join('\n');
  } catch (err) {
    Logger.log('⚠️ 日報: そうじ欄の読取失敗: ' + err);
    return '';
  }
}

/**
 * 初回セットアップ（GAS エディタから1回実行）
 *   - 「おそうじ記録」「おそうじ端末」タブを作る
 *   - 管理グループに「おそうじ」トピックを作り、番号を Script Property に入れる（作れない時は日報トピックのまま）
 */
function osoujiSetup() {
  osoujiSheet_(OSOUJI_REC_SHEET_, OSOUJI_REC_HEADERS_);
  osoujiSheet_(OSOUJI_DEV_SHEET_, OSOUJI_DEV_HEADERS_);
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(OSOUJI_THREAD_PROP_)) { Logger.log('✅ タブ OK・トピックは設定済み'); return; }
  const cfg = getConfig();
  const res = callTelegramApi(BOT_TYPE.INTERNAL, 'createForumTopic', { chat_id: cfg.adminGroupId, name: '🧹 おそうじ' });
  if (res && res.ok && res.result && res.result.message_thread_id) {
    props.setProperty(OSOUJI_THREAD_PROP_, String(res.result.message_thread_id));
    Logger.log('✅ タブ OK・「おそうじ」トピックを作りました');
    osoujiSendText_('🧹 ここに、毎朝のおそうじの写真が届きます。', true);
  } else {
    Logger.log('⚠️ タブ OK・トピックは作れませんでした（Bot にトピックを作る権限がない等）→ 日報トピックへ届きます。' +
      '手でトピックを作った時は、Script Property「' + OSOUJI_THREAD_PROP_ + '」に番号を入れてください');
  }
}

/** 日報の欄の見え方を確かめる（送らない・ログに出すだけ） */
function debugPreviewOsoujiSection() {
  Logger.log(buildOsoujiSection_(Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd')));
}
