/**
 * TabLayout.gs — v7 Database のタブ整理（並び・タブの色・表示/非表示・見出し行の見た目）
 *
 * 2026-10-27 Daisuke「タブが増えすぎて見づらい。色を付けて見やすく。1か月更新のないシートは一旦非表示」
 *
 * 使い方: シートのメニュー「📈 経営ダッシュボード → 🗂 タブを整える」
 *   - 何度実行しても同じ結果（冪等）。タブの名前・中身のデータには触らない
 *   - 新しいタブが増えたら TAB_LAYOUT に1行足す。載っていないタブは末尾に回すだけ（表示/非表示・色は触らない）
 *   - 非表示のタブは左下の「≡（すべてのシート）」から選ぶと表示に戻る。戻したら TAB_LAYOUT の表示も true に
 */

// グループごとの色（tab = タブの色 / head = 見出し行の背景 / band = 1行おきの薄い色）
const TAB_GROUPS = {
  DASH:  { tab: '#C9A84C' },                                      // 経営ダッシュボード（BK_COLOR.gold と同じ）
  DAILY: { tab: '#E06666', head: '#F4CCCC', band: '#FCF1F1' },    // 毎日の現場（予約・作業・顧客）
  SALES: { tab: '#6FA8DC', head: '#CFE2F3', band: '#F1F7FC' },    // 営業・提携
  SETUP: { tab: '#93C47D', head: '#D9EAD3', band: '#F3F9F1' },    // 設定（料金・営業時間など）
  LOG:   { tab: '#999999', head: '#E8E8E8', band: '#F7F7F7' },    // 自動の記録・使っていないタブ
};

// 上から順にタブを並べる。[タブ名, グループ, 表示するか, 見出し行を整えるか]
// 見出し行を整える = 1行目の背景色・太字・1行目の固定・1行おきの色（既に1行おきの色があるタブは触らない）
// 経営ダッシュボード / Picasso管理 / パートナー精算 はプログラムが見た目まで作るので整えない
const TAB_LAYOUT = [
  ['経営ダッシュボード', 'DASH',  true,  false],
  ['予約',               'DAILY', true,  true],
  ['作業記録',           'DAILY', true,  true],
  ['顧客',               'DAILY', true,  true],
  ['店マスター',         'SALES', true,  true],
  ['営業ログ',           'SALES', true,  true],
  ['Bot連携',            'SALES', true,  true],
  ['流入元',             'SALES', true,  true],
  ['Picasso管理',        'SALES', true,  false],
  ['パートナー精算',     'SALES', true,  false],
  ['紹介チラシの版',     'SALES', true,  true],
  ['紹介チラシ送付履歴', 'SALES', true,  true],
  ['メニュー',           'SETUP', true,  true],
  ['設定',               'SETUP', true,  true],
  ['チャット履歴',       'LOG',   true,  true],
  // ここから下は非表示（2026-10-27 時点で1か月以上更新なし・または役目を終えたタブ）
  ['休業日',             'SETUP', false, false],   // 最後の登録 9/2
  ['スタッフ',           'SETUP', false, false],   // 登録1名のまま変更なし
  ['QRコード',           'SETUP', false, false],   // 2026-04-23 から変更なし
  ['見込み取込_確認',    'LOG',   false, false],   // 10/20 の取り込みで役目終了
  ['ヒアリングメモ',     'SALES', false, false],   // 元から非表示
  ['パートナー仮申込み', 'LOG',   false, false],   // 元から非表示（回答0件）
  ['特価キャンペーン',   'LOG',   false, false],
  ['キャンペーン配信予約', 'LOG', false, false],
  ['キャンペーン素材',   'LOG',   false, false],
  ['キャンペーン下書き', 'LOG',   false, false],
  ['キャンペーン台帳',   'LOG',   false, false],
  ['キャンペーン送信エラー', 'LOG', false, false],
  ['ファネルログ',       'LOG',   false, false],
  ['車両',               'LOG',   false, false],
  ['_経営キャッシュ',    'LOG',   false, false],
];

/**
 * メニューから実行: タブを並べ替え → 色 → 見出し行 → 表示/非表示 の順に整える
 */
function tidyDatabaseTabs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('この GAS はスプレッドシート紐付きで実行してください（v7 は container-bound）');
  const sheets = ss.getSheets();
  const byName = {};
  sheets.forEach(function(sh) { byName[sh.getName()] = sh; });

  // 1) 並び順: TAB_LAYOUT の順 → 載っていないタブは今の順のまま末尾へ
  const known = {};
  const order = [];
  TAB_LAYOUT.forEach(function(row) {
    known[row[0]] = true;
    if (byName[row[0]]) order.push(byName[row[0]]);
  });
  const unknown = sheets.filter(function(sh) { return !known[sh.getName()]; });
  const unknownHidden = unknown.filter(function(sh) { return sh.isSheetHidden(); });   // 表に無いタブは元の表示/非表示に戻す
  // 並べ替えは表示中のタブで行う（非表示のタブを選ぶと表示に戻ってしまうため、先に全部表示してから最後に隠し直す）
  order.concat(unknown).forEach(function(sh) { if (sh.isSheetHidden()) sh.showSheet(); });
  order.concat(unknown).forEach(function(sh, i) {
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(i + 1);
  });

  // 2) タブの色・見出し行
  TAB_LAYOUT.forEach(function(row) {
    const sh = byName[row[0]];
    if (!sh) return;
    const g = TAB_GROUPS[row[1]];
    sh.setTabColor(g.tab);
    if (row[3]) styleHeaderRow_(sh, g);
  });

  // 3) 表示/非表示（表示するタブを先に戻してから隠す＝全部非表示になるエラーを避ける）
  TAB_LAYOUT.forEach(function(row) {
    const sh = byName[row[0]];
    if (sh && row[2]) sh.showSheet();
  });
  TAB_LAYOUT.forEach(function(row) {
    const sh = byName[row[0]];
    if (sh && !row[2]) sh.hideSheet();
  });
  unknownHidden.forEach(function(sh) { sh.hideSheet(); });

  if (byName['経営ダッシュボード']) ss.setActiveSheet(byName['経営ダッシュボード']);
  SpreadsheetApp.flush();

  const msg = '✅ タブを整えました（表示 ' + TAB_LAYOUT.filter(function(r) { return r[2] && byName[r[0]]; }).length
    + ' / 非表示 ' + TAB_LAYOUT.filter(function(r) { return !r[2] && byName[r[0]]; }).length + '）'
    + (unknown.length ? '\n一覧に載っていないタブ（末尾に移動・色はそのまま）: ' + unknown.map(function(sh) { return sh.getName(); }).join('、') : '');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* エディタ実行時は UI なし */ }
}

/**
 * 1行目（見出し）を色付き・太字・固定にし、データ部分に1行おきの薄い色を付ける。
 * 既に1行おきの色があるタブ・固定行を自分で決めているタブはそのまま。
 */
function styleHeaderRow_(sh, g) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return;
  sh.getRange(1, 1, 1, lastCol)
    .setBackground(g.head)
    .setFontWeight('bold')
    .setFontColor('#1F1F1F')
    .setVerticalAlignment('middle');
  if (sh.getFrozenRows() === 0) sh.setFrozenRows(1);
  if (sh.getBandings().length === 0) {
    const band = sh.getRange(1, 1, sh.getMaxRows(), lastCol)
      .applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
    band.setHeaderRowColor(g.head)
      .setFirstRowColor('#FFFFFF')
      .setSecondRowColor(g.band);
  }
}
