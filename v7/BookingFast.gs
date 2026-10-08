/**
 * BookingFast.gs — 予約画面の起動(booking_init)専用の軽い顧客検索
 *
 * 2026-10-08: findCustomerRow(findRow + readRow)は1件ヒットでシート往復が約12回になる。
 *   起動画面では「顧客シートを1回だけ全読み」して同じ形 {rowIndex, data} を返す。
 *   キャッシュは使わない（古い顧客IDを予約に書かないため）。
 *   findCustomerRow / findRow 本体には触れない（getOrCreateTopic のロック内再確認などはそのまま）。
 */

/**
 * @param {string} chatId
 * @return {{rowIndex:number, data:Object}|null}
 */
function findCustomerForInit_(chatId) {
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;

  // 見出し → 列番号（getHeaderMap と同じく空欄は飛ばし、重複は後ろ優先）
  const headers = {};
  values[0].forEach(function(h, i) {
    if (h !== '' && h !== null && h !== undefined) headers[String(h)] = i + 1;
  });
  const colIdx = headers['チャットID'];
  if (!colIdx) {
    throw new Error('❌ findRow: 列 "チャットID" が ' + SHEET_NAMES.CUSTOMERS + ' に存在しません');
  }

  const target = String(chatId);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][colIdx - 1]) === target) {
      const data = {};
      Object.keys(headers).forEach(function(key) { data[key] = values[i][headers[key] - 1]; });
      return { rowIndex: i + 1, data: data };
    }
  }
  return null;
}
