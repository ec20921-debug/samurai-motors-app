/**
 * Setup_MenuV3.gs — メニュー統合マイグレーション(2026-05-19)
 *
 * 【役割】
 *   Menu v3: WASH と GLASS を 1 つのシート(メニュー)に統合する。
 *   - 旧 料金設定 シート: SAMURAI WASH 行のみ MENU へ複製(料金設定本体は温存)
 *   - 旧 オプション シート: GLASS_3 / GLASS_ALL を MENU へ複製
 *
 *   コード(getActivePlans / getActiveOptions)は MENU シートを優先的に読み、
 *   存在しなければ旧シートにフォールバックする dual-read 方式。
 *   → ゼロダウンタイムで切替可能、リスク最小化。
 *
 * 【背景】
 *   Daisuke 指示(2026-05-19):
 *     「料金設定とオプションの二段構えがわかりにくい。GLASS はオプションじゃなく
 *      WASH と同列のメニュー。1枚に統合して、まとめて編集できるようにしたい」
 *
 * 【実行】
 *   1. clasp push で本ファイルを反映
 *   2. GAS エディタで `migrateMenuV3_createUnifiedMenu` を ▶ 実行(1回)
 *   3. 「メニュー」シートが作成される(WASH + GLASS_3 + GLASS_ALL の 3 行)
 *   4. 動作確認後、旧 料金設定 の WASH 行 / 旧 オプション の行を手動削除して良い(任意)
 *
 * 【冪等性】
 *   再実行すると MENU シートが再作成される(既存内容クリア → 再投入)。
 *   Daisuke が MENU を手動編集したあとに再実行すると編集が消えるので注意。
 *   通常は 1 回実行すれば十分。
 */

// ====== メニューシートの列定義 ======

const MENU_HEADERS = [
  'コード',           // A: WASH / GLASS_3 / GLASS_ALL
  '種別',             // B: WASH or GLASS (顧客フローで並列扱い)
  '名称(英)',         // C: 顧客に見せる英名
  '名称(クメール)',   // D: 顧客に見せるクメール語
  '名称(日)',         // E: 管理者用日本語
  'セダン価格(USD)',  // F
  'SUV価格(USD)',     // G
  'セダン所要(分)',   // H: 予約スケジュール計算に影響
  'SUV所要(分)',      // I: 同上
  '有効',             // J: チェックボックス、FALSE で予約フローから除外
  '備考'              // K: 管理者メモ
];

// 列インデックス (1-based) ヘルパー
const MENU_COL = {
  CODE:           1,
  KIND:           2,
  NAME_EN:        3,
  NAME_KM:        4,
  NAME_JP:        5,
  PRICE_SEDAN:    6,
  PRICE_SUV:      7,
  DURATION_SEDAN: 8,
  DURATION_SUV:   9,
  ACTIVE:        10,
  NOTE:          11
};

const MENU_KIND_WASH  = 'WASH';
const MENU_KIND_GLASS = 'GLASS';

// ====== マイグレーション本体 ======

/**
 * 新「メニュー」シートを作成し、現存データから WASH + GLASS を移送する
 */
