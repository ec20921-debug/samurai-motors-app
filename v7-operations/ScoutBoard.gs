/**
 * ScoutBoard.gs — SAMURAI SCOUT 営業ボード（PC で毎日見るスプレッドシート）2026-10-20
 *
 * Daisuke「Run Kosalたちが日々パソコンで確認する Google スプレッドシートも。それを見て会話する。
 *          他への影響が出ないように・重くなりすぎない形で。Excel での確認も考慮して」
 *
 * - 別ファイル（スクリプトプロパティ SCOUT_BOARD_SPREADSHEET_ID）。v7 Database は読むだけで、書き込まない
 * - 1時間に1回、全部書き直す（夜 22時〜朝 6時 プノンペン時間は止める）。数式は使わず値だけ
 *   → Excel でダウンロードしてもそのまま読める・並べ替えられる
 * - アプリ（ミニアプリ・GAS の受付）とは別の入口。ここで失敗してもアプリには影響しない
 * - タブ: 📅 今日 / 🏪 お店一覧 / 📝 最近の記録 / 📈 週ごと
 *
 * 初回だけ GAS エディタで scoutBoardSetup() を実行（ファイル作成・自動更新の登録・1回目の書き込み）。
 * 共有（Run Kosalたちに「閲覧者」で）は Daisuke が Drive の画面で行う。
 */

const SCOUT_BOARD_PROP = 'SCOUT_BOARD_SPREADSHEET_ID';
const SCOUT_BOARD_TZ = 'Asia/Phnom_Penh';
const SCOUT_BOARD_TABS = { today: '📅 今日', shops: '🏪 お店一覧', recent: '📝 最近の記録', weekly: '📈 週ごと',
                           links: '🔗 提携店QR・グループ連携',   // links は ScoutBoardShopLinks.gs（2026-10-22）
                           // 提携の種類ごと（2026-10-27 Daisuke「タブで個人提携、車屋提携、商業施設提携みたいにわける」・ScoutBoardShopLinks.gs）
                           pIndiv: '🙋 個人提携', pShop: '🚗 車屋提携', pFacility: '🏢 商業施設提携' };
const SCOUT_BOARD_RECENT_DAYS = 30;
const SCOUT_BOARD_WEEKS = 8;
const SCOUT_BOARD_HEAD_BG = '#fbeec9';

/** 初回セットアップ（GAS エディタから1回だけ実行） */
function scoutBoardSetup() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty(SCOUT_BOARD_PROP);
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('SAMURAI SCOUT 営業ボード（見るだけ・1時間ごとに自動更新）');
    ss.setSpreadsheetTimeZone(SCOUT_BOARD_TZ);
    props.setProperty(SCOUT_BOARD_PROP, ss.getId());
  }
  Object.keys(SCOUT_BOARD_TABS).forEach(function(k) {
    if (!ss.getSheetByName(SCOUT_BOARD_TABS[k])) ss.insertSheet(SCOUT_BOARD_TABS[k]);
  });
  const first = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1) ss.deleteSheet(first);

  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'scoutBoardTick') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scoutBoardTick').timeBased().everyHours(1).create();

  scoutBoardRefresh();
  Logger.log('✅ 営業ボード: ' + ss.getUrl() + '（1時間ごとに自動更新を登録しました。共有は Drive の画面で「閲覧者」に）');
}

/** 1時間ごとの自動更新（夜は止める・同時に2つ走らない） */
function scoutBoardTick() {
  const hour = Number(Utilities.formatDate(new Date(), SCOUT_BOARD_TZ, 'H'));
  if (hour >= 22 || hour < 6) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try { scoutBoardRefresh(); }
  catch (e) { Logger.log('⚠️ scoutBoardTick: ' + e); }
  finally { lock.releaseLock(); }
}

