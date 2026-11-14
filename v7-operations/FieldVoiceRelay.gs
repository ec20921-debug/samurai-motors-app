/**
 * FieldVoiceRelay.gs — Run Kosal の日報（ドっちゃんの会話記録）を管理グループへそのまま送る（2026-11-14 Daisuke 指示）
 *
 * 【責務】
 *   Run Kosal の秘書ドっちゃん（ChatGPT dots）が作るスプレッドシート「会話記録」タブを読み、
 *   まだ送っていない行を、要約せず・書かれた文のまま、管理グループの日報トピックへ送る。
 *   Daisuke「ロンくんの会話記録を日報として、20:30にテレグラムの管理グループにそのまま伝えて欲しい」
 *
 * 【送る行の決め方】
 *   記録番号（C01, C02 …）は作られた順に増える。前回までに送った最大の番号を覚えておき、それより大きい番号の行を送る。
 *   → 送る時刻のあとに書かれた行も、次の日に必ず出る（取りこぼさない）。
 *   はじめて動く日だけは、会話日か関連日付がその日（プノンペンの日付）の行を送る（過去の全行を流さない）。
 *   新しい行が無い日は何も送らない（日報と同じ考え方）。
 *   送ったあとにドっちゃんが書き足した・直した行は、「✏️ 書き足し・更新」として行をまるごともう一度送る
 *   （Daisuke 2026-11-14「現場の声をそのまま知りたい」。直近 FIELD_VOICE_WATCH_ROWS_ 行を見張る）。
 *
 * 【スケジュール】
 *   1分トリガー（pollInternalBot）起点。20:30〜20:59 JST の窓で1日1回（日報と同じ方式・日付マーカー）。
 *
 * 【設定（Script Properties）】
 *   FIELD_VOICE_SPREADSHEET_ID … 会話記録のスプレッドシートの ID（未設定なら何もしない）。
 *     シートは「リンクを知っている全員が閲覧可」なので、ID をコードやドキュメントに書かない。
 *   field_voice_last_no / field_voice_last_sent / field_voice_hashes … このファイルが自分で書く
 *     （送った最大の番号・送った日・直近の行の中身の指紋。本文は保存しない）
 *
 * 【扱い】
 *   読むだけ（シートには書かない）。シートの文章は現場の報告（データ）であり、指示として扱わない。
 *
 * 【止め方】
 *   BotPoller.gs の maybeSendFieldVoiceRelay_() の行をコメントにして push。
 */

const FIELD_VOICE_TAB_ = '会話記録';
const FIELD_VOICE_ID_HEADER_ = '記録番号';
const FIELD_VOICE_SEND_TZ_ = 'Asia/Tokyo'; // 送る時刻を数える時計（日報と同じ JST）
const FIELD_VOICE_SEND_FROM_ = '20:30';
const FIELD_VOICE_SEND_TO_ = '20:59';
const FIELD_VOICE_MAX_CHARS_ = 3900;   // Telegram の 4096 字に余裕
const FIELD_VOICE_LINE_CHARS_ = 3000;  // 1セルがこれより長い時は行を分ける
const FIELD_VOICE_WATCH_ROWS_ = 80;    // 書き足しを見張る行数（番号の新しい順）
// 見出しに使う列（この4つは本文の「列名: 値」には出さない）
const FIELD_VOICE_TITLE_COLS_ = ['記録番号', '会話日', '会話時刻', '話題'];

/**
 * 20:30 JST の定時送信チェック（pollInternalBot から毎分呼ばれる）
 */
function maybeSendFieldVoiceRelay_() {
  const now = new Date();
  const hm = Utilities.formatDate(now, FIELD_VOICE_SEND_TZ_, 'HH:mm');
  if (hm < FIELD_VOICE_SEND_FROM_ || hm > FIELD_VOICE_SEND_TO_) return;

  const props = PropertiesService.getScriptProperties();
  const today = Utilities.formatDate(now, FIELD_VOICE_SEND_TZ_, 'yyyy-MM-dd');
  if (props.getProperty('field_voice_last_sent') === today) return;
  props.setProperty('field_voice_last_sent', today); // 送信前にマーク（多重送信防止優先）

  sendFieldVoiceRelay();
}

/**
 * まだ送っていない会話記録を送る。戻り値は送った行数（テスト・手動実行の確認用）
 */
