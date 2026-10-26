/**
 * DotsReportItems.gs — ドッちゃんの日報・報連相を「日報明細」タブへ1件1行で記録し、管理グループ向けに整える
 *
 * 【責務】（2026-10-25 Daisuke「1日1行は少なすぎる。現場の日報はしっかり理解したい」→ 案 A を選択）
 *   - 日報: 見出し【…】の下の1行（- で始まる）が1件。作業1つ・お店とのやりとり1つ・困りごと1つ…をそれぞれ1行に
 *     1件の書き方: 「- 時刻: 09:30｜お店: LUXE Auto｜内容: ヘッドライト磨き｜台数: 2｜反応: …｜次: …｜判断: ★…」
 *     （項目は省略してよい。「キー: 」の無い部分は内容に入れる）
 *   - 報連相（緊急・相談・連絡・報告）: 1通を1行に
 *   - 「日報」タブ（1日1件・全文・管理ダッシュボード用）はそのまま。このタブは明細を見る・追いかけるためのもの
 *
 * 【新しいタブにした理由】「日報」タブは現場アプリと管理ダッシュボードが「1人1日1行」として使っているため、
 *   1件1行を混ぜると数がずれ、アプリの上書きともぶつかる
 *
 * 【書き直し】同じ日報の訂正・再試行では、その日報の明細を入れ替える（新しい明細を足してから古い明細を消す）。
 *   ただし日本側が「対応状況」を書き込んだ行（空・未対応・試験以外）は残し、同じ区分・内容の件は足さない
 */

const DOTS_ITEMS_SHEET = '日報明細';
const DOTS_ITEM_HEADERS = ['明細ID', '日報ID', '対象日', '区分', '時刻', 'お店・お客様', '内容', '台数', 'サービス',
  '金額($)', '相手の反応', '次にやること', '日本側の判断', '対応状況', '記録日時', '元メール'];
const DOTS_ITEM_OPEN = '未対応';
const DOTS_ITEM_TEST = '試験（消してよい）';
const DOTS_ITEM_STATUS_CHOICES = [DOTS_ITEM_OPEN, '対応中', '済', DOTS_ITEM_TEST];
const DOTS_ITEM_NONE_RE = /^(?:特に)?(?:なし|無し|不要|ありません)[。.]?$/;
// 見出し → 区分（上から順に判定。「明日の作業」は明日、「困りごと・相談」は困りごと、「お客様・お店の声」はお客様の声）
const DOTS_ITEM_SECTIONS = [
  { cat: '明日の予定',       icon: '📆', re: /明日|このあと|今後の予定/ },
  { cat: '確認したいこと',   icon: '❓', re: /確認/ },
  { cat: '困りごと',         icon: '⚠️', re: /困りごと|問題|トラブル/ },
  { cat: '相談',             icon: '🙋', re: /相談/ },
  { cat: 'お客様の声',       icon: '🗣', re: /お客様|声/ },
  { cat: 'お店とのやりとり', icon: '🏪', re: /お店|店舗|車屋|ディーラー|営業/ },
  { cat: 'お金',             icon: '💵', re: /お金|金額|支払|入金/ },
  { cat: '所感',             icon: '💭', re: /所感|気づき|感想/ },
  { cat: '作業',             icon: '🔧', re: /作業|やったこと/ }
];
// 1件の中の「キー: 値」→ 項目
const DOTS_ITEM_KEYS = {
  '時刻': 'time', '時間': 'time',
  'お店': 'shop', 'お客様': 'shop', '店': 'shop', '場所': 'shop', '相手': 'shop',
  '内容': 'content', 'こと': 'content',
  '台数': 'count',
  'サービス': 'service',
  '金額': 'amount', 'お金': 'amount',
  '反応': 'reaction', '相手の反応': 'reaction',
  '次': 'next', '次にやること': 'next', '次の一手': 'next',
  '判断': 'decision', '日本側の判断': 'decision', '決めてほしいこと': 'decision'
};

/** 見出しの文字 → {cat, icon}（どれにも当たらなければ見出しそのものを区分にする） */
function dotsSectionCategory_(title) {
  for (let i = 0; i < DOTS_ITEM_SECTIONS.length; i++) {
    if (DOTS_ITEM_SECTIONS[i].re.test(title)) return DOTS_ITEM_SECTIONS[i];
  }
  return { cat: String(title || 'その他').substring(0, 20), icon: '📌' };
}

