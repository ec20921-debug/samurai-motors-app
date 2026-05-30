/**
 * CustomerContact.gs — 顧客への個別連絡（1:1 送信）
 *
 * 【責務】
 *   「顧客」シートで選択した1名へ、予約Bot経由でテキストを1通送る。
 *   一斉送信は Campaign.gs（📢 キャンペーン）が担当。本ファイルは個別連絡のみ。
 *
 * 【経緯】
 *   旧 BroadcastTool.gs（📩 顧客連絡）を 2026-05-29 に Campaign 系へ統合する際、
 *   「一斉送信(Campaign.gs)」と「個別送信(本ファイル)」を責務分割した。
 *   メニューは「📢 キャンペーン」1本に集約（campaignOnOpen_ から本ファイルの
 *   sendMessageToSelectedCustomer を呼ぶ）。
 *
 * 【呼び出し元】
 *   Campaign.gs の campaignOnOpen_() メニュー「📤 選択した顧客に1通だけ送信」
 */

/**
 * 指定チャットIDにテキストメッセージを1件送る
 *
 * @param {string|number} chatId
 * @param {string} text
 * @return {{ok: boolean, raw: Object}}
 */
function sendToCustomer(chatId, text) {
  const res = sendMessage(BOT_TYPE.BOOKING, chatId, text);
  Logger.log('sendToCustomer chatId=' + chatId + ' ok=' + (res && res.ok));
  if (!res || !res.ok) {
    Logger.log('  失敗詳細: ' + JSON.stringify(res));
  }
  return { ok: !!(res && res.ok), raw: res };
}

/**
 * 「顧客」シートで選択した行の顧客に、ダイアログ入力した本文を1通送る
 * （Campaign メニュー「📤 選択した顧客に1通だけ送信」から呼ばれる）
 */
function sendMessageToSelectedCustomer() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  // 1. 「顧客」シート上にいるかチェック
  if (sheet.getName() !== SHEET_NAMES.CUSTOMERS) {
    ui.alert('⚠️ シートが違います',
      '「顧客」シートに切り替えてから実行してください。\n現在のシート: ' + sheet.getName(),
      ui.ButtonSet.OK);
    return;
  }

  // 2. 選択行
  const row = sheet.getActiveCell().getRow();
  if (row < 2) {
    ui.alert('⚠️ 顧客の行（2行目以降）を選択してください');
    return;
  }

  // 3. 顧客情報
  const headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  const colChat  = headers['チャットID'];
  const colName  = headers['氏名'];
  const colUser  = headers['ユーザー名'];
  const colTopic = headers['トピックID'];
  const colLast  = headers['最終連絡日時'];

  if (!colChat || !colName) {
    ui.alert('❌ 顧客シートのヘッダー構造が想定と異なります（チャットID/氏名 が見つからない）');
    return;
  }

  const chatId   = String(sheet.getRange(row, colChat).getValue() || '').trim();
  const name     = String(sheet.getRange(row, colName).getValue() || '').trim();
  const username = colUser  ? String(sheet.getRange(row, colUser).getValue()  || '').trim() : '';
  const topicId  = colTopic ? sheet.getRange(row, colTopic).getValue() : '';

  if (!chatId) {
    ui.alert('❌ この行にチャットIDが入っていません');
    return;
  }

  // 4. 本文入力
  const title  = '📤 ' + (name || '(名前未登録)') + (username ? ' / @' + username : '');
  const prompt =
    '本文を入力してください\n\n' +
    '🆔 チャットID: ' + chatId + '\n' +
    (topicId ? '🧵 トピックID: ' + topicId + '\n' : '') +
    '\n※ 改行も使えます。最大4096文字。';

  const response = ui.prompt(title, prompt, ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const text = response.getResponseText();
  if (!text || !text.trim()) {
    ui.alert('⚠️ 本文が空のため送信を中止しました');
    return;
  }

  // 5. 送信
  const result = sendToCustomer(chatId, text);

  // 6. 結果
  if (result.ok) {
    ss.toast('✅ ' + (name || chatId) + ' に送信しました', '送信成功', 5);
    if (colLast) sheet.getRange(row, colLast).setValue(new Date());
    try { logBroadcastToChatHistory_(chatId, topicId, text); }
    catch (e) { Logger.log('⚠️ チャット履歴記録失敗（送信は成功）: ' + e); }
  } else {
    const desc = (result.raw && result.raw.description)
      ? result.raw.description : JSON.stringify(result.raw);
    ui.alert('❌ 送信失敗',
      '宛先: ' + (name || chatId) + '\n\n原因:\n' + desc + '\n\n' +
      '【よくある原因】\n' +
      '• Forbidden: bot was blocked by the user → 顧客がBotをブロック済み\n' +
      '• chat not found → チャットID間違いまたは会話完全削除\n' +
      '• Too Many Requests → レート制限（少し待って再実行）',
      ui.ButtonSet.OK);
  }
}

/**
 * チャット履歴シートへ「管理→顧客」の送信ログを残す
 */
function logBroadcastToChatHistory_(chatId, topicId, content) {
  appendRow(SHEET_NAMES.CHAT_LOG, {
    '日時':           new Date(),
    '方向':           '管理→顧客',
    'チャットID':     String(chatId),
    'トピックID':     topicId || '',
    'メッセージ種別': 'テキスト',
    '内容':           content,
    '管理者ID':       'spreadsheet_menu'
  });
}