/** 今すぐ書き直す（GAS エディタからも実行できる） */
function scoutBoardRefresh() {
  const id = PropertiesService.getScriptProperties().getProperty(SCOUT_BOARD_PROP);
  if (!id) { Logger.log('⚠️ 営業ボード未作成（scoutBoardSetup を実行してください）'); return; }
  const board = SpreadsheetApp.openById(id);
  const d = scoutBoardData_();
  const stamp = Utilities.formatDate(new Date(), SCOUT_BOARD_TZ, 'yyyy-MM-dd HH:mm');

  scoutBoardWriteToday_(board, d, stamp);
  scoutBoardWriteShops_(board, d);
  scoutBoardWriteRecent_(board, d);
  scoutBoardWriteWeekly_(board, d);
  // 提携店QR・グループ連携（ScoutBoardShopLinks.gs）。失敗しても他のタブには影響させない
  try { scoutBoardWriteShopLinks_(board, d); } catch (e) { Logger.log('⚠️ 営業ボード 提携店QRタブ: ' + e); }
}

// ====== データ（v7 Database を読むだけ） ======

function scoutBoardData_() {
  const shops = readSheetObjects_(getShopSheet_())
    .map(function(r) { return shopRowToApi_(r.obj); })
    .filter(function(s) { return s.shopId; });
  const shopById = {};
  shops.forEach(function(s) { shopById[s.shopId] = s; });

  const visits = readSheetObjects_(getSalesLogSheet_())
    .map(function(r) { return visitRowToApi_(r.obj); })
    .filter(function(v) { return v.visitId && v.shopId; });

  const ss = getSalesLogSs_();
  const noteSheet = ss.getSheetByName(NOTES_SHEET_NAME);
  const notes = noteSheet ? readSheetObjects_(noteSheet).filter(function(r) { return r.obj['note_id']; }).map(function(r) {
    return { datetime: formatSalesLogDateCell_(r.obj['日時']), shopId: String(r.obj['shop_id'] || ''), shopName: String(r.obj['店名'] || ''),
             staff: String(r.obj['記録者'] || ''), text: String(r.obj['内容'] || '') };
  }) : [];
  const hearSheet = ss.getSheetByName(HEARING_SHEET_NAME);
  const hearings = hearSheet ? readSheetObjects_(hearSheet).filter(function(r) { return r.obj['hearing_id']; }).map(function(r) {
    return { datetime: formatSalesLogDateCell_(r.obj['日時']), shopId: String(r.obj['shop_id'] || ''), shopName: String(r.obj['店名'] || ''),
             staff: String(r.obj['記録者'] || ''), mode: String(r.obj['種類'] || ''), mine: Number(r.obj['紹介料(月・USD)']) || 0,
             potential: String(r.obj['見込み評価'] || '') };
  }) : [];

  // 店ごとの「直近」（同じ分なら後の行）
  const lastVisit = {}, lastNote = {}, lastHear = {}, firstVisit = {};
  visits.forEach(function(v) {
    if (!lastVisit[v.shopId] || v.datetime >= lastVisit[v.shopId].datetime) lastVisit[v.shopId] = v;
    if (!firstVisit[v.shopId] || v.datetime < firstVisit[v.shopId]) firstVisit[v.shopId] = v.datetime;
  });
  notes.forEach(function(n) { if (!lastNote[n.shopId] || n.datetime >= lastNote[n.shopId].datetime) lastNote[n.shopId] = n; });
  hearings.forEach(function(h) { if (!lastHear[h.shopId] || h.datetime >= lastHear[h.shopId].datetime) lastHear[h.shopId] = h; });

  shops.forEach(function(s) {
    const v = lastVisit[s.shopId], n = lastNote[s.shopId], h = lastHear[s.shopId];
    const useNote = n && (!v || !v.memo || n.datetime >= v.datetime);
    s.lastMemo = useNote ? n.text : (v ? v.memo : '');
    s.nextAction = v ? v.nextAction : '';
    s.nextDue = v ? v.nextDue : '';
    s.potential = h ? h.potential : '';
    s.potentialMine = h ? h.mine : '';
  });

  return { shops: shops, shopById: shopById, visits: visits, notes: notes, hearings: hearings, firstVisit: firstVisit,
           today: Utilities.formatDate(new Date(), SCOUT_BOARD_TZ, 'yyyy-MM-dd') };
}