/**
 * 見出しごとの本文 [{title, lines}] から明細を作る。
 * 「- 」「・」で始まる行が1件。「｜」で始まる行は直前の件の続き（折り返し）として読み直す。
 * ほかの続きの行は直前の件の内容に足す。「なし」だけの件は捨てる。
 */
function buildDotsItems_(sections) {
  const items = [];
  sections.forEach(function(sec) {
    const c = dotsSectionCategory_(sec.title);
    let cur = null;
    sec.lines.forEach(function(line) {
      if (!line.trim()) return;
      if (cur && /^\s*[｜|]/.test(line)) {
        const again = parseDotsItemLine_(cur.raw + line.trim());
        Object.keys(again).forEach(function(k) { cur[k] = again[k]; });
      } else if (/^\s*[-・•*]\s*/.test(line) || !cur) {
        cur = parseDotsItemLine_(line);
        cur.cat = c.cat;
        cur.icon = c.icon;
        items.push(cur);
      } else {
        cur.content = [cur.content, line.trim()].filter(Boolean).join('\n');
      }
    });
  });
  return items.filter(function(it) {
    const filled = ['time', 'shop', 'count', 'service', 'amount', 'reaction', 'next', 'decision']
      .some(function(k) { return it[k]; });
    return filled || (it.content && !DOTS_ITEM_NONE_RE.test(it.content));
  });
}

/** 1件の行を項目に分ける（「｜」区切りの「キー: 値」。キーの無い部分は内容へ。「なし」は空にする） */
function parseDotsItemLine_(line) {
  const text = line.replace(/^\s*[-・•*]\s*/, '').trim();
  const it = { raw: text, time: '', shop: '', content: '', count: '', service: '', amount: '', reaction: '', next: '', decision: '' };
  const extra = [];
  text.split(/[｜|]/).forEach(function(part) {
    const m = part.match(/^\s*([^:：]{1,8}?)\s*[:：]\s*([\s\S]*)$/);
    const key = m && Object.prototype.hasOwnProperty.call(DOTS_ITEM_KEYS, m[1].trim()) ? DOTS_ITEM_KEYS[m[1].trim()] : null;
    if (key) it[key] = [it[key], m[2].trim()].filter(Boolean).join(' ');
    else if (part.trim()) extra.push(part.trim());
  });
  if (extra.length) it.content = [it.content].concat(extra).filter(Boolean).join('｜');
  ['shop', 'service', 'amount', 'count', 'reaction', 'next', 'decision'].forEach(function(k) {
    if (DOTS_ITEM_NONE_RE.test(it[k])) it[k] = '';
  });
  if (it.decision && it.decision.charAt(0) !== '★') it.decision = '★ ' + it.decision;
  if (!it.decision && /(?:^|[｜|:：]\s*)★/.test(text)) it.decision = '★（内容を参照）'; // 項目の頭の ★ だけ（引用の ★ は数えない）
  return it;
}

/** 「日報明細」タブが無ければ作る（見出し行・時刻は文字のまま・対応状況は選択肢つき） */
function ensureDotsItemsSheet_() {
  const ss = getOpsSs_();
  if (ss.getSheetByName(DOTS_ITEMS_SHEET)) return;
  const sh = ss.insertSheet(DOTS_ITEMS_SHEET);
  const col = function(name) { return DOTS_ITEM_HEADERS.indexOf(name) + 1; };
  sh.getRange(1, 1, 1, DOTS_ITEM_HEADERS.length).setValues([DOTS_ITEM_HEADERS])
    .setFontWeight('bold').setBackground('#2b2b2b').setFontColor('#e8e8e8');
  sh.setFrozenRows(1);
  sh.getRange(2, col('時刻'), sh.getMaxRows() - 1, 1).setNumberFormat('@'); // 「09:30」を時刻の値に変えない
  sh.getRange(2, col('対応状況'), sh.getMaxRows() - 1, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(DOTS_ITEM_STATUS_CHOICES, true).setAllowInvalid(true).build());
  sh.setColumnWidth(col('内容'), 360);
  sh.setColumnWidth(col('次にやること'), 220);
  sh.setColumnWidth(col('日本側の判断'), 220);
  Logger.log('✅ 日報明細タブ作成');
}

