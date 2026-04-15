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
  const topic = getOrCreateTopic(customer);
  const cfg = getConfig();

  // ── 初回トピック作成時は挨拶メッセージを先頭に送信 ──
  if (topic.isNew) {
    const intro =
      '🆕 新規顧客からの最初の連絡\n' +
      '━━━━━━━━━━━━━━━━━\n' +
      '氏名: ' + buildDisplayName(customer) + '\n' +
      'Chat ID: ' + customer.chatId + '\n' +
      (customer.username ? 'Username: @' + customer.username + '\n' : '') +
      (customer.languageCode ? '言語: ' + customer.languageCode + '\n' : '') +
      '━━━━━━━━━━━━━━━━━\n' +
      'このトピックで返信すると顧客にメッセージが届きます。';
    sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, intro, {
      message_thread_id: topic.threadId
    });
  }

  // ── メッセージ種別に応じて転送 ──
  const result = sendMessageToTopic(msg, topic.threadId);

  // ── 顧客最終連絡日時を更新 ──
  touchCustomerLastContact(customer.chatId);

  // ── チャット履歴ログ ──
  logChat({
    direction: '顧客→管理',
    chatId: customer.chatId,
    threadId: topic.threadId,
    messageType: result.messageType,
    content: result.content,
    adminId: ''
  });
}

/**
 * メッセージの内容に応じて適切な send* を呼び分ける
 *
 * @return {{messageType: string, content: string}} ログ用の要約
 */
function sendMessageToTopic(msg, threadId) {
  const cfg = getConfig();
  const chatId = cfg.adminGroupId;
  const opts = { message_thread_id: threadId };

  // テキスト
  if (msg.text) {
    sendMessage(BOT_TYPE.BOOKING, chatId, msg.text, opts);
    return { messageType: 'テキスト', content: truncate(msg.text, 200) };
  }

  // 写真（最大解像度を送信）
  if (msg.photo && msg.photo.length > 0) {
    const best = msg.photo[msg.photo.length - 1];
    const caption = msg.caption || '';
    sendPhoto(BOT_TYPE.BOOKING, chatId, best.file_id, Object.assign({
      caption: caption
    }, opts));
    return { messageType: '写真', content: caption || '(写真)' };
  }

  // 動画
  if (msg.video) {
    sendTelegramGeneric('sendVideo', {
      chat_id: chatId,
      video: msg.video.file_id,
      caption: msg.caption || '',
      message_thread_id: threadId
    });
    return { messageType: '動画', content: msg.caption || '(動画)' };
  }

  // ドキュメント
  if (msg.document) {
    sendTelegramGeneric('sendDocument', {
      chat_id: chatId,
      document: msg.document.file_id,
      caption: msg.caption || '',
      message_thread_id: threadId
    });
    return { messageType: 'ドキュメント', content: msg.document.file_name || '(ファイル)' };
  }

  // 音声メモ
  if (msg.voice) {
    sendTelegramGeneric('sendVoice', {
      chat_id: chatId,
      voice: msg.voice.file_id,
      caption: msg.caption || '',
      message_thread_id: threadId
    });
    return { messageType: '音声', content: '(音声メモ ' + (msg.voice.duration || 0) + '秒)' };
  }

  // ビデオメモ（丸い動画）
  if (msg.video_note) {
    sendTelegramGeneric('sendVideoNote', {
      chat_id: chatId,
      video_note: msg.video_note.file_id,
      message_thread_id: threadId
    });
    return { messageType: '動画', content: '(ビデオメモ)' };
  }

  // 位置情報
  if (msg.location) {
    const loc = msg.location;
    sendTelegramGeneric('sendLocation', {
      chat_id: chatId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      message_thread_id: threadId
    });
    const locText = '📍 緯度: ' + loc.latitude + ' / 経度: ' + loc.longitude;
    return { messageType: '位置情報', content: locText };
  }

  // ステッカー
  if (msg.sticker) {
    sendTelegramGeneric('sendSticker', {
      chat_id: chatId,
      sticker: msg.sticker.file_id,
      message_thread_id: threadId
    });
    return { messageType: 'テキスト', content: '(ステッカー ' + (msg.sticker.emoji || '') + ')' };
  }

  // 未対応の種別はログ通知
  sendMessage(BOT_TYPE.BOOKING, chatId,
    '⚠️ 未対応のメッセージ種別を受信（ログ確認してください）',
    opts
  );
  return { messageType: 'テキスト', content: '(未対応種別)' };
}

// ====== 管理者 → 顧客（返信） ======

/**
 * 管理グループのトピック内からのメッセージを、該当顧客へ転送する
 *
 * @param {Object} msg - Telegram message オブジェクト（chat.id === ADMIN_GROUP_ID）
 */
function handleAdminReply(msg) {
  // トピック外（General）の投稿は無視
  if (!msg.message_thread_id) {
    return;
  }

  // Botの投稿（自分で転送した顧客メッセージ）はスキップ
  if (msg.from && msg.from.is_bot) {
    return;
  }

  // thread_id から顧客を逆引き
  const customer = findCustomerByThreadId(msg.message_thread_id);
  if (!customer) {
    Logger.log('⚠️ handleAdminReply: thread_id=' + msg.message_thread_id + ' に対応する顧客なし');
    return;
  }

  // 顧客へ送信（種別ごとに分岐）
  const result = sendMessageToCustomer(msg, customer.chatId);

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
