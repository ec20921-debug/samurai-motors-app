/**
 * DotsDailyReport.gs — ドッちゃん（dots）の日報メールを勤務用 GSS「日報」タブへ記録
 *
 * 【責務】（2026-10-25 Daisuke 指示「日報を毎日 GSS に自動で記録」）
 *   DotsDigestBridge.gs が受け取った日報メール（件名 [SM-DOTS] 日報 YYYY-MM-DD）の本文を、
 *   見出し【…】ごとに既存の列（本日の作業内容 / 所感・気づき / 明日の予定）へ振り分けて1日1行で書き、
 *   1件ずつの明細は「日報明細」タブへ（DotsReportItems.gs）。
 *
 * 【現場アプリの日報との関係】
 *   - 同じタブ・同じ列（ReportManager.gs の DAILY_REPORT_HEADERS_）。新しいタブは作らない
 *   - 行は分ける: 作成者 Chat ID を空にし、状態を「dots 記録」にする
 *     （submitDailyReport は Chat ID × 対象日で上書きするため、同じ Chat ID だとアプリ提出で消える）
 *   - 作成者名はスタッフマスターの氏名(JP)（管理ダッシュボードの「日報 ✅」が作成者名 × 対象日で数えるため）
 *
 * 【上書きの歯止め】同じ対象日の dots 行がある時
 *   - 同じメールの再試行 → 同じ行に書き直す（状態はそのまま）
 *   - 新しいメール（記録済みより後に届き、12時間以内）→ 上書き（状態「dots 記録（更新）」）
 *   - 記録済みより古いメール・12時間より後のメール → 上書きしない（件名の日付の書き間違いで前日の行を潰さない）
 */

const DOTS_REPORT_STATUS = 'dots 記録';
const DOTS_REPORT_STATUS_TEST = 'dots 試験（確認後に消してよい）';
const DOTS_REPORT_TEST_NAME = 'テスト（dots）'; // スタッフ別の「日報 ✅」に入らないよう、スタッフ名と別にする
const DOTS_REPORT_CELL_MAX = 45000;             // 1セル 50,000 字の上限に余裕を持たせる
const DOTS_REPORT_REWRITE_MS = 12 * 60 * 60 * 1000;
// 区分（DotsReportItems.gs の見出し判定）→「日報」タブの列。ほかの区分は「所感・気づき」へ
const DOTS_REPORT_WORK_CATS = ['作業', 'お店とのやりとり', 'お金'];
const DOTS_REPORT_NOTES_COL = '所感・気づき';

/**
 * 日報メール1通を「日報」タブに書く。失敗したら例外（呼び出し側が次の回に再試行する）。
 * @return {{status:string, reportId:string, reportDate:string}}
 *   status: created 新しく記録／updated 上書き／older・otherDay 上書きしなかった／noHeadings 形式違いで書かなかった
 *   created・updated の時は items（明細）・itemCount・preamble も返す（管理グループへの通知に使う）
 */
