/**
 * CampaignSheets.gs — キャンペーンのシート構築・セットアップ・定数定義
 *
 * 【責務】
 *   - キャンペーン関連の定数（シート名 / 送信設定 / 言語選択肢 / セル位置）
 *   - setupCampaign とその構成要素（フォルダ作成・メニュー登録・各シート生成）
 *   - 下書き / 配信履歴 / 配信台帳 の ensure*（冪等生成）、顧客列追加、台帳追記
 *
 * 【注意】GAS は全 .gs が同一グローバルスコープ。送信ロジック(Campaign.gs)が
 *   ここの定数・ensure 系・append 系をそのまま呼ぶ（import 不要）。
 *
 * 2026-05-31 Campaign.gs から構築系を分離（振る舞い不変・関数は移動のみ）。
 */

// === シート名 ===
const CAMPAIGN_DRAFT_SHEET  = 'キャンペーン下書き';
const CAMPAIGN_LOG_SHEET    = 'キャンペーン送信エラー'; // 失敗・ブロックした人だけ（届かなかった人）
const CAMPAIGN_LOG_SHEET_OLD = 'キャンペーン配信履歴';  // 旧名（自動リネーム用）
const CAMPAIGN_LEDGER_SHEET = 'キャンペーン台帳';     // 1配信=1行（いつ何を送ったか・全文保存）

// === 設定 ===
const CAMPAIGN_SEND_INTERVAL_MS = 50;   // 送信間ウェイト（20msg/秒）
const CAMPAIGN_MAX_RECIPIENTS   = 2000; // 1回の上限（6分制限の安全マージン）

// === 「言語」セル（B4）の選択肢 ===
// 2026-05-30 Daisuke 指示: クメール語＋英語を1通にまとめて全員に送るのがデフォルト。
// ここは「どの言語で送るか」の選択であり、送る相手は常に配信対象=☑ の全員。
const CAMPAIGN_LANG_BOTH    = 'クメール語＋英語（推奨）';
const CAMPAIGN_LANG_KM_ONLY = 'クメール語のみ';
const CAMPAIGN_LANG_EN_ONLY = '英語のみ';
const CAMPAIGN_AUDIENCE_OPTIONS = [CAMPAIGN_LANG_BOTH, CAMPAIGN_LANG_KM_ONLY, CAMPAIGN_LANG_EN_ONLY];

// === 下書きシートのセル位置（レイアウト変更時はここを直す） ===
const CAMPAIGN_CELL = {
  AUDIENCE:  'B4',
  NOTE_JP:   'B5',  // 内容(日本語) — 振り返り用の端的なメモ
  TEXT_KM:   'B6',
  TEXT_EN:   'B7',
  IMAGE_URL: 'B8',
  VOICE_URL: 'B9',
  VIDEO_URL: 'B10',
  RESULT_AT:    'B14',
  RESULT_STATS: 'B15',
  RESULT_ID:    'B16'
};

// =====================================================
//  セットアップ
// =====================================================

/**
 * キャンペーン機能の初期セットアップ（1回だけ実行）
 *   - 下書き／履歴シートを作成（既存なら維持）
 *   - 顧客シートに「配信対象」「最終配信日時」列を追加（冪等）
 *   - onOpen トリガーを登録（旧 BroadcastTool の孤立トリガーも掃除）
 */
function setupCampaign() {
  ensureCampaignDraftSheet_();
  ensureCampaignLogSheet_();
  ensureCampaignLedgerSheet_();   // 配信台帳（いつ何を送ったか・全文）
  ensureCustomerBroadcastColumns_();
  setupCampaignDriveFolder_();   // 素材フォルダ作成 + 下書きシートにリンク記載（冪等）
  ensureCampaignAssetsSheet_();  // 素材カタログシート（CampaignAssets.gs）
  scanCampaignAssets_();         // フォルダ走査→一覧更新→B8/B9/B10 ドロップダウン適用
  repairCampaignLanguageCell();  // 既存シートの B4 言語ドロップダウンを最新仕様へ
  ensureCampaignScheduleSheet_();// 予約投稿シート（CampaignScheduler.gs）。トリガーは別途 setupCampaignSchedule
  setupCampaignMenu_();
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ キャンペーン機能 セットアップ完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('  - 「' + CAMPAIGN_DRAFT_SHEET + '」シート 準備OK');
  Logger.log('  - 「' + CAMPAIGN_LOG_SHEET + '」シート 準備OK');
  Logger.log('  - 「' + CAMPAIGN_ASSETS_SHEET + '」シート 準備OK（📂 素材一覧を更新 で読込）');
  Logger.log('  - 「顧客」シートに 配信対象 / 最終配信日時 列 準備OK');
  Logger.log('  - 素材フォルダ リンクを下書きシート B11 に記載');
  Logger.log('  - onOpen メニュー登録済み → シートを開き直してください');
}

