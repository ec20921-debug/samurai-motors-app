/**
 * QueueManager.gs — 非同期キュー管理
 *
 * 【責務】
 *   doPost から投入された Telegram update を ScriptProperties に溜め込み、
 *   1分間隔トリガー `processTelegramQueue` で順次処理する。
 *
 * 【なぜ CacheService ではなく ScriptProperties か】
 *   v6 で CacheService にキューを置いたら 6h TTL で通知が消失した。
 *   キュー系は永続性が必須 → ScriptProperties 一択。
 *
 * 【キーフォーマット】
 *   queue_{timestamp}_{update_id}       : キュー本体（JSON文字列）
 *   processed_ids_v1                    : 処理済み update_id の一覧（1つのキーに最新 400 件。2026-10-31〜）
 *   processed_{update_id}               : 旧・重複排除マーカー（2026-10-31 まで。24h で消し切る）
 *
 * 【なぜ processed_* を1つのキーにまとめたか】（2026-10-31）
 *   1日分のマーカーが数百個になり、Script Properties の設定画面（50個まで）が読み取り専用になっていた。
 *   永続性は必要（v6 の教訓）なので Cache には移さず、1つのキーに最新 400 件を持つ（約 5KB・1件 9KB の上限内）
 *
 * 【トリガー】
 *   processTelegramQueue    : 1分間隔（キュー処理の本体）
 *   cleanupOldProcessedIds  : 1時間間隔（24h経過マーカー削除）
 */

/**
 * Telegram update をキューに投入する
 *
 * @param {Object} update - Telegram update オブジェクト
 * @param {string} botType - BOT_TYPE.BOOKING or BOT_TYPE.FIELD
 */
function enqueueTelegramUpdate(update, botType) {
  const props = PropertiesService.getScriptProperties();
  let ts = new Date().getTime();
  let key = STORAGE_KEYS.QUEUE_PREFIX + ts + '_' + update.update_id;
  // 別の Bot の同じ番号が同じミリ秒に届くと名前がかぶって上書きされるので、かぶったら1ミリ秒ずらす（2026-11-09）
  while (props.getProperty(key) !== null) {
    ts++;
    key = STORAGE_KEYS.QUEUE_PREFIX + ts + '_' + update.update_id;
  }
  const payload = JSON.stringify({
    botType: botType,
    update: update,
    enqueuedAt: ts
  });
  props.setProperty(key, payload);
}

/**
 * キューから update を取り出して処理する
 *
 * トリガー: 1分間隔（＋ pollTelegramUpdates の末尾・受付の tg_drain からも呼ばれる）
 * 1回の実行で最大 20件処理（GAS実行時間制限対策）
 *
 * 2026-11-09: 受付（TgRelay.gs）が届くたびに処理を頼むようになり、同時に走る回数が増えるので、
 *   キューの処理は1本ずつにする（UserLock＝ウェブアプリもトリガーも同じ持ち主で動くので共通。
 *   中の処理が使う ScriptLock・DocumentLock とは別のロックなので固まらない）。
 *   先に別の処理が動いていれば少し待ち、待ちきれなければ何もしない（次の1分ごとで拾う）
 */
function processTelegramQueue() {
  processTelegramQueueLocked_(10 * 1000);
}

/** @return {boolean} 処理したら true（ロックが取れず見送ったら false） */
function processTelegramQueueLocked_(waitMs) {
  var lock = null;
  try {
    if (typeof LockService.getUserLock === 'function') lock = LockService.getUserLock();
  } catch (e) { lock = null; }
  if (lock && !lock.tryLock(waitMs)) {
    Logger.log('⏳ processTelegramQueue: 別の処理が動いているので見送り（次の1分ごとで拾う）');
    return false;
  }
  try {
    // 処理中に届いた分も、続けて拾う（受付の tg_drain がロック待ちで見送っても取りこぼさない。最大3周・40秒まで）
    var started = Date.now();
    for (var pass = 0; pass < 3; pass++) {
      var done = processTelegramQueueBody_();
      if (!done || Date.now() - started > 40 * 1000) break;
    }
    return true;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (ignore) {} }
  }
}

