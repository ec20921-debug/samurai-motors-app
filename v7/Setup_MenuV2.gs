/**
 * Setup_MenuV2.gs — Menu v2 マイグレーション(2026-05-06 確定版)
 *
 * 【役割】
 *   旧4プラン(KIYOME/KAGAMI/TAKUMI/SHOGUN)を廃止し、
 *   新メニュー構造(SAMURAI WASH 必須 + GLASS 任意 add-on)へ切り替える一回限りのスクリプト。
 *
 * 【実行手順】
 *   1. clasp push で本ファイルをリモートへ反映
 *   2. GAS エディタで `migrateMenuV2()` を ▶ 実行(1回のみ)
 *   3. 完了ログを確認
 *   4. 本ファイルは初回実行後はローカル保持のみ(.claspignore で本番から除外推奨)
 *
 * 【冪等性】
 *   再実行しても安全(既存シート上書き、同名行は更新)
 *
 * 【参考】
 *   - 確定メニュー: G:\マイドライブ\SuzukiEmpire\Vault\04_Projects\Samurai\04_Businesses\Motors\Menu_v2.md
 *   - 真田メモリ: 04_Projects/Samurai/03_Agents/sanada-memory.md
 */

/**
 * Menu v2 への一括マイグレーション
 */
function migrateMenuV2() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🚀 Menu v2 マイグレーション開始');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  try {
    // ── 1. Plan_Prices シートの再構築 ──
    rebuildPlanPricesV2_();

    // ── 2. OPTIONS シートの作成・初期化 ──
    rebuildOptionsSheetV2_();

    // ── 3. FUNNEL_LOG シートの作成・初期化 ──
    rebuildFunnelLogSheetV2_();

    // ── 4. BOOKINGS シートにキャンペーン分析用 3 列を追加(冪等) ──
    ensureBookingCampaignColumnsV2_();

    // ── 5. キャッシュクリア ──
    if (typeof clearBookingConfigCache === 'function') clearBookingConfigCache();

    Logger.log('━━━━━━━━━━━━━━━━━━━━');
    Logger.log('✅ Menu v2 マイグレーション完了');
    Logger.log('━━━━━━━━━━━━━━━━━━━━');
    Logger.log('次のアクション:');
    Logger.log('  - Bot で予約フローをテスト');
    Logger.log('  - booking.html の更新は P3 で実施');
    Logger.log('━━━━━━━━━━━━━━━━━━━━');
  } catch (err) {
    Logger.log('❌ マイグレーション失敗: ' + err);
    Logger.log('スタック: ' + (err.stack || ''));
    throw err;
  }
}

/**
 * Plan_Prices シートを Menu v2 構造に再構築
 *  - 旧4プラン(清/鏡/匠/将軍)行を削除
 *  - SAMURAI WASH (W) 1行のみに置換
 *  - 出張料・営業時間・バッファ行は保持
 */
function rebuildPlanPricesV2_() {
  const sheet = getSheet(SHEET_NAMES.PLAN_PRICES);
  Logger.log('📊 Plan_Prices 再構築開始');

  // ヘッダー行はそのまま、2行目以降をクリア
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }

  // 新メニュー構造の行を投入
  const newRows = [
    // [プラン名, セダン価格, SUV価格, セダン所要(分), SUV所要(分), 備考]
    ['SAMURAI WASH (W)', 12, 15, 30, 45, 'Waterless body wash + Tire wax (Required base service)'],
    ['出張料',           2,  2,  '', '', 'Delivery fee — flat USD'],
    ['【設定】移動バッファ(分)', 30, '', '', '', 'Buffer between bookings'],
    ['【設定】営業開始時刻',     9,  '', '', '', 'Business hour start (24h)'],
    ['【設定】営業終了時刻',     18, '', '', '', 'Business hour end (24h)'],
    // ── キャンペーン設定 (2026-05-06 GRAND OPENING -30% 開始) ──
    ['【設定】キャンペーン有効', true, '', '', '', 'TRUE=キャンペーン適用 / FALSE=通常価格'],
    ['【設定】キャンペーン割引(%)', 30, '', '', '', '0-99 の整数。例: 30 = 30%引き'],
    ['【設定】キャンペーン名(英)', 'GRAND OPENING', '', '', '', '顧客に表示する英語名'],
    ['【設定】キャンペーン名(クメール)', 'ការបើកដំបូង', '', '', '', '顧客に表示するクメール語名(空でも可)']
  ];

  sheet.getRange(2, 1, newRows.length, 6).setValues(newRows);
  Logger.log('  ✅ ' + newRows.length + '行を投入: ' + newRows.map(function(r) { return r[0]; }).join(', '));
}

/**
 * OPTIONS シートを作成または再構築
 *  - GLASS_3 / GLASS_ALL を初期登録
 */
