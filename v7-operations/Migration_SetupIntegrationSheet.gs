/**
 * Migration_SetupIntegrationSheet.gs
 *
 * 「サムライモーターズ_経費統合_v6.xlsx」(Excel形式) を
 * ネイティブ Google スプレッドシートに変換し、
 * INTEGRATION_SPREADSHEET_ID を自動登録し、
 * 既存の経費を一括バックフィルする ワンショット セットアップ関数。
 *
 * 【前提】
 *   - appsscript.json で Drive Advanced Service (v2) を有効化済み（このコミットで対応済み）
 *   - 初回実行時、Drive API への OAuth スコープ承認が求められる（許可してください）
 *
 * 【実行】
 *   GAS エディタで setupExpenseIntegration() を1回実行 → ログで結果確認
 *
 * 【その後】
 *   - 新ファイルが Drive にできていることを確認
 *   - 旧 .xlsx (1UqMg3FkTPZLANca8LLN6_J8LWaL9TuOq) は数日残してから削除推奨
 *   - このファイル (Migration_SetupIntegrationSheet.gs) を削除して再 clasp push
 */

// 変換元の .xlsx ファイル ID（添付の経費統合シート）
const INTEGRATION_SOURCE_XLSX_ID_ = '1UqMg3FkTPZLANca8LLN6_J8LWaL9TuOq';

// 変換後の Google Sheets タイトル
const INTEGRATION_NEW_TITLE_ = 'サムライモーターズ_経費統合';

/**
 * ワンショット セットアップ:
 *   1) .xlsx を Google Sheets に変換
 *   2) PropertiesService.INTEGRATION_SPREADSHEET_ID 登録
 *   3) 接続確認
 *   4) 既存経費を一括バックフィル
 */
function setupExpenseIntegration() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🔧 経費統合シート セットアップ開始');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ステップ 1: 変換
  let newId;
  try {
    newId = convertIntegrationXlsxToGsheets_();
  } catch (err) {
    Logger.log('❌ 変換失敗: ' + err);
    Logger.log('   → Drive Advanced Service が有効か / Drive API スコープが承認済みか確認してください');
    return;
  }

  // ステップ 2: PropertiesService に登録
  PropertiesService.getScriptProperties().setProperty(
    CONFIG_KEYS.INTEGRATION_SPREADSHEET_ID,
    newId
  );
  Logger.log('✅ PropertiesService.INTEGRATION_SPREADSHEET_ID = ' + newId);
  Logger.log('');

  // ステップ 3: 接続確認
  Logger.log('🔍 接続確認...');
  try {
    const ctx = openIntegrationContext_(newId);
    Logger.log('  シート: ' + ctx.sheet.getName());
    Logger.log('  ヘッダー列数: ' + ctx.headerCount);
    Logger.log('  既存元ID数: ' + Object.keys(ctx.existingIds).length);
    Logger.log('  次のNo: ' + ctx.nextNo);
    Logger.log('  為替: USD=' + ctx.rates.USD + ' / KHR=' + ctx.rates.KHR + ' / JPY=' + ctx.rates.JPY);
  } catch (err) {
    Logger.log('⚠️ 接続確認失敗: ' + err);
    Logger.log('   → 変換後ファイルの「統合明細」シート名 / ヘッダー（1行目）を確認してください');
    Logger.log('   → 変換自体は成功しているので、手で原因を見て再 syncExpensesToIntegration を実行');
    return;
  }
  Logger.log('');

  // ステップ 4: バックフィル
  Logger.log('🔁 既存経費をバックフィル中...');
  const result = syncExpensesToIntegration();

  Logger.log('');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🎉 セットアップ完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('  新スプレッドシート ID: ' + newId);
  Logger.log('  URL: https://docs.google.com/spreadsheets/d/' + newId + '/edit');
  Logger.log('  バックフィル: 追加 ' + result.added +
             ' / スキップ ' + result.skipped +
             ' / 失敗 ' + result.failed);
  Logger.log('');
  Logger.log('以降、Bot 経費登録は自動的に統合明細へ追記されます。');
  Logger.log('このファイル Migration_SetupIntegrationSheet.gs は削除してOK。');
}

/**
 * .xlsx → ネイティブ Google Sheets に変換
 * Drive API v2 で targetMimeType を google-apps.spreadsheet にして insert すると自動変換される
 * @return {string} 新スプレッドシートの ID
 */
function convertIntegrationXlsxToGsheets_() {
  Logger.log('📄 変換元 ID: ' + INTEGRATION_SOURCE_XLSX_ID_);

  let sourceFile;
  try {
    sourceFile = DriveApp.getFileById(INTEGRATION_SOURCE_XLSX_ID_);
  } catch (e) {
    throw new Error('変換元 .xlsx が見つかりません: ' + e);
  }
  Logger.log('  名前: ' + sourceFile.getName());
  Logger.log('  MIME: ' + sourceFile.getMimeType());

  // 親フォルダ
  const parents = sourceFile.getParents();
  const parentId = parents.hasNext() ? parents.next().getId() : null;

  // 同名既存ファイルがあれば中断（二重変換防止）
  if (parentId) {
    const folder = DriveApp.getFolderById(parentId);
    const it = folder.getFilesByName(INTEGRATION_NEW_TITLE_);
    while (it.hasNext()) {
      const existing = it.next();
      if (existing.getMimeType() === 'application/vnd.google-apps.spreadsheet') {
        Logger.log('ℹ️ 既に変換済みファイルがあります: ' + existing.getId());
        Logger.log('   既存ファイルを再利用します（再変換しない）');
        return existing.getId();
      }
    }
  }

  const blob = sourceFile.getBlob();
  const resource = {
    title: INTEGRATION_NEW_TITLE_,
    mimeType: 'application/vnd.google-apps.spreadsheet'
  };
  if (parentId) resource.parents = [{ id: parentId }];

  const newFile = Drive.Files.insert(resource, blob);
  Logger.log('✅ 変換完了: ' + newFile.id);
  return newFile.id;
}
