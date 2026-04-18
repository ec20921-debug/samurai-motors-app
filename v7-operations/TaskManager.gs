/**
 * TaskManager.gs — タスク管理（Phase 2）
 *
 * 【責務】
 *   - タスクの CRUD（タスクシート）
 *   - 毎朝ローカル8時のタスク通知（Field: 個人DM, Admin: 管理グループ・タスクトピック）
 *   - 完了/未完了ボタンのコールバック処理
 *   - 繰返しタスクテンプレートから当日の子タスク自動生成
 *
 * 【通知スケジュール】
 *   - Field (role=field):   現地 PP 08:00（ロン個人DMへ）
 *   - Admin (role=admin):   現地 JST 08:00（管理グループ・タスクトピックへ）
 *   - 日報:                  JST 20:00（別実装 Phase 2e）
 *
 *   全て hourlyTaskScheduler()（1時間トリガー）から発火。
 *
 * 【繰返しルール】
 *   RECURRENCE_OPTIONS = ['なし','毎日','毎週月曜','毎週金曜','毎月1日','毎月10日','毎月末']
 *   テンプレート行（ステータス=繰返し中）を generateRecurringTasks() がスキャンし、
 *   当日ルールに合致 かつ 子タスク未生成なら子タスクを作成する。
 */

// ============================================================
//  スケジューラ（1時間トリガー）
// ============================================================

/**
 * 1時間毎に実行するスケジューラ。
 * 現地時刻を見て適切な通知を発火する。冪等性を担保。
 */
function hourlyTaskScheduler() {
  const now = new Date();
  const ppHour  = Number(Utilities.formatDate(now, 'Asia/Phnom_Penh', 'H'));
  const jstHour = Number(Utilities.formatDate(now, 'Asia/Tokyo',      'H'));

  Logger.log('⏰ hourlyTaskScheduler PP=' + ppHour + 'h JST=' + jstHour + 'h');

  if (ppHour === 8) {
    try { generateRecurringTasks(); } catch (e) { Logger.log('⚠️ genRec(PP): ' + e); }
    try { sendMorningTaskForField(); } catch (e) { Logger.log('❌ sendField: ' + e); }
  }
  if (jstHour === 8) {
    try { generateRecurringTasks(); } catch (e) { Logger.log('⚠️ genRec(JST): ' + e); }
    try { sendMorningTaskForAdmin(); } catch (e) { Logger.log('❌ sendAdmin: ' + e); }
  }
  // 日報 (Phase 2e) は jstHour === 20 時点で sendDailyReport() を後日追加
}

/**
 * hourlyTaskScheduler 用のトリガーを設定（毎時）
 */