/**
 * キャンペーン素材フォルダを Drive に用意し、下書きシート B11 にリンクを記載する（冪等）
 *
 * - フォルダ ID は ScriptProperties('DRIVE_FOLDER_CAMPAIGN') に保存して再利用
 * - 公開共有はしない（GAS が所有者権限で読むため、画像/動画送信に公開は不要）
 *   ※ ロン君に渡す場合は Daisuke が手動でフォルダ共有してください（権限変更は人が行う）
 */
function setupCampaignDriveFolder_() {
  const props = PropertiesService.getScriptProperties();
  let folder = null;
  const savedId = props.getProperty('DRIVE_FOLDER_CAMPAIGN');
  if (savedId) {
    try { folder = DriveApp.getFolderById(savedId); } catch (e) { folder = null; }
  }
  if (!folder) {
    const name = 'Samurai Motors キャンペーン素材';
    const it = DriveApp.getFoldersByName(name);
    folder = it.hasNext() ? it.next() : DriveApp.createFolder(name);
    props.setProperty('DRIVE_FOLDER_CAMPAIGN', folder.getId());
  }

  // 下書きシート 11行目（注釈の上の空き行）に素材フォルダ案内を記載
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (sh) {
    sh.getRange('A11').setValue('📁 素材フォルダ')
      .setFontWeight('bold').setBackground('#e8f0e0').setVerticalAlignment('top');
    sh.getRange('B11').setValue(folder.getUrl()).setFontSize(10).setWrap(true);
    sh.getRange('C11').setValue('← ここに画像/ボイス/動画を入れて、各ファイルのリンクを上の欄(B8/B9/B10)に貼る')
      .setFontColor('#888').setFontSize(9).setFontStyle('italic');
  }
  Logger.log('  📁 素材フォルダ: ' + folder.getUrl());
  return folder;
}

/**
 * 既存の「キャンペーン下書き」シートを壊さずに、B4の言語ドロップダウンと
 * A4/C4ラベルだけを最新仕様に貼り直す（2026-05-30 の言語モード変更の反映用）。
 * setupCampaign は既存シートを作り直さないため、この軽量修復を別途用意。
 */
function repairCampaignLanguageCell() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (!sh) {
    SpreadsheetApp.getUi().alert('「' + CAMPAIGN_DRAFT_SHEET + '」シートがありません。先に setupCampaign を実行してください。');
    return;
  }
  sh.getRange('A4').setValue('言語').setFontWeight('bold').setBackground('#f0e8d0');
  const b4 = sh.getRange('B4');
  // 旧値（全員 等）なら新デフォルトに置換。新3択のいずれかなら尊重。
  const cur = String(b4.getValue() || '').trim();
  if (CAMPAIGN_AUDIENCE_OPTIONS.indexOf(cur) < 0) b4.setValue(CAMPAIGN_LANG_BOTH);
  b4.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(CAMPAIGN_AUDIENCE_OPTIONS, true)
      .setAllowInvalid(false).build()
  );
  sh.getRange('C4').setValue('← 配信対象=☑ の全員に、この言語で送ります（推奨=クメール語＋英語を1通に）')
    .setFontColor('#888').setFontSize(9).setFontStyle('italic');

  // 内容（日本語）行を既存シートにも追加（無ければ）
  if (String(sh.getRange('A5').getValue() || '').trim() !== '内容（日本語）') {
    sh.getRange('A5').setValue('内容（日本語）').setFontWeight('bold').setBackground('#f0e8d0');
    sh.getRange('C5').setValue('← 例:「6/1 ローンチ告知 $5/$10」。台帳に残り日本側で振り返れる（任意）')
      .setFontColor('#888').setFontSize(9).setFontStyle('italic');
  }
  SpreadsheetApp.getActiveSpreadsheet().toast('言語セル(B4)・内容(日本語)行を最新仕様に更新しました', '修復完了', 5);
}

