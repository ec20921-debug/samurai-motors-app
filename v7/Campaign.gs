/**
 * Campaign.gs — 顧客向けキャンペーン一斉送信 + 個別連絡（統合版）
 *
 * 【責務】
 *   スプレッドシートのメニューから、登録済み顧客へ予約Bot経由で
 *   - 一斉送信（テキスト / 画像 / ボイス、言語別出し分け）
 *   - 個別送信（選択行の1名へ）
 *   を行い、結果を記録する。
 *
 * 【Option A 統合 (2026-05-29)】
 *   旧 BroadcastTool.gs（📩 顧客連絡 個別送信）を本ファイルに吸収・廃止。
 *   キャンペーン系メニューを「📢 キャンペーン」1本に集約（メニュー乱立防止）。
 *
 * 【使い方】
 *   1. `setupCampaign()` を1回だけ実行
 *      → 「キャンペーン下書き」「キャンペーン配信履歴」シート生成
 *      → 「顧客」シートに「配信対象」「最終配信日時」列を追加
 *      → onOpen トリガー登録（旧📩メニューの孤立トリガーも掃除）
 *   2. スプレッドシートを開き直す
 *   3. 「キャンペーン下書き」シートに本文（＋任意で画像/ボイスのDriveリンク）を記入
 *   4. メニュー「📢 キャンペーン」→「① プレビュー」で送信先と内容を確認
 *   5. 「② 送信実行」で配信開始（最終確認ダイアログあり）
 *   6. 結果は「キャンペーン配信履歴」シートに自動記録
 *
 * 【設計方針】
 *   - 顧客接点は予約Bot1本に統一（BOT_TYPE.BOOKING を使う）
 *   - 全員に同じ内容を送る。何語で送るかは下書きB4の「言語」設定で決まる:
 *       クメール語＋英語（デフォルト/推奨）= 1通に両方をまとめて送信
 *       クメール語のみ / 英語のみ = その言語だけ
 *     （顧客の「言語」列での絞り込みはしない。2026-05-30 Daisuke 指示）
 *   - 「配信対象」チェックボックス=FALSE の顧客は一斉送信から除外（苦情客/ブロック客）
 *   - 50ms 間隔 = 20msg/秒 で送信（Telegram レート制限 30msg/秒 の安全圏）
 *   - 429（Too Many Requests）は retry_after に従って1回リトライ
 *   - 403（bot blocked）は履歴に「blocked」と記録して継続
 *   - 画像は既存 sendQRImage() を流用（Driveリンク/外部URL両対応）
 *   - ボイスは sendVoiceFromUrl()（sendVoice→sendAudio フォールバック）
 *   - 動画は sendVideoFromUrl()。初回アップロードの file_id を再利用して
 *     再アップロードを避ける（50名×動画でも6分制限内に収める）。50MB上限。
 *   - メイン送信の優先順位: 動画 > 画像 > テキスト（本文=キャプション）
 *   - 6分実行制限に備え、CAMPAIGN_MAX_RECIPIENTS で上限ガード
 *
 * 【2価格分離の原則（SPEC_CampaignBroadcast.md）】
 *   テレグラム限定特価（例:5ドル）は本文に手書きするのみ。
 *   料金設定/メニューシートには絶対に入れない（公開客に漏れるため）。
 */

// === シート名 ===
const CAMPAIGN_DRAFT_SHEET  = 'キャンペーン下書き';
const CAMPAIGN_LOG_SHEET    = 'キャンペーン配信履歴'; // 1人×1配信=1行（誰に届いたか）
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
  SpreadsheetApp.getActiveSpreadsheet().toast('言語セル(B4)を最新仕様に更新しました', '修復完了', 5);
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
    .addItem('① プレビュー（送信先と内容を確認）', 'previewCampaign')
    .addItem('② 一斉送信を実行', 'sendCampaign')
    .addItem('🧪 テスト送信（自分のチャットIDへ）', 'testSendCampaign')
    .addSeparator()
    .addItem('📤 選択した顧客に1通だけ送信', 'sendMessageToSelectedCustomer')
    .addSubMenu(ui.createMenu('☑ 配信対象 一括操作')
      .addItem('全員を ON（☑）', 'setAllBroadcastOn')
      .addItem('全員を OFF（☐）', 'setAllBroadcastOff')
      .addSeparator()
      .addItem('選択した行だけ ON', 'setSelectedBroadcastOn')
      .addItem('選択した行だけ OFF', 'setSelectedBroadcastOff'))
    .addSeparator()
    .addItem('📂 素材一覧を更新（フォルダから読込）', 'refreshCampaignAssets')
    .addItem('📒 配信台帳を開く（いつ何を送ったか）', 'openCampaignLedgerSheet')
    .addItem('📋 配信履歴を開く（誰に届いたか）', 'openCampaignLogSheet')
    .addItem('❓ 使い方', 'showCampaignHelp_')
    .addItem('🔧 シート再生成（壊した時の復旧）', 'setupCampaign')
    .addToUi();
}