function processTelegramQueueBody_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  // キューキーのみ抽出してタイムスタンプ順にソート（同じ Bot の中は update_id 順に並べ直す・queueOrder_）
  const queueKeys = queueOrder_(Object.keys(all)
    .filter(function(k) { return k.indexOf(STORAGE_KEYS.QUEUE_PREFIX) === 0; })
    .sort(), all);

  // 2026-10-31: Script Properties に残る小さな状態（移行前・退避）を「状態」タブへ少しずつ移す（KvStore.gs。無ければ何もしない）
  if (typeof kvAutoMigrate_ === 'function') kvAutoMigrate_(all);

  if (queueKeys.length === 0) return 0;

  const MAX_PER_RUN = 20;
  const targets = queueKeys.slice(0, MAX_PER_RUN);

  let success = 0;
  let failed = 0;
  const seen = loadProcessedIds_(all);

  targets.forEach(function(key) {
    try {
      const payload = JSON.parse(all[key]);
      const update = payload.update;
      const botType = payload.botType;
      const updateId = update.update_id;

      // ── 重複排除（処理済みの一覧に入っていれば捨てる。印は処理が終わってから付ける） ──
      const processedKey = STORAGE_KEYS.PROCESSED_PREFIX + updateId;   // 旧マーカー（移行期間だけ見る）
      if (seen.indexOf(String(updateId)) >= 0 || props.getProperty(processedKey)) {
        // 既に処理済み → キューから削除のみ
        props.deleteProperty(key);
        return;
      }

      // ── Bot種別ごとにハンドラへ振り分け ──
      // Phase 1 時点ではハンドラ未実装 → typeof で存在確認しスキップ
      if (botType === BOT_TYPE.BOOKING) {
        if (typeof handleBookingBotUpdate === 'function') {
          handleBookingBotUpdate(update);
        } else {
          Logger.log('⏭️ handleBookingBotUpdate 未実装（Phase 3 で実装予定） update_id=' + updateId);
        }
      } else if (botType === BOT_TYPE.FIELD) {
        if (typeof handleFieldBotUpdate === 'function') {
          handleFieldBotUpdate(update);
        } else {
          Logger.log('⏭️ handleFieldBotUpdate 未実装（Phase 4 で実装予定） update_id=' + updateId);
        }
      }

      // ── 完了マーカー（1つのキーにまとめて保存）+ キュー削除 ──
      seen.push(String(updateId));
      if (seen.length > PROCESSED_IDS_MAX_) seen.splice(0, seen.length - PROCESSED_IDS_MAX_);
      props.setProperty(STORAGE_KEYS.PROCESSED_IDS, JSON.stringify(seen));
      props.deleteProperty(key);
      success++;

    } catch (err) {
      Logger.log('❌ processTelegramQueue error key=' + key + ' err=' + err);
      failed++;
      // 失敗したキューは残して次回再試行。ただし QUEUE_MAX_ATTEMPTS_ 回で諦めて管理グループへ知らせる（2026-11-09）
      //   受付（TgRelay.gs）が届くたびに処理を走らせるので、途中まで返信してから落ちる update が
      //   お客様へ同じ返信を何度も送らないようにする
      queueRecordFailure_(props, key, all[key], seen, err);
    }
  });

  if (success > 0 || failed > 0) {
    Logger.log('📬 queue processed: success=' + success + ' failed=' + failed + ' remaining=' + (queueKeys.length - targets.length));
  }
  return success;   // 1件でも処理できたら、呼び出し元がもう一周見る（失敗だけの時は回さない＝回数を一気に使わない）
}

var QUEUE_MAX_ATTEMPTS_ = 3;

/**
 * 処理順: 到着順（キーの時刻）を基本に、同じ Bot の update は update_id の小さい順に並べ直す
 * （受付は複数の update を並行して届けることがあり、到着順が入れ替わっても会話の順番を守る）
 */
function queueOrder_(keys, all) {
  var items = keys.map(function(k) {
    var bot = '', id = NaN;
    try { var p = JSON.parse(all[k]); bot = String(p.botType || ''); id = Number(p.update.update_id); } catch (ignore) {}
    return { key: k, bot: bot, id: id };
  });
  var byBot = {};
  items.forEach(function(it, i) { (byBot[it.bot] = byBot[it.bot] || []).push(i); });
  var out = items.slice();
  Object.keys(byBot).forEach(function(bot) {
    var pos = byBot[bot];
    var sorted = pos.map(function(i) { return items[i]; }).sort(function(a, b) {
      if (isNaN(a.id) || isNaN(b.id)) return 0;
      return a.id - b.id;
    });
    pos.forEach(function(i, j) { out[i] = sorted[j]; });
  });
  return out.map(function(it) { return it.key; });
}