function setupCampaignMenu_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // 自分のトリガー + 旧 BroadcastTool の孤立トリガーを削除
  ScriptApp.getProjectTriggers().forEach(function(t) {
    const fn = t.getHandlerFunction();
    if (fn === 'campaignOnOpen_' || fn === 'broadcastMenuOnOpen_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('campaignOnOpen_')
    .forSpreadsheet(ss).onOpen().create();
  try { campaignOnOpen_(); } catch (e) { Logger.log('⚠️ onOpen 即時実行: ' + e); }
}

function campaignOnOpen_() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📢 キャンペーン')
    // ── 一斉送信フロー（下書き → 配信対象 → 送信）が主役 ──
    .addItem('① 下書きを準備（このタブで本文・画像を編集）', 'openCampaignDraftSheet')
    .addItem('② 配信対象を選ぶ（顧客タブで一括ON/OFF）', 'openCustomerSheetForTargeting')
    .addItem('③ プレビュー（送信先と内容を確認）', 'previewCampaign')
    .addItem('④ 一斉送信を実行', 'sendCampaign')
    .addSeparator()
    .addItem('🧪 テスト送信（自分のチャットIDへ）', 'testSendCampaign')
    .addSubMenu(ui.createMenu('☑ 配信対象 一括操作')
      .addItem('全員を ON（☑）', 'setAllBroadcastOn')
      .addItem('全員を OFF（☐）', 'setAllBroadcastOff')
      .addSeparator()
      .addItem('選択した行だけ ON', 'setSelectedBroadcastOn')
      .addItem('選択した行だけ OFF', 'setSelectedBroadcastOff'))
    .addSeparator()
    .addSubMenu(ui.createMenu('🗓 配信予約（曜日・時刻で自動配信）')
      .addItem('配信予約シートを開く', 'openCampaignScheduleSheet')
      .addSeparator()
      .addItem('👁 選択した配信予約をプレビュー', 'previewScheduledRow')
      .addItem('🧪 選択した配信予約をテスト送信（自分へ）', 'testSendScheduledRow'))
    .addSeparator()
    .addItem('📂 素材一覧を更新（フォルダから読込）', 'refreshCampaignAssets')
    .addItem('📒 配信台帳を開く（いつ何を送ったか）', 'openCampaignLedgerSheet')
    .addItem('📋 送信エラーを開く（失敗・ブロックのみ）', 'openCampaignLogSheet')
    .addSeparator()
    .addItem('❓ 使い方', 'showCampaignHelp_')
    .addSubMenu(ui.createMenu('⚙️ その他・メンテ')
      .addItem('📤 1人だけに手入力で送る（下書き不使用）', 'sendMessageToSelectedCustomer')
      .addItem('🗓 配信予約のセットアップ（初回/トリガー再登録）', 'setupCampaignSchedule')
      .addItem('🔧 シート再生成（壊した時の復旧）', 'setupCampaign'))
    .addToUi();
}

function ensureCampaignDraftSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (sh) return sh; // 既存なら内容を壊さない

  sh = ss.insertSheet(CAMPAIGN_DRAFT_SHEET);

  // タイトル
  sh.getRange('A1:B1').merge()
    .setValue('📢 キャンペーン下書き')
    .setBackground('#1a1a1a').setFontColor('#c9a84c')
    .setFontSize(16).setFontWeight('bold')
    .setHorizontalAlignment('center');
  sh.setRowHeight(1, 36);

  sh.getRange('A2:B2').merge()
    .setValue('本文を編集 →  メニュー「📢 キャンペーン」→「① プレビュー」→「② 一斉送信を実行」')
    .setFontColor('#666').setFontSize(10)
    .setHorizontalAlignment('center');

  // 言語（どの言語で全員に送るか）
  sh.getRange('A4').setValue('言語').setFontWeight('bold').setBackground('#f0e8d0');
  const audience = sh.getRange('B4');
  audience.setValue(CAMPAIGN_LANG_BOTH); // デフォルト=クメール語＋英語
  audience.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(CAMPAIGN_AUDIENCE_OPTIONS, true)
      .setAllowInvalid(false).build()
  );
  sh.getRange('C4').setValue('← 配信対象=☑ の全員に、この言語で送ります（推奨=クメール語＋英語を1通に）')
    .setFontColor('#888').setFontSize(9).setFontStyle('italic');

  // 内容（日本語）— 振り返り用メモ。台帳に転記される
  sh.getRange('A5').setValue('内容（日本語）').setFontWeight('bold').setBackground('#f0e8d0');
  sh.getRange('B5').setValue('');
  sh.getRange('C5').setValue('← 例:「6/1 ローンチ告知 $5/$10」。台帳に残り日本側で振り返れる（任意）')
    .setFontColor('#888').setFontSize(9).setFontStyle('italic');

  // 本文（クメール語）
  sh.getRange('A6').setValue('本文（クメール語）').setFontWeight('bold').setBackground('#f0e8d0').setVerticalAlignment('top');
  sh.getRange('B6').setValue(
    '🎉 ការផ្តល់ជូនពិសេសសប្តាហ៍នេះ!\n\n' +
    'សម្រាប់អតិថិជនដែលបានចុះឈ្មោះតាម Telegram\n' +
    '👉 តម្លៃពិសេស! (ផ្ញើសារមកយើងដើម្បីកក់)\n\n' +
    '📞 ផ្ញើ សារ ឬ សារសំឡេង មកកាន់យើងបាន!\n' +
    'បុគ្គលិកខ្មែររបស់យើងនឹងទាក់ទងទៅអ្នកវិញ 🚗✨'
  ).setWrap(true).setVerticalAlignment('top').setFontSize(11);
  sh.setRowHeight(6, 150);

  // 本文（英語）
  sh.getRange('A7').setValue('本文（英語）任意').setFontWeight('bold').setBackground('#f0e8d0').setVerticalAlignment('top');
  sh.getRange('B7').setValue(
    '🎉 SPECIAL OFFER THIS WEEK!\n\n' +
    'For customers registered via Telegram:\n' +
    '👉 Special price! (Message us to book)\n\n' +
    '📞 Send us a text OR voice message — anything works!\n' +
    'Our Cambodian staff will get back to you 🚗✨'
  ).setWrap(true).setVerticalAlignment('top').setFontSize(11);
  sh.setRowHeight(7, 150);

  // 画像 Drive リンク（任意）
  sh.getRange('A8').setValue('画像 Driveリンク（任意）').setFontWeight('bold').setBackground('#e8f0e0').setVerticalAlignment('top');
  sh.getRange('B8').setValue('').setWrap(true).setFontSize(10);
  sh.getRange('C8').setValue('← チラシ等。空なら画像なし。本文がキャプションになる')
    .setFontColor('#888').setFontSize(9).setFontStyle('italic');

  // ボイス Drive リンク（任意）
  sh.getRange('A9').setValue('ボイス Driveリンク（任意）').setFontWeight('bold').setBackground('#e8f0e0').setVerticalAlignment('top');
  sh.getRange('B9').setValue('').setWrap(true).setFontSize(10);
  sh.getRange('C9').setValue('← クメール語ボイス。OGG推奨（MP3/M4Aも自動対応）')
    .setFontColor('#888').setFontSize(9).setFontStyle('italic');

  // 動画 Drive リンク（任意）
  sh.getRange('A10').setValue('動画 Driveリンク（任意）').setFontWeight('bold').setBackground('#e8f0e0').setVerticalAlignment('top');
  sh.getRange('B10').setValue('').setWrap(true).setFontSize(10);
  sh.getRange('C10').setValue('← before/after等。必ず50MB以内に圧縮。動画がある時は画像より優先')
    .setFontColor('#888').setFontSize(9).setFontStyle('italic');

  // 注釈
  sh.getRange('A12:B12').merge()
    .setValue('💡 B4の「言語」設定で全員に同じ内容を送ります（推奨=クメール語＋英語を1通に）。' +
              '「顧客」シートの「配信対象」=☑ の人だけに届きます。')
    .setFontColor('#888').setFontSize(9).setFontStyle('italic')
    .setHorizontalAlignment('center');
  sh.setRowHeight(12, 30);

  // 最終結果
  sh.getRange('A13:B13').merge()
    .setValue('━━━ 最終配信結果（自動更新） ━━━')
    .setBackground('#1a1a1a').setFontColor('#c9a84c')
    .setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange('A14').setValue('送信日時');
  sh.getRange('A15').setValue('成功 / 失敗 / ブロック');
  sh.getRange('A16').setValue('キャンペーンID');
  ['A14', 'A15', 'A16'].forEach(function(a) {
    sh.getRange(a).setFontWeight('bold').setBackground('#f8f4e8');
  });

  // 列幅・凍結
  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(2, 600);
  sh.setColumnWidth(3, 360);
  sh.setFrozenRows(2);

  return sh;
}

function ensureCampaignLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 旧名「キャンペーン配信履歴」が残っていれば新名へリネーム（自動移行）。
  // 新名が未作成のときだけ。両方ある場合は触らない（手動対応を優先）。
  const oldSh = ss.getSheetByName(CAMPAIGN_LOG_SHEET_OLD);
  if (oldSh && !ss.getSheetByName(CAMPAIGN_LOG_SHEET)) {
    oldSh.setName(CAMPAIGN_LOG_SHEET);
  }

  let sh = ss.getSheetByName(CAMPAIGN_LOG_SHEET);
  if (sh) {
    // 旧10列フォーマットが残っていたら新7列ヘッダーに作り替える（データはまだ無い前提）
    const firstHeader = String(sh.getRange(1, 7).getValue() || '');
    if (firstHeader === '添付' || firstHeader === '結果') {
      // 7列目が「理由」でなければ旧版 → ヘッダーだけ貼り直す
      const want = ['キャンペーンID', '送信日時', '顧客ID', 'チャットID', '氏名', '結果', '理由'];
      if (String(sh.getRange(1, 6).getValue()) !== '結果' || String(sh.getRange(1, 7).getValue()) !== '理由') {
        if (sh.getLastRow() >= 1) sh.getRange(1, 1, 1, Math.max(10, sh.getLastColumn())).clearContent();
        sh.getRange(1, 1, 1, want.length).setValues([want])
          .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
      }
    }
    return sh;
  }

  sh = ss.insertSheet(CAMPAIGN_LOG_SHEET);
  // 失敗・ブロックのみ記録するスリム版（成功は台帳の件数で見る）
  const headers = [
    'キャンペーンID', '送信日時', '顧客ID', 'チャットID', '氏名', '結果', '理由'
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  // 説明メモ（このシートは例外だけが載る、を明示）
  sh.getRange('A2').setValue('（このシートには「失敗・ブロックされた人」だけが記録されます。空＝全員成功）')
    .setFontColor('#999').setFontStyle('italic');

  const widths = [180, 160, 100, 130, 140, 80, 320];
  widths.forEach(function(w, i) { sh.setColumnWidth(i + 1, w); });

  return sh;
}