/**
 * 日報の明細を書く。先に新しい明細を足し、そのあと同じ日報の古い明細（日本側がまだ触っていない行）を消す。
 * 日本側が対応状況を書き込んだ行は残し、その行と同じ区分・内容の件は足さない。明細 ID も重ねない。
 * @return {number} その日報の明細の件数
 */
function writeDotsReportItems_(reportId, reportDate, items, link, isTest) {
  ensureDotsItemsSheet_();
  const sheet = getSheet(DOTS_ITEMS_SHEET);
  const headers = dotsItemHeaders_(sheet);
  const old = findDotsItemRows_(function(r) { return String(r['日報ID']) === reportId; });
  const kept = old.filter(function(o) { return !o.replaceable; });
  const keptIds = kept.map(function(o) { return String(o.data['明細ID']); });
  const keptKeys = kept.map(function(o) { return dotsItemKey_(o.data['区分'], o.data['内容']); });
  let seq = 0;
  const nextId = function() {
    let id;
    do { seq++; id = reportId + '-' + ('0' + seq).slice(-2); } while (keptIds.indexOf(id) !== -1);
    return id;
  };
  const now = new Date();
  const rows = items.filter(function(it) {
    return keptKeys.indexOf(dotsItemKey_(it.cat, it.content)) === -1;
  }).map(function(it) {
    return dotsItemRow_(headers, {
      '明細ID':       nextId(),
      '日報ID':       reportId,
      '対象日':       reportDate,
      '区分':         it.cat,
      '時刻':         it.time,
      'お店・お客様': it.shop,
      '内容':         it.content,
      '台数':         dotsItemNumber_(it.count),
      'サービス':     it.service,
      '金額($)':      dotsItemNumber_(it.amount),
      '相手の反応':   it.reaction,
      '次にやること': it.next,
      '日本側の判断': it.decision,
      '対応状況':     isTest ? DOTS_ITEM_TEST : (it.decision || it.cat === '相談' ? DOTS_ITEM_OPEN : ''),
      '記録日時':     now,
      '元メール':     link
    });
  });
  appendDotsItemRows_(sheet, rows);
  deleteDotsItemRows_(sheet, headers, old.filter(function(o) { return o.replaceable; }));
  return items.length;
}

/**
 * 報連相1通を1行に書く（同じメールの再試行なら書かない）。
 * 本文の【内容】【Run Kosal の考え】【日本側に決めてほしいこと】を列に分ける（無ければ本文ぜんぶを内容へ）。
 * @return {string} 明細ID
 */
function recordDotsHourensou_(msg, kind, body, token) {
  ensureDotsItemsSheet_();
  const sheet = getSheet(DOTS_ITEMS_SHEET);
  const link = dotsGmailLink_(msg.getId());
  const dup = findDotsItemRows_(function(r) { return String(r['元メール']) === link; })[0];
  if (dup) return String(dup.data['明細ID']);

  const parsed = parseDotsReport_(body);
  const pick = function(re) {
    const s = parsed.sections.filter(function(x) { return re.test(x.title); })[0];
    return s ? s.lines.join('\n').trim() : '';
  };
  const shopRe = /^\s*[-・]?\s*(?:お店|お客様|相手)\s*[:：]\s*(.+)$/m;
  const shopLine = String(body).match(shopRe);
  const content = (pick(/内容/) || body).split('\n').filter(function(l) { return !shopRe.test(l); }).join('\n').trim();
  const decision = pick(/決めて|判断/);
  const id = generateDateSeqId('RS', DOTS_ITEMS_SHEET, '明細ID');
  appendDotsItemRows_(sheet, [dotsItemRow_(dotsItemHeaders_(sheet), {
    '明細ID':       id,
    '日報ID':       '',
    '対象日':       Utilities.formatDate(msg.getDate(), OPS_TZ, 'yyyy-MM-dd'),
    '区分':         kind.label,
    '時刻':         Utilities.formatDate(msg.getDate(), OPS_TZ, 'HH:mm'),
    'お店・お客様': shopLine ? shopLine[1].trim() : '',
    '内容':         [maskDotsText_(kind.title, token), content].filter(Boolean).join('\n'), // 題名は件名から（伏せ字を通す）
    '次にやること': pick(/考え|次/),
    '日本側の判断': decision ? (decision.charAt(0) === '★' ? decision : '★ ' + decision) : '',
    '対応状況':     (decision || kind.key === 'consult' || kind.key === 'urgent') ? DOTS_ITEM_OPEN : '',
    '記録日時':     new Date(),
    '元メール':     link
  })]);
  Logger.log('📒 dots 報連相 記録 ' + id);
  return id;
}

