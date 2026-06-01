/**
 * Setup_CampaignBooking.gs — 手動特価キャンペーン マスターシート初期化
 *
 * 【役割】
 *   - 「特価キャンペーン」シートをスプレッドシートに作成（無ければ）
 *   - ヘッダー行を整え、チェックボックスバリデーションを設定
 *   - 初期データとして CAMP-5USD（5ドル特価・両方）を 1 行投入
 *
 * 【実行】
 *   1. 本ファイルを clasp push（一時的）
 *   2. GAS エディタで `setupManualCampaignSheet()` を ▶ 実行（初回 1 回のみ）
 *   3. ログで「✅ シート作成 / 初期行投入」を確認
 *   4. 不要になったら `.claspignore` に追記済みなのでリモートから自動的に外れる
 *
 * 【冪等性】
 *   - シートが既存ならヘッダー再設定のみ、初期行は重複追加しない
 *   - 既に CAMP-5USD 行があれば再投入しない
 *
 * 【設計方針】
 *   - 価格は固定額（USD）。プラン計算は介在しない
 *   - 「対象サービスタイプ」=「両方/店舗/出張」でミニアプリ側の選択肢を制御
 *   - 「有効」FALSE / 期間外 はミニアプリで非表示（コード変更なしで切替可能）
 */

// ====== シート定義 ======

const MANUAL_CAMPAIGN_SHEET_NAME = '特価キャンペーン';

const MANUAL_CAMPAIGN_HEADERS = [
  'キャンペーンID',       // A: 例 CAMP-5USD
  '名前(クメール)',       // B: ミニアプリ表示用
  '名前(日本語)',         // C: ミニアプリ表示用＋予約シートのキャンペーン名列に記録
  '特価(USD)',            // D: 固定額（プラン計算しない）
  '対象サービスタイプ',   // E: 両方 / 店舗 / 出張
  '有効',                 // F: チェックボックス（TRUE で表示）
  '期間開始',             // G: 任意、空なら無期限
  '期間終了',             // H: 任意、空なら無期限
  'メモ'                  // I: 運用メモ
];

const MANUAL_CAMPAIGN_DEFAULT_ROW = {
  'キャンペーンID':       'CAMP-5USD',
  '名前(クメール)':       'ការលាងសម្អាតពិសេស ៥ ដុល្លារ',
  '名前(日本語)':         '5ドル特価',
  '特価(USD)':            5,
  '対象サービスタイプ':   '両方',
  '有効':                 true,
  '期間開始':             '',
  '期間終了':             '',
  'メモ':                 '初期投入（テレグラム限定特価）'
};

// ====== セットアップ本体 ======

/**
 * 「特価キャンペーン」シートを作成し、初期データを投入する
 * 初回 1 回のみ実行する。冪等性あり。
 */