function recordDotsDailyReport_(msg, subject, body, isTest) {
  const reportDate = resolveDotsReportDate_(subject, msg.getDate());
  const parsed = parseDotsReport_(body);
  if (parsed.headings === 0) return { status: 'noHeadings', reportId: '', reportDate: reportDate };

  const staff = isTest ? null : resolveDotsStaff_();
  const name = isTest ? DOTS_REPORT_TEST_NAME : dotsStaffName_(staff);
  const link = dotsGmailLink_(msg.getId());
  const values = {
    '提出日時':       msg.getDate(),
    '対象日':         reportDate,
    '作成者名':       name,
    '作成者 Chat ID': '',
    '役割':           staff ? staff.role : 'field',
    '本日の作業内容': dotsCellText_(parsed.work),
    '所感・気づき':   dotsCellText_(parsed.notes),
    '明日の予定':     dotsCellText_(parsed.tomorrow),
    '関連リンク':     link
  };

  const items = buildDotsItems_(parsed.sections);
  const done = function(status, reportId) {
    // 明細（1件1行）も入れ替える。失敗したら例外 → 次の回に「日報」タブの行ごとやり直す（同じ行・同じ明細 ID になる）
    const n = writeDotsReportItems_(reportId, reportDate, items, link, isTest);
    return { status: status, reportId: reportId, reportDate: reportDate, items: items, itemCount: n, preamble: parsed.preamble };
  };

  const found = findDotsReportRow_(reportDate, name);
  if (!found) {
    values['日報ID'] = generateDateSeqId('DR', SHEET_NAMES.DAILY_REPORTS, '日報ID');
    values['状態'] = isTest ? DOTS_REPORT_STATUS_TEST : DOTS_REPORT_STATUS;
    appendRow(SHEET_NAMES.DAILY_REPORTS, values);
    Logger.log('📝 dots 日報 記録 ' + values['日報ID'] + ' 対象日=' + reportDate);
    return done('created', values['日報ID']);
  }

  const prevId = String(found.data['日報ID'] || '');
  const prevStatus = String(found.data['状態'] || '');
  const sameMail = String(found.data['関連リンク'] || '') === link;
  if (!sameMail) {
    const prev = found.data['提出日時'];
    const prevAt = prev && typeof prev.getTime === 'function' ? prev.getTime() : 0; // Date のセル（文字列なら比べない）
    const at = msg.getDate().getTime();
    if (prevAt && at < prevAt) return { status: 'older', reportId: prevId, reportDate: reportDate };
    if (prevAt && at - prevAt > DOTS_REPORT_REWRITE_MS) return { status: 'otherDay', reportId: prevId, reportDate: reportDate };
  }
  // 同じメールの再試行（Telegram 送信に失敗した後など）なら状態はそのまま
  values['日報ID'] = prevId || generateDateSeqId('DR', SHEET_NAMES.DAILY_REPORTS, '日報ID');
  values['状態'] = sameMail ? prevStatus : (isTest ? DOTS_REPORT_STATUS_TEST : DOTS_REPORT_STATUS + '（更新）');
  updateRow(SHEET_NAMES.DAILY_REPORTS, found.row, values); // 書くのは日報の列だけ（足された列・数式は触らない）
  Logger.log('📝 dots 日報 上書き ' + values['日報ID'] + ' 対象日=' + reportDate + (sameMail ? '（再試行）' : ''));
  const updated = sameMail ? /更新/.test(prevStatus) : true;
  return done(updated ? 'updated' : 'created', values['日報ID']);
}

/** 同じ対象日・同じ作成者名の dots 行（状態が「dots」で始まる行）を探す */
function findDotsReportRow_(reportDate, name) {
  const all = readAllValues_(SHEET_NAMES.DAILY_REPORTS);
  if (!all) return null;
  const h = all.headers;
  const iDate = h.indexOf('対象日'), iName = h.indexOf('作成者名'), iStatus = h.indexOf('状態');
  if (iDate < 0 || iName < 0 || iStatus < 0) throw new Error('❌ 日報シートの列が足りません（対象日 / 作成者名 / 状態）');
  for (let i = 0; i < all.values.length; i++) {
    const v = all.values[i];
    if (formatDateCell_(v[iDate]) !== reportDate) continue; // Date になったセルはシートの TZ で読む（1日ズレ防止）
    if (String(v[iName]) !== name || String(v[iStatus]).indexOf('dots') !== 0) continue;
    const data = {};
    h.forEach(function(col, j) { data[col] = v[j]; });
    return { row: i + 2, data: data };
  }
  return null;
}

/** その日の Run Kosal の日報が「日報」タブにあるか（現場アプリの行も、ドッちゃんの行も数える） */
function hasDotsStaffReportFor_(day) {
  const name = dotsStaffName_(resolveDotsStaff_());
  const all = readAllValues_(SHEET_NAMES.DAILY_REPORTS);
  if (!all) return false;
  const iDate = all.headers.indexOf('対象日'), iName = all.headers.indexOf('作成者名');
  if (iDate < 0 || iName < 0) return false;
  return all.values.some(function(v) {
    return String(v[iName]) === name && formatDateCell_(v[iDate]) === day;
  });
}

/**
 * 本文を見出し【…】で区切り、「日報」タブの列ごとにまとめる（見出しは残す）。
 * 見出しより前の行（「（Run Kosal 未確認）」など）は preamble として「本日の作業内容」の先頭へ。
 * @return {{work:string, notes:string, tomorrow:string, headings:number, preamble:string, sections:Array<{title:string, lines:string[]}>}}
 */