// ====== 書き込み（全部消して値だけ書く・数式なし） ======

function scoutBoardSheet_(board, key) {
  const sh = board.getSheetByName(SCOUT_BOARD_TABS[key]) || board.insertSheet(SCOUT_BOARD_TABS[key]);
  const f = sh.getFilter();
  if (f) f.remove();
  sh.clear();
  return sh;
}

/** 表を書く: 見出し1行＋データ。見出しは太字・色・固定、絞り込み（Excel のオートフィルタにもなる） */
function scoutBoardTable_(sh, startRow, headers, rows, widths, wrapCols) {
  const data = [headers].concat(rows.length ? rows : [headers.map(function(_, i) { return i === 0 ? '（なし）' : ''; })]);
  sh.getRange(startRow, 1, data.length, headers.length).setValues(data);
  sh.getRange(startRow, 1, 1, headers.length).setFontWeight('bold').setBackground(SCOUT_BOARD_HEAD_BG).setWrap(true);
  if (rows.length) {
    (wrapCols || []).forEach(function(c) { sh.getRange(startRow + 1, c, rows.length, 1).setWrap(true); });
    sh.getRange(startRow + 1, 1, rows.length, headers.length).setVerticalAlignment('top');
  }
  (widths || []).forEach(function(w, i) { if (w) sh.setColumnWidth(i + 1, w); });
  return data.length;
}

function scoutBoardMap_(s) {
  return (s.lat !== null && s.lng !== null && s.lat !== undefined) ? 'https://www.google.com/maps?q=' + s.lat + ',' + s.lng : '';
}

function scoutBoardWriteToday_(board, d, stamp) {
  const sh = scoutBoardSheet_(board, 'today');
  const t = d.today;
  const due = d.shops.filter(function(s) { return s.nextDue && s.nextDue <= t; })
    .sort(function(a, b) { return a.nextDue.localeCompare(b.nextDue); });
  const isToday = function(x) { return String(x.datetime).indexOf(t) === 0; };
  const counts = [
    ['今日の訪問 (Visits today)', d.visits.filter(isToday).length],
    ['今日のメモ (Notes today)', d.notes.filter(isToday).length],
    ['今日の計算 (Calcs today)', d.hearings.filter(isToday).length],
    ['フォロー期限切れ (Overdue)', due.filter(function(s) { return s.nextDue < t; }).length],
    ['未訪問の見込み (Not visited yet)', d.shops.filter(function(s) { return s.status === SALESLOG_UNVISITED; }).length],
    ['提携済 (Partners)', d.shops.filter(function(s) { return s.status === '提携済'; }).length]
  ];
  sh.getRange(1, 1, 2, 1).setValues([['SAMURAI SCOUT 営業ボード'], ['最終更新 ' + stamp + '（1時間ごとに自動更新。直すのはアプリで。このファイルは見るだけ）']]);
  sh.getRange(1, 1).setFontSize(16).setFontWeight('bold');
  sh.getRange(2, 1).setFontColor('#6f6859');
  sh.getRange(4, 1, counts.length, 2).setValues(counts);
  sh.getRange(4, 2, counts.length, 1).setFontWeight('bold').setHorizontalAlignment('left');
  const r0 = 5 + counts.length;
  sh.getRange(r0, 1).setValue('⏰ 今日やるフォロー（期限切れが上） / Follow-ups due').setFontWeight('bold').setFontSize(13);
  const rows = due.map(function(s) {
    return [s.nextDue, s.shopName, s.nextAction || '', s.lastReaction || '', s.lastMemo || '', s.phone || '', s.status || '', scoutBoardMap_(s)];
  });
  scoutBoardTable_(sh, r0 + 1,
    ['期日 (Due)', '店名 (Shop)', '次にやること (Next)', '前回の反応 (Reaction)', '前回メモ (Last note)', '電話 (Phone)', '状態 (Status)', '地図 (Map)'],
    rows, [230, 200, 200, 110, 320, 120, 90, 200], [3, 5]);
  sh.setFrozenRows(2);
}

