/**
 * NihongoSection.gs — 日報の「日本語」欄（2026-11-21）
 *
 * Daisuke「学習アプリの内容は日報につけくわえてほしい」
 *
 * 日本語アプリ（SAMURAI NIHONGO）のシート「日別」タブ（1日1行）を読むだけ。書かない。
 *   - シートの ID: Script Property「NIHONGO_SPREADSHEET_ID」があればそれ、無ければ下の NIHONGO_SHEET_DEFAULT_
 *     （Property に「off」と入れると、この欄を出さない）
 *   - 日報は 18:30（プノンペン）に出るので、夜の勉強は当日の行に入っていない → きのうの分を主に、今日の分は「ここまで」として出す
 *   - シートに届くのは最初に登録した1台だけ（今はナビン君）。名前はシートに無いので NIHONGO_LABEL_ で出す
 */

const NIHONGO_SHEET_PROP_ = 'NIHONGO_SPREADSHEET_ID';
const NIHONGO_SHEET_DEFAULT_ = '1ggs8knh6S1RCcQ2Sg-eqD_yTEPe2CxIu2hVoWzAhc9w';
const NIHONGO_DAILY_TAB_ = '日別';
const NIHONGO_LABEL_ = 'ナビン';

/** 日付のセル → yyyy-MM-dd。Date の時は、そのシートの時間帯で読む（別の時間帯で読むと1日ずれる） */
function nihongoDateStr_(v, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]') return Utilities.formatDate(v, tz || OPS_TZ, 'yyyy-MM-dd');
  return String(v || '').trim().substring(0, 10).replace(/\//g, '-');
}

/** 1日分の行を文に。勉強なし（0分・0問）なら '' */
function nihongoLine_(row, col) {
  const num = function (name) { const i = col[name]; return i >= 0 ? Number(row[i]) || 0 : 0; };
  const min = num('勉強した分'), ans = num('回答数'), ok = num('正解数');
  if (!min && !ans) return '';
  const parts = [min + '分', ans + '問'];
  if (ans) parts.push('正答率' + Math.round(ok * 100 / ans) + '%');
  if (col['ミッション(0-3)'] >= 0) parts.push('ミッション' + num('ミッション(0-3)') + '/3');
  const streak = num('連続日数');
  if (streak) parts.push('連続' + streak + '日');
  return parts.join('・');
}

/**
 * 日報の「日本語」欄。設定が無い・読めない時は ''
 */
function buildNihongoSection_(ppToday) {
  try {
    const id = PropertiesService.getScriptProperties().getProperty(NIHONGO_SHEET_PROP_) || NIHONGO_SHEET_DEFAULT_;
    if (!id || id === 'off') return '';
    const book = SpreadsheetApp.openById(id);
    const sheet = book.getSheetByName(NIHONGO_DAILY_TAB_);
    if (!sheet) return '';
    const vals = sheet.getDataRange().getValues();
    const head = (vals[0] || []).map(function (h) { return String(h).trim(); });
    const col = {};
    ['日付', '勉強した分', '回答数', '正解数', 'ミッション(0-3)', '連続日数'].forEach(function (n) { col[n] = head.indexOf(n); });
    if (col['日付'] < 0) return '';
    const y = new Date(new Date(ppToday + 'T12:00:00+07:00').getTime() - 24 * 3600 * 1000);
    const ppYesterday = Utilities.formatDate(y, OPS_TZ, 'yyyy-MM-dd');
    let today = '', yesterday = '';
    let tz = OPS_TZ;
    try { tz = book.getSpreadsheetTimeZone() || OPS_TZ; } catch (e) { /* 既定のまま */ }
    for (let r = 1; r < vals.length; r++) {
      const d = nihongoDateStr_(vals[r][col['日付']], tz);
      if (d === ppToday) today = nihongoLine_(vals[r], col);
      else if (d === ppYesterday) yesterday = nihongoLine_(vals[r], col);
    }
    const title = '📚 <b>日本語</b>（' + escapeHtml_(NIHONGO_LABEL_) + '）';
    if (!today && !yesterday) return title + 'きのう・今日とも なし';
    return title + '\n　きのう：' + (yesterday || 'なし') + '\n　今日（ここまで）：' + (today || 'まだ');
  } catch (err) {
    Logger.log('⚠️ 日報: 日本語欄の読取失敗: ' + err);
    return '';
  }
}

/** 日報の欄の見え方を確かめる（送らない・ログに出すだけ） */
function debugPreviewNihongoSection() {
  Logger.log(buildNihongoSection_(Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd')));
}