// =====================================================
//  下書きシート構築
// =====================================================

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
  let sh = ss.getSheetByName(CAMPAIGN_LOG_SHEET);
  if (sh) return sh;

  sh = ss.insertSheet(CAMPAIGN_LOG_SHEET);
  const headers = [
    'キャンペーンID', '送信日時', '顧客ID', 'チャットID', '氏名',
    '言語', '添付', '結果', 'エラー詳細', '本文プレビュー'
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  const widths = [180, 160, 100, 130, 140, 90, 100, 80, 220, 400];
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
  let sh = ss.getSheetByName(CAMPAIGN_LEDGER_SHEET);
  if (sh) return sh;

  sh = ss.insertSheet(CAMPAIGN_LEDGER_SHEET);
  const headers = [
    'キャンペーンID', '送信日時', '言語',
    '本文(クメール語)', '本文(英語)', '添付ファイル',
    '送信数', '成功', '失敗', 'ブロック', '反応メモ'
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  const widths = [180, 160, 120, 360, 360, 260, 70, 70, 70, 80, 300];
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

  // 配信対象
  if (!headers['配信対象']) {
    const col = sheet.getLastColumn() + 1;
    sheet.getRange(1, col).setValue('配信対象')
      .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
    sheet.setColumnWidth(col, 80);
    if (lastRow >= 2) {
      const rng = sheet.getRange(2, col, lastRow - 1, 1);
      rng.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
      const vals = [];
      for (let i = 0; i < lastRow - 1; i++) vals.push([true]); // 既存顧客はデフォルト送る
      rng.setValues(vals);
    }
    Logger.log('  ➕ 顧客シートに「配信対象」列を追加');
    headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
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

function openCampaignLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_LOG_SHEET);
  if (!sh) {
    SpreadsheetApp.getUi().alert('履歴シートが存在しません。「🔧 シート再生成」を実行してください。');
    return;
  }
  ss.setActiveSheet(sh);
}

function openCampaignLedgerSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_LEDGER_SHEET);
  if (!sh) {
    SpreadsheetApp.getUi().alert('台帳シートが存在しません。「🔧 シート再生成」を実行してください。');
    return;
  }
  ss.setActiveSheet(sh);
}

// =====================================================
//  プレビュー
// =====================================================