function migrateMenuV3_createUnifiedMenu() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🚀 Menu v3 統合マイグレーション開始');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  const ss = getSpreadsheet();

  // ── 1. メニューシートを作成/再構築 ──
  let sheet = ss.getSheetByName(SHEET_NAMES.MENU);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.MENU);
    // オプションシートの隣に置く(視認性のため)
    const opt = ss.getSheetByName(SHEET_NAMES.OPTIONS);
    if (opt) {
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(opt.getIndex() + 1);
    }
    Logger.log('  🆕 新規作成: ' + SHEET_NAMES.MENU);
  } else {
    sheet.clear();
    Logger.log('  🧹 既存内容をクリア: ' + SHEET_NAMES.MENU);
  }

  // ── 2. ヘッダー ──
  sheet.getRange(1, 1, 1, MENU_HEADERS.length).setValues([MENU_HEADERS]);
  sheet.getRange(1, 1, 1, MENU_HEADERS.length)
    .setFontWeight('bold')
    .setBackground('#1a1a1a')
    .setFontColor('#ffffff');

  // ── 3. データ行を組み立て(WASH を 料金設定 から、GLASS を オプション から取り込む) ──
  const rows = [];

  // 3-a. WASH 行(料金設定シートから取得)
  const washRow = extractWashFromLegacyPlanPrices_();
  if (washRow) {
    rows.push(washRow);
    Logger.log('  ✅ WASH を 料金設定 から取り込み: ' + washRow.join(' | '));
  } else {
    // フォールバック: ハードコードのデフォルト
    const defaultWash = [
      'WASH', MENU_KIND_WASH,
      'SAMURAI WASH', 'លាង', '洗車',
      12, 15,
      30, 45,
      true,
      'Waterless body wash + Tire wax — bookable solo or with GLASS'
    ];
    rows.push(defaultWash);
    Logger.log('  ⚠️ 料金設定 に WASH 行なし、デフォルト値を投入');
  }

  // 3-b. GLASS 行(オプションシートから全行取得)
  const glassRows = extractGlassFromLegacyOptions_();
  glassRows.forEach(function(r) {
    rows.push(r);
    Logger.log('  ✅ GLASS を オプション から取り込み: ' + r[0]);
  });
  if (glassRows.length === 0) {
    Logger.log('  ⚠️ オプション に GLASS 行なし、デフォルト値を投入');
    rows.push([
      'GLASS_3', MENU_KIND_GLASS,
      '3 Windows + Mirrors', 'កញ្ចក់ ៣ + កញ្ចក់ឆ្លុះ ២', '3面+ドアミラー',
      15, 20, 40, 60, true,
      'Front 3 windows + both door mirrors: waterless wash + water-repellent coating'
    ]);
    rows.push([
      'GLASS_ALL', MENU_KIND_GLASS,
      'All Windows + Mirrors', 'កញ្ចក់ ទាំងអស់ + កញ្ចក់ឆ្លុះ ២', '全面+ドアミラー',
      30, 40, 70, 120, true,
      'All windows + both door mirrors: waterless wash + water-repellent coating'
    ]);
  }

  // ── 4. 行投入 ──
  sheet.getRange(2, 1, rows.length, MENU_HEADERS.length).setValues(rows);

  // ── 5. 列幅 + チェックボックス ──
  sheet.setColumnWidth(MENU_COL.CODE, 110);
  sheet.setColumnWidth(MENU_COL.KIND, 80);
  sheet.setColumnWidth(MENU_COL.NAME_EN, 220);
  sheet.setColumnWidth(MENU_COL.NAME_KM, 250);
  sheet.setColumnWidth(MENU_COL.NAME_JP, 150);
  sheet.setColumnWidth(MENU_COL.PRICE_SEDAN, 110);
  sheet.setColumnWidth(MENU_COL.PRICE_SUV, 110);
  sheet.setColumnWidth(MENU_COL.DURATION_SEDAN, 110);
  sheet.setColumnWidth(MENU_COL.DURATION_SUV, 110);
  sheet.setColumnWidth(MENU_COL.ACTIVE, 60);
  sheet.setColumnWidth(MENU_COL.NOTE, 400);

  // 有効列にチェックボックス
  const validation = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange(2, MENU_COL.ACTIVE, rows.length, 1).setDataValidation(validation);

  // 種別列にドロップダウン(WASH or GLASS)
  const kindValidation = SpreadsheetApp.newDataValidation()
    .requireValueInList([MENU_KIND_WASH, MENU_KIND_GLASS], true)
    .build();
  sheet.getRange(2, MENU_COL.KIND, rows.length, 1).setDataValidation(kindValidation);

  // 1 行目フリーズ
  sheet.setFrozenRows(1);

  // ── 6. キャッシュクリア(getBookingConfig も含む) ──
  if (typeof clearBookingConfigCache === 'function') {
    clearBookingConfigCache();
    Logger.log('  🧹 booking config キャッシュクリア');
  }

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ Menu v3 統合完了 — ' + SHEET_NAMES.MENU + ' に ' + rows.length + ' 行');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('次のステップ:');
  Logger.log('  1. 顧客側 booking.html で WASH + GLASS が正しく表示されるか確認');
  Logger.log('  2. テスト予約 1 件入れて、所要時間/価格が新メニューから引かれているか確認');
  Logger.log('  3. 動作OK なら 料金設定 の WASH 行 / オプション の行を手動削除して良い');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

