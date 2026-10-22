/**
 * ScoutBoardShopLinks.gs — 営業ボードの「🔗 提携店QR・グループ連携」タブ（2026-10-22）
 *
 * Daisuke「QR はRun Kosalがラベル印刷してチラシに貼る時にも関わる大事な作業。網羅的に把握したい」
 *          「店ごとのグループ名・招待手順・送る文の一覧を」「統一したところで提携先・QR・グループ番号を一元管理」
 *
 * - 営業ボード（ScoutBoard.gs）の1時間ごとの書き直しに相乗りする。v7 Database は読むだけ
 * - 店ごとに: 連携の状態 / 作るグループ名 / グループで送る文（/register <コード>）/ 予約QRのURL /
 *   流入（QRを読んだ人 → 予約画面 → 予約 → 施工完了 → 売上・取り分）/ 実際のグループ名・連携日時
 * - 対象: 店マスターの「QRリンク(BookingBot)」に予約Botのリンクがある店（= 専用QRを配った店）と、Bot連携シートにある店。
 *   【サンプル】行（SHOP-SAMPLE-xxx）は除く
 * - 流入はファネルログの bot_start / ソース shop:<shop_id>（v7 本番 @82・2026-10-21 14:15 以降）。
 *   予約・施工・売上は、その店のQRを読んだお客様（チャットID）の予約すべて（2回目以降も含む）
 * - 同日 v2: スマホでコピーしやすい列順（店名 → QRのURL → 連携 → 送る文）・シール枚数/最終日（ShopQrSticker.gs が店マスターに書く）・
 *   あいさつ文は右端・全行を折り返さず1行の高さに揃える。手順は「アプリでQRを出す → 印刷 → 記録 → グループ」の順
 */

const SCOUT_LINKS_TAB_KEY = 'links';
const SCOUT_LINKS_BOT = 'SAMURAI_MOTORS_BOOKING_BOT';
// グループに最初に送るあいさつ文（{shop} に店名）。クメール語は Panha 校閲（provisional・Run Kosal 確認待ち）
const SCOUT_LINKS_GREETING_KM =
  'នេះជាក្រុមរបស់ {shop} និង SAMURAI MOTORS។\n' +
  'សម្រាប់ភ្ញៀវដែលកក់តាម QR របស់ហាងអ្នក យើងនឹងផ្ញើសារពេលចាប់ផ្តើម និងបញ្ចប់ការលាងសម្អាត ព្រមទាំងរូបថត មុន / ក្រោយ មកក្រុមនេះ។\n' +
  'នៅដើមខែនីមួយៗ យើងនឹងផ្ញើរបាយការណ៍ប្រចាំខែ ដែលបង្ហាញចំនួនការងារ និងចំនួនទឹកប្រាក់ ផងដែរ។\n' +
  'សូមអរគុណដែលសហការជាមួយយើង ហើយសូមបន្តដើរជាមួយគ្នា!';
const SCOUT_LINKS_GREETING_EN =
  'This is the group for {shop} × SAMURAI MOTORS.\n' +
  'For customers who book through your shop\'s QR, you\'ll see start and finish updates and Before/After photos here.\n' +
  'At the start of each month, we\'ll also send a monthly report with the number of jobs and the amounts.\n' +
  'Thank you for working with us. We look forward to a great partnership!';

