/**
 * v7-operations: Run Kosal の日報（ドっちゃんの会話記録）を原文のまま送る（FieldVoiceRelay.gs・2026-11-14）
 *
 * 実行: node --test "tests/*.test.js"
 *
 *   - 前回までに送った最大の番号より大きい行だけを、番号順に、文を変えずに送る
 *   - はじめて動く日は、会話日か関連日付が今日の行だけ（過去の全行を流さない）
 *   - 新しい行が無い日は送らない。読めない日は1行だけ知らせ、番号は進めない
 *   - 長い時は複数の通に分け、送れたところまで番号を進める
 *   - 20:30〜20:59 JST に1日1回だけ
 *   - シートの ID が未設定なら何もしない
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const OPS = path.join(__dirname, '..', 'v7-operations');
const HEADERS = ['記録番号', '会話日', '会話時刻', '話者・関係者', '話題', '内容・背景', '決定・依頼・確認事項', '次の対応・提案', '担当', '関連日付', '状況', '出典'];
const TOP = [[], ['会話記録'], ['確認範囲：2026/10/23〜2026/11/14'], [], HEADERS];
const TODAY = '2026-11-14';

function row(id, date, topic, extra) {
  const e = Object.assign({ time: '', who: 'スタッフ', body: '内容 ' + id, decided: '', next: '', owner: '', related: '', status: '報告済み', src: '音声' }, extra || {});
  return [id, date, e.time, e.who, topic, e.body, e.decided, e.next, e.owner, e.related, e.status, e.src];
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

function makeCtx(opts) {
  opts = Object.assign({ rows: [], props: { FIELD_VOICE_SPREADSHEET_ID: 'SHEET' }, now: '2026-11-14T11:35:00Z', threadId: '157', openThrow: false, noTab: false, failAt: 0 }, opts || {});
  const props = Object.assign({}, opts.props);
  const sent = [];
  const opened = [];
  const ctx = {
    console,
    Logger: { log: () => {} },
    OPS_TZ: 'Asia/Phnom_Penh',
    BOT_TYPE: { INTERNAL: 'internal' },
    Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(opts.now); } },
    // テスト用の簡略版: Asia/Tokyo = UTC+9、Asia/Phnom_Penh = UTC+7
    Utilities: { formatDate: (d, tz, fmt) => {
      const t = new Date(d.getTime() + (tz === 'Asia/Tokyo' ? 9 : 7) * 3600000);
      const ymd = t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
      if (fmt === 'HH:mm') return pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes());
      if (fmt === 'yyyy-MM-dd (E)') return ymd + ' (' + ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()] + ')';
      return ymd;
    } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); }
    }) },
    SpreadsheetApp: { openById: (id) => {
      opened.push(id);
      if (opts.openThrow) throw new Error('権限がありません <x>');
      return { getSheetByName: (name) => (name === '会話記録' && !opts.noTab
        ? { getDataRange: () => ({ getDisplayValues: () => TOP.concat(opts.rows) }) } : null) };
    } },
    getConfig: () => ({ adminGroupId: '-100', adminDailyReportThreadId: opts.threadId }),
    sendMessage: (bot, chat, text, o) => {
      sent.push({ bot, chat, text, o });
      return { ok: !(opts.failAt && sent.length >= opts.failAt) };
    },
    escapeHtml_: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(OPS, 'FieldVoiceRelay.gs'), 'utf8'), ctx, { filename: 'FieldVoiceRelay.gs' });
  return { ctx, props, sent, opened };
}

test('前回の番号より大きい行だけを番号順に送り、文は変えない。空の列は出さず、番号を最後まで進める', () => {
  const { ctx, props, sent } = makeCtx({
    props: { FIELD_VOICE_SPREADSHEET_ID: 'SHEET', field_voice_last_no: '57' },
    rows: [
      row('C57', '2026/11/14', '送り済み'),
      row('C59', '2026/11/14', '休みと月曜の予定', { time: '18:25', decided: '休むと説明 <確認>', related: '2026/11/16' }),
      [],
      row('C58', '2026/11/14', 'ヘッドライト3台', { time: '18:25', body: '09:00〜17:30、3台を磨いた\n2行目', owner: 'スタッフ' })
    ]
  });
  assert.equal(ctx.sendFieldVoiceRelay(), 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, '-100');
  assert.equal(sent[0].o.message_thread_id, 157);
  assert.equal(sent[0].o.parse_mode, 'HTML');
  assert.equal(sent[0].text, [
    '🗣 <b>Run Kosal の日報（ドっちゃんの会話記録・原文のまま）</b>',
    '2026-11-14 (Sat)・新しい記録 2件（C58〜C59）',
    '━━━━━━━━━━━━━━━━━━',
    '',
    '<b>C58｜2026/11/14 18:25｜ヘッドライト3台</b>',
    '話者・関係者: スタッフ',
    '内容・背景: 09:00〜17:30、3台を磨いた\n2行目',
    '担当: スタッフ',
    '状況: 報告済み',
    '出典: 音声',
    '',
    '<b>C59｜2026/11/14 18:25｜休みと月曜の予定</b>',
    '話者・関係者: スタッフ',
    '内容・背景: 内容 C59',
    '決定・依頼・確認事項: 休むと説明 &lt;確認&gt;',
    '関連日付: 2026/11/16',
    '状況: 報告済み',
    '出典: 音声'
  ].join('\n'));
  assert.equal(props.field_voice_last_no, '59');
});

test('はじめて動く日: 会話日か関連日付が今日の行だけを送り、番号はシートの最後まで進める', () => {
  const { ctx, props, sent } = makeCtx({ rows: [
    row('C01', '2026/10/23', '昔の話'),
    row('C30', '', 'アプリの記録', { related: '2026/11/14' }),
    row('C31', '2026/11/14', '今日の報告'),
    row('C32', '2026/11/13', '昨日の報告'),
    row('C40', '2026/11/09', 'あとから足された古い日付の行')
  ] });
  assert.equal(ctx.sendFieldVoiceRelay(), 2);
  assert.match(sent[0].text, /新しい記録 2件（C30〜C31）/);
  assert.doesNotMatch(sent[0].text, /昔の話|昨日の報告|古い日付/);
  assert.equal(props.field_voice_last_no, '40');
});

test('はじめて動く日に今日の行が無い: 送らず、番号だけ最後まで進める（次の日に過去分を流さない）', () => {
  const { ctx, props, sent } = makeCtx({ rows: [row('C01', '2026/10/23', '昔'), row('C02', '2026/11/13', '昨日')] });
  assert.equal(ctx.sendFieldVoiceRelay(), 0);
  assert.equal(sent.length, 0);
  assert.equal(props.field_voice_last_no, '2');
});

test('新しい行が無い日は送らない。送る時刻のあとに書かれた行は次の日に出る', () => {
  const rows = [row('C58', '2026/11/14', '今日')];
  const a = makeCtx({ props: { FIELD_VOICE_SPREADSHEET_ID: 'SHEET', field_voice_last_no: '58' }, rows });
  assert.equal(a.ctx.sendFieldVoiceRelay(), 0);
  assert.equal(a.sent.length, 0);
  const b = makeCtx({ props: { FIELD_VOICE_SPREADSHEET_ID: 'SHEET', field_voice_last_no: '58' }, now: '2026-11-15T11:35:00Z',
    rows: rows.concat([row('C59', '2026/11/14', '昨日の夜に書かれた行')]) });
  assert.equal(b.ctx.sendFieldVoiceRelay(), 1);
  assert.match(b.sent[0].text, /新しい記録 1件（C59）/);
  assert.match(b.sent[0].text, /<b>C59｜2026\/11\/14｜昨日の夜に書かれた行<\/b>/);
});

test('列が足されても、足された列を「列名: 値」でそのまま出す', () => {
  const { ctx } = makeCtx();
  const headers = HEADERS.concat(['メモ']);
  const lines = ctx.fieldVoiceRowLines_(headers, row('C70', '2026/11/14', '話題').concat(['足した列の値']));
  assert.equal(lines[0], '<b>C70｜2026/11/14｜話題</b>');
  assert.equal(lines[lines.length - 1], 'メモ: 足した列の値');
});

test('長い時は通を分ける。どの通も上限以内で、文は1字も欠けない', () => {
  const big = 'あ'.repeat(1500);
  const rows = [];
  for (let i = 1; i <= 6; i++) rows.push(row('C' + (100 + i), '2026/11/14', '話題' + i, { body: big + i }));
  const { ctx, props, sent } = makeCtx({ props: { FIELD_VOICE_SPREADSHEET_ID: 'SHEET', field_voice_last_no: '100' }, rows });
  assert.equal(ctx.sendFieldVoiceRelay(), 6);
  assert.ok(sent.length >= 3);
  sent.forEach((m) => assert.ok(m.text.length <= 3900, '上限以内: ' + m.text.length));
  const all = sent.map((m) => m.text).join('\n');
  for (let i = 1; i <= 6; i++) assert.ok(all.includes('内容・背景: ' + big + i));
  assert.equal(props.field_voice_last_no, '106');
});

test('1件だけで上限を超える時は、行の切れ目と長いセルの途中で分ける（欠けない）', () => {
  const huge = 'ゑ'.repeat(7000);
  const { ctx, sent } = makeCtx({ props: { FIELD_VOICE_SPREADSHEET_ID: 'SHEET', field_voice_last_no: '0' },
    rows: [row('C01', '2026/11/14', '長い行', { body: huge, decided: '決定' })] });
  assert.equal(ctx.sendFieldVoiceRelay(), 1);
  assert.ok(sent.length >= 2);
  sent.forEach((m) => assert.ok(m.text.length <= 3900));
  assert.equal(sent.map((m) => m.text).join('').split('ゑ').length - 1, 7000);
  assert.match(sent[sent.length - 1].text, /決定・依頼・確認事項: 決定/);
});

test('途中の通で送信に失敗: 送れたところまで番号を進め、残りは次の日に出る', () => {
  const big = 'う'.repeat(3000);
  const rows = [1, 2, 3].map((i) => row('C0' + i, '2026/11/14', '話題' + i, { body: big }));
  const { ctx, props, sent } = makeCtx({ props: { FIELD_VOICE_SPREADSHEET_ID: 'SHEET', field_voice_last_no: '0' }, rows, failAt: 2 });
  assert.equal(ctx.sendFieldVoiceRelay(), 1);
  assert.equal(sent.length, 2);
  assert.equal(props.field_voice_last_no, '1');
});

test('シートが読めない・タブが無い: 1行だけ知らせ、番号は進めない', () => {
  const a = makeCtx({ props: { FIELD_VOICE_SPREADSHEET_ID: 'SHEET', field_voice_last_no: '10' }, openThrow: true });
  assert.equal(a.ctx.sendFieldVoiceRelay(), 0);
  assert.equal(a.sent.length, 1);
  assert.match(a.sent[0].text, /シートを読めませんでした/);
  assert.match(a.sent[0].text, /&lt;x&gt;/);
  assert.equal(a.props.field_voice_last_no, '10');
  const b = makeCtx({ noTab: true });
  assert.equal(b.ctx.sendFieldVoiceRelay(), 0);
  assert.match(b.sent[0].text, /タブが見つからない/);
});

test('シートの ID か日報トピックが未設定なら、何も読まず何も送らない', () => {
  const a = makeCtx({ props: {} });
  assert.equal(a.ctx.sendFieldVoiceRelay(), 0);
  assert.equal(a.opened.length, 0);
  assert.equal(a.sent.length, 0);
  const b = makeCtx({ threadId: '', rows: [row('C01', '2026/11/14', '今日')] });
  assert.equal(b.ctx.sendFieldVoiceRelay(), 0);
  assert.equal(b.sent.length, 0);
});

test('20:30〜20:59 JST に1日1回だけ。窓の外では何もしない', () => {
  const rows = [row('C01', '2026/11/14', '今日')];
  const early = makeCtx({ rows, now: '2026-11-14T11:29:00Z' }); // 20:29 JST
  early.ctx.maybeSendFieldVoiceRelay_();
  assert.equal(early.sent.length, 0);
  assert.equal(early.props.field_voice_last_sent, undefined);
  const late = makeCtx({ rows, now: '2026-11-14T12:00:00Z' }); // 21:00 JST
  late.ctx.maybeSendFieldVoiceRelay_();
  assert.equal(late.sent.length, 0);
  const inWin = makeCtx({ rows, now: '2026-11-14T11:30:00Z' }); // 20:30 JST
  inWin.ctx.maybeSendFieldVoiceRelay_();
  inWin.ctx.maybeSendFieldVoiceRelay_();
  assert.equal(inWin.sent.length, 1);
  assert.equal(inWin.props.field_voice_last_sent, TODAY);
});

test('見出しの行が無いシートは読めない扱い。番号でない行（空行・メモ）は無視する', () => {
  const { ctx } = makeCtx();
  assert.throws(() => ctx.fieldVoiceParse_([['会話記録'], ['C01', '2026/11/14']]), /見出し/);
  const t = ctx.fieldVoiceParse_([HEADERS, [], ['メモ'], ['C1a', 'x'], row('C07', '2026/11/4', '話題')]);
  assert.equal(t.rows.length, 1);
  assert.equal(t.rows[0].no, 7);
  assert.equal(ctx.fieldVoiceDay_(t.rows[0].date), '2026-11-04');
  assert.equal(ctx.fieldVoiceDay_(''), '');
});