// ====== レガシーシートからの抽出ヘルパー ======

/**
 * 料金設定 シートから SAMURAI WASH 行を抽出し、メニューシート用の配列に変換する
 * 見つからない場合は null を返す
 */
function extractWashFromLegacyPlanPrices_() {
  let sheet;
  try {
    sheet = getSheet(SHEET_NAMES.PLAN_PRICES);
  } catch (e) {
    Logger.log('  ℹ️ 料金設定 シート未作成: ' + e);
    return null;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const name = String(row[0] || '').trim();
    // SAMURAI WASH (W) 形式を検出
    if (/SAMURAI\s+WASH/i.test(name)) {
      return [
        'WASH',
        MENU_KIND_WASH,
        'SAMURAI WASH',              // 名称(英)
        'លាង',                       // 名称(クメール)
        '洗車',                       // 名称(日)
        Number(row[1]) || 0,         // セダン価格
        Number(row[2]) || 0,         // SUV価格
        Number(row[3]) || 0,         // セダン所要
        Number(row[4]) || 0,         // SUV所要
        true,                        // 有効
        String(row[5] || 'Waterless body wash + Tire wax — bookable solo or with GLASS')
      ];
    }
  }
  return null;
}

/**
 * オプション シートから全 GLASS 行を抽出し、メニューシート用の配列に変換する
 */
function extractGlassFromLegacyOptions_() {
  let sheet;
  try {
    sheet = getSheet(SHEET_NAMES.OPTIONS);
  } catch (e) {
    Logger.log('  ℹ️ オプション シート未作成: ' + e);
    return [];
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  // オプションシートの列構造(Setup_MenuV2.gs より):
  // A:コード B:名称(英) C:名称(クメール) D:名称(日) E:セダン価格 F:SUV価格
  // G:セダン所要 H:SUV所要 I:必須プラン J:有効 K:備考
  const data = sheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const out = [];

  data.forEach(function(row) {
    const code = String(row[0] || '').trim();
    if (!code) return;
    const active = row[9];
    // チェックボックス値は true / 'TRUE' / 'true' のいずれもあり得る
    const isActive = (active === true || String(active).toUpperCase() === 'TRUE');

    out.push([
      code,
      MENU_KIND_GLASS,
      String(row[1] || ''),       // 名称(英)
      String(row[2] || ''),       // 名称(クメール)
      String(row[3] || ''),       // 名称(日)
      Number(row[4]) || 0,        // セダン価格
      Number(row[5]) || 0,        // SUV価格
      Number(row[6]) || 0,        // セダン所要
      Number(row[7]) || 0,        // SUV所要
      isActive,                   // 有効
      String(row[10] || '')       // 備考
    ]);
  });
  return out;
}

// ====== ロールバック用(必要時のみ実行) ======

/**
 * メニューシートを削除して元の状態(料金設定 + オプション 単独運用)に戻す
 * 緊急時/取り消し用
 */
function rollbackMenuV3_dropUnifiedMenu() {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAMES.MENU);
  if (!sheet) {
    Logger.log('  ℹ️ メニュー シートが存在しないので何もしない');
    return;
  }
  ss.deleteSheet(sheet);
  if (typeof clearBookingConfigCache === 'function') clearBookingConfigCache();
  Logger.log('🔄 メニュー シート削除完了。dual-read コードは自動的に旧 料金設定+オプション にフォールバック');
}

// ====== Menu v3 後処理クリーンアップ (Option α 最終形態へ) ======

