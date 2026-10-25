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
 * 【書き直し】同じ日報の訂正・再試行では、その日報の明細を入れ替える。
 *   ただし日本側が「対応状況」を書き込んだ行（空・未対応以外）は残す
 */

const DOTS_ITEMS_SHEET = '日報明細';
const DOTS_ITEM_HEADERS = ['明細ID', '日報ID', '対象日', '区分', '時刻', 'お店・お客様', '内容', '台数', 'サービス',
  '金額($)', '相手の反応', '次にやること', '日本側の判断', '対応状況', '記録日時', '元メール'];
const DOTS_ITEM_OPEN = '未対応';
const DOTS_ITEM_TEST = '試験（消してよい）';
// 見出し → 区分（上から順に判定。「明日の作業」は明日、「困りごと・相談」は困りごと、「お客様・お店の声」はお客様の声）
const DOTS_ITEM_SECTIONS = [
  { cat: '明日の予定',     icon: '📆', re: /明日|このあと|今後の予定/ },
  { cat: '確認したいこと', icon: '❓', re: /確認/ },
  { cat: '困りごと',       icon: '⚠️', re: /困りごと|問題|トラブル/ },
  { cat: '相談',           icon: '🙋', re: /相談/ },
  { cat: 'お客様の声',     icon: '🗣', re: /お客様|声/ },
  { cat: 'お店とのやりとり', icon: '🏪', re: /お店|店舗|車屋|ディーラー|営業/ },
  { cat: 'お金',           icon: '💵', re: /お金|金額|支払|入金/ },
  { cat: '所感',           icon: '💭', re: /所感|気づき|感想/ },
  { cat: '作業',           icon: '🔧', re: /作業|やったこと/ }
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
 * 「- 」「・」で始まる行が1件。続きの行は直前の件の内容に足す。「なし」だけの件は捨てる。
 */
function buildDotsItems_(sections) {
  const items = [];
  sections.forEach(function(sec) {
    const c = dotsSectionCategory_(sec.title);
    let cur = null;
    sec.lines.forEach(function(line) {
      if (!line.trim()) return;
      if (/^\s*[-・•*]\s*/.test(line) || !cur) {
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
    return filled || !/^(?:特に)?(?:なし|無し|ありません)[。.]?$/.test(it.content);
  });
}

/** 1件の行を項目に分ける（「｜」区切りの「キー: 値」。キーの無い部分は内容へ） */
function parseDotsItemLine_(line) {
  const text = line.replace(/^\s*[-・•*]\s*/, '').trim();
  const it = { time: '', shop: '', content: '', count: '', service: '', amount: '', reaction: '', next: '', decision: '' };
  const extra = [];
  text.split(/[｜|]/).forEach(function(part) {
    const m = part.match(/^\s*([^:：]{1,8}?)\s*[:：]\s*([\s\S]*)$/);
    const key = m ? DOTS_ITEM_KEYS[m[1].trim()] : null;
    if (key) it[key] = [it[key], m[2].trim()].filter(Boolean).join(' ');
    else if (part.trim()) extra.push(part.trim());
  });
  if (extra.length) it.content = [it.content].concat(extra).filter(Boolean).join('｜');
  if (it.decision && it.decision.charAt(0) !== '★') it.decision = '★ ' + it.decision;
  if (!it.decision && text.indexOf('★') !== -1) it.decision = '★（内容を参照）';
  return it;
}

/** 「日報明細」タブが無ければ作る（見出し行つき） */
function ensureDotsItemsSheet_() {
  const ss = getOpsSs_();
  if (ss.getSheetByName(DOTS_ITEMS_SHEET)) return;
  const sh = ss.insertSheet(DOTS_ITEMS_SHEET);
  sh.getRange(1, 1, 1, DOTS_ITEM_HEADERS.length).setValues([DOTS_ITEM_HEADERS])
    .setFontWeight('bold').setBackground('#2b2b2b').setFontColor('#e8e8e8');
  sh.setFrozenRows(1);
  sh.setColumnWidth(7, 360);   // 内容
  sh.setColumnWidth(12, 220);  // 次にやること
  sh.setColumnWidth(13, 220);  // 日本側の判断
  Logger.log('✅ 日報明細タブ作成');
}

/**
 * 日報の明細を書く（同じ日報 ID の明細は入れ替える。日本側が対応状況を書いた行は残す）。
 * @return {number} 書いた件数
 */
function writeDotsReportItems_(reportId, reportDate, items, link, isTest) {
  ensureDotsItemsSheet_();
  const sheet = getSheet(DOTS_ITEMS_SHEET);
  removeDotsItemRows_(sheet, function(r) { return String(r['日報ID']) === reportId; });
  const now = new Date();
  const rows = items.map(function(it, i) {
    return dotsItemRow_(sheet, {
      '明細ID':       reportId + '-' + ('0' + (i + 1)).slice(-2),
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
  if (rows.length > 0) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  return rows.length;
}

/**
 * 報連相1通を1行に書く（同じメールの再試行なら書かない）。
 * 本文の【内容】【Run Kosal の考え】【日本側に決めてほしいこと】を列に分ける（無ければ本文ぜんぶを内容へ）。
 * @return {string} 明細ID
 */
function recordDotsHourensou_(msg, kind, body) {
  ensureDotsItemsSheet_();
  const sheet = getSheet(DOTS_ITEMS_SHEET);
  const link = dotsGmailLink_(msg.getId());
  const dup = getAllRows(DOTS_ITEMS_SHEET).filter(function(r) { return String(r['元メール']) === link; })[0];
  if (dup) return String(dup['明細ID']);

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
  const row = dotsItemRow_(sheet, {
    '明細ID':       id,
    '日報ID':       '',
    '対象日':       Utilities.formatDate(msg.getDate(), OPS_TZ, 'yyyy-MM-dd'),
    '区分':         kind.label,
    '時刻':         Utilities.formatDate(msg.getDate(), OPS_TZ, 'HH:mm'),
    'お店・お客様': shopLine ? shopLine[1].trim() : '',
    '内容':         [kind.title, content].filter(Boolean).join('\n'),
    '次にやること': pick(/考え|次/),
    '日本側の判断': decision ? (decision.charAt(0) === '★' ? decision : '★ ' + decision) : '',
    '対応状況':     (decision || kind.key === 'consult' || kind.key === 'urgent') ? DOTS_ITEM_OPEN : '',
    '記録日時':     new Date(),
    '元メール':     link
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  Logger.log('📒 dots 報連相 記録 ' + id);
  return id;
}

/** 見出しの並びに合わせて1行分の配列を作る（文字はセル用に整える） */
function dotsItemRow_(sheet, values) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  return headers.map(function(h) {
    const v = values.hasOwnProperty(h) ? values[h] : '';
    return typeof v === 'string' ? dotsCellText_(v) : v;
  });
}

/** 条件に合う行のうち、日本側がまだ触っていない行（対応状況が空・未対応・試験）を下から消す */
function removeDotsItemRows_(sheet, match) {
  const all = readAllValues_(DOTS_ITEMS_SHEET);
  if (!all) return;
  for (let i = all.values.length - 1; i >= 0; i--) {
    const r = {};
    all.headers.forEach(function(h, j) { r[h] = all.values[i][j]; });
    const st = String(r['対応状況'] || '');
    if (match(r) && (st === '' || st === DOTS_ITEM_OPEN || st === DOTS_ITEM_TEST)) sheet.deleteRow(i + 2);
  }
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
      const meta = [it.count ? it.count + (/台$/.test(it.count) ? '' : '台') : '', it.service, it.amount].filter(Boolean).join('・');
      const head = [it.time, it.shop].filter(Boolean).join(' ');
      lines.push('・' + (head ? head + ' — ' : '') + (it.content || '').replace(/\n/g, '\n   ') + (meta ? '（' + meta + '）' : ''));
      const sub = [it.reaction ? '反応: ' + it.reaction : '', it.next ? '次: ' + it.next : ''].filter(Boolean).join('／');
      if (sub) lines.push('   ' + sub);
      if (it.decision) lines.push('   ' + it.decision);
    });
    return lines.join('\n');
  }).join('\n\n');
}