function scoutBoardWriteShopLinks_(board, d) {
  const sh = scoutBoardSheet_(board, SCOUT_LINKS_TAB_KEY);
  const rows = scoutLinksRows_();

  const steps = [
    ['🔗 提携店QR・グループ連携（1時間ごとに自動更新・見るだけ） / Partner shop QR & group link'],
    ['QRシールの作り方（お店がOKした時・スマホで） / How to make the QR sticker'],
    ['① 営業アプリのお店の画面 →「🔗 このお店のQRを出す」→「📋 URLをコピー」（この表の「予約QRのURL」をコピーしてもよい） / In the app: issue QR → copy URL'],
    ['② ラベル印刷アプリに貼り付けてシールを印刷 → 自分のスマホで1回読んで確認（「QRを読んだ人」が増える） / Paste into the label app → print → scan once to check'],
    ['③ アプリで「🏷 QRシールを渡した」に枚数を記録（この表の「シール枚数」に出る） / Record the sticker count in the app'],
    ['お店の Telegram グループの作り方 / How to set up the shop group'],
    ['④ Telegram で「新しいグループ」→ お店の人（オーナー）と 予約Bot @' + SCOUT_LINKS_BOT + ' を追加。グループ名は「作るグループ名」をコピペ / New group → add the owner and the bot'],
    ['⑤「グループで送る文」（/register 6桁）を送る → Bot が「✅ Connected!」と返したら完了 → 続けて「あいさつ文」（右端の列）を送る / Send the /register line, then the greeting'],
    ['⚠️ コード（6桁）はその店のグループでだけ使う。社外に出さない（他の人が使うとお店の写真が別のグループに届く） / Never share the codes outside']
  ];
  sh.getRange(1, 1, steps.length, 1).setValues(steps);
  sh.getRange(1, 1).setFontSize(14).setFontWeight('bold');
  sh.getRange(2, 1).setFontWeight('bold');
  sh.getRange(6, 1).setFontWeight('bold');
  sh.getRange(steps.length, 1).setFontColor('#b3261e');

  const r0 = steps.length + 2;
  // スマホで開いた時に「店名 → QRのURL → 連携 → 送る文」が横スクロールなしで見える順（2026-10-22）。
  // あいさつ文（長い・全店同じ形）は右端へ。1行の高さを揃えるため折り返さない
  const headers = ['No', '店名 (Shop)', '予約QRのURL (QR link)', '連携 (Linked)', 'グループで送る文 (Send in group)',
    '作るグループ名 (Group name)', 'シール枚数 (Stickers)', 'シール最終日 (Last sticker)',
    'QRを読んだ人 (Scanned)', '予約画面を開いた人 (Opened)', '予約 (Bookings)',
    '施工完了 (Done)', '売上 USD (Sales)', '店の取り分 USD (Shop share)', 'SAMURAI USD', '取り分の率 (Rate %)',
    '実際のグループ名 (Actual group)', '連携日時 (Linked at)', 'あいさつ文 (Greeting)', 'shop_id'];
  const n = scoutBoardTable_(sh, r0, headers, rows,
    [36, 160, 260, 90, 140, 230, 80, 100, 80, 90, 70, 70, 80, 90, 80, 70, 200, 130, 360, 220], []);
  if (rows.length) {
    sh.getRange(r0 + 1, 1, rows.length, headers.length).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
    sh.setRowHeightsForced(r0 + 1, rows.length, 24);
  }
  sh.setFrozenRows(r0);
  sh.setFrozenColumns(2);
  if (rows.length) sh.getRange(r0, 1, n, headers.length).createFilter();
}