function previewCampaign() {
  const ui = SpreadsheetApp.getUi();
  try {
    const draft = readCampaignDraft_();
    const recipients = buildRecipientList_();
    const total = recipients.length;

    if (total === 0) {
      ui.alert('⚠️ 送信先が0名です',
        '「配信対象=☑」の顧客がいません。', ui.ButtonSet.OK);
      return;
    }
    if (!draft.textKm && !draft.textEn) {
      ui.alert('⚠️ 本文が空です',
        'クメール語または英語のいずれかに本文を入力してください。', ui.ButtonSet.OK);
      return;
    }

    // 実際に送られる言語の説明
    let langDesc;
    if (draft.audience === CAMPAIGN_LANG_KM_ONLY)      langDesc = 'クメール語のみ';
    else if (draft.audience === CAMPAIGN_LANG_EN_ONLY) langDesc = '英語のみ';
    else langDesc = 'クメール語＋英語（1通にまとめて）';

    const previewKm = draft.textKm ? draft.textKm.substring(0, 300) : '(空)';
    const previewEn = draft.textEn ? draft.textEn.substring(0, 300) : '(空)';

    // 素材名がリンクに解決できたか（名前のまま残っている＝フォルダ未更新/ファイル名違い）
    var assetWarn = '';
    if (typeof isAssetUrl_ === 'function') {
      var bad = [];
      if (draft.imageUrl && !isAssetUrl_(draft.imageUrl)) bad.push('画像「' + draft.imageUrl + '」');
      if (draft.voiceUrl && !isAssetUrl_(draft.voiceUrl)) bad.push('ボイス「' + draft.voiceUrl + '」');
      if (draft.videoUrl && !isAssetUrl_(draft.videoUrl)) bad.push('動画「' + draft.videoUrl + '」');
      if (bad.length) {
        assetWarn = '⚠️ 素材が見つかりません: ' + bad.join(', ') + '\n' +
          '　「📂 素材一覧を更新」してから正しいファイル名を選んでください\n\n';
      }
    }

    const msg =
      assetWarn +
      '🎯 送信先\n' +
      '  合計: ' + total + '名（配信対象=☑ の全員）\n' +
      '  送信言語: ' + langDesc + '\n' +
      '\n' +
      '📎 添付\n' +
      '  動画: ' + (draft.videoUrl ? 'あり ✅（画像より優先）' : 'なし') + '\n' +
      '  画像: ' + (draft.imageUrl ? 'あり ✅' : 'なし') + '\n' +
      '  ボイス: ' + (draft.voiceUrl ? 'あり ✅' : 'なし') + '\n' +
      '\n' +
      '📝 本文（クメール語）\n' +
      '────────────────\n' +
      previewKm + '\n' +
      '\n' +
      '📝 本文（英語）\n' +
      '────────────────\n' +
      previewEn + '\n' +
      '\n' +
      '※ これはプレビューです。送信は「② 一斉送信を実行」から。';

    ui.alert('📢 キャンペーン プレビュー', msg, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('❌ プレビュー失敗', String(err && err.message || err), ui.ButtonSet.OK);
  }
}

// =====================================================
//  送信実行
// =====================================================

function sendCampaign() {
  const ui = SpreadsheetApp.getUi();

  let draft, recipients;
  try {
    draft = readCampaignDraft_();
    recipients = buildRecipientList_();
  } catch (err) {
    ui.alert('❌ 設定読込失敗', String(err && err.message || err), ui.ButtonSet.OK);
    return;
  }

  if (recipients.length === 0) {
    ui.alert('⚠️ 送信先が0名です',
      '「配信対象=☑」の顧客がいません。', ui.ButtonSet.OK);
    return;
  }
  if (!draft.textKm && !draft.textEn) {
    ui.alert('⚠️ 本文が空です', '本文を入力してください。', ui.ButtonSet.OK);
    return;
  }
  if (recipients.length > CAMPAIGN_MAX_RECIPIENTS) {
    ui.alert('⚠️ 送信先が多すぎます',
      '送信先 ' + recipients.length + '名 が上限 ' + CAMPAIGN_MAX_RECIPIENTS + ' を超えています。',
      ui.ButtonSet.OK);
    return;
  }

  // 動画サイズ事前チェック（Telegram Bot のアップロード上限は 50MB）
  if (draft.videoUrl) {
    const mb = driveSizeMB_(draft.videoUrl);
    if (mb > 50) {
      ui.alert('⚠️ 動画が大きすぎます',
        '動画サイズ ' + mb.toFixed(1) + 'MB は Telegram の上限 50MB を超えています。\n' +
        '50MB以内（推奨20MB以下）に圧縮してから再実行してください。',
        ui.ButtonSet.OK);
      return;
    }
  }

  // 最終確認
  const attachNote =
    (draft.videoUrl ? '\n🎬 動画添付あり（画像より優先）' : '') +
    (draft.imageUrl ? '\n📷 画像添付あり' : '') +
    (draft.voiceUrl ? '\n🎤 ボイス添付あり' : '');
  const confirm = ui.alert(
    '⚠️ 最終確認：本当に送信しますか？',
    recipients.length + ' 名 にメッセージを送信します。' + attachNote + '\n\n' +
    'この操作は取り消せません。よろしいですか？',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) {
    ui.alert('🚫 キャンセルしました');
    return;
  }

  // 配信実行
  const result = executeBroadcast_(draft, recipients);

  // 下書きシートに最終結果を書き戻す
  writeCampaignSummary_(result);

  ui.alert('📢 配信完了',
    '✅ 成功: ' + result.success + ' 件\n' +
    '❌ 失敗: ' + result.failed + ' 件\n' +
    '🚫 ブロック済み: ' + result.blocked + ' 件\n' +
    '\n' +
    'キャンペーンID: ' + result.campaignId + '\n\n' +
    '📒 何を送ったか →「' + CAMPAIGN_LEDGER_SHEET + '」（1配信=1行・全文）\n' +
    '👥 誰に届いたか →「' + CAMPAIGN_LOG_SHEET + '」（1人=1行・成否）',
    ui.ButtonSet.OK
  );
}

// =====================================================
//  テスト送信（自分のチャットIDだけに実物を送る）
// =====================================================

/**
 * 下書きの実物（テキスト＋画像/ボイス/動画）を、指定した1つのチャットIDだけに送る。
 * 配信履歴・最終配信日時には記録しない（本番配信と混ざらない）。
 * 50名のチェックを触らず安全に「見え方」を確認するためのもの。
 */
function testSendCampaign() {
  const ui = SpreadsheetApp.getUi();
  let draft;
  try { draft = readCampaignDraft_(); }
  catch (err) { ui.alert('❌ 設定読込失敗', String(err && err.message || err), ui.ButtonSet.OK); return; }

  if (!draft.textKm && !draft.textEn && !draft.imageUrl && !draft.voiceUrl && !draft.videoUrl) {
    ui.alert('⚠️ 本文も添付もありません', '下書きを入力してから実行してください。', ui.ButtonSet.OK);
    return;
  }
  if (draft.videoUrl) {
    const mb = driveSizeMB_(draft.videoUrl);
    if (mb > 50) {
      ui.alert('⚠️ 動画が大きすぎます',
        mb.toFixed(1) + 'MB は上限50MBを超えています。圧縮してください。', ui.ButtonSet.OK);
      return;
    }
  }

  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('CAMPAIGN_TEST_CHAT_ID') || '';
  const resp = ui.prompt('🧪 テスト送信',
    'テスト送信先の Telegram チャットID を入力してください。\n' +
    '（自分のチャットID。予約Botを /start 済みであること）' +
    (saved ? '\n\n空欄のままOKで前回のID（' + saved + '）を使います。' : ''),
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  let chatId = String(resp.getResponseText() || '').trim();
  if (!chatId) chatId = saved;
  if (!chatId) { ui.alert('⚠️ チャットIDが空です'); return; }
  props.setProperty('CAMPAIGN_TEST_CHAT_ID', chatId);

  const text = draft.textKm || draft.textEn; // クメール語優先（多数派の見え方）
  const cache = { id: '' };
  let res;
  if (draft.videoUrl)      res = sendCampaignVideo_(chatId, draft.videoUrl, text, cache);
  else if (draft.imageUrl) res = sendCampaignPhoto_(chatId, draft.imageUrl, text);
  else                     res = sendCampaignText_(chatId, text);

  let voiceNote = '';
  if (draft.voiceUrl) {
    const vr = sendVoiceFromUrl(BOT_TYPE.BOOKING, chatId, draft.voiceUrl, {});
    voiceNote = '\nボイス: ' + (vr && vr.ok ? '✅ 送信' : '❌ 失敗');
  }

  const cls = classifyTgResult_(res);
  if (cls.ok) {
    ui.alert('🧪 テスト送信 完了',
      'チャットID ' + chatId + ' に送信しました。\nTelegram を確認してください。' + voiceNote + '\n\n' +
      '※ テスト送信は配信履歴・最終配信日時には記録しません。',
      ui.ButtonSet.OK);
  } else {
    ui.alert('❌ テスト送信 失敗',
      '原因: ' + (cls.error || '不明') + voiceNote + '\n\n' +
      'チャットIDが正しいか、相手が予約Botを開始(/start)済みか確認してください。',
      ui.ButtonSet.OK);
  }
}

// =====================================================
//  内部処理
// =====================================================

function readCampaignDraft_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (!sh) {
    throw new Error('「' + CAMPAIGN_DRAFT_SHEET +
      '」シートが見つかりません。メニューの「🔧 シート再生成」を実行してください。');
  }
  // 画像/ボイス/動画は「ファイル名」でも「リンク直貼り」でもOK。
  // resolveAssetValue_(CampaignAssets.gs) が ファイル名→リンク へ自動解決する。
  const resolve = (typeof resolveAssetValue_ === 'function')
    ? resolveAssetValue_
    : function(x) { return String(x || '').trim(); };
  return {
    audience: String(sh.getRange(CAMPAIGN_CELL.AUDIENCE).getValue() || CAMPAIGN_LANG_BOTH).trim(),
    textKm:   String(sh.getRange(CAMPAIGN_CELL.TEXT_KM).getValue() || '').trim(),
    textEn:   String(sh.getRange(CAMPAIGN_CELL.TEXT_EN).getValue() || '').trim(),
    imageUrl: resolve(sh.getRange(CAMPAIGN_CELL.IMAGE_URL).getValue()),
    voiceUrl: resolve(sh.getRange(CAMPAIGN_CELL.VOICE_URL).getValue()),
    videoUrl: resolve(sh.getRange(CAMPAIGN_CELL.VIDEO_URL).getValue())
  };
}

/**
 * 顧客シートから配信対象リストを構築
 *   - チャットID が空の顧客は除外（Bot から送信不可能）
 *   - 「配信対象」=FALSE の顧客は除外（空欄/未設定は送る扱い=後方互換）
 *   - rowIndex を保持（送信後に「最終配信日時」を書き戻すため）
 *
 * 2026-05-30: 顧客の「言語」列での絞り込みは廃止。送る相手は常に
 * 「配信対象=☑ の全員」。何語で送るかは下書きの「言語」設定(B4)で決まり、
 * 全員に同じ内容（クメール語＋英語 など）が届く。
 */
function buildRecipientList_() {
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  const idCol     = headers['顧客ID'];
  const chatCol   = headers['チャットID'];
  const nameCol   = headers['氏名'];
  const targetCol = headers['配信対象'];   // 無い場合もある（後方互換）
  if (!chatCol) throw new Error('「顧客」シートに「チャットID」列が見つかりません');

  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const list = [];
  data.forEach(function(row, idx) {
    const chatId = String(row[chatCol - 1] || '').trim();
    if (!chatId) return;

    // 配信対象フィルタ: 明示的 FALSE のみ除外。空欄/未設定/TRUE は送る。
    if (targetCol) {
      const t = row[targetCol - 1];
      if (t === false || String(t).toUpperCase() === 'FALSE') return;
    }

    list.push({
      customerId: idCol  ? String(row[idCol  - 1] || '') : '',
      chatId:     chatId,
      name:       nameCol ? String(row[nameCol - 1] || '') : '',
      rowIndex:   idx + 2   // データは2行目開始
    });
  });
  return list;
}

/**
 * 顧客1件あたりの本文を決定（全員に同じ内容を送る）
 *
 * 2026-05-30 Daisuke 指示で「言語」設定ベースに変更:
 *   - クメール語＋英語（デフォルト）: 両方を区切り線でつないで1通に
 *   - クメール語のみ / 英語のみ: その言語だけ
 * いずれも顧客の「言語」列は見ない（全員に同じものを送る）。
 * 片方の本文が空なら、もう片方だけを送る（フォールバック）。
 */
function pickCampaignText_(draft, recipient) {
  const km = draft.textKm || '';
  const en = draft.textEn || '';
  if (draft.audience === CAMPAIGN_LANG_KM_ONLY) return km || en;
  if (draft.audience === CAMPAIGN_LANG_EN_ONLY) return en || km;
  // デフォルト = クメール語＋英語を1通にまとめる
  if (km && en) return km + '\n\n━━━━━━━━━━\n\n' + en;
  return km || en;
}

/**
 * Telegram レスポンスを成否分類する
 * @return {{ok:boolean, blocked:boolean, error:string, retryAfter:number}}
 */
function classifyTgResult_(res) {
  if (res && res.ok) return { ok: true, blocked: false, error: '', retryAfter: 0 };
  const desc = (res && res.description) ? String(res.description) : (res && res.error) ? String(res.error) : '';
  const errCode = (res && res.error_code) ? Number(res.error_code) : 0;
  if (errCode === 429 && res.parameters && res.parameters.retry_after) {
    return { ok: false, blocked: false, error: desc, retryAfter: Number(res.parameters.retry_after) };
  }
  if (errCode === 403 || /blocked|deactivated|user is deactivated|kicked|chat not found/i.test(desc)) {
    return { ok: false, blocked: true, error: desc || ('error_code=' + errCode), retryAfter: 0 };
  }
  return { ok: false, blocked: false, error: desc || ('error_code=' + errCode), retryAfter: 0 };
}

/**
 * ブロードキャスト本体
 */
function executeBroadcast_(draft, recipients) {
  const campaignId = 'CAMP-' + Utilities.formatDate(
    new Date(), 'Asia/Phnom_Penh', 'yyyyMMdd-HHmmss'
  );
  const sentAt = new Date();
  const attachParts = [];
  if (draft.videoUrl) attachParts.push('動画');
  if (draft.imageUrl) attachParts.push('画像');
  if (draft.voiceUrl) attachParts.push('ボイス');
  const attachLabel = attachParts.length ? attachParts.join('+') : '—';
  // 配信履歴の「言語」列に入れるラベル（全員に同じ内容を送るため配信単位で1つ）
  let langLabel;
  if (draft.audience === CAMPAIGN_LANG_KM_ONLY)      langLabel = 'クメール語';
  else if (draft.audience === CAMPAIGN_LANG_EN_ONLY) langLabel = '英語';
  else langLabel = 'クメール語＋英語';

  let success = 0, failed = 0, blocked = 0;
  const logRows = [];
  const sentRowIndexes = [];
  // 動画は初回アップロードで得た file_id を再利用（再アップロード回避→6分制限のタイムアウト防止）
  const videoCache = { id: '' };

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const text = pickCampaignText_(draft, r);
    const preview = text ? (text.length > 80 ? text.substring(0, 80) + '…' : text) : '';

    if (!text && !draft.imageUrl && !draft.voiceUrl && !draft.videoUrl) {
      failed += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, langLabel,
                    attachLabel, 'failed', '本文・添付すべて空', '']);
      continue;
    }

    // メイン送信の優先順位: 動画 > 画像 > テキスト（本文=キャプション）
    let mainRes;
    if (draft.videoUrl) {
      mainRes = sendCampaignVideo_(r.chatId, draft.videoUrl, text, videoCache);
    } else if (draft.imageUrl) {
      mainRes = sendCampaignPhoto_(r.chatId, draft.imageUrl, text);
    } else {
      mainRes = sendCampaignText_(r.chatId, text);
    }
    const cls = classifyTgResult_(mainRes);

    // ボイスは best-effort（メイン結果は変えない）
    if (draft.voiceUrl && (cls.ok || !cls.blocked)) {
      try { sendVoiceFromUrl(BOT_TYPE.BOOKING, r.chatId, draft.voiceUrl, {}); }
      catch (e) { Logger.log('⚠️ voice 送信失敗 chatId=' + r.chatId + ': ' + e); }
    }

    if (cls.ok) {
      success += 1;
      sentRowIndexes.push(r.rowIndex);
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, langLabel,
                    attachLabel, 'success', '', preview]);
    } else if (cls.blocked) {
      blocked += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, langLabel,
                    attachLabel, 'blocked', cls.error || 'bot blocked', preview]);
    } else {
      failed += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, langLabel,
                    attachLabel, 'failed', cls.error || 'unknown', preview]);
    }

    if (i < recipients.length - 1) {
      Utilities.sleep(CAMPAIGN_SEND_INTERVAL_MS);
    }
  }

  // 履歴シートに一括書き込み
  if (logRows.length > 0) {
    const logSh = ensureCampaignLogSheet_();
    logSh.getRange(logSh.getLastRow() + 1, 1, logRows.length, logRows[0].length)
      .setValues(logRows);
  }

  // 顧客シートの「最終配信日時」を成功分だけ更新
  updateCustomerLastBroadcast_(sentRowIndexes, sentAt);

  const result = {
    campaignId: campaignId,
    sentAt:     sentAt,
    total:      recipients.length,
    success:    success,
    failed:     failed,
    blocked:    blocked,
    langLabel:  langLabel
  };

  // 台帳に1行追記（いつ・何を・何語で・送信数/成否を全文保存）
  appendCampaignLedger_(draft, result, langLabel);

  return result;
}

