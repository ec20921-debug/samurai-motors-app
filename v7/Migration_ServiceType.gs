/**
 * Migration_ServiceType.gs — BOOKINGS シートに「サービスタイプ」列を追加
 *
 * 2026-05-20 マイグレーション:
 *   店舗作業オプション(出張料$0)導入に伴い、BOOKINGS シートの最終列に
 *   「サービスタイプ」列を追加する。
 *
 * 【実行方法】
 *   GAS エディタから addServiceTypeColumn() を選択 → 実行
 *   または `clasp run addServiceTypeColumn` (CLI)
 *
 * 【後始末】
 *   実行成功後、本ファイルは削除して構わない(本番コード肥大化防止)。
 */

function addServiceTypeColumn() {
  const sheet = getSheet(SHEET_NAMES.BOOKINGS);
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  if (headers.indexOf('サービスタイプ') >= 0) {
    Logger.log('✅ 「サービスタイプ」列は既に存在します(重複追加なし)');
    return { status: 'skipped', reason: 'already_exists' };
  }

  const newCol = lastCol + 1;
  sheet.getRange(1, newCol).setValue('サービスタイプ');

  // 既存ヘッダーの書式を継承(太字・背景色など)
  try {
    const existingHeaderRange = sheet.getRange(1, lastCol);
    const newHeaderRange = sheet.getRange(1, newCol);
    newHeaderRange.setFontWeight(existingHeaderRange.getFontWeight());
    newHeaderRange.setBackground(existingHeaderRange.getBackground());
    newHeaderRange.setFontColor(existingHeaderRange.getFontColor());
    newHeaderRange.setHorizontalAlignment(existingHeaderRange.getHorizontalAlignment());
    newHeaderRange.setVerticalAlignment(existingHeaderRange.getVerticalAlignment());
  } catch (err) {
    Logger.log('⚠️ ヘッダー書式コピーで例外(続行): ' + err);
  }

  Logger.log('✅ 「サービスタイプ」列を追加しました(位置: ' + newCol + '列目)');
  return { status: 'ok', column: newCol, headerName: 'サービスタイプ' };
}
