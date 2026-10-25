/**
 * DotsState.gs — ドッちゃんのメール転送（DotsDigestBridge.gs）の状態
 *
 * 【持っている状態】すべて Script Properties（失うと取りこぼし・二重投稿になるので Cache は使わない）
 *   dots_seen_message_ids  処理を終えたメッセージ ID（新しい方から200件）
 *   dots_processing        処理中の ID → 予約した時刻。15分たっても終わらなければ、前の実行が落ちたとみなして取り直す
 *   dots_retry_counts      ID → 失敗回数（1通につき最大3回）
 *   dots_day_state         当日の {date, checked, rejects}（未着の確認が済んだか・拒否の通知を何通出したか）
 *   dots_cursor_ms         Gmail を探し始める時刻（まだ終わっていないメールがあれば、その時刻より前に戻す）
 *   dots_active_since_ms   止まっていた状態から動き出した時刻（その日の未着警告の誤報防止）
 *   dots_last_run_ms       最後に動いた時刻
 *
 * 【ロック】勤怠・経費と共通のスクリプトロックを、読み書きの瞬間だけ握る
 */

const DOTS_PROCESSING_TTL_MS = 15 * 60 * 1000;
const DOTS_RESTART_GAP_MS = 30 * 60 * 1000;   // これより長く動いていなければ「止まっていた」とみなす
const DOTS_STATE_PROP = {
  SEEN_IDS:     'dots_seen_message_ids',
  PROCESSING:   'dots_processing',
  RETRY:        'dots_retry_counts',
  DAY_STATE:    'dots_day_state',
  CURSOR:       'dots_cursor_ms',
  ACTIVE_SINCE: 'dots_active_since_ms',
  LAST_RUN:     'dots_last_run_ms'
};

function withDotsLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return { locked: false };
  try {
    return { locked: true, value: fn() };
  } finally {
    lock.releaseLock();
  }
}

/** 失うと取りこぼし・二重投稿になる書き込み用。ロックが取れるまで3回まで試す */
function withDotsLockRetry_(fn) {
  for (let i = 0; i < 3; i++) {
    const r = withDotsLock_(fn);
    if (r.locked) return r;
    Utilities.sleep(1000);
  }
  Logger.log('⚠️ dots: ロックが取れず状態を更新できませんでした');
  return { locked: false };
}

/** 処理を終えた ID の一覧（ロックなしの先読み用。最終判定は claimDotsId_ がロックの中でする） */
function loadDotsSeenIds_(props) {
  return loadDotsJson_(props, DOTS_STATE_PROP.SEEN_IDS, []);
}

/**
 * 処理の予約。
 * @return {string} 'claimed' 予約できた／'reclaimed' 15分以上終わっていなかったものを取り直した（失敗1回と数える）
 *                  'done' もう終わっている／'busy' 他の実行が処理中・ロックが取れない（次の回に回す）
 */
function claimDotsId_(props, id) {
  const r = withDotsLock_(function() {
    if (loadDotsJson_(props, DOTS_STATE_PROP.SEEN_IDS, []).indexOf(id) !== -1) return 'done';
    const proc = loadDotsJson_(props, DOTS_STATE_PROP.PROCESSING, {});
    const now = Date.now();
    let result = 'claimed';
    if (proc[id]) {
      if (now - proc[id] < DOTS_PROCESSING_TTL_MS) return 'busy';
      result = 'reclaimed';
    }
    proc[id] = now;
    props.setProperty(DOTS_STATE_PROP.PROCESSING, JSON.stringify(proc));
    return result;
  });
  return r.locked ? r.value : 'busy';
}

/** 処理を終えた（転送した・弾いた・諦めて知らせた）。処理中から外して、終わった一覧に入れる */
function finishDotsId_(props, id) {
  withDotsLockRetry_(function() {
    const proc = loadDotsJson_(props, DOTS_STATE_PROP.PROCESSING, {});
    delete proc[id];
    props.setProperty(DOTS_STATE_PROP.PROCESSING, JSON.stringify(proc));
    const seen = loadDotsJson_(props, DOTS_STATE_PROP.SEEN_IDS, []);
    if (seen.indexOf(id) === -1) seen.push(id);
    props.setProperty(DOTS_STATE_PROP.SEEN_IDS, JSON.stringify(seen.slice(-DOTS_SEEN_KEEP)));
  });
}