/**
 * テキスト1件送信（429リトライ込み）
 */
function sendCampaignText_(chatId, text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = sendMessage(BOT_TYPE.BOOKING, chatId, text, { disable_web_page_preview: true });
    const cls = classifyTgResult_(res);
    if (cls.ok) return res;
    if (cls.retryAfter > 0) { Utilities.sleep((cls.retryAfter + 1) * 1000); continue; }
    return res;
  }
  return { ok: false, description: '429 リトライ後も失敗' };
}

/**
 * 写真1件送信（本文をキャプションに）。429リトライ込み。
 * 既存 sendQRImage()（Driveリンク/外部URL両対応）を流用。
 */
function sendCampaignPhoto_(chatId, imageUrl, caption) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = sendQRImage(chatId, imageUrl, caption);
    const cls = classifyTgResult_(res);
    if (cls.ok) return res;
    if (cls.retryAfter > 0) { Utilities.sleep((cls.retryAfter + 1) * 1000); continue; }
    return res;
  }
  return { ok: false, description: '429 リトライ後も失敗' };
}

/**
 * 動画1件送信（本文をキャプションに）。429リトライ込み。
 *
 * 初回は Drive からアップロードして file_id を取得し cache に保存、
 * 2回目以降は file_id で送信（再アップロード回避＝6分制限のタイムアウト防止）。
 * 50名に30MB動画を毎回アップすると6分制限を超えるため、この最適化は必須。
 *
 * @param {Object} cache - { id: string } 配信ループ内で file_id を共有する
 */
