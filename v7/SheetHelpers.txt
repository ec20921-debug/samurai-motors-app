/**
 * SheetHelpers.gs — スプレッドシート読み書きユーティリティ
 *
 * 【責務】
 *   - シートオブジェクト取得（キャッシュあり）
 *   - 行の追加 / 検索 / 更新のラッパー
 *   - 料金設定（Plan_Prices）の60秒キャッシュ読み込み
 *   - 各シートの列名 ⇔ 列番号マッピング
 *
 * 【設計方針】
 *   - スプレッドシートは CONFIG.spreadsheetId から openById で取得
 *   - ヘッダー行（1行目）は日本語（Setup.gs で定義済み）
 *   - 列位置はヘッダー行から動的に取得（ハードコード禁止、並び替えに強くする）
 */

// ====== スプレッドシート取得 ======

/**
 * スプレッドシート本体を取得（1回の実行内でキャッシュ）
 */
var __ssCache = null;
function getSpreadsheet() {
  if (__ssCache) return __ssCache;
  const cfg = getConfig();
  __ssCache = SpreadsheetApp.openById(cfg.spreadsheetId);
  return __ssCache;
}

/**
 * シートを取得
 *
 * @param {string} sheetName - SHEET_NAMES.CUSTOMERS 等
 * @return {Sheet}
 */
function getSheet(sheetName) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    throw new Error('❌ シート未作成: ' + sheetName + '（先に setupV7Initial を実行）');
  }
  return sheet;
}

// ====== ヘッダー列マッピング ======

/**
 * シートのヘッダー行を読み取り、列名 → 1-based 列番号のマップを返す
 *
 * @param {string} sheetName
 * @return {Object<string, number>}
 */
function getHeaderMap(sheetName) {
  const sheet = getSheet(sheetName);
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  headers.forEach(function(h, i) {
    if (h !== '' && h !== null && h !== undefined) {
      map[String(h)] = i + 1;
    }
  });
  return map;
}

// ====== 行操作 ======

/**
 * 行を末尾に追加する
 *
 * @param {string} sheetName
 * @param {Object} rowObj - { 列ヘッダー名: 値, ... }
 */
function appendRow(sheetName, rowObj) {
  const sheet = getSheet(sheetName);
  const headers = getHeaderMap(sheetName);
  const lastCol = sheet.getLastColumn();
  const row = new Array(lastCol).fill('');
  Object.keys(rowObj).forEach(function(key) {
    const colIdx = headers[key];
    if (colIdx) {
      row[colIdx - 1] = rowObj[key];
    } else {
      Logger.log('⚠️ appendRow: 列 "' + key + '" が ' + sheetName + ' に存在しません');
    }
  });
  sheet.appendRow(row);
}

/**
 * 指定列の値で行を検索（最初にヒットした1行を返す）
 *
 * @param {string} sheetName
 * @param {string} colName - 検索対象の列名
 * @param {*} value - 検索値
 * @return {{rowIndex: number, data: Object} | null}
 */