/** 失敗の回数をキューに書き戻す。上限に達したら処理済みにして捨て、管理グループへ知らせる */
function queueRecordFailure_(props, key, raw, seen, err) {
  try {
    var payload = JSON.parse(raw);
    payload.attempts = (Number(payload.attempts) || 0) + 1;
    if (payload.attempts < QUEUE_MAX_ATTEMPTS_) {
      props.setProperty(key, JSON.stringify(payload));
      return;
    }
    var updateId = payload.update && payload.update.update_id;
    seen.push(String(updateId));
    if (seen.length > PROCESSED_IDS_MAX_) seen.splice(0, seen.length - PROCESSED_IDS_MAX_);
    props.setProperty(STORAGE_KEYS.PROCESSED_IDS, JSON.stringify(seen));
    props.deleteProperty(key);
    var u = payload.update || {};
    var msg = u.message || u.edited_message || (u.callback_query && u.callback_query.message) || {};
    var chatId = (msg.chat && msg.chat.id) || (u.callback_query && u.callback_query.from && u.callback_query.from.id) || '';
    Logger.log('🛑 queue: ' + QUEUE_MAX_ATTEMPTS_ + '回失敗したので処理をあきらめた key=' + key + ' err=' + err);
    if (typeof sendMessage === 'function' && typeof getConfig === 'function') {
      sendMessage(BOT_TYPE.BOOKING, getConfig().adminGroupId,
        '🛑 Bot のメッセージを' + QUEUE_MAX_ATTEMPTS_ + '回処理できなかったので、処理をやめました\n' +
        'Bot: ' + (payload.botType === BOT_TYPE.FIELD ? '業務Bot' : '予約Bot') + ' / update_id: ' + updateId +
        (chatId ? ' / チャットID: ' + chatId : '') + '\n' +
        'エラー: ' + String(err).substring(0, 200) + '\n' +
        'お客様への返事が届いていない可能性があります。管理グループの該当トピックで確認してください。');
    }
  } catch (e) {
    Logger.log('⚠️ queueRecordFailure_ 失敗(キューは残す): ' + e);
  }
}

var PROCESSED_IDS_MAX_ = 400;

/** 処理済み update_id の一覧（文字列の配列）。読めない・壊れている時は空から */
function loadProcessedIds_(all) {
  try {
    const raw = (all && all[STORAGE_KEYS.PROCESSED_IDS]) || PropertiesService.getScriptProperties().getProperty(STORAGE_KEYS.PROCESSED_IDS);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch (err) {
    return [];
  }
}

/**
 * 24時間経過した旧 processed_* マーカーを削除する（2026-10-31 からは新しく作られない。残りを消し切るまで動かす）
 *
 * トリガー: 1時間間隔
 */
function cleanupOldProcessedIds() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const now = new Date().getTime();
  const cutoff = TTL.PROCESSED_ID * 1000; // 秒 → ミリ秒

  let deleted = 0;
  Object.keys(all).forEach(function(key) {
    if (key.indexOf(STORAGE_KEYS.PROCESSED_PREFIX) !== 0) return;
    const ts = parseInt(all[key], 10);
    if (isNaN(ts)) {
      // タイムスタンプ不正 → 削除
      props.deleteProperty(key);
      deleted++;
      return;
    }
    if (now - ts > cutoff) {
      props.deleteProperty(key);
      deleted++;
    }
  });

  if (deleted > 0) {
    Logger.log('🧹 cleanupOldProcessedIds: ' + deleted + '件削除');
  }

  // 2026-10-08: 溜めておいたファネルログをまとめてシートへ（FunnelLog.gs。失敗しても本処理に影響させない）
  try {
    if (typeof flushFunnelQueue_ === 'function') flushFunnelQueue_(props, all);
  } catch (err) {
    Logger.log('⚠️ flushFunnelQueue_ 失敗(次回に持ち越し): ' + err);
  }
}

/**
 * キュー状況確認（デバッグ用）
 */
function showQueueStatus() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  let queueCount = 0;
  let processedCount = 0;   // 旧マーカー（残っている数）
  Object.keys(all).forEach(function(k) {
    if (k.indexOf(STORAGE_KEYS.QUEUE_PREFIX) === 0) queueCount++;
    else if (k.indexOf(STORAGE_KEYS.PROCESSED_PREFIX) === 0) processedCount++;
  });
  const seenCount = loadProcessedIds_(all).length;

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📬 キュー状況');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('処理待ちキュー: ' + queueCount + '件');
  Logger.log('処理済み一覧(processed_ids_v1): ' + seenCount + '件 / 旧マーカー残り: ' + processedCount + '件');
  Logger.log('Script Properties 全体: ' + Object.keys(all).length + '個');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}

/**
 * Phase 1 デプロイ時に実行：トリガーを一括登録
 *
 * 既存の同名トリガーは一旦全削除してから作り直す（冪等）
 */
function setupV7Triggers() {
  const targets = [
    'processTelegramQueue',
    'cleanupOldProcessedIds',
    'pollTelegramUpdates',
    'checkUnpaidReminders'
  ];

  // ── 既存トリガー削除 ──
  const existing = ScriptApp.getProjectTriggers();
  let removed = 0;
  existing.forEach(function(t) {
    if (targets.indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log('🗑️ 既存トリガー削除: ' + removed + '件');

  // ── 新規登録 ──
  ScriptApp.newTrigger('pollTelegramUpdates')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('⏰ pollTelegramUpdates: 1分間隔（Polling方式）');

  ScriptApp.newTrigger('processTelegramQueue')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('⏰ processTelegramQueue: 1分間隔');

  ScriptApp.newTrigger('cleanupOldProcessedIds')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('⏰ cleanupOldProcessedIds: 1時間間隔');

  // ── Phase 5: 24h催促 ──
  ScriptApp.newTrigger('checkUnpaidReminders')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('⏰ checkUnpaidReminders: 1時間間隔（24h未払い催促）');

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ トリガー設定完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