function dotsItemHeaders_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

/** 見出しの並びに合わせて1行分の配列を作る（文字はセル用に整える） */
function dotsItemRow_(headers, values) {
  return headers.map(function(h) {
    const v = values.hasOwnProperty(h) ? values[h] : '';
    return typeof v === 'string' ? dotsCellText_(v) : v;
  });
}

function dotsItemKey_(cat, content) {
  return String(cat || '') + '|' + String(content || '').replace(/^'/, '').trim();
}

/** 条件に合う行 [{row, data, replaceable}]。replaceable = 日本側がまだ触っていない（対応状況が空・未対応・試験） */
function findDotsItemRows_(match) {
  const all = readAllValues_(DOTS_ITEMS_SHEET);
  if (!all) return [];
  const out = [];
  all.values.forEach(function(v, i) {
    const r = {};
    all.headers.forEach(function(h, j) { r[h] = v[j]; });
    if (!match(r)) return;
    const st = String(r['対応状況'] || '').trim();
    out.push({ row: i + 2, data: r, replaceable: st === '' || st === DOTS_ITEM_OPEN || st === DOTS_ITEM_TEST });
  });
  return out;
}

/** 下に足す（タブの行が足りなければ先に増やす。範囲外への setValues は失敗するため） */
function appendDotsItemRows_(sheet, rows) {
  if (rows.length === 0) return;
  const start = sheet.getLastRow() + 1;
  const need = start + rows.length - 1;
  if (need > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows());
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}

/** 古い明細を下から消す。消す直前にその行を読み直し、別の行に変わった・日本側が書き込んだ行は残す */
function deleteDotsItemRows_(sheet, headers, targets) {
  const iId = headers.indexOf('明細ID'), iSt = headers.indexOf('対応状況');
  targets.slice().sort(function(a, b) { return b.row - a.row; }).forEach(function(t) {
    const v = sheet.getRange(t.row, 1, 1, headers.length).getValues()[0];
    const st = String(v[iSt] || '').trim();
    if (String(v[iId]) !== String(t.data['明細ID'])) return;
    if (st !== '' && st !== DOTS_ITEM_OPEN && st !== DOTS_ITEM_TEST) return;
    sheet.deleteRow(t.row);
  });
}

/** 「2台」「$5」「5 USD」→ 数字。数字だけで表せないもの（「$5〜$10」「4万リエル」）は文字のまま */
function dotsItemNumber_(s) {
  const t = String(s || '').trim();
  const m = t.match(/^\$?\s*(-?\d[\d,]*(?:\.\d+)?)\s*(?:台|ドル|USD|\$)?$/i);
  return m ? Number(m[1].replace(/,/g, '')) : t;
}

/** 管理グループ向けに、明細を区分ごとに並べる */
function renderDotsItems_(items) {
  const groups = [];
  items.forEach(function(it) {
    let g = groups.filter(function(x) { return x.cat === it.cat; })[0];
    if (!g) { g = { cat: it.cat, icon: it.icon, items: [] }; groups.push(g); }
    g.items.push(it);
  });
  return groups.map(function(g) {
    const lines = [g.icon + ' ' + g.cat];
    g.items.forEach(function(it) {
      const count = /^\d+$/.test(it.count) ? it.count + '台' : it.count;
      const amount = /^\d/.test(it.amount) ? '$' + it.amount : it.amount;
      const meta = [count, it.service, amount].filter(Boolean).join('・');
      const head = [it.time, it.shop].filter(Boolean).join(' ');
      lines.push('・' + (head ? head + ' — ' : '') + (it.content || '').replace(/\n/g, '\n   ') + (meta ? '（' + meta + '）' : ''));
      const sub = [it.reaction ? '反応: ' + it.reaction : '', it.next ? '次: ' + it.next : ''].filter(Boolean).join('／');
      if (sub) lines.push('   ' + sub);
      if (it.decision) lines.push('   ' + it.decision);
    });
    return lines.join('\n');
  }).join('\n\n');
}