/**
 * 「キャンペーン台帳」シートを用意（1配信=1行・全文保存）
 * 「いつ・何を・何語で・誰に・成否」を1行で振り返れる台帳。
 * 本文は全文、添付はファイル名（解決できた場合）を残す。
 */
function ensureCampaignLedgerSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const headers = [
    'キャンペーンID', '送信日時', '言語', '内容(日本語)',
    '本文(クメール語)', '本文(英語)', '添付ファイル',
    '送信数', '成功', '失敗', 'ブロック', '反応メモ'
  ];
  const widths = [180, 160, 120, 260, 340, 340, 240, 70, 70, 70, 80, 280];

  let sh = ss.getSheetByName(CAMPAIGN_LEDGER_SHEET);
  if (sh) {
    // 旧ヘッダー（内容(日本語)なし＝D列が「本文(クメール語)」）なら D列を挿入して移行
    if (String(sh.getRange(1, 4).getValue()) === '本文(クメール語)') {
      sh.insertColumnBefore(4);
      sh.getRange(1, 4).setValue('内容(日本語)');
      sh.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
      sh.setColumnWidth(4, 260);
    }
    return sh;
  }

  sh = ss.insertSheet(CAMPAIGN_LEDGER_SHEET);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  widths.forEach(function(w, i) { sh.setColumnWidth(i + 1, w); });
  return sh;
}

/**
 * 台帳に1配信ぶんの行を追記する（全文・添付名・集計を1行で）
 *
 * @param {Object} draft     readCampaignDraft_ の結果
 * @param {Object} result    executeBroadcast_ の戻り（campaignId/sentAt/total/success/failed/blocked）
 * @param {string} langLabel 'クメール語＋英語' 等
 */
function appendCampaignLedger_(draft, result, langLabel) {
  try {
    const sh = ensureCampaignLedgerSheet_();
    // 添付は「ファイル名（あれば）/ 無ければURL」を種別ラベル付きで連結
    const parts = [];
    if (draft.videoUrl) parts.push('動画: ' + assetLabelForLedger_(draft.videoUrl));
    if (draft.imageUrl) parts.push('画像: ' + assetLabelForLedger_(draft.imageUrl));
    if (draft.voiceUrl) parts.push('ボイス: ' + assetLabelForLedger_(draft.voiceUrl));
    const attach = parts.length ? parts.join('\n') : '—';

    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
    sh.appendRow([
      result.campaignId,
      Utilities.formatDate(result.sentAt, tz, 'yyyy-MM-dd HH:mm:ss'),
      langLabel,
      draft.noteJp || '',   // 内容(日本語) — 振り返り用の端的な日本語メモ
      draft.textKm || '',
      draft.textEn || '',
      attach,
      result.total,
      result.success,
      result.failed,
      result.blocked,
      ''  // 反応メモ（週末に人が追記）
    ]);
  } catch (e) {
    Logger.log('⚠️ appendCampaignLedger_ 失敗（配信自体は完了）: ' + e);
  }
}