/** 予約を外す（次の回にやり直す）。外せなくても15分後に取り直されるので取りこぼしにはならない */
function releaseDotsId_(props, id) {
  withDotsLockRetry_(function() {
    const proc = loadDotsJson_(props, DOTS_STATE_PROP.PROCESSING, {});
    delete proc[id];
    props.setProperty(DOTS_STATE_PROP.PROCESSING, JSON.stringify(proc));
  });
}

/**
 * 失敗を1回数える。まだ再試行できるなら予約を外して true（次の回でやり直す）。上限に達したら false。
 * 記録失敗・送信失敗・途中で落ちたもので回数は共通（1通につき最大3回）
 */
function retryDotsLater_(props, id) {
  const n = bumpDotsRetry_(props, id);
  if (n >= DOTS_MAX_RETRY) return false;
  releaseDotsId_(props, id);
  Logger.log('⚠️ dots 失敗 ' + n + '/' + DOTS_MAX_RETRY + ' — 次回再試行 id=' + id);
  return true;
}

function bumpDotsRetry_(props, id) {
  const r = withDotsLockRetry_(function() {
    const map = loadDotsJson_(props, DOTS_STATE_PROP.RETRY, {});
    map[id] = (map[id] || 0) + 1;
    const keys = Object.keys(map).filter(function(k) { return k !== id; });
    if (keys.length >= 20) delete map[keys[0]]; // 古いものから捨てる（今の ID は残す）
    props.setProperty(DOTS_STATE_PROP.RETRY, JSON.stringify(map));
    return map[id];
  });
  return r.locked ? r.value : DOTS_MAX_RETRY; // ロックが取れない時は諦めて通知側へ
}

/**
 * 当日の状態 {date, checked, rejects} を読み、mutate して保存する。
 * @return {boolean} 保存できたら true
 */
function updateDotsDayState_(props, mutate) {
  const r = withDotsLockRetry_(function() {
    const today = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd');
    let state = loadDotsJson_(props, DOTS_STATE_PROP.DAY_STATE, {});
    if (state.date !== today || !state.checked) state = { date: today, checked: {}, rejects: 0 };
    mutate(state);
    props.setProperty(DOTS_STATE_PROP.DAY_STATE, JSON.stringify(state));
  });
  return r.locked;
}

function loadDotsDayState_(props) {
  const s = loadDotsJson_(props, DOTS_STATE_PROP.DAY_STATE, {});
  const today = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd');
  return (s.date === today && s.checked) ? s : { date: today, checked: {}, rejects: 0 };
}

/**
 * Gmail を探し始める時刻。前回の続き（取りこぼし防止に30分前から）。初めての時は3日前から。
 */
function getDotsSearchFrom_(props, now) {
  const cursor = Number(props.getProperty(DOTS_STATE_PROP.CURSOR) || 0);
  return cursor > 0 ? cursor - 30 * 60 * 1000 : now - 3 * 24 * 60 * 60 * 1000;
}

function setDotsCursor_(props, ms) {
  props.setProperty(DOTS_STATE_PROP.CURSOR, String(ms));
}

/** 動いた記録。30分以上止まっていたら（初回・再開）「動き出した時刻」を今にする */
function noteDotsRun_(props) {
  const now = Date.now();
  const last = Number(props.getProperty(DOTS_STATE_PROP.LAST_RUN) || 0);
  if (!last || now - last > DOTS_RESTART_GAP_MS) props.setProperty(DOTS_STATE_PROP.ACTIVE_SINCE, String(now));
  props.setProperty(DOTS_STATE_PROP.LAST_RUN, String(now));
}

function loadDotsJson_(props, key, fallback) {
  try {
    const v = JSON.parse(props.getProperty(key) || 'null');
    if (v === null || typeof v !== 'object' || Array.isArray(v) !== Array.isArray(fallback)) return fallback;
    return v;
  } catch (e) {
    Logger.log('⚠️ ' + key + ' 破損 — 作り直す: ' + e);
    return fallback;
  }
}
