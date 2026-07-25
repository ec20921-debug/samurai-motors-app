/**
 * SalesLogManager.gs — 車屋提携 営業ログ（B2B訪問記録・実験版）
 *
 * 【責務】
 *   - 現場スタッフの車屋（中古車販売店・整備工場・修理工場）訪問記録を
 *     v7 Database（顧客系スプレッドシート）の「営業ログ」タブに記録
 *   - 一覧取得・後追い編集（帰所後にメモ・反応A-D・連絡先を追記する運用）
 *
 * 【設計方針（要件 v1 = B2B_SalesLog_MiniApp_Requirements_v1.md）】
 *   - 実験段階につき最小構成。通知・集計・複数ユーザー対応はしない
 *   - タブは V7_SPREADSHEET_ID 側（Looker Studio 等での将来利用を想定）。
 *     v7 GAS の関数は呼ばず openById で直接読み書き（分離原則は TaskManager と同様）
 *   - タブが無ければ自動作成（Setup 実行不要のゼロタッチ運用）
 *   - GPS はミニアプリ側で Telegram LocationManager API により取得（作成時のみ記録、編集で変更しない）
 *
 * 【シート列（営業ログ）】
 *   visit_id / 日時 / 緯度 / 経度 / 緯度経度結合("lat,lng") / 店名 / オーナー名 /
 *   電話 / 反応(A-D) / メモ / 最終更新日時
 *   ※ 緯度経度結合は将来の Looker Studio マップ用（今は列だけ用意）
 */

// ====== 定数 ======

const SALESLOG_SHEET_NAME = '営業ログ';
const SALESLOG_HEADERS = [
  'visit_id', '日時', '緯度', '経度', '緯度経度結合',
  '店名', 'オーナー名', '電話', '反応', 'メモ', '最終更新日時'
];
const SALESLOG_REACTIONS = ['A', 'B', 'C', 'D'];
const SALESLOG_LIST_LIMIT = 200;

// ====== 公開 API（Router からディスパッチ） ======

/**
 * 訪問記録の一覧取得（新しい順・最大 SALESLOG_LIST_LIMIT 件）
 * @param {string} chatId - Telegram chat_id
 * @return {Object} { ok, visits: [{ visitId, datetime, lat, lng, shopName, ownerName, phone, reaction, memo, updatedAt }] }
 */
function salesLogList(chatId) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const sheet = getSalesLogSheet_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, visits: [] };

  const startRow = Math.max(2, lastRow - SALESLOG_LIST_LIMIT + 1);
  const values = sheet.getRange(startRow, 1, lastRow - startRow + 1, SALESLOG_HEADERS.length).getValues();

  const visits = values.map(function(row) {
    return {
      visitId:   String(row[0] || ''),
      datetime:  formatSalesLogDateCell_(row[1]),
      lat:       row[2] === '' ? null : Number(row[2]),
      lng:       row[3] === '' ? null : Number(row[3]),
      shopName:  String(row[5] || ''),
      ownerName: String(row[6] || ''),
      phone:     String(row[7] || ''),
      reaction:  String(row[8] || ''),
      memo:      String(row[9] || ''),
      updatedAt: formatSalesLogDateCell_(row[10])
    };
  }).filter(function(v) { return v.visitId; });

  visits.reverse(); // 新しい順
  return { ok: true, visits: visits };
}

/**
 * 新規訪問記録
 * @param {string} chatId
 * @param {Object} p - { shopName, ownerName, phone, reaction, memo, gps: { lat, lng } | null }
 * @return {Object} { ok, visitId }
 */
function salesLogCreate(chatId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const shopName = String(p.shopName || '').trim();
  if (!shopName) return { ok: false, error: 'MISSING_SHOP_NAME' };

  const gps = normalizeSalesLogGps_(p.gps);
  const visitId = generateDateTimeId('SL');
  const nowStr = Utilities.formatDate(new Date(), getSalesLogTz_(), 'yyyy-MM-dd HH:mm');

  const sheet = getSalesLogSheet_();
  sheet.appendRow([
    visitId,
    nowStr,
    gps ? gps.lat : '',
    gps ? gps.lng : '',
    gps ? (gps.lat + ',' + gps.lng) : '',
    shopName,
    String(p.ownerName || '').trim(),
    String(p.phone || '').trim(),
    normalizeSalesLogReaction_(p.reaction),
    String(p.memo || ''),
    nowStr
  ]);

  return { ok: true, visitId: visitId };
}

/**
 * 訪問記録の修正・追記（GPS・日時は変更しない）
 * @param {string} chatId
 * @param {string} visitId
 * @param {Object} p - { shopName, ownerName, phone, reaction, memo }
 * @return {Object} { ok }
 */