/**
 * 台帳の添付表示用ラベル。素材一覧から名前を逆引きできればファイル名、
 * できなければURL末尾やURLそのものを返す。
 */
function assetLabelForLedger_(url) {
  // 素材一覧でリンク→名前の逆引きを試みる
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const a = ss.getSheetByName('キャンペーン素材');
    if (a && a.getLastRow() >= 2) {
      const data = a.getRange(2, 1, a.getLastRow() - 1, 5).getValues();
      // URL から Drive fileId を抽出して突合
      const m = String(url).match(/[?&]id=([a-zA-Z0-9_-]+)|\/file\/d\/([a-zA-Z0-9_-]+)/);
      const fid = m ? (m[1] || m[2]) : '';
      for (let i = 0; i < data.length; i++) {
        const link = String(data[i][4] || '');
        const lm = link.match(/[?&]id=([a-zA-Z0-9_-]+)|\/file\/d\/([a-zA-Z0-9_-]+)/);
        const lfid = lm ? (lm[1] || lm[2]) : '';
        if ((fid && lfid && fid === lfid) || link === url) {
          return String(data[i][1]); // ファイル名
        }
      }
    }
  } catch (e) { /* 逆引き失敗時は URL を返す */ }
  return String(url);
}

/**
 * 「顧客」シートに「配信対象」「最終配信日時」列を追加（冪等）
 *   - 配信対象: チェックボックス。既存顧客はデフォルト ☑（送る）
 *   - 最終配信日時: 直近配信日時の記録用
 */
function ensureCustomerBroadcastColumns_() {
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const lastRow = sheet.getLastRow();
  let headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);

  // 配信対象（列が無ければ作成）
  if (!headers['配信対象']) {
    const col = sheet.getLastColumn() + 1;
    sheet.getRange(1, col).setValue('配信対象')
      .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
    sheet.setColumnWidth(col, 80);
    Logger.log('  ➕ 顧客シートに「配信対象」列を追加');
    headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  }

  // 配信対象列の「全データ行」にチェックボックス書式を再適用（冪等）。
  // 後から appendRow で増えた行（値だけで書式なし=TRUE文字表示）を
  // 正しいチェックボックスに揃える。空欄は ☑(true) で初期化。
  const targetCol = headers['配信対象'];
  if (targetCol && lastRow >= 2) {
    const rng = sheet.getRange(2, targetCol, lastRow - 1, 1);
    rng.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    // 空欄セルだけ true で埋める（既存の TRUE/FALSE は尊重）
    const cur = rng.getValues();
    let filled = 0;
    for (let i = 0; i < cur.length; i++) {
      const v = cur[i][0];
      if (v === '' || v === null) { cur[i][0] = true; filled++; }
    }
    if (filled > 0) rng.setValues(cur);
    Logger.log('  ☑ 配信対象列にチェックボックス書式を再適用（空欄 ' + filled + ' 件を ☑ で初期化）');
  }

  // 最終配信日時
  if (!headers['最終配信日時']) {
    const col = sheet.getLastColumn() + 1;
    sheet.getRange(1, col).setValue('最終配信日時')
      .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
    sheet.setColumnWidth(col, 160);
    Logger.log('  ➕ 顧客シートに「最終配信日時」列を追加');
  }
}

/**
 * 指定行の「配信対象」セルにチェックボックス書式を付ける（新規登録時に呼ぶ）。
 * appendRow は値のみで書式を付けないため、登録経路から個別に適用して
 * 「TRUE 文字」表示を防ぐ。失敗しても登録自体は止めない。
 *
 * @param {number} rowIndex - 1-based の対象行
 */
function applyBroadcastCheckboxToRow_(rowIndex) {
  try {
    const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
    const headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
    const col = headers['配信対象'];
    if (!col || !rowIndex || rowIndex < 2) return;
    sheet.getRange(rowIndex, col)
      .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  } catch (e) {
    Logger.log('⚠️ applyBroadcastCheckboxToRow_ error: ' + e);
  }
}