function rebuildOptionsSheetV2_() {
  const ss = getSpreadsheet();
  const sheetName = SHEET_NAMES.OPTIONS;
  Logger.log('📊 ' + sheetName + ' 再構築開始');

  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    Logger.log('  🆕 新規作成: ' + sheetName);
  } else {
    sheet.clear();
    Logger.log('  🧹 既存内容をクリア: ' + sheetName);
  }

  // ヘッダー
  const headers = [
    'コード',           // GLASS_3 / GLASS_ALL 等の識別子
    '名称(英)',
    '名称(クメール)',
    '名称(日)',
    'セダン価格(USD)',
    'SUV価格(USD)',
    'セダン所要(分)',
    'SUV所要(分)',
    '必須プラン',       // 'W' = SAMURAI WASH 必須
    '有効',             // TRUE/FALSE
    '備考'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');

  // データ行
  const rows = [
    [
      'GLASS_3',
      '3 Windows + Mirrors',
      'កញ្ចក់ ៣ + កញ្ចក់ឆ្លុះ ២',
      '3面+ドアミラー',
      15, 20,        // 価格
      30, 50,        // 所要時間
      'W',           // 必須プラン = WASH
      true,          // 有効
      'Front 3 windows + both door mirrors: waterless wash + water-repellent coating'
    ],
    [
      'GLASS_ALL',
      'All Windows + Mirrors',
      'កញ្ចក់ ទាំងអស់ + កញ្ចក់ឆ្លុះ ២',
      '全面+ドアミラー',
      30, 40,        // 価格
      60, 100,       // 所要時間
      'W',           // 必須プラン = WASH
      true,          // 有効
      'All windows + both door mirrors: waterless wash + water-repellent coating'
    ]
  ];
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);

  // 列幅調整
  sheet.setColumnWidth(1, 100);  // コード
  sheet.setColumnWidth(2, 200);  // 名称(英)
  sheet.setColumnWidth(3, 250);  // クメール
  sheet.setColumnWidth(4, 150);  // 日
  for (let i = 5; i <= 8; i++) sheet.setColumnWidth(i, 110);
  sheet.setColumnWidth(9, 90);   // 必須プラン
  sheet.setColumnWidth(10, 60);  // 有効
  sheet.setColumnWidth(11, 400); // 備考

  // チェックボックス(有効列)
  const validation = SpreadsheetApp.newDataValidation()
    .requireCheckbox()
    .build();
  sheet.getRange(2, 10, rows.length, 1).setDataValidation(validation);

  Logger.log('  ✅ ' + rows.length + '行を投入: ' + rows.map(function(r) { return r[0]; }).join(', '));
}

/**
 * FUNNEL_LOG シートを作成または再構築
 *  - Bot来訪 / ミニアプリ開く / 予約完了 の3段ファネル計測用
 */
function rebuildFunnelLogSheetV2_() {
  const ss = getSpreadsheet();
  const sheetName = SHEET_NAMES.FUNNEL_LOG;
  Logger.log('📊 ' + sheetName + ' 再構築開始');

  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    Logger.log('  🆕 新規作成: ' + sheetName);
  } else {
    Logger.log('  ✅ 既存(維持)、ヘッダーのみ更新');
  }

  // ヘッダー
  const headers = [
    'タイムスタンプ',
    'チャットID',
    'イベント',         // bot_start / miniapp_opened / booking_completed / option_selected_glass 等
    'ソース',           // telegram / booking.html / system
    '予約ID',
    'メタデータ(JSON)'
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');

  // 列幅調整
  sheet.setColumnWidth(1, 180);  // タイムスタンプ
  sheet.setColumnWidth(2, 150);  // チャットID
  sheet.setColumnWidth(3, 200);  // イベント
  sheet.setColumnWidth(4, 130);  // ソース
  sheet.setColumnWidth(5, 180);  // 予約ID
  sheet.setColumnWidth(6, 400);  // メタデータ

  Logger.log('  ✅ ヘッダー設定完了');
}

/**
 * BOOKINGS シートに分析用 3 列を追加(冪等)
 *  - 割引前金額(USD): キャンペーン適用前の合計
 *  - 割引額(USD): キャンペーンで引かれた額
 *  - キャンペーン名: 適用したキャンペーン識別子
 *
 *  既に存在する列はスキップ。新規列はヘッダー右端に追加。
 */
function ensureBookingCampaignColumnsV2_() {
  Logger.log('📊 BOOKINGS 拡張列の確認(キャンペーン分析 + 顧客体験トリガー)');
  const sheet = getSheet(SHEET_NAMES.BOOKINGS);
  const headers = getHeaderMap(SHEET_NAMES.BOOKINGS);
  const newCols = [
    '割引前金額(USD)',
    '割引額(USD)',
    'キャンペーン名',
    '1h前リマインダー送信日時',  // A2: 1時間前リマインダー Bot 用
    'フィードバック送信日時'        // A4: 完了後24h フィードバック Bot 用
  ];

  let lastCol = sheet.getLastColumn();
  const added = [];
  newCols.forEach(function(col) {
    if (!headers[col]) {
      lastCol += 1;
      sheet.getRange(1, lastCol).setValue(col);
      sheet.getRange(1, lastCol).setFontWeight('bold');
      added.push(col);
    }
  });

  if (added.length > 0) {
    Logger.log('  ✅ 追加された列: ' + added.join(', '));
  } else {
    Logger.log('  ✅ 既存(スキップ)');
  }
}

/**
 * Funnel イベントを記録(本番コードからも呼ぶ簡易ヘルパー)
 *  - 失敗してもメイン処理を止めないよう try/catch で保護
 */
function logFunnelEvent(chatId, event, source, bookingId, metadata) {
  try {
    appendRow(SHEET_NAMES.FUNNEL_LOG, {
      'タイムスタンプ': new Date(),
      'チャットID':     String(chatId || ''),
      'イベント':       String(event || ''),
      'ソース':         String(source || ''),
      '予約ID':         String(bookingId || ''),
      'メタデータ(JSON)': metadata ? JSON.stringify(metadata) : ''
    });
  } catch (err) {
    // ファネルログは欠損しても業務影響なし(計測のみ)
    Logger.log('⚠️ logFunnelEvent 失敗(無視可): ' + err);
  }
}
