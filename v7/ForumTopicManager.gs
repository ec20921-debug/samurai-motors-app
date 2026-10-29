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
 * @param {number} [staleThreadId] - 消えていたトピックの番号。シートの番号がこれと同じなら、無いものとして作り直す。
 *        確認と作り直しを同じロックの中で行うので、並走した別の実行が先に作り直していればその番号を使う（2026-10-29）
 * @return {{threadId: number, isNew: boolean}}
 */
function getOrCreateTopic(customer, staleThreadId) {
  const chatId = String(customer.chatId);
  const hasUsableTopic = function(row) {
    return !!(row && row.data['トピックID']) &&
      !(staleThreadId && Number(row.data['トピックID']) === Number(staleThreadId));
  };

  // ── 1. シートから既存トピックIDを検索 ──
  const existing = findCustomerRow(chatId);
  if (hasUsableTopic(existing)) {
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
    if (hasUsableTopic(recheck)) {
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
      // 氏名・ユーザー名は Telegram の表示名（誰でも決められる）。appendRow が数式にならないよう無害化する（SheetHelpers.gs）
      appendRow(SHEET_NAMES.CUSTOMERS, {
        '顧客ID': customerId,
        'チャットID': chatId,
        'ユーザー名': customer.username || '',
        '氏名': buildDisplayName(customer),
        '電話番号': '',
        '言語': 'クメール語',
        'トピックID': threadId,
        '登録日時': new Date(),
        '最終連絡日時': new Date(),
        '配信対象': true   // 新規は配信対象ON。ただし当日登録はスケジュール配信から除外（即時配信防止）
      });
      // 追加した行の配信対象セルをチェックボックス化（TRUE 文字表示を防ぐ）
      if (typeof applyBroadcastCheckboxToRow_ === 'function') {
        applyBroadcastCheckboxToRow_(getSheet(SHEET_NAMES.CUSTOMERS).getLastRow());
      }
    }

    return { threadId: threadId, isNew: true };

  } finally {
    // 書き込みを確定してからロック解放する。
    // flush しないと、並走する後発実行の再チェック(findCustomerRow)や
    // generateDateSeqId から「直前に追加した行」が見えず、トピック・顧客行が
    // 二重作成される（同じ顧客IDで2行できる）。
    SpreadsheetApp.flush();
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
 * Telegram の失敗応答が「トピックが消えている」ことを示すか
 */
function isStaleThreadError_(res) {
  const desc = String((res && res.description) || '');
  return /thread.*not.*found/i.test(desc) || /TOPIC_.*(INVALID|DELETED)/i.test(desc);
}

/**
 * 顧客トピックへ送信する共通処理（古い thread_id で失敗したら自動再作成してリトライ）
 *
 * 【背景】
 *   管理グループでチャットログを削除してトピックごと消してしまうと、
 *   顧客シートに残った「トピックID」は無効になり、sendMessage が
 *   "message thread not found" (400) を返して配送失敗する。
 *   ここで検知して: getOrCreateTopic に消えた番号を渡して再作成 → 1回だけリトライ。
 *   2026-10-29: テキスト以外（顧客メッセージの転送・写真付きの決済通知）でも使えるよう送信部分を sendFn に分離。
 *     トピックID のクリアはやめ、確認と作り直しを getOrCreateTopic のロックの中でまとめて行う（並走でトピックを二重に作らない）
 *   ⚠️ 作り直す時は getOrCreateTopic が ScriptLock を取る。別の ScriptLock を持ったまま呼ばない（通知はロックの外で送る）
 *
 * @param {Object} customer - {chatId, firstName, lastName, username, ...}
 * @param {function(number, {isNew: boolean, recreated: boolean}): Object} sendFn
 *        threadId を受け取って送信し、Telegram API の応答を返す
 * @param {number|string} [knownThreadId] - 呼び出し側が顧客シートから読んだトピックID（同じ行をもう一度読まないため）
 * @return {{ok: boolean, threadId: number, recreated: boolean}}
 */
function sendWithTopicRecovery_(customer, sendFn, knownThreadId) {
  const chatId = String(customer.chatId);

  // ── 1回目: 既存の（あるいは新規作成の）トピックへ送信 ──
  let topic = knownThreadId ? { threadId: Number(knownThreadId), isNew: false } : getOrCreateTopic(customer);
  let res = sendFn(topic.threadId, { isNew: topic.isNew, recreated: false });

  if (res && res.ok) {
    return { ok: true, threadId: topic.threadId, recreated: false };
  }

  // ── 失敗時: "message thread not found" なら1回だけ再作成 ──
  const isStaleThread = isStaleThreadError_(res);
  Logger.log('⚠️ sendWithTopicRecovery_: 1回目失敗 desc="' + ((res && res.description) || '') + '" stale=' + isStaleThread);

  if (!isStaleThread) {
    // 別の理由（権限・chat_id 不正など）は再作成しても直らないのでここで終了
    return { ok: false, threadId: topic.threadId, recreated: false };
  }

  const staleThreadId = topic.threadId;
  try {
    topic = getOrCreateTopic(customer, staleThreadId);
  } catch (e) {
    // 作り直せなかった（ロック待ち・トピックを作る権限がない等）。呼び出し側がグループ直下へ逃がす
    // （例外のまま返すとキューが毎分やり直し続けるため）
    Logger.log('❌ sendWithTopicRecovery_: トピック再作成失敗 chatId=' + chatId + ' err=' + e);
    return { ok: false, threadId: staleThreadId, recreated: false };
  }
  Logger.log('♻️ トピック再作成 chatId=' + chatId + ' 旧 threadId=' + staleThreadId + ' 新 threadId=' + topic.threadId);

  res = sendFn(topic.threadId, { isNew: topic.isNew, recreated: true });

  return {
    ok: !!(res && res.ok),
    threadId: topic.threadId,
    recreated: true
  };
}

/**
 * 顧客トピックへテキスト送信（古い thread_id で失敗したら自動再作成してリトライ）
 *
 * @param {Object} customer - {chatId, firstName, lastName, username, ...}
 * @param {string} text
 * @param {Object} [extraOpts] - sendMessage の追加オプション
 * @return {{ok: boolean, threadId: number, recreated: boolean}}
 */
function sendToCustomerTopicWithRecovery(customer, text, extraOpts) {
  const cfg = getConfig();
  return sendWithTopicRecovery_(customer, function(threadId, topic) {
    if (topic.isNew && topic.recreated) sendRecreatedTopicIntro_(threadId, customer);
    return sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId, text, Object.assign({
      message_thread_id: threadId
    }, extraOpts || {}));
  });
}

/**
 * 顧客のトピックへ管理通知を送る（決済・特価予約・QR連携の通知など・2026-10-29）
 *
 * トピックが消えていたら作り直して1回だけ再送し、それでも届かなければグループ直下（General）へ送る。
 * トピックをまだ持たない顧客は、これまでどおりグループ直下へ送る（ここではトピックも顧客行も作らない）。
 * ⚠️ トピックを作り直す時に ScriptLock を取るので、別の ScriptLock を持ったまま呼ばない
 *
 * @param {string} chatId - 顧客のチャットID（空ならグループ直下）
 * @param {function(Object): Object} sendFn - 送信オプション（{message_thread_id} または {}）を受け取って送信し、
 *        Telegram API の応答を返す
 * @return {{ok: boolean, threadId: (number|null)}}
 */
function sendAdminNoticeToCustomerTopic_(chatId, sendFn) {
  try {
    const row = chatId ? findCustomerRow(chatId) : null;
    if (row && row.data['トピックID']) {
      const customer = {
        chatId:    String(chatId),
        firstName: String(row.data['氏名'] || ''),
        lastName:  '',
        username:  String(row.data['ユーザー名'] || '')
      };
      const sent = sendWithTopicRecovery_(customer, function(threadId, topic) {
        if (topic.isNew && topic.recreated) sendRecreatedTopicIntro_(threadId, customer);
        return sendFn({ message_thread_id: threadId });
      }, row.data['トピックID']);
      if (sent.ok) return { ok: true, threadId: sent.threadId };
    }
  } catch (e) {
    // 通知は最優先。トピックの検索・作り直しで失敗してもグループ直下へ送る
    Logger.log('⚠️ sendAdminNoticeToCustomerTopic_: トピック送信で例外 chatId=' + chatId + ' err=' + e);
  }
  const res = sendFn({});
  return { ok: !!(res && res.ok), threadId: null };
}

/**
 * 作り直したトピックの先頭に「作り直しました」の案内を送る（予約・決済などの通知で作り直した時）
 * お客様のメッセージで作り直した時は CustomerChat.gs が詳しい案内を送る
 */
function sendRecreatedTopicIntro_(threadId, customer) {
  const cfg = getConfig();
  sendMessage(BOT_TYPE.BOOKING, cfg.adminGroupId,
    '♻️ トピックを作り直しました（前のトピックは削除されていました）\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    '氏名: ' + buildDisplayName(customer) + '\n' +
    'Chat ID: ' + customer.chatId + '\n' +
    '━━━━━━━━━━━━━━━━━\n' +
    'これまでのやりとりはスプレッドシートの「チャット履歴」タブにあります。\n' +
    'このトピックで返信すると顧客にメッセージが届きます。',
    { message_thread_id: threadId });
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
