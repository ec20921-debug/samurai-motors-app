/**
 * BroadcastTool.gs — 顧客への個別/一斉メッセージ送信ツール
 *
 * 【責務】
 *   既存顧客（CUSTOMERSシートに記録されたチャットID）に対して、
 *   予約Botから直接メッセージを送る。
 *
 * 【主な機能】
 *   - スプレッドシートメニュー「📩 顧客連絡」から、選択行の顧客に1通送信
 *   - 送信成功時に「最終連絡日時」更新 + チャット履歴へ記録
 *   - デバッグ用の単体テスト送信
 *
 * 【初回セットアップ】
 *   GASエディタで `setupBroadcastMenu()` を1回実行 → 以降スプレッドシートを開くたびにメニュー表示
 *
 * 【注意】
 *   - 顧客がBotをブロックしている場合は届かない（API応答で検知可能）
 *   - 一斉送信時はレート制限（30msg/秒）を考慮し1秒間隔程度を推奨（将来実装）
 */

// ====== 個別送信ヘルパー ======

/**
 * 指定チャットIDにテキストメッセージを1件送る
 *
 * @param {string|number} chatId - 送信先チャットID
 * @param {string} text - 送信するテキスト
 * @return {{ok: boolean, raw: Object}} 送信結果
 */
function sendToCustomer(chatId, text) {
  const res = sendMessage(BOT_TYPE.BOOKING, chatId, text);
  Logger.log('sendToCustomer chatId=' + chatId + ' ok=' + res.ok);
  if (!res.ok) {
    Logger.log('  失敗詳細: ' + JSON.stringify(res));
  }
  return { ok: !!res.ok, raw: res };
}

// ====== メニュー: スプレッドシート連動 ======

/**
 * onOpen トリガー登録（initial setup、1回だけ実行）
 *
 * 実行後、スプレッドシートを開き直すと「📩 顧客連絡」メニューが表示される。
 * 既存の他メニュー（経営ダッシュボード等）には影響しない。
 */
function setupBroadcastMenu() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 既存の自分のトリガーだけ削除（他メニューのトリガーは残す）
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'broadcastMenuOnOpen_') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('broadcastMenuOnOpen_')
    .forSpreadsheet(ss)
    .onOpen()
    .create();

  // 即時に1回呼んで、現セッションでもメニューを出す
  try {
    broadcastMenuOnOpen_();
  } catch (e) {
    Logger.log('⚠️ onOpen 即時実行スキップ: ' + e);
  }

  Logger.log('✅ 「📩 顧客連絡」メニューのonOpenトリガーを登録しました');
}

/**
 * onOpen ハンドラ: メニューを構築
 */
function broadcastMenuOnOpen_() {
  SpreadsheetApp.getUi()
    .createMenu('📩 顧客連絡')
    .addItem('📤 この顧客にメッセージ送信', 'sendMessageToSelectedCustomer')
    .addSeparator()
    .addItem('❓ 使い方', 'showBroadcastHelp_')
    .addToUi();
}

/**
 * 選択行の顧客に対してメッセージを送る（メニューから呼ばれる）
 */
function sendMessageToSelectedCustomer() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getActiveSheet();

  // ── 1. 「顧客」シート上にいるかチェック ──
  if (sheet.getName() !== SHEET_NAMES.CUSTOMERS) {
    ui.alert(
      '⚠️ シートが違います',
      '「顧客」シートに切り替えてから実行してください。\n現在のシート: ' + sheet.getName(),
      ui.ButtonSet.OK
    );
    return;
  }

  // ── 2. 選択行を特定 ──
  const row = sheet.getActiveCell().getRow();
  if (row < 2) {
    ui.alert('⚠️ 顧客の行（2行目以降）を選択してください');
    return;
  }

  // ── 3. 顧客情報を読み取り ──
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

  // ── 4. 本文入力ダイアログ ──
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

  // ── 5. 送信 ──
  const result = sendToCustomer(chatId, text);

  // ── 6. 結果処理 ──
  if (result.ok) {
    ss.toast('✅ ' + (name || chatId) + ' に送信しました', '送信成功', 5);

    // 最終連絡日時を更新
    if (colLast) {
      sheet.getRange(row, colLast).setValue(new Date());
    }

    // チャット履歴に記録（失敗しても本処理は止めない）
    try {
      logBroadcastToChatHistory_(chatId, topicId, text);
    } catch (e) {
      Logger.log('⚠️ チャット履歴への記録失敗（送信自体は成功）: ' + e);
    }
  } else {
    const desc = (result.raw && result.raw.description)
      ? result.raw.description
      : JSON.stringify(result.raw);
    ui.alert(
      '❌ 送信失敗',
      '宛先: ' + (name || chatId) + '\n\n原因:\n' + desc + '\n\n' +
      '【よくある原因】\n' +
      '• Forbidden: bot was blocked by the user → 顧客がBotをブロック済み\n' +
      '• chat not found → チャットID間違いまたは会話完全削除\n' +
      '• Too Many Requests → レート制限（少し待って再実行）',
      ui.ButtonSet.OK
    );
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

/**
 * 使い方ヘルプダイアログ
 */
function showBroadcastHelp_() {
  SpreadsheetApp.getUi().alert(
    '📩 顧客連絡 — 使い方',
    '【手順】\n' +
    '1. 「顧客」シートを開く\n' +
    '2. 連絡したい顧客の行のどこかをクリック\n' +
    '3. メニュー「📩 顧客連絡 → 📤 この顧客にメッセージ送信」をクリック\n' +
    '4. 表示されたダイアログに本文を入力\n' +
    '5. OKを押すと予約Botから即送信\n\n' +
    '【成功時の動作】\n' +
    '• 顧客のTelegramに即届く\n' +
    '• 「最終連絡日時」列が自動更新\n' +
    '• 「チャット履歴」シートに送信記録\n\n' +
    '【失敗時】\n' +
    '原因がアラートで表示されます（ブロック検知等）',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ====== デバッグ用テスト送信 ======

/**
 * 【デバッグ専用】チャットID 7500384947 にテストメッセージを送る
 *
 * 通常の業務では使わない。動作確認・障害切り分け用。
 */
function testSendOnce() {
  const chatId = '7500384947';
  const text = 'សាកល្បង / テスト送信です（Samurai Motors v7）';

  const result = sendToCustomer(chatId, text);

  if (result.ok) {
    Logger.log('✅ 送信成功');
  } else {
    Logger.log('❌ 送信失敗: ' + JSON.stringify(result.raw));
  }
  return result;
}
