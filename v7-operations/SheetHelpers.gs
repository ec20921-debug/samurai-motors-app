/**
 * SheetHelpers.gs — シート CRUD ユーティリティ
 *
 * 【責務】
 *   - v7-ops 用スプレッドシートの読み書き
 *   - スタッフマスターの 60秒キャッシュ付き読み取り
 *   - 列名ベースの汎用 append / find 関数
 *
 * 【設計方針】
 *   - getConfig().operationsSpreadsheetId で常に勤務専用シートを開く
 *   - 列ヘッダーは1行目を基準（v7 と同じ方式）
 */

/**
 * シートを取得（存在しなければ例外）
 */
function getSheet(sheetName) {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('❌ シート未発見: ' + sheetName);
  return sheet;
}

/**
 * ヘッダー行（1行目）を配列で取得
 */
function getHeaders(sheetName) {
  const sheet = getSheet(sheetName);
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

/**
 * オブジェクト形式で1行追加
 * dict: { '列名': 値, ... } のハッシュ
 */
function appendRow(sheetName, dict) {
  const sheet = getSheet(sheetName);
  const headers = getHeaders(sheetName);
  const row = headers.map(function(h) {
    return dict.hasOwnProperty(h) ? dict[h] : '';
  });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

/**
 * 指定列の値で行を検索
 * @return {{row: number, data: Object} | null}
 */
function findRow(sheetName, columnName, value) {
  const sheet = getSheet(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const headers = getHeaders(sheetName);
  const colIdx = headers.indexOf(columnName);
  if (colIdx < 0) throw new Error('❌ 列未発見: ' + columnName + ' in ' + sheetName);

  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][colIdx]) === String(value)) {
      const data = {};
      headers.forEach(function(h, j) { data[h] = values[i][j]; });
      return { row: i + 2, data: data };
    }
  }
  return null;
}

/**
 * 指定行の列値を更新
 * updates: { '列名': 新値, ... }
 */
function updateRow(sheetName, rowNumber, updates) {
  const sheet = getSheet(sheetName);
  const headers = getHeaders(sheetName);
  Object.keys(updates).forEach(function(col) {
    const colIdx = headers.indexOf(col);
    if (colIdx < 0) {
      Logger.log('⚠️ updateRow: 列 ' + col + ' 未発見、スキップ');
      return;
    }
    sheet.getRange(rowNumber, colIdx + 1).setValue(updates[col]);
  });
}

/**
 * 全行をオブジェクト配列で取得
 */
function getAllRows(sheetName) {
  const sheet = getSheet(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const headers = getHeaders(sheetName);
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function(row) {
    const o = {};
    headers.forEach(function(h, j) { o[h] = row[j]; });
    return o;
  });
}

// ====== スタッフマスターキャッシュ（60秒） ======

/**
 * スタッフマスターから有効スタッフ一覧を取得（CacheService 60秒キャッシュ）
 *
 * @return {Array<Object>} [{ staffId, chatId, nameJp, nameEn, role, employmentType, hireDate, monthlySalary, active, memo }]
 */
function getActiveStaff() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('staff_master_cache');
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through */ }
  }

  const rows = getAllRows(SHEET_NAMES.STAFF_MASTER);
  const staff = rows
    .filter(function(r) { return r['有効'] === true || String(r['有効']).toUpperCase() === 'TRUE'; })
    .map(function(r) {
      return {
        staffId:        String(r['スタッフID'] || ''),
        chatId:         String(r['Chat ID'] || ''),
        nameJp:         String(r['氏名(JP)'] || ''),
        nameEn:         String(r['Name(EN)'] || ''),
        role:           String(r['役割'] || ''),
        timezone:       String(r['タイムゾーン'] || OPS_TZ),
        username:       String(r['Telegram Username'] || ''),
        employmentType: String(r['雇用形態'] || ''),
        hireDate:       r['入社日'] || '',
        monthlySalary:  Number(r['月給(USD)']) || 0,
        active:         true,
        memo:           String(r['備考'] || '')
      };
    });

  cache.put('staff_master_cache', JSON.stringify(staff), TTL.STAFF_MASTER_CACHE);
  return staff;
}

/**
 * 氏名(JP) からスタッフ1名を検索
 */
function findStaffByNameJp(nameJp) {
  const all = getActiveStaff();
  const target = String(nameJp || '').trim();
  for (let i = 0; i < all.length; i++) {
    if (all[i].nameJp === target) return all[i];
  }
  return null;
}

/**
 * Chat ID からスタッフ1名を検索
 */
function findStaffByChatId(chatId) {
  const all = getActiveStaff();
  const target = String(chatId);
  for (let i = 0; i < all.length; i++) {
    if (all[i].chatId === target) return all[i];
  }
  return null;
}

/**
 * スタッフIDからスタッフ1名を検索
 */
function findStaffById(staffId) {
  const all = getActiveStaff();
  for (let i = 0; i < all.length; i++) {
    if (all[i].staffId === staffId) return all[i];
  }
  return null;
}

/**
 * スタッフマスターキャッシュを強制クリア
 */
function clearStaffMasterCache() {
  CacheService.getScriptCache().remove('staff_master_cache');
  Logger.log('🧹 スタッフマスターキャッシュをクリアしました');
}

// ====== 汎用 ID 採番 ======

/**
 * 日付付き連番ID採番 `{prefix}-YYYYMMDD-NNN`
 * 同じ日・同じプレフィックスの既存最大連番+1 を返す
 */
function generateDateSeqId(prefix, sheetName, idColumnName) {
  const tz = OPS_TZ;
  const dateStr = Utilities.formatDate(new Date(), tz, 'yyyyMMdd');
  const headPrefix = prefix + '-' + dateStr + '-';

  const rows = getAllRows(sheetName);
  let maxSeq = 0;
  rows.forEach(function(r) {
    const id = String(r[idColumnName] || '');
    if (id.indexOf(headPrefix) === 0) {
      const seq = parseInt(id.substring(headPrefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });

  const nextSeq = maxSeq + 1;
  return headPrefix + ('00' + nextSeq).slice(-3);
}

/**
 * 時刻付きID採番 `{prefix}-YYYYMMDD-HHmmss`
 */
function generateDateTimeId(prefix) {
  const ts = Utilities.formatDate(new Date(), OPS_TZ, 'yyyyMMdd-HHmmss');
  return prefix + '-' + ts;
}
