/**
 * CustomerChat.gs — 顧客⇔管理者 メッセージ転送
 *
 * 【責務】
 *   - 顧客（DM）→ 管理グループの該当トピックへ転送
 *   - 管理グループのトピック内で管理者が送信 → 該当顧客へ転送
 *   - チャット履歴シートへのログ記録
 *
 * 【対応メッセージ種別】
 *   text / photo / video / document / voice / location / sticker / video_note
 *
 * 【方向判定ロジック】
 *   msg.chat.id === ADMIN_GROUP_ID → 管理者→顧客（thread_id から逆引き）
 *   msg.chat.type === 'private'    → 顧客→管理者
 */

// ====== 顧客 → 管理者（転送） ======

/**
 * 顧客からのメッセージを管理グループの該当トピックへ転送する
 *
 * @param {Object} msg - Telegram message オブジェクト
 */
function forwardCustomerMessage(msg) {
  const customer = extractCustomerFromMessage(msg);
  const cfg = getConfig();
  let result = null;

  // トピックが消えていたら作り直して1回だけ転送し直す（ForumTopicManager.gs・2026-10-29）
  const sent = sendWithTopicRecovery_(customer, function(threadId, topic) {
    // ── 初回トピック作成時（作り直した時も）は挨拶メッセージを先頭に送信 ──
    if (topic.isNew) {
      const intro =
        (topic.recreated ? '♻️ トピックを作り直しました（前のトピックは削除されていました）\n' : '🆕 新規顧客からの最初の連絡\n') +
        '━━━━━━━━━━━━━━━━━\n' +
        '氏名: ' + buildDisplayName(customer) + '\n' +
        'Chat ID: ' + customer.chatId + '\n' +
        (customer.username ? 'Username: @' + customer.username + '\n' : '') +
        (customer.languageCode ? '言語: ' + customer.languageCode + '\n' : '') +
        '━━━━━━━━━━━━━━━━━\n' +
        (topic.recreated ? 'これまでのやりとりはスプレッドシートの「チャット履歴」タブにあります。\n' : '') +
        'このトピックで返信すると顧客にメッセージが届きます。';
      sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, intro, {
        message_thread_id: threadId
      });
    }

    // ── メッセージ種別に応じて転送 ──
    result = sendMessageToTopic(msg, threadId);
    return result.res;
  });
  if (!sent.ok) {
    // トピックに届かなかった（閉じたトピック・作り直しても失敗など）→ グループ直下（General）へ誰からかを添えて送る
    // General での返信はお客様に届かない（handleAdminReply はトピック内だけ）ので、その旨も書く
    Logger.log('⚠️ forwardCustomerMessage: 管理グループへの転送失敗 chatId=' + customer.chatId + ' threadId=' + sent.threadId);
    sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
      '⚠️ お客様のメッセージをトピックに転送できませんでした\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      '氏名: ' + buildDisplayName(customer) + '\n' +
      'Chat ID: ' + customer.chatId + '\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      'このすぐ下が届いた内容です。ここ（General）で返信してもお客様には届きません。');
    sendMessageToTopic(msg, undefined);   // thread 指定なし＝General
  }

  // ── 顧客最終連絡日時を更新 ──
  touchCustomerLastContact(customer.chatId);

  // ── チャット履歴ログ ──
  logChat({
    direction: '顧客→管理',
    chatId: customer.chatId,
    threadId: sent.threadId,
    messageType: result.messageType,
    content: (sent.ok ? '' : '(トピックへの転送失敗・General へ) ') + result.content,
    adminId: ''
  });
}

/**
 * メッセージの内容に応じて適切な send* を呼び分ける
 *
 * @return {{messageType: string, content: string, res: Object}} ログ用の要約と Telegram API の応答
 */