function setupTaskSchedulerTrigger() {
  const existing = ScriptApp.getProjectTriggers();
  existing.forEach(function(t) {
    if (t.getHandlerFunction() === 'hourlyTaskScheduler') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourlyTaskScheduler').timeBased().everyHours(1).create();
  Logger.log('✅ hourlyTaskScheduler を毎時実行で登録');
}

// ============================================================
//  繰返しタスクの自動生成
// ============================================================

/**
 * 今日の日付（指定タイムゾーン）に対応する繰返し子タスクを生成する。
 * テンプレート行（ステータス=繰返し中）を全スキャンし、
 * ルールが今日に一致 かつ 今日分の子タスクが未生成なら appendRow する。
 */
function generateRecurringTasks() {
  const all = getAllRows(SHEET_NAMES.TASKS);
  const templates = all.filter(function(r) { return String(r['ステータス']) === '繰返し中'; });

  if (templates.length === 0) {
    Logger.log('ℹ️ 繰返しテンプレートが無いためスキップ');
    return;
  }

  let created = 0;
  templates.forEach(function(t) {
    const rule     = String(t['繰返しルール'] || '');
    const tz       = String(t['担当 timezone'] || 'Asia/Phnom_Penh');
    const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

    if (!matchRecurrenceToday_(rule, tz)) return;

    // 既に同じ親・同じ期限日で子タスクが居ればスキップ
    const parentId = String(t['タスクID']);
    const dup = all.some(function(r) {
      if (String(r['親タスクID']) !== parentId) return false;
      const d = formatDateCellTz_(r['期限'], tz);
      return d === todayStr;
    });
    if (dup) return;

    appendRow(SHEET_NAMES.TASKS, {
      'タスクID':      generateDateSeqId('TASK', SHEET_NAMES.TASKS, 'タスクID'),
      '作成日時':      new Date(),
      '担当者名':      t['担当者名'],
      '担当 Chat ID':  t['担当 Chat ID'],
      '担当 role':     t['担当 role'],
      '担当 timezone': tz,
      '期限':          todayStr,
      'タスク内容':    t['タスク内容'],
      'ステータス':    '未着手',
      '完了日時':      '',
      '未完了理由':    '',
      '繰返しルール':  '',
      '親タスクID':    parentId
    });
    created++;
  });

  if (created > 0) Logger.log('✅ 繰返し子タスク生成: ' + created + '件');
}

/**
 * 繰返しルールが「今日」に合致するかを判定
 */
function matchRecurrenceToday_(rule, tz) {
  if (!rule || rule === 'なし') return false;
  const now = new Date();
  const dayOfWeek = Utilities.formatDate(now, tz, 'u');  // 1=Mon..7=Sun
  const day       = Number(Utilities.formatDate(now, tz, 'd'));
  const lastDay   = daysInMonthTz_(now, tz);

  switch (rule) {
    case '毎日':      return true;
    case '毎週月曜':  return dayOfWeek === '1';
    case '毎週金曜':  return dayOfWeek === '5';
    case '毎月1日':   return day === 1;
    case '毎月10日':  return day === 10;
    case '毎月末':    return day === lastDay;
    default:          return false;
  }
}

function daysInMonthTz_(d, tz) {
  const y = Number(Utilities.formatDate(d, tz, 'yyyy'));
  const m = Number(Utilities.formatDate(d, tz, 'M'));
  const last = new Date(y, m, 0);   // m月の0日 = (m-1)月の末日。JSのDateはローカルだが日数計算には十分
  return last.getDate();
}

function formatDateCellTz_(v, tz) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const s = String(v).trim();
  // セルに 'yyyy-MM-dd' の文字列が入ってるケース
  return s;
}

// ============================================================
//  タスク通知（Field / Admin）
// ============================================================

/**
 * field スタッフへ当日朝のタスクを送信（個人DM）
 */
function sendMorningTaskForField() {
  const staff = getActiveStaff().filter(function(s) { return s.role === 'field'; });
  if (staff.length === 0) return;

  staff.forEach(function(s) {
    if (!s.chatId) return;  // chat_id 無ければ送らない
    const tasks = getPendingTasksForStaff_(s);
    if (tasks.length === 0) {
      // タスクゼロの日は通知しない（スパム防止）
      return;
    }
    const text = buildFieldTaskMessage_(s, tasks);
    const keyboard = buildTaskInlineKeyboard_(tasks);
    sendMessage(BOT_TYPE.INTERNAL, s.chatId, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
    Logger.log('📤 field タスク送信: ' + s.nameJp + ' (' + tasks.length + '件)');
  });
}

/**
 * admin スタッフへ当日朝のタスクを送信（管理グループ・タスクトピック）
 * 全 admin のタスクを1メッセージにまとめる。
 */
function sendMorningTaskForAdmin() {
  const cfg = getConfig();
  if (!cfg.adminTaskThreadId) {
    Logger.log('⚠️ ADMIN_TASK_THREAD_ID が未設定 — 送信スキップ');
    return;
  }

  const admins = getActiveStaff().filter(function(s) { return s.role === 'admin'; });
  if (admins.length === 0) return;

  // 担当者別にタスクをグループ化
  const sections = [];
  const allInlineTasks = [];
  admins.forEach(function(a) {
    const tasks = getPendingTasksForStaff_(a);
    if (tasks.length === 0) return;
    sections.push(buildAdminTaskSection_(a, tasks));
    tasks.forEach(function(t) { allInlineTasks.push(t); });
  });

  if (sections.length === 0) {
    Logger.log('ℹ️ 本日 admin タスク無し — 送信スキップ');
    return;
  }

  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd (E)');
  const header = '📋 <b>本日 ' + today + ' のタスク</b>\n━━━━━━━━━━━━━━━━━━\n';
  const text = header + sections.join('\n\n');
  const keyboard = buildTaskInlineKeyboard_(allInlineTasks);

  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, text, {
    parse_mode: 'HTML',
    message_thread_id: Number(cfg.adminTaskThreadId),
    reply_markup: { inline_keyboard: keyboard }
  });
  Logger.log('📤 admin タスク送信: ' + allInlineTasks.length + '件');
}

/**
 * 対象スタッフの、今日以前が期限で未完了のタスク一覧
 */
function getPendingTasksForStaff_(staff) {
  const rows = getAllRows(SHEET_NAMES.TASKS);
  const tz = staff.timezone || 'Asia/Phnom_Penh';
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  return rows.filter(function(r) {
    if (String(r['ステータス']) !== '未着手') return false;
    if (String(r['担当者名'])   !== staff.nameJp) return false;
    const due = formatDateCellTz_(r['期限'], tz);
    if (!due) return false;
    return due <= todayStr;   // 期限超過も含める
  }).map(function(r) {
    const due = formatDateCellTz_(r['期限'], tz);
    return {
      id:        String(r['タスクID']),
      desc:      String(r['タスク内容']),
      due:       due,
      overdue:   due < todayStr,
      assignee:  String(r['担当者名']),
      role:      String(r['担当 role'])
    };
  });
}

/**
 * field 用メッセージ
 */
function buildFieldTaskMessage_(staff, tasks) {
  const todayJp = Utilities.formatDate(new Date(), staff.timezone || 'Asia/Phnom_Penh', 'yyyy-MM-dd (E)');
  const lines = [
    '☀️ <b>អរុណសួស្តី / おはよう ' + escapeHtml_(staff.nameJp) + ' さん</b>',
    '📋 ថ្ងៃនេះ / 本日 ' + todayJp + ' のタスク',
    '━━━━━━━━━━━━━━━━━━'
  ];
  tasks.forEach(function(t, i) {
    const mark = t.overdue ? '🔴' : '🟡';
    lines.push((i + 1) + '. ' + mark + ' ' + escapeHtml_(t.desc) + ' <i>(期限 ' + t.due + ')</i>');
  });
  return lines.join('\n');
}

/**
 * admin 用セクション（1名分）
 */
function buildAdminTaskSection_(admin, tasks) {
  const header = '👤 <b>' + escapeHtml_(admin.nameJp) + ' さん</b>';
  const body = tasks.map(function(t) {
    const mark = t.overdue ? '🔴' : '🟡';
    return '　' + mark + ' ' + escapeHtml_(t.desc) + '\n　　<i>期限 ' + t.due + '</i>';
  }).join('\n');
  return header + '\n' + body;
}

/**
 * インラインキーボード（完了/未完了）
 * 各タスクに 2ボタン。1メッセージあたり 最大 Telegram の制約あり（100行くらい） — 実運用で超えない想定。
 */
function buildTaskInlineKeyboard_(tasks) {
  const kb = [];
  tasks.forEach(function(t) {
    const label = t.desc.length > 24 ? t.desc.substring(0, 24) + '…' : t.desc;
    kb.push([
      { text: '✅ ' + label,    callback_data: 'task_done:' + t.id },
      { text: '❌ 未完了', callback_data: 'task_notdone:' + t.id }
    ]);
  });
  return kb;
}

// ============================================================
//  コールバック処理（完了/未完了）
// ============================================================

/**
 * 勤務Bot の update ディスパッチ
 * QueueManager の processInternalQueue からコールされる
 */
function handleInternalBotUpdate(update) {
  try {
    if (update.callback_query) {
      handleTaskCallback_(update.callback_query);
      return;
    }
    if (update.message && update.message.text) {
      handleTextCommand_(update.message);
      return;
    }
  } catch (err) {
    Logger.log('❌ handleInternalBotUpdate: ' + err);
  }
}

function handleTaskCallback_(cb) {
  const data = String(cb.data || '');
  const cbId = cb.id;

  if (data.indexOf('task_done:') === 0) {
    const taskId = data.substring('task_done:'.length);
    markTaskDone(taskId, cb.from);
    answerCallbackQuery(BOT_TYPE.INTERNAL, cbId, { text: '✅ 完了にしました' });
    return;
  }
  if (data.indexOf('task_notdone:') === 0) {
    const taskId = data.substring('task_notdone:'.length);
    markTaskNotDone(taskId, cb.from);
    answerCallbackQuery(BOT_TYPE.INTERNAL, cbId, { text: '❌ 未完了にしました' });
    return;
  }
  // 未対応
  answerCallbackQuery(BOT_TYPE.INTERNAL, cbId, { text: '不明な操作' });
}

function markTaskDone(taskId, actor) {
  const row = findRow(SHEET_NAMES.TASKS, 'タスクID', taskId);
  if (!row) { Logger.log('⚠️ タスク未発見 ' + taskId); return; }
  if (String(row.data['ステータス']) === '完了') return;  // 冪等

  updateRow(SHEET_NAMES.TASKS, row.row, {
    'ステータス': '完了',
    '完了日時':   new Date()
  });
  notifyTaskStatusChange_(row.data, '完了', actor);
}

function markTaskNotDone(taskId, actor, reason) {
  const row = findRow(SHEET_NAMES.TASKS, 'タスクID', taskId);
  if (!row) { Logger.log('⚠️ タスク未発見 ' + taskId); return; }

  updateRow(SHEET_NAMES.TASKS, row.row, {
    'ステータス':   '未完了',
    '未完了理由':   reason || '',
    '完了日時':     new Date()
  });
  notifyTaskStatusChange_(row.data, '未完了', actor);
}

/**
 * 完了/未完了時に管理グループへ通知
 */
function notifyTaskStatusChange_(task, status, actor) {
  const cfg = getConfig();
  if (!cfg.adminTaskThreadId) return;

  const actorName = actor && (actor.username ? '@' + actor.username : (actor.first_name || '?')) || '?';
  const icon = status === '完了' ? '✅' : '❌';
  const text =
    icon + ' <b>タスク' + status + '</b>\n' +
    '担当: ' + escapeHtml_(String(task['担当者名'])) + '\n' +
    '内容: ' + escapeHtml_(String(task['タスク内容']).substring(0, 120)) + '\n' +
    '操作者: ' + escapeHtml_(actorName);
  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, text, {
    parse_mode: 'HTML',
    message_thread_id: Number(cfg.adminTaskThreadId)
  });
}

// ============================================================
//  テキストコマンド（当面は未実装／将来 /task 用）
// ============================================================

function handleTextCommand_(message) {
  const text = String(message.text || '').trim();
  if (text === '/ping') {
    sendMessage(BOT_TYPE.INTERNAL, message.chat.id, 'pong');
  }
  // /task 対話式は Phase 2g で実装予定
}

// ============================================================
//  デバッグ
// ============================================================

function debugSendFieldTaskNow() {
  generateRecurringTasks();
  sendMorningTaskForField();
}

function debugSendAdminTaskNow() {
  generateRecurringTasks();
  sendMorningTaskForAdmin();
}

function debugShowPendingTasks() {
  getActiveStaff().forEach(function(s) {
    const list = getPendingTasksForStaff_(s);
    Logger.log(s.nameJp + ' (' + s.role + '): ' + list.length + '件');
    list.forEach(function(t) {
      Logger.log('  - ' + t.id + ' ' + t.desc.substring(0, 40) + ' 期限=' + t.due + ' overdue=' + t.overdue);
    });
  });
}

// ============================================================
//  ユーティリティ
// ============================================================

function escapeHtml_(s) {
  return String(s || '').replace(/[&<>"']/g, function(c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
  });
}
