/**
 * ForumTopicManager.gs — フォーラムトピック管理
 *
 * 【責務】
 *   管理グループのフォーラムトピックを 1顧客=1トピック で排他制御する。
 *   顧客初回コンタクト時にトピック作成、以降は同じ thread_id を使い続ける。
 *
 * 【排他制御】
 *   同じ顧客から短時間に複数メッセージが来た場合、複数トピック作成を防ぐため
 *   LockService.getScriptLock() で排他ロックをかける。
 *
 * 【データ構造】
 *   CUSTOMERS シートの「トピックID」列に thread_id（数値）を保存
 *   トピック名フォーマット: "{氏名 or username} ({chat_id})"
 */

// ====== トピック取得/作成（メインAPI） ======

/**
 * 顧客のフォーラムトピックを取得する。未作成なら新規作成する。
 *
 * @param {Object} customer - {chatId, firstName, lastName, username}
 * @return {{threadId: number, isNew: boolean}}
 */
function getOrCreateTopic(customer) {
  const chatId = String(customer.chatId);

  // ── 1. シートから既存トピックIDを検索 ──
  const existing = findCustomerRow(chatId);
  if (existing && existing.data['トピックID']) {
    return {
      threadId: Number(existing.data['トピックID']),
      isNew: false
    };
  }

  // ── 2. 排他ロック取得（同時リクエスト対策） ──
  const lock = LockService.getScriptLock();
  const acquired = lock.tryLock(10 * 1000); // 10秒待機
  if (!acquired) {
    throw new Error('❌ getOrCreateTopic: ロック取得失敗（10秒タイムアウト）');
  }

  try {
    // ── 3. ロック取得後にもう一度チェック（他のスレッドが先に作った可能性） ──
    const recheck = findCustomerRow(chatId);
    if (recheck && recheck.data['トピックID']) {
      return {
        threadId: Number(recheck.data['トピックID']),
        isNew: false
      };
    }

    // ── 4. トピック作成 ──
    const cfg = getConfig();
    const topicName = buildTopicName(customer);
    const res = createForumTopic(BOT_TYPE.BOOKING, cfg.adminGroupId, topicName, {
      icon_color: pickIconColor(chatId)
    });

    if (!res.ok || !res.result || !res.result.message_thread_id) {
      throw new Error('❌ createForumTopic failed: ' + JSON.stringify(res));
    }
    const threadId = res.result.message_thread_id;

    // ── 5. 顧客シートに登録 or トピックID更新 ──
    if (recheck) {
      updateRow(SHEET_NAMES.CUSTOMERS, recheck.rowIndex, {
        'トピックID': threadId,
        '最終連絡日時': new Date()
      });
    } else {
      const customerId = generateDateSeqId('CUST', SHEET_NAMES.CUSTOMERS, '顧客ID');
      appendRow(SHEET_NAMES.CUSTOMERS, {
        '顧客ID': customerId,
        'チャットID': chatId,
        'ユーザー名': customer.username || '',
        '氏名': buildDisplayName(customer),
        '電話番号': '',
        '言語': 'クメール語',
        'トピックID': threadId,
        '登録日時': new Date(),
        '最終連絡日時': new Date()
      });
    }

    return { threadId: threadId, isNew: true };

  } finally {
    lock.releaseLock();
  }
}

/**
 * thread_id から顧客のチャットIDを逆引きする（管理者返信で使用）
 *
 * @param {number|string} threadId
 * @return {{chatId: string, customerData: Object} | null}
 */
function findCustomerByThreadId(threadId) {
  const row = findRow(SHEET_NAMES.CUSTOMERS, 'トピックID', threadId);
  if (!row) return null;
  return {
    chatId: String(row.data['チャットID']),
    customerData: row.data,
    rowIndex: row.rowIndex
  };
}

/**
 * チャットIDで顧客行を検索
 */
function findCustomerRow(chatId) {
  return findRow(SHEET_NAMES.CUSTOMERS, 'チャットID', String(chatId));
}

// ====== 顧客最終連絡日時の更新 ======

/**
 * 顧客の「最終連絡日時」を now に更新
 */
function touchCustomerLastContact(chatId) {
  const row = findCustomerRow(chatId);
  if (!row) return;
  updateRow(SHEET_NAMES.CUSTOMERS, row.rowIndex, {
    '最終連絡日時': new Date()
  });
}

// ====== ヘルパー ======

/**
 * トピック名を生成
 * 例: "Sophea (7500384947)" / "@sophea_k (7500384947)"
 */
function buildTopicName(customer) {
  const name = buildDisplayName(customer);
  return name + ' (' + customer.chatId + ')';
}

/**
 * 表示名を生成（氏名 > username > chat_id の優先順）
 */
function buildDisplayName(customer) {
  const first = (customer.firstName || '').trim();
  const last = (customer.lastName || '').trim();
  const full = (first + ' ' + last).trim();
  if (full) return full;
  if (customer.username) return '@' + customer.username;
  return 'User_' + customer.chatId;
}