function findRow(sheetName, colName, value) {
  const sheet = getSheet(sheetName);
  const headers = getHeaderMap(sheetName);
  const colIdx = headers[colName];
  if (!colIdx) {
    throw new Error('❌ findRow: 列 "' + colName + '" が ' + sheetName + ' に存在しません');
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const colValues = sheet.getRange(2, colIdx, lastRow - 1, 1).getValues();
  for (let i = 0; i < colValues.length; i++) {
    if (String(colValues[i][0]) === String(value)) {
      const rowIndex = i + 2; // 2行目から
      return { rowIndex: rowIndex, data: readRow(sheetName, rowIndex) };
    }
  }
  return null;
}

/**
 * 指定列の値で行を検索し、「最後にヒットした1行」を返す
 * 同じ予約で複数ジョブ行がある場合に最新行を更新したい時に使う
 *
 * @param {string} sheetName
 * @param {string} colName
 * @param {*} value
 * @return {{rowIndex: number, data: Object} | null}
 */
function findLastRow(sheetName, colName, value) {
  const sheet = getSheet(sheetName);
  const headers = getHeaderMap(sheetName);
  const colIdx = headers[colName];
  if (!colIdx) {
    throw new Error('❌ findLastRow: 列 "' + colName + '" が ' + sheetName + ' に存在しません');
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const colValues = sheet.getRange(2, colIdx, lastRow - 1, 1).getValues();
  var hitRow = -1;
  for (let i = 0; i < colValues.length; i++) {
    if (String(colValues[i][0]) === String(value)) {
      hitRow = i + 2;
    }
  }
  if (hitRow === -1) return null;
  return { rowIndex: hitRow, data: readRow(sheetName, hitRow) };
}

/**
 * 指定行を読み取ってオブジェクトで返す
 */
function readRow(sheetName, rowIndex) {
  const sheet = getSheet(sheetName);
  const headers = getHeaderMap(sheetName);
  const lastCol = sheet.getLastColumn();
  const values = sheet.getRange(rowIndex, 1, 1, lastCol).getValues()[0];
  const obj = {};
  Object.keys(headers).forEach(function(key) {
    obj[key] = values[headers[key] - 1];
  });
  return obj;
}

/**
 * 指定行の特定列を更新
 *
 * @param {string} sheetName
 * @param {number} rowIndex
 * @param {Object} updates - { 列名: 新値, ... }
 */
function updateRow(sheetName, rowIndex, updates) {
  const sheet = getSheet(sheetName);
  const headers = getHeaderMap(sheetName);
  Object.keys(updates).forEach(function(key) {
    const colIdx = headers[key];
    if (colIdx) {
      sheet.getRange(rowIndex, colIdx).setValue(updates[key]);
    } else {
      Logger.log('⚠️ updateRow: 列 "' + key + '" が ' + sheetName + ' に存在しません');
    }
  });
}

// ====== 料金設定キャッシュ（60秒） ======

/**
 * 料金設定シートを解析して設定オブジェクトを返す
 *
 * @return {{
 *   plans: Object<string, {sedan: number, suv: number, durationSedan: number, durationSuv: number}>,
 *   travelFee: number,
 *   bufferMinutes: number,
 *   businessHourStart: number,
 *   businessHourEnd: number
 * }}
 */
function getBookingConfig() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('plan_prices_cache');
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // キャッシュ破損 → 再読込
    }
  }

  const sheet = getSheet(SHEET_NAMES.PLAN_PRICES);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('❌ 料金設定シートが空です');
  }
  const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();

  const config = {
    plans: {},
    travelFee: 0,
    bufferMinutes: 30,
    businessHourStart: 9,
    businessHourEnd: 18
  };

  data.forEach(function(row) {
    const name = String(row[0] || '').trim();
    if (!name) return;
    const sedan = Number(row[1]);
    const suv = Number(row[2]);
    const durationSedan = Number(row[3]);
    const durationSuv = Number(row[4]);

    if (name === '出張料') {
      config.travelFee = sedan; // セダン列に代表値
    } else if (name === '【設定】移動バッファ(分)') {
      config.bufferMinutes = sedan;
    } else if (name === '【設定】営業開始時刻') {
      config.businessHourStart = sedan;
    } else if (name === '【設定】営業終了時刻') {
      config.businessHourEnd = sedan;
    } else {
      // 通常プラン（清/鏡/匠/将軍）
      config.plans[name] = {
        sedan: sedan,
        suv: suv,
        durationSedan: durationSedan,
        durationSuv: durationSuv
      };
    }
  });

  cache.put('plan_prices_cache', JSON.stringify(config), TTL.PLAN_PRICES_CACHE);
  return config;
}

/**
 * 料金設定キャッシュを強制クリア（シート更新後即反映したい時用）
 */
function clearBookingConfigCache() {
  CacheService.getScriptCache().remove('plan_prices_cache');
  Logger.log('🧹 plan_prices_cache をクリアしました');
}

// ====== ID採番 ======

/**
 * 日付ベースの連番 ID を採番する
 * 例: prefix='BK', today='2026-04-15', seq=42 → 'BK-20260415-042'
 *
 * @param {string} prefix
 * @param {string} sheetName
 * @param {string} idColName - ID列の名前
 * @return {string}
 */
function generateDateSeqId(prefix, sheetName, idColName) {
  const today = Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyyMMdd');
  const sheet = getSheet(sheetName);
  const headers = getHeaderMap(sheetName);
  const colIdx = headers[idColName];
  if (!colIdx) {
    throw new Error('❌ generateDateSeqId: 列 "' + idColName + '" が見つかりません');
  }
  const lastRow = sheet.getLastRow();

  let maxSeq = 0;
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, colIdx, lastRow - 1, 1).getValues();
    const re = new RegExp('^' + prefix + '-' + today + '-(\\d+)$');
    ids.forEach(function(r) {
      const m = re.exec(String(r[0] || ''));
      if (m) {
        const n = parseInt(m[1], 10);
        if (!isNaN(n) && n > maxSeq) maxSeq = n;
      }
    });
  }
  const next = maxSeq + 1;
  const padded = ('000' + next).slice(-3);
  return prefix + '-' + today + '-' + padded;
}

// ====== デバッグ ======

/**
 * 各シートの行数・ヘッダーを表示
 */
function showSheetStatus() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📊 シート状況');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Object.keys(SHEET_NAMES).forEach(function(key) {
    const name = SHEET_NAMES[key];
    try {
      const sheet = getSheet(name);
      const rows = Math.max(0, sheet.getLastRow() - 1);
      const cols = sheet.getLastColumn();
      Logger.log('✅ ' + name + ' : ' + rows + '行 / ' + cols + '列');
    } catch (err) {
      Logger.log('❌ ' + name + ' : ' + err.message);
    }
  });
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