function setupManualCampaignSheet() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🚀 特価キャンペーン マスター初期化');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  const ss = getSpreadsheet();

  // ── 1. シート作成（無ければ） ──
  let sheet = ss.getSheetByName(MANUAL_CAMPAIGN_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MANUAL_CAMPAIGN_SHEET_NAME);
    Logger.log('✅ シート作成: ' + MANUAL_CAMPAIGN_SHEET_NAME);
  } else {
    Logger.log('ℹ️ シート既存: ' + MANUAL_CAMPAIGN_SHEET_NAME + '（ヘッダーのみ再設定）');
  }

  // ── 2. ヘッダー行を整える ──
  sheet.getRange(1, 1, 1, MANUAL_CAMPAIGN_HEADERS.length).setValues([MANUAL_CAMPAIGN_HEADERS]);
  sheet.getRange(1, 1, 1, MANUAL_CAMPAIGN_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#1f1f1f')
    .setFontColor('#c9a84c');
  sheet.setFrozenRows(1);

  // 列幅の目安（読みやすさのため）
  sheet.setColumnWidth(1, 130);  // キャンペーンID
  sheet.setColumnWidth(2, 220);  // 名前(クメール)
  sheet.setColumnWidth(3, 140);  // 名前(日本語)
  sheet.setColumnWidth(4, 90);   // 特価(USD)
  sheet.setColumnWidth(5, 140);  // 対象サービスタイプ
  sheet.setColumnWidth(6, 70);   // 有効
  sheet.setColumnWidth(7, 110);  // 期間開始
  sheet.setColumnWidth(8, 110);  // 期間終了
  sheet.setColumnWidth(9, 260);  // メモ

  // ── 3. 「有効」列にチェックボックス、「対象サービスタイプ」にプルダウン ──
  const lastRow = Math.max(sheet.getMaxRows(), 100);
  const activeRange = sheet.getRange(2, 6, lastRow - 1, 1);
  activeRange.setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build()
  );
  const targetRange = sheet.getRange(2, 5, lastRow - 1, 1);
  targetRange.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['両方', '店舗', '出張'], true)
      .setAllowInvalid(false)
      .build()
  );

  // 日付列のフォーマット
  sheet.getRange(2, 7, lastRow - 1, 2).setNumberFormat('yyyy-MM-dd');

  // ── 4. 初期行 CAMP-5USD を投入（重複ガード） ──
  const existing = findRow(MANUAL_CAMPAIGN_SHEET_NAME, 'キャンペーンID', MANUAL_CAMPAIGN_DEFAULT_ROW['キャンペーンID']);
  if (existing) {
    Logger.log('ℹ️ CAMP-5USD 行は既存（再投入なし）');
  } else {
    appendRow(MANUAL_CAMPAIGN_SHEET_NAME, MANUAL_CAMPAIGN_DEFAULT_ROW);
    Logger.log('✅ CAMP-5USD 初期行を投入');
  }

  // ── 5. キャッシュクリア（次回 manualCampaignList で再取得） ──
  try {
    CacheService.getScriptCache().remove('manual_campaign_names');
  } catch (e) { /* キャッシュ未生成は無視 */ }

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🎉 完了。シート「' + MANUAL_CAMPAIGN_SHEET_NAME + '」を確認してください');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 「特価キャンペーン」シートを完全リセットして再生成する（破壊的）
 *
 * 既存のデータ行（2行目以降）を全削除してから setupManualCampaignSheet を
 * 呼び直す。手動編集が消えるので、初回セットアップで行が見つからない時や、
 * シートが壊れた時にだけ実行する。
 *
 * 使い方（GAS エディタ）:
 *   1. 関数選択ドロップダウンで `resetManualCampaignSheet` を選択
 *   2. ▶ 実行
 *   3. ログで「既存 N 行削除」「CAMP-5USD 初期行を投入」を確認
 */
function resetManualCampaignSheet() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('♻️ 特価キャンペーン シート 強制リセット');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(MANUAL_CAMPAIGN_SHEET_NAME);
  if (sheet) {
    var lastRow = sheet.getLastRow();
    var lastCol = Math.max(sheet.getLastColumn(), MANUAL_CAMPAIGN_HEADERS.length);
    if (lastRow > 1) {
      // ※「固定されていない行をすべて削除することはできません」エラー回避のため
      //   deleteRows ではなく clearContent で内容だけ消す。
      //   データ検証（チェックボックス・プルダウン）は維持される。
      sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
      Logger.log('🧹 既存データ ' + (lastRow - 1) + ' 行をクリア');
    } else {
      Logger.log('ℹ️ データ行なし（ヘッダーのみ）');
    }
  } else {
    Logger.log('ℹ️ シート未作成 → setup で作成します');
  }

  // キャッシュも完全に消す（次回 list 取得で再ロード）
  try {
    CacheService.getScriptCache().remove('manual_campaign_names');
  } catch (e) { /* キャッシュ未生成は無視 */ }

  // 通常 setup を呼ぶ（ヘッダー再設定 + CAMP-5USD 初期行投入）
  setupManualCampaignSheet();

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ リセット完了。「特価キャンペーン」シート 2 行目に CAMP-5USD があるはず');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