function sendCampaignVideo_(chatId, videoUrl, caption, cache) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    if (cache && cache.id) {
      // 2回目以降: file_id を再利用（高速・再アップロードなし）
      const p = { chat_id: String(chatId), video: cache.id, supports_streaming: true };
      if (caption) p.caption = caption;
      res = callTelegramApi(BOT_TYPE.BOOKING, 'sendVideo', p);
    } else {
      // 初回: Drive からアップロードし file_id を確保
      res = sendVideoFromUrl(BOT_TYPE.BOOKING, chatId, videoUrl, { caption: caption });
      if (res && res.ok && res.result && res.result.video && cache) {
        cache.id = res.result.video.file_id;
      }
    }
    const cls = classifyTgResult_(res);
    if (cls.ok) return res;
    if (cls.retryAfter > 0) { Utilities.sleep((cls.retryAfter + 1) * 1000); continue; }
    return res;
  }
  return { ok: false, description: '429 リトライ後も失敗' };
}

/**
 * Drive リンクの動画サイズ(MB)を返す。Drive でない/取得失敗時は -1。
 * 送信前の 50MB 上限チェックに使う。
 */
function driveSizeMB_(url) {
  const m = url.match(/[?&]id=([a-zA-Z0-9_-]+)|\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return -1; // 外部URL等はサイズ不明
  const fileId = m[1] || m[2];
  try {
    return DriveApp.getFileById(fileId).getSize() / (1024 * 1024);
  } catch (e) {
    Logger.log('⚠️ driveSizeMB_ 取得失敗: ' + e);
    return -1;
  }
}

/**
 * 成功した顧客行の「最終配信日時」を更新（バッチ）
 */
function updateCustomerLastBroadcast_(rowIndexes, when) {
  if (!rowIndexes || rowIndexes.length === 0) return;
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  const col = headers['最終配信日時'];
  if (!col) return; // 列が無ければスキップ
  rowIndexes.forEach(function(rowIndex) {
    sheet.getRange(rowIndex, col).setValue(when);
  });
}

/**
 * 下書きシートに最終結果を書き戻す
 */
function writeCampaignSummary_(result) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (!sh) return;

  const tz = ss.getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
  sh.getRange(CAMPAIGN_CELL.RESULT_AT).setValue(Utilities.formatDate(result.sentAt, tz, 'yyyy-MM-dd HH:mm:ss'));
  sh.getRange(CAMPAIGN_CELL.RESULT_STATS).setValue(
    '✅ ' + result.success + ' / ❌ ' + result.failed + ' / 🚫 ' + result.blocked +
    '   （合計 ' + result.total + '）'
  );
  sh.getRange(CAMPAIGN_CELL.RESULT_ID).setValue(result.campaignId);
}