function parseDotsReport_(text) {
  const cols = {};
  cols['本日の作業内容'] = [];
  cols[DOTS_REPORT_NOTES_COL] = [];
  cols['明日の予定'] = [];
  const preamble = [];
  const sections = [];
  let current = null;
  String(text || '').split('\n').forEach(function(line) {
    const m = line.match(/^\s*【([^】]{1,30})】\s*(.*)$/);
    if (m) {
      current = { title: m[1], lines: m[2] ? [m[2]] : [] };
      sections.push(current);
      cols[dotsSectionColumn_(m[1])].push(current);
      return;
    }
    (current ? current.lines : preamble).push(line);
  });
  const join = function(secs) {
    return secs.map(function(s) { return ('【' + s.title + '】\n' + s.lines.join('\n')).trim(); }).join('\n\n');
  };
  const head = preamble.join('\n').trim();
  const work = join(cols['本日の作業内容']);
  return {
    work: [head, work].filter(Boolean).join('\n\n'),
    notes: join(cols[DOTS_REPORT_NOTES_COL]),
    tomorrow: join(cols['明日の予定']),
    headings: sections.length,
    preamble: head,
    sections: sections
  };
}

function dotsSectionColumn_(title) {
  const cat = dotsSectionCategory_(title).cat;
  if (cat === '明日の予定') return '明日の予定';
  return DOTS_REPORT_WORK_CATS.indexOf(cat) !== -1 ? '本日の作業内容' : DOTS_REPORT_NOTES_COL;
}

/**
 * 件名の日付（YYYY-MM-DD / YYYY/M/D / YYYY年M月D日）を対象日にする。
 * 無い・受信日の3日前〜当日の範囲外（書き間違い）の時は、受信日（プノンペン）。
 */
function resolveDotsReportDate_(subject, received) {
  const recv = Utilities.formatDate(received, OPS_TZ, 'yyyy-MM-dd');
  const m = String(subject || '').match(/(20\d{2})[-\/.年](\d{1,2})[-\/.月](\d{1,2})/);
  if (!m) return recv;
  const ds = m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  const diffDays = (Date.parse(recv + 'T00:00:00Z') - Date.parse(ds + 'T00:00:00Z')) / 86400000;
  return (diffDays >= 0 && diffDays <= 3) ? ds : recv;
}

/**
 * 日報を書く人（Run Kosal）をスタッフマスターから決める。
 * RON_CHAT_ID があればそれ、無ければ有効な field スタッフが1人だけの時にその人。決められなければ null。
 */
function resolveDotsStaff_() {
  const cfg = getConfig();
  if (cfg.ronChatId) {
    const s = findStaffByChatId(cfg.ronChatId);
    if (s) return s;
  }
  const field = getActiveStaff().filter(function(s) { return s.role === 'field'; });
  return field.length === 1 ? field[0] : null;
}

/** 「日報」タブの作成者名（スタッフマスターの氏名。決められなければ本名） */
function dotsStaffName_(staff) {
  return staff && staff.nameJp ? staff.nameJp : 'Run Kosal';
}

/** 今日 Run Kosal が出勤しているか（分からない時は true = 警告を出す側に倒す） */
function isDotsStaffOnDutyToday_() {
  try {
    const staff = resolveDotsStaff_();
    if (!staff || !staff.chatId) return true;
    const a = getTodayAttendance(staff.chatId);
    return !(a && a.ok && !a.clockIn);
  } catch (e) {
    Logger.log('⚠️ dots 出勤確認失敗（警告は出す）: ' + e);
    return true;
  }
}

/** 管理者が Gmail で原文を開けるリンク（GAS 実行者のアカウントを明示） */
function dotsGmailLink_(id) {
  const me = String(Session.getEffectiveUser().getEmail() || '');
  return 'https://mail.google.com/mail/u/' + (me ? encodeURIComponent(me) : '0') + '/#all/' + id;
}

/** セルに入れる文字列（= + - @ で始まると数式扱いになるので先頭に ' を付ける・長すぎる分は切る） */
function dotsCellText_(s) {
  let t = String(s || '');
  if (t.length > DOTS_REPORT_CELL_MAX) t = safeDotsCut_(t, DOTS_REPORT_CELL_MAX) + '\n…（長すぎるため省略。全文は関連リンクのメール）';
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}