function scoutBoardWriteShops_(board, d) {
  const sh = scoutBoardSheet_(board, 'shops');
  const rank = function(s) { return s.status === SALESLOG_UNVISITED ? 2 : (s.nextDue ? 0 : 1); };
  const list = d.shops.slice().sort(function(a, b) {
    return rank(a) - rank(b) || String(a.nextDue || '').localeCompare(String(b.nextDue || '')) ||
           String(b.lastVisit || '').localeCompare(String(a.lastVisit || '')) || a.shopName.localeCompare(b.shopName);
  });
  const rows = list.map(function(s) {
    return [s.shopName, s.status || '', s.lastReaction || '', s.potential || '', s.potentialMine === '' ? '' : s.potentialMine,
            s.visitCount || 0, s.lastVisit || '', s.nextAction || '', s.nextDue || '', s.lastMemo || '',
            (s.shopTypes || []).join('・'), s.phone || '', s.tier || '', s.address || '', scoutBoardMap_(s), s.shopId];
  });
  const n = scoutBoardTable_(sh, 1,
    ['店名 (Shop)', '状態 (Status)', '最新の反応 (Reaction)', '見込み (Potential)', '紹介料見込み $/月 (Est. commission)',
     '訪問回数 (Visits)', '最終訪問日 (Last visit)', '次にやること (Next)', '期日 (Due)', '前回メモ (Last note)',
     '業種 (Type)', '電話 (Phone)', 'Tier', '住所 (Address)', '地図 (Map)', 'shop_id'],
    rows, [200, 80, 90, 80, 110, 70, 100, 200, 100, 320, 130, 120, 50, 200, 200, 150], [8, 10]);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(1);
  sh.getRange(1, 1, n, 16).createFilter();
}

function scoutBoardWriteRecent_(board, d) {
  const sh = scoutBoardSheet_(board, 'recent');
  const from = Utilities.formatDate(new Date(Date.now() - SCOUT_BOARD_RECENT_DAYS * 86400000), SCOUT_BOARD_TZ, 'yyyy-MM-dd');
  const name = function(id, fallback) { return d.shopById[id] ? d.shopById[id].shopName : (fallback || id); };
  const rows = [];
  d.visits.forEach(function(v) {
    if (v.datetime < from) return;
    const parts = [];
    if (v.reaction) parts.push('反応 ' + v.reaction + ' ' + (SALESLOG_REACTION_LABELS[v.reaction] || ''));
    if (v.memo) parts.push(v.memo);
    if (v.nextAction || v.nextDue) parts.push('次: ' + [v.nextDue, v.nextAction].filter(String).join(' '));
    rows.push([v.datetime, '📍 訪問 (Visit)', name(v.shopId, v.shopName), '', parts.join(' ／ ')]);
  });
  d.notes.forEach(function(n) {
    if (n.datetime < from) return;
    rows.push([n.datetime, '🗒 メモ (Note)', name(n.shopId, n.shopName), n.staff, n.text]);
  });
  d.hearings.forEach(function(h) {
    if (h.datetime < from) return;
    rows.push([h.datetime, '🧮 計算 (Calc)', name(h.shopId, h.shopName), h.staff,
               '紹介料 ' + h.mine + '$/月（' + h.mode + '）' + (h.potential ? ' ・見込み ' + h.potential : '')]);
  });
  rows.sort(function(a, b) { return String(b[0]).localeCompare(String(a[0])); });
  const n = scoutBoardTable_(sh, 1, ['日時 (Date)', '種類 (Type)', '店名 (Shop)', '記録者 (By)', '内容 (Detail)'],
    rows, [130, 110, 200, 90, 480], [5]);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, n, 5).createFilter();
}