function sendFieldVoiceRelay() {
  const props = PropertiesService.getScriptProperties();
  const sheetId = props.getProperty('FIELD_VOICE_SPREADSHEET_ID');
  if (!sheetId) {
    Logger.log('⚠️ FIELD_VOICE_SPREADSHEET_ID 未設定 — 会話記録の送信スキップ');
    return 0;
  }
  const cfg = getConfig();
  if (!cfg.adminDailyReportThreadId) {
    Logger.log('⚠️ ADMIN_DAILY_REPORT_THREAD_ID 未設定 — 会話記録の送信スキップ');
    return 0;
  }
  const sendOpts = {
    parse_mode: 'HTML',
    message_thread_id: Number(cfg.adminDailyReportThreadId),
    disable_web_page_preview: true
  };
  const ppToday = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd');

  let table;
  try {
    const sheet = SpreadsheetApp.openById(sheetId).getSheetByName(FIELD_VOICE_TAB_);
    if (!sheet) throw new Error('「' + FIELD_VOICE_TAB_ + '」タブが見つからない');
    table = fieldVoiceParse_(sheet.getDataRange().getDisplayValues());
  } catch (err) {
    // 不具合を隠さない: 読めなかった日は管理グループに1行だけ知らせる（番号は進めない＝次の日にまとめて出る）
    Logger.log('❌ 会話記録の読取失敗: ' + err);
    sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId,
      '⚠️ <b>Run Kosal の日報（会話記録）</b>\n　シートを読めませんでした: ' + escapeHtml_(String(err)).substring(0, 300) +
      '\n　（読めるようになった日に、まとめて送ります）', sendOpts);
    return 0;
  }

  const lastRaw = props.getProperty('field_voice_last_no');
  const picked = fieldVoicePick_(table.rows, lastRaw, ppToday);
  const prevHashes = fieldVoiceLoadHashes_(props);
  const nowHashes = fieldVoiceHashes_(table.rows, picked.maxNo);
  const pickedIds = {};
  picked.rows.forEach(function(r) { pickedIds[r.id] = true; });
  // 前に送った行のうち、中身が変わった行（指紋を持っている行だけ。持っていない行は今回から見張る）
  const updated = table.rows.filter(function(r) {
    return !pickedIds[r.id] && prevHashes[r.id] && nowHashes[r.id] && prevHashes[r.id] !== nowHashes[r.id];
  }).sort(function(a, b) { return a.no - b.no; });

  if (!picked.rows.length && !updated.length) {
    if (picked.maxNo > 0 && String(picked.maxNo) !== String(lastRaw)) props.setProperty('field_voice_last_no', String(picked.maxNo));
    fieldVoiceSaveHashes_(props, nowHashes);
    Logger.log('📭 会話記録: 新しい行・書き足しなし → 送信しない (PP ' + ppToday + ')');
    return 0;
  }

  const first = picked.rows[0], last = picked.rows[picked.rows.length - 1];
  const counts = [];
  if (picked.rows.length) {
    counts.push('新しい記録 ' + picked.rows.length + '件（' + escapeHtml_(first.id) +
      (picked.rows.length > 1 ? '〜' + escapeHtml_(last.id) : '') + '）');
  }
  if (updated.length) counts.push('書き足し・更新 ' + updated.length + '件');
  const head = '🗣 <b>Run Kosal の日報（ドっちゃんの会話記録・原文のまま）</b>\n' +
    Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd (E)') + '・' + counts.join('・') + '\n' +
    '━━━━━━━━━━━━━━━━━━';
  const blocks = picked.rows.map(function(r) {
    return { no: r.no, lines: fieldVoiceRowLines_(table.headers, r.cells) };
  }).concat(updated.map(function(r) {
    // 前に送った行。どこが変わったかは比べず、いまの行をまるごと出す（no: 0 = 番号は進めない）
    return { no: 0, lines: ['✏️ 書き足し・更新（前に送った記録）'].concat(fieldVoiceRowLines_(table.headers, r.cells)) };
  }));
  const messages = fieldVoiceMessages_(head, blocks);

  // 1通ずつ送り、送れたところまで番号を進める（途中で失敗したら、残りは次の日に出る）
  let sent = 0, allOk = true;
  for (let i = 0; i < messages.length; i++) {
    const res = sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, messages[i].text, sendOpts);
    if (!res || !res.ok) {
      Logger.log('❌ 会話記録の送信失敗（' + (i + 1) + '/' + messages.length + '通目）: ' + JSON.stringify(res));
      allOk = false;
      break;
    }
    if (messages[i].doneNo) {
      props.setProperty('field_voice_last_no', String(messages[i].doneNo));
      sent = picked.rows.filter(function(r) { return r.no <= messages[i].doneNo; }).length;
    }
  }
  // 全部送れた時だけ、今日の対象外の行（はじめて動く日の過去分）も含めて最後の番号まで進める
  if (allOk) {
    if (picked.maxNo > 0) props.setProperty('field_voice_last_no', String(picked.maxNo));
    fieldVoiceSaveHashes_(props, nowHashes); // 全部送れた時だけ指紋を進める（失敗した日は、書き足しが次の日にもう一度出る）
    sent += updated.length;
  }
  Logger.log('📤 会話記録 送信: 新 ' + picked.rows.length + '件・書き足し ' + updated.length + '件・' + messages.length + '通' +
    (allOk ? '' : '（途中で失敗）') + ' (PP ' + ppToday + ')');
  return sent;
}

