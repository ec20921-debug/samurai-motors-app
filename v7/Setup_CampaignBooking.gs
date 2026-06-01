/**
 * Setup_CampaignBooking.gs — 手動特価キャンペーン マスターシート初期化
 *
 * 【役割】
 *   - 「特価キャンペーン」シートを作成し、CAMP-5USD を必ず 2 行目に配置
 *   - チェックボックス/プルダウンは「データ行＋少しのバッファ」だけに限定
 *
 * 【重要な設計上の教訓 (2026-06-01)】
 *   初版は checkbox/プルダウンの data validation を F2:F999 等に敷き詰めていた。
 *   requireCheckbox() は適用時にセルへ FALSE 値を書き込むため getLastRow() が
 *   約 1000 に膨張し、appendRow() が CAMP-5USD を 1000 行目付近に追記していた
 *   （API は全行走査で拾えるが、シート上部は空に見えて混乱）。
 *   → 対策: ①初期行は appendRow ではなく setValues で 2 行目に直接書く
 *           ②validation は MANUAL_CAMPAIGN_BUFFER_ROWS 行だけに限定する
 *
 * 【実行】
 *   GAS エディタで `rebuildManualCampaignSheet()` を ▶ 実行（推奨・クリーン再生成）。
 *   初回だけなら `setupManualCampaignSheet()` でも可。
 */

// ====== シート定義 ======

const MANUAL_CAMPAIGN_SHEET_NAME = '特価キャンペーン';

// validation（チェックボックス・プルダウン）を適用する行数。
// データ行 + 手動追加用バッファ。1000 行に敷き詰めない（getLastRow 膨張防止）。
const MANUAL_CAMPAIGN_BUFFER_ROWS = 20;

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

// 2 行目に置く初期データ（ヘッダー順に並べた1次元配列）
const MANUAL_CAMPAIGN_DEFAULT_VALUES = [
  'CAMP-5USD',
  'ការលាងសម្អាតពិសេស ៥ ដុល្លារ',
  '5ドル特価',
  5,
  '両方',
  true,
  '',
  '',
  '初期投入（テレグラム限定特価）'
];

// ====== 内部ヘルパー: シートの体裁を整える ======

/**
 * ヘッダー・列幅・validation・日付フォーマットを設定する（値は触らない）
 * @param {Sheet} sheet
 */
function formatManualCampaignSheet_(sheet) {
  // ヘッダー
  sheet.getRange(1, 1, 1, MANUAL_CAMPAIGN_HEADERS.length).setValues([MANUAL_CAMPAIGN_HEADERS]);
  sheet.getRange(1, 1, 1, MANUAL_CAMPAIGN_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#1f1f1f')
    .setFontColor('#c9a84c');
  sheet.setFrozenRows(1);

  // 列幅
  var widths = [130, 220, 140, 90, 140, 70, 110, 110, 260];
  for (var c = 0; c < widths.length; c++) sheet.setColumnWidth(c + 1, widths[c]);

  // validation は限定行のみ（getLastRow 膨張防止）
  var rows = MANUAL_CAMPAIGN_BUFFER_ROWS;
  sheet.getRange(2, 6, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build()
  );
  sheet.getRange(2, 5, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(['両方', '店舗', '出張'], true)
      .setAllowInvalid(false)
      .build()
  );
  sheet.getRange(2, 7, rows, 2).setNumberFormat('yyyy-MM-dd');
}

// ====== クリーン再生成（推奨） ======

/**
 * 「特価キャンペーン」シートを削除して作り直し、CAMP-5USD を 2 行目に確実配置する。
 * getLastRow 膨張・行位置ズレを根本的に解消する最も確実な復旧手段。
 *
 * 使い方（GAS エディタ）:
 *   関数ドロップダウンで `rebuildManualCampaignSheet` を選択 → ▶ 実行
 */
function rebuildManualCampaignSheet() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('♻️ 特価キャンペーン シート クリーン再生成');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  var ss = getSpreadsheet();

  // 既存シートを削除（中身ごと破棄）
  var old = ss.getSheetByName(MANUAL_CAMPAIGN_SHEET_NAME);
  if (old) {
    ss.deleteSheet(old);
    Logger.log('🗑 旧シートを削除');
  }

  // 新規作成
  var sheet = ss.insertSheet(MANUAL_CAMPAIGN_SHEET_NAME);
  formatManualCampaignSheet_(sheet);

  // CAMP-5USD を 2 行目に直接書き込む（appendRow を使わない＝行位置を固定）
  sheet.getRange(2, 1, 1, MANUAL_CAMPAIGN_DEFAULT_VALUES.length)
    .setValues([MANUAL_CAMPAIGN_DEFAULT_VALUES]);
  Logger.log('✅ CAMP-5USD を 2 行目に配置');

  // キャッシュクリア
  try {
    CacheService.getScriptCache().remove('manual_campaign_names');
  } catch (e) { /* 未生成は無視 */ }

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🎉 完了。2 行目に CAMP-5USD / 5ドル特価 / $5 / 両方 / ☑ が入っています');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

// ====== 冪等セットアップ（初回用・非破壊） ======

/**
 * シートが無ければ作成し、CAMP-5USD が無ければ 2 行目に置く。既存データは保持。
 * クリーンにやり直したい場合は rebuildManualCampaignSheet() を使うこと。
 */
function setupManualCampaignSheet() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🚀 特価キャンペーン マスター初期化（非破壊）');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(MANUAL_CAMPAIGN_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MANUAL_CAMPAIGN_SHEET_NAME);
    Logger.log('✅ シート作成');
  } else {
    Logger.log('ℹ️ シート既存（体裁のみ再設定）');
  }

  formatManualCampaignSheet_(sheet);

  // CAMP-5USD が存在するか走査（appendRow は使わない）
  var existing = findRow(MANUAL_CAMPAIGN_SHEET_NAME, 'キャンペーンID', 'CAMP-5USD');
  if (existing) {
    Logger.log('ℹ️ CAMP-5USD 行は既存（再投入なし）rowIndex=' + existing.rowIndex);
  } else {
    // 2 行目に直接配置（空でなければ rebuild を促す）
    var firstCell = sheet.getRange(2, 1).getValue();
    if (firstCell === '' || firstCell === null) {
      sheet.getRange(2, 1, 1, MANUAL_CAMPAIGN_DEFAULT_VALUES.length)
        .setValues([MANUAL_CAMPAIGN_DEFAULT_VALUES]);
      Logger.log('✅ CAMP-5USD を 2 行目に配置');
    } else {
      Logger.log('⚠️ 2 行目に別データあり。クリーンにするなら rebuildManualCampaignSheet() を実行してください');
    }
  }

  try {
    CacheService.getScriptCache().remove('manual_campaign_names');
  } catch (e) { /* 未生成は無視 */ }

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🎉 完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