function scoutBoardWriteWeekly_(board, d) {
  const sh = scoutBoardSheet_(board, 'weekly');
  // 週は月曜はじまり（プノンペン時間）
  const today = new Date(d.today + 'T00:00:00Z');
  const dow = (today.getUTCDay() + 6) % 7;
  const weeks = [];
  for (let i = 0; i < SCOUT_BOARD_WEEKS; i++) {
    const start = new Date(today.getTime() - (dow + 7 * i) * 86400000);
    weeks.push({ from: start.toISOString().substring(0, 10), to: new Date(start.getTime() + 7 * 86400000).toISOString().substring(0, 10),
                 visits: 0, newShops: 0, notes: 0, calcs: 0, a: 0, b: 0 });
  }
  const put = function(dt, fn) {
    const day = String(dt).substring(0, 10);
    for (let i = 0; i < weeks.length; i++) if (day >= weeks[i].from && day < weeks[i].to) { fn(weeks[i]); return; }
  };
  d.visits.forEach(function(v) { put(v.datetime, function(w) { w.visits++; if (v.reaction === 'A') w.a++; if (v.reaction === 'B') w.b++; }); });
  Object.keys(d.firstVisit).forEach(function(id) { put(d.firstVisit[id], function(w) { w.newShops++; }); });
  d.notes.forEach(function(n) { put(n.datetime, function(w) { w.notes++; }); });
  d.hearings.forEach(function(h) { put(h.datetime, function(w) { w.calcs++; }); });
  const rows = weeks.map(function(w) { return [w.from, w.visits, w.newShops, w.a, w.b, w.notes, w.calcs]; });
  sh.getRange(1, 1).setValue('📈 週ごとの数字（月曜はじまり・新しい週が上） / Weekly numbers').setFontWeight('bold').setFontSize(13);
  scoutBoardTable_(sh, 2, ['週のはじめ (Week of)', '訪問 (Visits)', '初めて訪問した店 (New shops)', '反応A デモ決定', '反応B 興味あり',
                           'メモ (Notes)', '計算 (Calcs)'], rows, [130, 90, 150, 110, 110, 90, 90], []);
  sh.setFrozenRows(2);
}

// ====== ホーム画面用リンク（GAS エディタから実行・管理者だけが使える場所） ======

/**
 * スタッフ全員の SAMURAI SCOUT ホーム画面用リンクを実行ログに出す（2026-10-20）
 * Daisuke「Safari でホーム画面に追加したい。1タップで立ち上げ」「拡張機能も使ってすべて自動で」
 * - 鍵は現場アプリ v2 と同じ（FieldLink.gs・スタッフごと）。Telegram を開かなくても PC だけで作れる
 * - リンクの gas= は、スクリプトプロパティ SCOUT_GAS_URL（本番の /exec URL）。無ければ ScriptApp の URL
 * - リンクは本人だけに送る（他人に渡すとその人として記録できてしまう）。全員分を無効にする時は FIELD_LINK_SECRET を削除
 */
function scoutHomeLinks() {
  var gas = PropertiesService.getScriptProperties().getProperty('SCOUT_GAS_URL') || ScriptApp.getService().getUrl();
  var base = 'https://ec20921-debug.github.io/samurai-motors-miniapp/saleslog-internal.html';
  getActiveStaff().forEach(function(s) {
    if (!s.chatId) { Logger.log('— ' + (s.nameEn || s.nameJp) + '：Chat ID 未登録'); return; }
    Logger.log('🔗 ' + (s.nameEn || s.nameJp) + '：' + base + '?gas=' + encodeURIComponent(gas) +
               '&u=' + encodeURIComponent(s.chatId) + '&k=' + fieldLinkKey_(s.chatId));
  });
}