/** 表の行を作る（v7 Database の 店マスター・Bot連携・ファネルログ・予約 を読むだけ） */
function scoutLinksRows_() {
  const ss = getSalesLogSs_();
  const shopRows = readSheetObjects_(getShopSheet_());
  const shopById = {};
  shopRows.forEach(function(r) { const id = String(r.obj['shop_id'] || '').trim(); if (id) shopById[id] = r.obj; });

  // Bot連携: 同じ shop_id は 連携済 → 待機中 → その他 の順に1行（v7 ShopRouting.findShopLinkByShopId_ と同じ）
  const linkSheet = ss.getSheetByName(SHOP_PROV_LINK_SHEET);
  const rank = { '連携済': 3, '待機中': 2 };
  const linkById = {};
  (linkSheet ? readSheetObjects_(linkSheet) : []).forEach(function(r) {
    const id = String(r.obj['shop_id'] || '').trim();
    if (!id) return;
    const rk = rank[String(r.obj['状態'])] || 1;
    if (!linkById[id] || rk > linkById[id].rk) linkById[id] = { rk: rk, obj: r.obj };
  });

  // 対象の店（店マスターの QR リンクの順 → Bot連携だけにある店）
  const ids = [];
  const isSample = function(id, name) { return id.indexOf('SHOP-SAMPLE') === 0 || String(name || '').indexOf('【サンプル】') === 0; };
  shopRows.forEach(function(r) {
    const id = String(r.obj['shop_id'] || '').trim();
    if (id && !isSample(id, r.obj['店名']) && /t\.me\/[^?\s]+\?start=shop_/.test(String(r.obj['QRリンク(BookingBot)'] || ''))) ids.push(id);
  });
  Object.keys(linkById).forEach(function(id) {
    if (ids.indexOf(id) < 0 && !isSample(id, (linkById[id].obj || {})['店名'])) ids.push(id);
  });

  const funnel = scoutLinksFunnel_(ss);
  const bookings = scoutLinksBookings_(ss);

  return ids.map(function(id, i) {
    const shop = shopById[id] || {};
    const link = linkById[id] ? linkById[id].obj : null;
    const name = String(shop['店名'] || (link && link['店名']) || id);
    const st = link ? String(link['状態'] || '') : '';
    const linked = st === '連携済';
    const code = (link && st === '待機中') ? String(link['ワンタイムコード'] || '') : '';
    const qr = 'https://t.me/' + SCOUT_LINKS_BOT + '?start=shop_' + id;

    // 流入: その店のQRを読んだお客様（重複なし）→ 予約画面・予約・施工・売上
    const chats = funnel.scans[id] || {};
    const chatIds = Object.keys(chats);
    let opened = 0, booked = 0, done = 0, sales = 0;
    chatIds.forEach(function(c) {
      if (funnel.opened[c]) opened++;
      (bookings[c] || []).forEach(function(b) {
        if (b.status === 'キャンセル') return;
        booked++;
        if (b.status === '作業完了') { done++; sales += b.amount; }
      });
    });
    const rate = (typeof shopCommissionTerms_ === 'function' && shopById[id]) ? shopCommissionTerms_(shop).rate : 30;
    const shopShare = Math.round(sales * rate) / 100;

    return [
      i + 1,
      name,
      qr,
      linked ? '✅ 連携済' : (code ? '⏳ 未連携' : '— コード未発行'),
      linked ? '（連携済み・送らなくてよい）' : (code ? '/register ' + code : '（コード未発行: アプリのお店の画面で「🔗 このお店のQRを出す」を押す）'),
      name + ' × SAMURAI MOTORS',
      Number(shop['QRシール枚数']) || 0,
      formatSalesLogDateCell_(shop['QRシール最終日']).substring(0, 10),
      chatIds.length, opened, booked, done,
      Math.round(sales * 100) / 100, shopShare, Math.round((sales - shopShare) * 100) / 100, rate,
      linked ? String(link['グループ名'] || '') : '',
      linked ? String(link['紐付け日時'] || '') : '',
      (SCOUT_LINKS_GREETING_KM ? SCOUT_LINKS_GREETING_KM.replace(/\{shop\}/g, name) + '\n\n' : '') + SCOUT_LINKS_GREETING_EN.replace(/\{shop\}/g, name),
      id
    ];
  });
}

/** ファネルログ: 店QRの読み取り（bot_start / shop:<id>）と予約画面を開いたお客様 */
function scoutLinksFunnel_(ss) {
  const out = { scans: {}, opened: {} };
  const sh = ss.getSheetByName('ファネルログ');
  if (!sh || sh.getLastRow() < 2) return out;
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(String);
  const ci = head.indexOf('チャットID'), ei = head.indexOf('イベント'), si = head.indexOf('ソース');
  if (ci < 0 || ei < 0 || si < 0) return out;
  values.forEach(function(r) {
    const chat = String(r[ci] || '').trim(), ev = String(r[ei] || ''), src = String(r[si] || '');
    if (!chat) return;
    if (ev === 'bot_start' && src.indexOf('shop:') === 0) {
      const id = src.substring(5);
      (out.scans[id] = out.scans[id] || {})[chat] = true;
    } else if (ev === 'miniapp_opened') {
      out.opened[chat] = true;
    }
  });
  return out;
}

/** 予約タブ: チャットID → [{status, amount}] */
function scoutLinksBookings_(ss) {
  const out = {};
  const sh = ss.getSheetByName('予約');
  if (!sh || sh.getLastRow() < 2) return out;
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(String);
  const ci = head.indexOf('チャットID'), li = head.indexOf('進行状態'), ki = head.indexOf('料金(USD)');
  if (ci < 0 || li < 0) return out;
  values.forEach(function(r) {
    const chat = String(r[ci] || '').trim();
    if (!chat) return;
    (out[chat] = out[chat] || []).push({ status: String(r[li] || ''), amount: ki >= 0 ? (Number(r[ki]) || 0) : 0 });
  });
  return out;
}