function sendMessageToTopic(msg, threadId) {
  const cfg = getConfig();
  const chatId = cfg.adminGroupId;
  const opts = { message_thread_id: threadId };
  let res;

  // テキスト
  if (msg.text) {
    res = sendMessage(BOT_TYPE.BOOKING, chatId, msg.text, opts);
    return { messageType: 'テキスト', content: truncate(msg.text, 200), res: res };
  }

  // 写真（最大解像度を送信）
  if (msg.photo && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1];
    const caption = msg.caption || '';
    res = sendPhoto(BOT_TYPE.BOOKING, chatId, best.file_id, Object.assign({
      caption: caption
    }, opts));
    return { messageType: '写真', content: caption || '(写真)', res: res };
  }

  // 動画
  if (msg.video) {
    res = sendTelegramGeneric('sendVideo', {
      chat_id: chatId,
      video: msg.video.file_id,
      caption: msg.caption || '',
      message_thread_id: threadId
    });
    return { messageType: '動画', content: msg.caption || '(動画)', res: res };
  }

  // ドキュメント
  if (msg.document) {
    res = sendTelegramGeneric('sendDocument', {
      chat_id: chatId,
      document: msg.document.file_id,
      caption: msg.caption || '',
      message_thread_id: threadId
    });
    return { messageType: 'ドキュメント', content: msg.document.file_name || '(ファイル)', res: res };
  }

  // 音声メモ
  if (msg.voice) {
    res = sendTelegramGeneric('sendVoice', {
      chat_id: chatId,
      voice: msg.voice.file_id,
      caption: msg.caption || '',
      message_thread_id: threadId
    });
    return { messageType: '音声', content: '(音声メモ ' + (msg.voice.duration || 0) + '秒)', res: res };
  }

  // ビデオメモ（丸い動画）
  if (msg.video_note) {
    res = sendTelegramGeneric('sendVideoNote', {
      chat_id: chatId,
      video_note: msg.video_note.file_id,
      message_thread_id: threadId
    });
    return { messageType: '動画', content: '(ビデオメモ)', res: res };
  }

  // 位置情報
  if (msg.location) {
    const loc = msg.location;
    res = sendTelegramGeneric('sendLocation', {
      chat_id: chatId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      message_thread_id: threadId
    });
    const locText = '📍 緯度: ' + loc.latitude + ' / 経度: ' + loc.longitude;
    return { messageType: '位置情報', content: locText, res: res };
  }

  // ステッカー
  if (msg.sticker) {
    res = sendTelegramGeneric('sendSticker', {
      chat_id: chatId,
      sticker: msg.sticker.file_id,
      message_thread_id: threadId
    });
    return { messageType: 'テキスト', content: '(ステッカー ' + (msg.sticker.emoji || '') + ')', res: res };
  }

  // 未対応の種別はログ通知
  res = sendMessage(BOT_TYPE.BOOKING, chatId,
    '⚠️ 未対応のメッセージ種別を受信（ログ確認してください）',
    opts
  );
  return { messageType: 'テキスト', content: '(未対応種別)', res: res };
}

// ====== 管理者 → 顧客（返信） ======

/**
 * 管理グループのトピック内からのメッセージを、該当顧客へ転送する
 *
 * @param {Object} msg - Telegram message オブジェクト（chat.id === ADMIN_GROUP_ID）
 */
function handleAdminReply(msg) {
  // ── 診断ログ: 受信したmsgのメタ情報を出す ──
  Logger.log('🔵 handleAdminReply called: thread_id=' + msg.message_thread_id +
    ' from.is_bot=' + (msg.from ? msg.from.is_bot : 'no-from') +
    ' from.id=' + (msg.from ? msg.from.id : '-') +
    ' type=' + (msg.text ? 'text' : (msg.photo ? 'photo' : (msg.document ? 'document' : 'other'))));

  // トピック外（General）の投稿は無視
  if (!msg.message_thread_id) {
    Logger.log('⏭️ handleAdminReply: thread_id 無し（General投稿） → skip');
    return;
  }

  // Botの投稿（自分で転送した顧客メッセージ）はスキップ
  if (msg.from && msg.from.is_bot) {
    Logger.log('⏭️ handleAdminReply: is_bot=true → skip');
    return;
  }

  // thread_id から顧客を逆引き
  const customer = findCustomerByThreadId(msg.message_thread_id);
  if (!customer) {
    Logger.log('⚠️ handleAdminReply: thread_id=' + msg.message_thread_id + ' に対応する顧客なし（顧客シートのトピックID列を確認）');
    return;
  }

  Logger.log('✅ handleAdminReply: 顧客特定 chatId=' + customer.chatId + ' → sendMessageToCustomer 呼び出し');

  // 顧客へ送信（種別ごとに分岐）
  const result = sendMessageToCustomer(msg, customer.chatId);

  Logger.log('📤 handleAdminReply 送信完了: type=' + result.messageType + ' content=' + result.content);

  // ログ
  logChat({
    direction: '管理→顧客',
    chatId: customer.chatId,
    threadId: msg.message_thread_id,
    messageType: result.messageType,
    content: result.content,
    adminId: msg.from ? String(msg.from.id) : ''
  });
}

