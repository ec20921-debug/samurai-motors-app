/**
 * SystemChangeLog.gs — 「本日のシステム変更」（2026-10-31 Daisuke 要望）
 *
 * 【責務】
 *   経費・勤務関連 GSS の「システム変更」タブ（日付／時刻／絵文字／ひとこと／対象／記録者／補足（内部））を読み、
 *   日報に「🛠 本日のシステム変更」として、その日の分を絵文字つきの1行ずつで出す。
 *
 * 【書く人】
 *   本番に変更を反映した Claude のセッション（または人）が1行ずつ書く（ルールはリポの CLAUDE.md）。
 *   読む人は日本側の管理者なので「ひとこと」は日本語・日常の言葉。コードの言葉や版番号は「補足（内部）」へ。
 *
 * 【壊れ方】
 *   タブが無い・読めない時は空文字（日報は止めない）。タブは初回の読取で自動作成する。
 */

const SYSCHANGE_SHEET_NAME = 'システム変更';
const SYSCHANGE_HEADERS = ['日付', '時刻', '絵文字', 'ひとこと', '対象', '記録者', '補足（内部）'];
const SYSCHANGE_MAX_LINES = 8; // 日報に出す最大行数（超えた分は「…他N件」）

/** 「システム変更」タブ（無ければヘッダー付きで作る） */
function getSystemChangeSheet_() {
  const ss = getOpsSs_();
  let sheet = ss.getSheetByName(SYSCHANGE_SHEET_NAME);
  if (!sheet) sheet = createHeaderedSheet_(ss, SYSCHANGE_SHEET_NAME, SYSCHANGE_HEADERS);
  return sheet;
}

/** セルの値を yyyy-MM-dd に（Date でも文字でも） */
function syschangeDateStr_(v) {
  if (syschangeIsDate_(v)) return Utilities.formatDate(v, OPS_TZ, 'yyyy-MM-dd');
  return String(v || '').trim().substring(0, 10);
}

/** セルの値を HH:mm に（Date でも文字でも） */
function syschangeTimeStr_(v) {
  if (syschangeIsDate_(v)) return Utilities.formatDate(v, OPS_TZ, 'HH:mm');
  return String(v || '').trim().substring(0, 5);
}

/** Date か（別の実行環境で作られた Date も拾えるように instanceof は使わない） */
function syschangeIsDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

/**
 * その日の変更を時刻順に返す: [{ time, emoji, text, target, by }]
 * 読めない時は例外（呼ぶ側で握る）
 */
function readSystemChangesForDate_(ppToday) {
  const rows = readSheetObjects_(getSystemChangeSheet_());
  return rows
    .map(function(r) {
      const o = r.obj;
      return {
        date: syschangeDateStr_(o['日付']),
        time: syschangeTimeStr_(o['時刻']),
        emoji: String(o['絵文字'] || '').trim(),
        text: String(o['ひとこと'] || '').trim(),
        target: String(o['対象'] || '').trim(),
        by: String(o['記録者'] || '').trim()
      };
    })
    .filter(function(c) { return c.date === ppToday && c.text; })
    .sort(function(a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
}

/**
 * 日報のセクション。ゼロ件・読取失敗は空文字（セクション自体を出さない）
 */
function buildSystemChangesSection_(ppToday) {
  try {
    const changes = readSystemChangesForDate_(ppToday);
    if (!changes.length) return '';
    const lines = ['🛠 <b>本日のシステム変更</b>（' + changes.length + '件）'];
    changes.slice(0, SYSCHANGE_MAX_LINES).forEach(function(c) {
      let line = '　' + (c.emoji || '・') + ' ' + escapeHtml_(c.text);
      if (c.target) line += '（' + escapeHtml_(c.target) + '）';
      lines.push(line);
    });
    if (changes.length > SYSCHANGE_MAX_LINES) {
      lines.push('　…他 ' + (changes.length - SYSCHANGE_MAX_LINES) + ' 件（シート「' + SYSCHANGE_SHEET_NAME + '」）');
    }
    return lines.join('\n');
  } catch (e) {
    Logger.log('⚠️ 日報: システム変更セクション生成失敗（スキップ）: ' + e);
    return '';
  }
}

/** デバッグ: 今日のシステム変更セクションをログに出す */
function debugPreviewSystemChangesSection() {
  const ppToday = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd');
  Logger.log(buildSystemChangesSection_(ppToday) || '（本日のシステム変更なし）');
}