/**
 * chat_id からトピックアイコン色を決定（同じ顧客は常に同じ色）
 * Telegram が受け付けるアイコン色は以下の7色：
 *   7322096, 16766590, 13338331, 9367192, 16749490, 16478047, 15817233
 */
function pickIconColor(chatId) {
  const colors = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047, 15817233];
  let sum = 0;
  const s = String(chatId);
  for (let i = 0; i < s.length; i++) sum += s.charCodeAt(i);
  return colors[sum % colors.length];
}

// ====== stale thread 自動復旧 ======

/**
 * 顧客トピックへテキスト送信（古い thread_id で失敗したら自動再作成してリトライ）
 *
 * 【背景】
 *   管理グループでチャットログを削除してトピックごと消してしまうと、
 *   顧客シートに残った「トピックID」は無効になり、sendMessage が
 *   "message thread not found" (400) を返して配送失敗する。
 *   ここで検知して: トピックID をクリア → getOrCreateTopic で再作成 → 1回だけリトライ。
 *
 * @param {Object} customer - {chatId, firstName, lastName, username, ...}
 * @param {string} text
 * @param {Object} [extraOpts] - sendMessage の追加オプション
 * @return {{ok: boolean, threadId: number, recreated: boolean}}
 */
function sendToCustomerTopicWithRecovery(customer, text, extraOpts) {
  const cfg = getConfig();
  const chatId = String(customer.chatId);

  // ── 1回目: 既存の（あるいは新規作成の）トピックへ送信 ──
  let topic = getOrCreateTopic(customer);
  let res = sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, text, Object.assign({
    message_thread_id: topic.threadId
  }, extraOpts || {}));

  if (res && res.ok) {
    return { ok: true, threadId: topic.threadId, recreated: false };
  }

  // ── 失敗時: "message thread not found" ならトピックID をクリアして1回だけ再作成 ──
  const desc = String((res && res.description) || '');
  const isStaleThread = /thread.*not.*found/i.test(desc) || /TOPIC_.*INVALID/i.test(desc);
  Logger.log('⚠️ sendToCustomerTopicWithRecovery: 1回目失敗 desc="' + desc + '" stale=' + isStaleThread);

  if (!isStaleThread) {
    // 別の理由（権限・chat_id 不正など）は再作成しても直らないのでここで終了
    return { ok: false, threadId: topic.threadId, recreated: false };
  }

  // トピックID をクリアして強制的に再作成
  const row = findCustomerRow(chatId);
  if (row) {
    updateRow(SHEET_NAMES.CUSTOMERS, row.rowIndex, { 'トピックID': '' });
    Logger.log('🧹 stale トピックID クリア chatId=' + chatId + ' (旧 threadId=' + topic.threadId + ')');
  }

  topic = getOrCreateTopic(customer);
  Logger.log('♻️ トピック再作成 chatId=' + chatId + ' 新 threadId=' + topic.threadId);

  res = sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, text, Object.assign({
    message_thread_id: topic.threadId
  }, extraOpts || {}));

  return {
    ok: !!(res && res.ok),
    threadId: topic.threadId,
    recreated: true
  };
}

/**
 * 全顧客のトピックID を一括クリア（管理グループのチャットログを完全削除した場合のリセット用）
 * ⚠️ 次の顧客メッセージ・次の予約で自動的に新しいトピックが作成される
 */
function resetAllCustomerTopicIds() {
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('⚠️ 顧客シート空'); return; }

  const headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  const topicCol = headers['トピックID'];
  if (!topicCol) { Logger.log('⚠️ トピックID列が見つからない'); return; }

  const range = sheet.getRange(2, topicCol, lastRow - 1, 1);
  range.clearContent();
  Logger.log('✅ 全顧客のトピックID をクリア (' + (lastRow - 1) + ' 件)。次の顧客メッセージ/予約で自動再作成されます。');
}

// ====== デバッグ ======

/**
 * 顧客シートの トピックID 列の中身を一覧表示（診断用）
 * GAS エディタで関数選択 → 実行 → ログ確認
 */
function dumpCustomerTopics() {
  var sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    Logger.log('⚠️ 顧客シートにデータなし');
    return;
  }
  var headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  var data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📋 顧客シート トピックID 一覧');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var name  = row[(headers['氏名'] || 1) - 1];
    var cid   = row[(headers['チャットID'] || 1) - 1];
    var tid   = row[(headers['トピックID'] || 1) - 1];
    Logger.log((i + 2) + ': 氏名=' + name + ' chatId=' + cid + ' topicId=' + tid + ' (type=' + typeof tid + ')');
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Telegram update から customer オブジェクトを抽出する共通ヘルパー
 */
function extractCustomerFromMessage(msg) {
  const from = msg.from || {};
  return {
    chatId: String(msg.chat.id),
    firstName: from.first_name || '',
    lastName: from.last_name || '',
    username: from.username || '',
    languageCode: from.language_code || ''
  };
}