/**
 * 管理者のメッセージを顧客チャットへ送信
 */
function sendMessageToCustomer(msg, customerChatId) {
  if (msg.text) {
    sendMessage(BOT_TYPE.BOOKING, customerChatId, msg.text);
    return { messageType: 'テキスト', content: truncate(msg.text, 200) };
  }

  if (msg.photo && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1];
    sendPhoto(BOT_TYPE.BOOKING, customerChatId, best.file_id, {
      caption: msg.caption || ''
    });
    return { messageType: '写真', content: msg.caption || '(写真)' };
  }

  if (msg.video) {
    sendTelegramGeneric('sendVideo', {
      chat_id: customerChatId,
      video: msg.video.file_id,
      caption: msg.caption || ''
    });
    return { messageType: '動画', content: msg.caption || '(動画)' };
  }

  if (msg.document) {
    sendTelegramGeneric('sendDocument', {
      chat_id: customerChatId,
      document: msg.document.file_id,
      caption: msg.caption || ''
    });
    return { messageType: 'ドキュメント', content: msg.document.file_name || '(ファイル)' };
  }

  if (msg.voice) {
    sendTelegramGeneric('sendVoice', {
      chat_id: customerChatId,
      voice: msg.voice.file_id
    });
    return { messageType: '音声', content: '(音声)' };
  }

  if (msg.sticker) {
    sendTelegramGeneric('sendSticker', {
      chat_id: customerChatId,
      sticker: msg.sticker.file_id
    });
    return { messageType: 'テキスト', content: '(ステッカー)' };
  }

  // 未対応種別は管理者に通知（顧客には送らない）
  const cfg = getConfig();
  sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
    '⚠️ この種別は顧客へ転送できません。テキスト・写真・動画・音声でお願いします。',
    { message_thread_id: msg.message_thread_id }
  );
  return { messageType: 'テキスト', content: '(未対応・転送せず)' };
}

// ====== 共通ヘルパー ======

/**
 * TelegramAPI.gs に未定義の send メソッドを直接呼ぶ汎用ラッパー
 * （TelegramAPI.gs に都度追加してもよいが、今は callTelegramApi に直打ち）
 */
function sendTelegramGeneric(method, payload) {
  return callTelegramApi(BOT_TYPE.BOOKING, method, payload);
}

/**
 * チャット履歴シートにログ記録
 * 内容はお客様のメッセージ本文・キャプション・ファイル名そのまま。appendRow が数式にならないよう無害化する（SheetHelpers.gs）
 */
function logChat(entry) {
  try {
    appendRow(SHEET_NAMES.CHAT_LOG, {
      '日時': new Date(),
      '方向': entry.direction,
      'チャットID': entry.chatId,
      'トピックID': entry.threadId,
      'メッセージ種別': entry.messageType,
      '内容': entry.content,
      '管理者ID': entry.adminId || ''
    });
  } catch (err) {
    Logger.log('⚠️ logChat error: ' + err);
  }
}

/**
 * 文字列を指定長で切り詰める
 */
function truncate(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length <= n ? s : s.substring(0, n) + '…';
}