/**
 * オプション シートを削除する(GLASS データはメニューに移行済前提)
 *
 * 【安全装置】
 *   メニューシートに GLASS 行が存在することを確認してから削除する
 *   存在しない場合は中止して何もしない
 *
 * 【実行手順】
 *   migrateMenuV3_createUnifiedMenu 実行後、本番で booking.html の動作確認 → 本関数実行
 */
function cleanupMenuV3_dropOptionsSheet() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🧹 オプション シート削除');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  const ss = getSpreadsheet();

  // pre-flight: メニュー に GLASS 行が存在するか
  const menuSheet = ss.getSheetByName(SHEET_NAMES.MENU);
  if (!menuSheet) {
    Logger.log('❌ メニュー シートが存在しません。先に migrateMenuV3_createUnifiedMenu を実行してください');
    return;
  }
  const lastRow = menuSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('❌ メニュー シートが空です。削除を中止');
    return;
  }
  const kinds = menuSheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const hasGlass = kinds.some(function(r) { return String(r[0]).trim() === 'GLASS'; });
  if (!hasGlass) {
    Logger.log('❌ メニュー シートに GLASS 行がありません。削除を中止(データ消失防止)');
    return;
  }

  const optSheet = ss.getSheetByName(SHEET_NAMES.OPTIONS);
  if (!optSheet) {
    Logger.log('  ℹ️ オプション シートが既に存在しません(過去に削除済?)');
    return;
  }
  ss.deleteSheet(optSheet);
  Logger.log('  ✅ オプション シート削除完了');
  Logger.log('注: dual-read コードはメニューシートから GLASS を読み続けます');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * 料金設定 シートから SAMURAI WASH 行のみを削除する
 * 設定行(出張料・営業時間・バッファ・キャンペーン4行)は温存
 *
 * 【安全装置】
 *   メニューシートに WASH 行が存在することを確認してから削除する
 */
function cleanupMenuV3_removeWashFromPlanPrices() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🧹 料金設定 から WASH 行のみ削除');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  const ss = getSpreadsheet();

  // pre-flight: メニュー に WASH 行が存在するか
  const menuSheet = ss.getSheetByName(SHEET_NAMES.MENU);
  if (!menuSheet) {
    Logger.log('❌ メニュー シートが存在しません。削除を中止');
    return;
  }
  const lastRow = menuSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('❌ メニュー シートが空です。削除を中止');
    return;
  }
  const kinds = menuSheet.getRange(2, 2, lastRow - 1, 1).getValues();
  const hasWash = kinds.some(function(r) { return String(r[0]).trim() === 'WASH'; });
  if (!hasWash) {
    Logger.log('❌ メニュー シートに WASH 行がありません。削除を中止(データ消失防止)');
    return;
  }

  // 料金設定 シートを取得 (リネーム済なら 設定)
  const ppSheet = getPlanPricesSheet_();
  const ppLastRow = ppSheet.getLastRow();
  if (ppLastRow < 2) {
    Logger.log('  ℹ️ ' + ppSheet.getName() + ' シートに削除対象行なし');
    return;
  }

  // SAMURAI WASH 行を後ろから探して削除(行削除でインデックスがずれないように)
  const names = ppSheet.getRange(2, 1, ppLastRow - 1, 1).getValues();
  let deleted = 0;
  for (let i = names.length - 1; i >= 0; i--) {
    const name = String(names[i][0] || '').trim();
    if (/SAMURAI\s+WASH/i.test(name)) {
      const sheetRowNum = i + 2;
      Logger.log('  ✏️ 削除: ' + ppSheet.getName() + ' 行' + sheetRowNum + ' = "' + name + '"');
      ppSheet.deleteRow(sheetRowNum);
      deleted++;
    }
  }

  if (typeof clearBookingConfigCache === 'function') clearBookingConfigCache();
  Logger.log('  ✅ WASH 行削除完了 (' + deleted + ' 行)');
  Logger.log('  ℹ️ 設定行(出張料・営業時間・バッファ・キャンペーン)は温存されています');
}