// =====================================================
//  配信対象 一括操作（顧客シートの「配信対象」チェックボックス）
// =====================================================

function setAllBroadcastOn()       { bulkSetBroadcastTarget_(true,  false); }
function setAllBroadcastOff()      { bulkSetBroadcastTarget_(false, false); }
function setSelectedBroadcastOn()  { bulkSetBroadcastTarget_(true,  true); }
function setSelectedBroadcastOff() { bulkSetBroadcastTarget_(false, true); }

/**
 * 「顧客」シートの「配信対象」チェックを一括 ON/OFF する
 *
 * @param {boolean} value        - true=☑ON / false=☐OFF
 * @param {boolean} selectedOnly - true=選択した行だけ / false=全顧客
 */
function bulkSetBroadcastTarget_(value, selectedOnly) {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  const col = headers['配信対象'];
  if (!col) {
    ui.alert('「配信対象」列がありません',
      'メニュー「🔧 シート再生成」または setupCampaign を先に実行してください。', ui.ButtonSet.OK);
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { ui.alert('顧客がいません。'); return; }

  let startRow = 2, numRows = lastRow - 1;
  if (selectedOnly) {
    const active = ss.getActiveSheet();
    if (active.getName() !== SHEET_NAMES.CUSTOMERS) {
      ui.alert('⚠️ 「顧客」シートで対象の行を選択してから実行してください。',
        '現在のシート: ' + active.getName(), ui.ButtonSet.OK);
      return;
    }
    const sel = active.getActiveRange();
    startRow = Math.max(2, sel.getRow());
    const selEnd = sel.getRow() + sel.getNumRows() - 1;
    numRows = Math.min(selEnd, lastRow) - startRow + 1;
    if (numRows < 1) {
      ui.alert('対象行がありません（2行目以降を選択してください）。');
      return;
    }
  }

  // チェックボックス検証を付与してから一括代入（未設定セルでも確実に☑/☐になる）
  const rng = sheet.getRange(startRow, col, numRows, 1);
  rng.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  const vals = [];
  for (let i = 0; i < numRows; i++) vals.push([value]);
  rng.setValues(vals);

  ss.toast('配信対象を ' + numRows + ' 件 ' + (value ? 'ON ☑' : 'OFF ☐') + ' にしました', '一括操作', 5);
}

// =====================================================
//  ヘルプ
//  ※ 個別送信（sendMessageToSelectedCustomer 等）は CustomerContact.gs に分離
// =====================================================

/**
 * 使い方ヘルプ
 */
function showCampaignHelp_() {
  SpreadsheetApp.getUi().alert(
    '📢 キャンペーン — 使い方',
    '【一斉送信】\n' +
    '1. 「キャンペーン下書き」シートで本文を編集\n' +
    '   画像/ボイス/動画を付ける場合:\n' +
    '   ① B11「📁 素材フォルダ」にファイルを入れる\n' +
    '   ② メニュー「📂 素材一覧を更新」を実行\n' +
    '   ③ B8/B9/B10 のドロップダウンからファイル名を選ぶ\n' +
    '   （Driveリンクの直貼りも従来どおり可）\n' +
    '   ※ 動画は50MB以内に圧縮。動画がある時は画像より優先\n' +
    '2. メニュー「① プレビュー」で送信先と内容を確認\n' +
    '3. 「② 一斉送信を実行」→ 最終確認 → 配信\n' +
    '4. 結果は「キャンペーン配信履歴」シートに記録\n\n' +
    '【テスト送信（おすすめ）】\n' +
    '「🧪 テスト送信」で、自分のチャットIDだけに実物を送れます。\n' +
    '本番前に動画・画像・本文の見え方を安全に確認できます。\n\n' +
    '【個別送信】\n' +
    '1. 「顧客」シートで対象の行をクリック\n' +
    '2. メニュー「📤 選択した顧客に1通だけ送信」\n' +
    '3. 本文を入力して送信\n\n' +
    '【配信対象の一括ON/OFF】\n' +
    'メニュー「☑ 配信対象 一括操作」で\n' +
    '・全員を ON / 全員を OFF\n' +
    '・選択した行だけ ON / OFF（範囲選択してから実行）\n' +
    '配信対象=☐ の人は一斉送信から除外されます。\n\n' +
    '【重要】テレグラム限定特価（5ドル等）は本文に手書きするだけ。\n' +
    '料金設定/メニューシートには絶対に入れないでください（公開客に漏れます）。',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}