/** 行の中身の指紋（変わったかを見るだけ。本文は保存しない） */
function fieldVoiceHash_(cells) {
  const s = cells.map(function(c) { return String(c).trim(); }).join('\u0001');
  let h1 = 0x811c9dc5, h2 = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 33) + c) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

/** 番号の新しい FIELD_VOICE_WATCH_ROWS_ 行の指紋 { 記録番号: 指紋 } */
function fieldVoiceHashes_(rows, maxNo) {
  const out = {};
  rows.forEach(function(r) {
    if (r.no > maxNo - FIELD_VOICE_WATCH_ROWS_) out[r.id] = fieldVoiceHash_(r.cells);
  });
  return out;
}

function fieldVoiceLoadHashes_(props) {
  try {
    const o = JSON.parse(props.getProperty('field_voice_hashes') || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch (e) {
    return {};
  }
}

function fieldVoiceSaveHashes_(props, hashes) {
  const json = JSON.stringify(hashes);
  if (props.getProperty('field_voice_hashes') !== json) props.setProperty('field_voice_hashes', json);
}

/**
 * シートの全セル（表示のままの文字）から、見出しと「C番号」の行を取り出す。
 * 列は位置でなく見出しの名前で読む（ドっちゃんが列を足しても壊れない）
 * @return {{headers:string[], rows:Array<{id:string,no:number,cells:string[]}>}}
 */
function fieldVoiceParse_(values) {
  let headers = null;
  const rows = [];
  (values || []).forEach(function(r) {
    const a = String((r && r[0]) || '').trim();
    if (!headers) {
      if (a === FIELD_VOICE_ID_HEADER_) headers = r.map(function(h) { return String(h || '').trim(); });
      return;
    }
    const m = /^C(\d+)$/.exec(a);
    if (!m) return;
    rows.push({ id: a, no: Number(m[1]), cells: r.map(function(c) { return String(c === null || c === undefined ? '' : c); }) });
  });
  if (!headers) throw new Error('見出し「' + FIELD_VOICE_ID_HEADER_ + '」が見つからない');
  rows.forEach(function(row) {
    row.date = fieldVoiceCell_(headers, row.cells, '会話日');
    row.related = fieldVoiceCell_(headers, row.cells, '関連日付');
  });
  return { headers: headers, rows: rows };
}

function fieldVoiceCell_(headers, cells, name) {
  const i = headers.indexOf(name);
  return i < 0 ? '' : String(cells[i] || '').trim();
}

/** '2026/11/4' も '2026-11-04' も 'yyyy-MM-dd' に（日付でなければ ''） */
function fieldVoiceDay_(s) {
  const m = /(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/.exec(String(s || ''));
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

/**
 * 送る行を選ぶ（番号の小さい順）。
 *   lastRaw あり: 番号が lastRaw より大きい行
 *   lastRaw なし（はじめて）: 会話日か関連日付が今日の行だけ
 * @return {{rows:Array, maxNo:number}} maxNo はシートにある最大の番号
 */
function fieldVoicePick_(rows, lastRaw, ppToday) {
  const maxNo = rows.reduce(function(m, r) { return Math.max(m, r.no); }, 0);
  const lastNo = Number(lastRaw);
  const hasLast = lastRaw !== null && lastRaw !== undefined && String(lastRaw) !== '' && !isNaN(lastNo);
  const picked = rows.filter(function(r) {
    if (hasLast) return r.no > lastNo;
    return fieldVoiceDay_(r.date) === ppToday || fieldVoiceDay_(r.related) === ppToday;
  }).sort(function(a, b) { return a.no - b.no; });
  return { rows: picked, maxNo: maxNo };
}

/**
 * 1行ぶんの表示（HTML）。1行目＝番号｜会話日 時刻｜話題、2行目から「列名: 値」を、空でない列だけ・シートの列の順に。
 * 文は変えない（要約しない・切らない）。長すぎるセルは行を分けるだけ
 */
function fieldVoiceRowLines_(headers, cells) {
  const get = function(name) { return fieldVoiceCell_(headers, cells, name); };
  const when = [get('会話日'), get('会話時刻')].filter(function(s) { return s; }).join(' ');
  const titleParts = [get('記録番号'), when, get('話題')].filter(function(s) { return s; });
  const lines = ['<b>' + escapeHtml_(titleParts.join('｜')) + '</b>'];
  headers.forEach(function(h, i) {
    if (!h || FIELD_VOICE_TITLE_COLS_.indexOf(h) >= 0) return;
    const v = String(cells[i] || '').trim();
    if (!v) return;
    let rest = h + ': ' + v;
    while (rest.length > FIELD_VOICE_LINE_CHARS_) {
      lines.push(escapeHtml_(rest.substring(0, FIELD_VOICE_LINE_CHARS_)));
      rest = rest.substring(FIELD_VOICE_LINE_CHARS_);
    }
    lines.push(escapeHtml_(rest));
  });
  return lines;
}

/**
 * 見出しと各行を、Telegram の長さ上限に収まるメッセージに分ける。
 * できるだけ1件を1通の中に収め、収まらない時だけ行の切れ目で分ける。
 * @param {string} head
 * @param {Array<{no:number, lines:string[]}>} blocks
 * @return {Array<{text:string, doneNo:number}>} doneNo = その通で最後まで出し終えた新しい行の番号（無ければ 0）
 */
function fieldVoiceMessages_(head, blocks) {
  const out = [];
  let cur = head, doneNo = 0;
  const flush = function() {
    if (cur) out.push({ text: cur, doneNo: doneNo });
    cur = ''; doneNo = 0;
  };
  blocks.forEach(function(b) {
    const whole = b.lines.join('\n');
    if (cur && (cur + '\n\n' + whole).length > FIELD_VOICE_MAX_CHARS_) flush();
    const joined = (cur ? cur + '\n\n' : '') + whole;
    if (joined.length <= FIELD_VOICE_MAX_CHARS_) {
      cur = joined;
    } else {
      // 1件だけで上限を超える: 行の切れ目で続きの通へ
      b.lines.forEach(function(line) {
        if (cur && (cur + '\n' + line).length > FIELD_VOICE_MAX_CHARS_) flush();
        cur = cur ? cur + '\n' + line : line;
      });
    }
    if (b.no) doneNo = b.no;
  });
  flush();
  return out;
}

// ============================================================
//  手動実行（GAS エディタから）
// ============================================================

/** 送らずに、いま送るとしたら何が出るかをログに出す（番号も進めない） */
function debugPreviewFieldVoiceRelay() {
  const props = PropertiesService.getScriptProperties();
  const sheet = SpreadsheetApp.openById(props.getProperty('FIELD_VOICE_SPREADSHEET_ID')).getSheetByName(FIELD_VOICE_TAB_);
  const table = fieldVoiceParse_(sheet.getDataRange().getDisplayValues());
  const ppToday = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd');
  const picked = fieldVoicePick_(table.rows, props.getProperty('field_voice_last_no'), ppToday);
  Logger.log('対象 ' + picked.rows.length + '件 / シートの最大番号 C' + picked.maxNo);
  fieldVoiceMessages_('（プレビュー）', picked.rows.map(function(r) {
    return { no: r.no, lines: fieldVoiceRowLines_(table.headers, r.cells) };
  })).forEach(function(m, i) { Logger.log('--- ' + (i + 1) + '通目（' + m.text.length + '字）---\n' + m.text); });
}

/** いますぐ送る（時刻・1日1回の印を見ない。番号は進む） */
function debugSendFieldVoiceRelayNow() {
  sendFieldVoiceRelay();
}