/**
 * メニュー シートの WASH 行 備考から "(Required base service)" を取り除く
 *
 * Menu v2.1 以降 WASH は任意化されているが、migrateMenuV3 が旧 料金設定 の
 * 備考をそのままコピーしたため "Required base service" 文言が残った場合のクリーンアップ。
 */
function cleanupMenuV3_patchWashNote() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🧹 メニュー WASH 備考の v2.1 是正');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  const ss = getSpreadsheet();
  const menuSheet = ss.getSheetByName(SHEET_NAMES.MENU);
  if (!menuSheet) {
    Logger.log('❌ メニュー シートが存在しません');
    return;
  }
  const lastRow = menuSheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('  ℹ️ メニュー シートに行なし');
    return;
  }

  const data = menuSheet.getRange(2, 1, lastRow - 1, 11).getValues();
  const expectedNote = 'Waterless body wash + Tire wax — bookable solo or with GLASS';
  let updated = 0;
  for (let i = 0; i < data.length; i++) {
    const code = String(data[i][0] || '').trim();
    if (code !== 'WASH') continue;
    const currentNote = String(data[i][10] || '');
    if (currentNote.indexOf('Required base service') !== -1 || currentNote.indexOf('Required') !== -1) {
      Logger.log('  ✏️ WASH 備考更新');
      Logger.log('    旧: ' + currentNote);
      Logger.log('    新: ' + expectedNote);
      menuSheet.getRange(i + 2, 11).setValue(expectedNote);
      updated++;
    } else {
      Logger.log('  ⏭ WASH 備考: skip (既に v2.1 表記)');
    }
  }
  Logger.log('  ✅ 更新セル数: ' + updated);
}

/**
 * 料金設定 シートを 「設定」 にリネームする(Option α 最終形態への完成)
 *
 * 【内容】
 *   - シート名のみ変更(中身は触らない)
 *   - 既存の getBookingConfig は getPlanPricesSheet_() 経由で
 *     '設定' を優先試行→なければ '料金設定' にフォールバック → どちらでも動く
 *
 * 【実行タイミング】
 *   cleanupMenuV3_removeWashFromPlanPrices 実行後、シートに設定行だけ残った状態で実行
 *   = タブ名「料金設定」を「設定」に直して概念を明確化する
 */
function cleanupMenuV3_renamePlanPricesToSettings() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🧹 料金設定 → 設定 リネーム');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  const ss = getSpreadsheet();
  const newName = '設定';

  if (ss.getSheetByName(newName)) {
    Logger.log('  ℹ️ "' + newName + '" シートが既に存在(過去に実行済?)');
    return;
  }
  const oldSheet = ss.getSheetByName(SHEET_NAMES.PLAN_PRICES);
  if (!oldSheet) {
    Logger.log('❌ "' + SHEET_NAMES.PLAN_PRICES + '" シートが見つかりません');
    return;
  }
  oldSheet.setName(newName);
  Logger.log('  ✅ シート名変更: "' + SHEET_NAMES.PLAN_PRICES + '" → "' + newName + '"');

  if (typeof clearBookingConfigCache === 'function') clearBookingConfigCache();
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('Option α 最終形態:');
  Logger.log('  📑 メニュー  ← WASH / GLASS など顧客向け商品');
  Logger.log('  📑 設定      ← 出張料 / 営業時間 / バッファ / キャンペーン');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * クリーンアップ一括実行(便利関数)
 * 上記4つを順番に実行する。事故防止のため pre-flight チェックは各関数で行う。
 */
function cleanupMenuV3_runAll() {
  Logger.log('🚀 cleanupMenuV3_runAll 開始 — Option α 最終形態へ');
  cleanupMenuV3_patchWashNote();
  cleanupMenuV3_dropOptionsSheet();
  cleanupMenuV3_removeWashFromPlanPrices();
  cleanupMenuV3_renamePlanPricesToSettings();
  Logger.log('✅ cleanupMenuV3_runAll 完了');
}