function salesLogUpdate(chatId, visitId, p) {
  const staff = findStaffByChatId(chatId);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const shopName = String(p.shopName || '').trim();
  if (!shopName) return { ok: false, error: 'MISSING_SHOP_NAME' };

  const sheet = getSalesLogSheet_();
  const rowNum = findSalesLogRow_(sheet, visitId);
  if (!rowNum) return { ok: false, error: 'VISIT_NOT_FOUND' };

  const nowStr = Utilities.formatDate(new Date(), getSalesLogTz_(), 'yyyy-MM-dd HH:mm');

  // ⚠️ SALESLOG_HEADERS の列順に依存: F=店名(6) G=オーナー名(7) H=電話(8) I=反応(9) J=メモ(10) K=最終更新日時(11)
  //    ヘッダー構成を変更する場合は必ずここも同時修正すること
  sheet.getRange(rowNum, 6, 1, 6).setValues([[
    shopName,
    String(p.ownerName || '').trim(),
    String(p.phone || '').trim(),
    normalizeSalesLogReaction_(p.reaction),
    String(p.memo || ''),
    nowStr
  ]]);

  return { ok: true, visitId: visitId };
}

// ====== 内部実装 ======

/**
 * 「営業ログ」タブを取得（無ければヘッダー付きで自動作成）
 * ★ v7 Database（顧客系）側のタブ。getSheet()（勤務用シート）は使わない
 */
function getSalesLogSheet_() {
  const cfg = getConfig();
  if (!cfg.v7SpreadsheetId) {
    throw new Error('❌ V7_SPREADSHEET_ID 未設定（営業ログは v7 Database 側のタブです）');
  }
  const ss = SpreadsheetApp.openById(cfg.v7SpreadsheetId);
  let sheet = ss.getSheetByName(SALESLOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SALESLOG_SHEET_NAME);
    sheet.getRange(1, 1, 1, SALESLOG_HEADERS.length)
      .setValues([SALESLOG_HEADERS])
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
    // 電話番号の先頭ゼロ保持（数値化防止）
    // ※ この書式はタブ自動作成時のみ適用。タブを手動で先に作った場合は入らない（ゼロタッチ自動作成が前提）
    sheet.getRange('H2:H').setNumberFormat('@');
    Logger.log('🆕 v7 Database に「' + SALESLOG_SHEET_NAME + '」タブを新規作成');
  }
  return sheet;
}

/**
 * visit_id で行番号を検索（見つからなければ null）
 */
function findSalesLogRow_(sheet, visitId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const target = String(visitId);
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === target) return i + 2;
  }
  return null;
}

/**
 * GPS 入力を正規化（不正値は null = GPS なし保存）
 */
function normalizeSalesLogGps_(gps) {
  if (!gps) return null;
  const lat = Number(gps.lat);
  const lng = Number(gps.lng);
  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

/**
 * 反応を A/B/C/D に正規化（それ以外は空 = 未入力）
 */
function normalizeSalesLogReaction_(reaction) {
  const r = String(reaction || '').trim().toUpperCase();
  return SALESLOG_REACTIONS.indexOf(r) >= 0 ? r : '';
}

/**
 * 日時セルを 'yyyy-MM-dd HH:mm' 文字列に正規化
 * ★ Sheets が Date に変換したセルはシートの TZ で解釈（OPS_LESSONS #5 の TZ ズレ対策）
 */
function formatSalesLogDateCell_(cell) {
  if (cell instanceof Date) {
    return Utilities.formatDate(cell, getSalesLogTz_(), 'yyyy-MM-dd HH:mm');
  }
  return String(cell || '').trim();
}

/**
 * v7 Database の TZ を取得（失敗時は OPS_TZ にフォールバック・実行中キャッシュ）
 */
let _salesLogTzCache_ = null;
function getSalesLogTz_() {
  if (_salesLogTzCache_) return _salesLogTzCache_;
  try {
    const id = getConfig().v7SpreadsheetId;
    const tz = SpreadsheetApp.openById(id).getSpreadsheetTimeZone();
    _salesLogTzCache_ = tz || OPS_TZ;
  } catch (e) {
    Logger.log('⚠️ getSalesLogTz_ failed: ' + e);
    _salesLogTzCache_ = OPS_TZ;
  }
  return _salesLogTzCache_;
}

// ====== デバッグ用 ======

function debugSalesLogCreate() {
  // ロンの chatId でテスト記録
  const res = salesLogCreate('7500384947', {
    shopName: 'テスト車屋',
    ownerName: 'テストオーナー',
    phone: '012345678',
    reaction: 'B',
    memo: 'debugSalesLogCreate からのテスト行',
    gps: { lat: 11.556374, lng: 104.928207 }
  });
  Logger.log(JSON.stringify(res, null, 2));
}

function debugSalesLogList() {
  const res = salesLogList('7500384947');
  Logger.log(JSON.stringify(res, null, 2));
}
