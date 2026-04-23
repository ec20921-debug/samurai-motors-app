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
  // 日報 (Phase 2e) JST 20:00
  if (jstHour === 20) {
    try { sendDailyReport(); } catch (e) { Logger.log('❌ sendDailyReport: ' + e); }
  }
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
 * field スタッフへ当日朝の通知を送信（個人DM）
 * 【v7.4】本日の洗車予約スケジュール + タスクをセットで通知
 */
function sendMorningTaskForField() {
  const staff = getActiveStaff().filter(function(s) { return s.role === 'field'; });
  if (staff.length === 0) return;

  // 予約は field スタッフ全員共通（現場のロンさんは全予約を見る）
  const bookings = getTodayBookingsFromV7_();

  staff.forEach(function(s) {
    if (!s.chatId) return;  // chat_id 無ければ送らない
    const tasks = getPendingTasksForStaff_(s);

    // 予約もタスクもゼロなら通知しない（スパム防止）
    if (tasks.length === 0 && bookings.length === 0) {
      Logger.log('ℹ️ 予約・タスクゼロ: ' + s.nameJp + ' - 通知スキップ');
      return;
    }

    const text = buildFieldMorningMessage_(s, bookings, tasks);
    const keyboard = tasks.length > 0 ? buildTaskInlineKeyboard_(tasks) : null;

    const opts = { parse_mode: 'HTML', disable_web_page_preview: true };
    if (keyboard) opts.reply_markup = { inline_keyboard: keyboard };

    sendMessage(BOT_TYPE.INTERNAL, s.chatId, text, opts);
    Logger.log('📤 field 朝通知: ' + s.nameJp +
      ' (予約' + bookings.length + '件 / タスク' + tasks.length + '件)');
  });
}

/**
 * v7（顧客系）スプレッドシートの「予約」シートから、当日・未完了の予約一覧を取得
 * 【設計】v7 と v7-ops は別プロジェクトだが、SpreadsheetApp.openById で読み取り専用参照する
 *         （v7 の GAS 関数は呼び出さない＝分離原則を維持）
 */
function getTodayBookingsFromV7_() {
  const cfg = getConfig();
  if (!cfg.v7SpreadsheetId) {
    Logger.log('⚠️ V7_SPREADSHEET_ID 未設定 — 予約情報の取得スキップ');
    return [];
  }

  try {
    const ss = SpreadsheetApp.openById(cfg.v7SpreadsheetId);
    const bookingSheet = ss.getSheetByName('予約');
    if (!bookingSheet) {
      Logger.log('⚠️ v7 に「予約」シートが見つからない');
      return [];
    }

    const data = bookingSheet.getDataRange().getValues();
    if (data.length < 2) return [];

    // ヘッダーから列インデックスを解決
    const headers = data[0];
    const col = {};
    headers.forEach(function(h, i) { col[String(h).trim()] = i; });

    const required = ['予約ID', '予約日', '予約時刻', 'プラン', '進行状態'];
    for (var k = 0; k < required.length; k++) {
      if (col[required[k]] === undefined) {
        Logger.log('⚠️ 予約シートに必須列なし: ' + required[k]);
        return [];
      }
    }

    // 顧客名マップ（チャットID → 氏名）を先に作る
    const custMap = buildCustomerNameMap_(ss);

    const todayStr = Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd');
    const results = [];

    for (var i = 1; i < data.length; i++) {
      const row = data[i];

      // 予約日の照合（Date オブジェクト or 文字列の両対応）
      const dateCell = row[col['予約日']];
      var dateStr = '';
      if (dateCell instanceof Date) {
        dateStr = Utilities.formatDate(dateCell, 'Asia/Phnom_Penh', 'yyyy-MM-dd');
      } else {
        dateStr = String(dateCell || '').trim();
      }
      if (dateStr !== todayStr) continue;

      // 完了・キャンセル済みは除外
      const status = String(row[col['進行状態']] || '');
      if (status === '作業完了' || status === 'completed' ||
          status === 'キャンセル' || status === 'cancelled') continue;

      // 時間計算
      const startTime = String(row[col['予約時刻']] || '').trim();
      const duration = Number(row[col['所要時間(分)']] || 0);
      var endTime = '';
      if (startTime && duration) {
        const hm = startTime.split(':');
        if (hm.length === 2) {
          const total = Number(hm[0]) * 60 + Number(hm[1]) + duration;
          const eh = Math.floor(total / 60);
          const em = total % 60;
          endTime = ('0' + eh).slice(-2) + ':' + ('0' + em).slice(-2);
        }
      }

      const chatId = String(row[col['チャットID']] || '');
      const customerName = custMap[chatId] || '';

      results.push({
        bookingId:   String(row[col['予約ID']] || ''),
        startTime:   startTime,
        endTime:     endTime,
        duration:    duration,
        customerName: customerName,
        vehicleType: String(row[col['車種タイプ']] || ''),
        vehicleName: String(row[col['車種名']] || ''),
        plan:        String(row[col['プラン']] || ''),
        price:       row[col['料金(USD)']] || '',
        mapUrl:      String(row[col['マップリンク']] || '')
      });
    }

    // 予約時刻順にソート
    results.sort(function(a, b) {
      return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0;
    });

    return results;

  } catch (err) {
    Logger.log('❌ getTodayBookingsFromV7_ error: ' + err + ' stack=' + (err.stack || ''));
    return [];
  }
}

/**
 * v7 顧客シートから チャットID → 氏名 のマップを構築
 */
function buildCustomerNameMap_(ss) {
  const map = {};
  const custSheet = ss.getSheetByName('顧客');
  if (!custSheet) return map;
  const cdata = custSheet.getDataRange().getValues();
  if (cdata.length < 2) return map;

  const chead = {};
  cdata[0].forEach(function(h, i) { chead[String(h).trim()] = i; });
  if (chead['チャットID'] === undefined) return map;

  const nameCol = chead['氏名'] !== undefined ? chead['氏名'] :
                  chead['ユーザー名'] !== undefined ? chead['ユーザー名'] : -1;
  if (nameCol < 0) return map;

  for (var i = 1; i < cdata.length; i++) {
    const cid = String(cdata[i][chead['チャットID']] || '');
    if (cid) map[cid] = String(cdata[i][nameCol] || '');
  }
  return map;
}

/**
 * field 向け朝メッセージ組み立て（予約 + タスク）
 */
function buildFieldMorningMessage_(staff, bookings, tasks) {
  const tz = staff.timezone || 'Asia/Phnom_Penh';
  const todayJp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd (E)');
  const lines = [
    '☀️ <b>អរុណសួស្តី / おはよう ' + escapeHtml_(staff.nameJp) + ' さん</b>',
    '📅 ថ្ងៃនេះ / 本日 ' + todayJp,
    ''
  ];

  // ── 予約セクション ──
  if (bookings.length > 0) {
    lines.push('🚗 <b>ការកក់ថ្ងៃនេះ / 本日の予約 (' + bookings.length + '件)</b>');
    lines.push('━━━━━━━━━━━━━━━━━━');
    const NUM = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
    bookings.forEach(function(b, i) {
      const num = NUM[i] || ('(' + (i + 1) + ')');
      const timeRange = b.endTime ? (b.startTime + '〜' + b.endTime) : b.startTime;
      lines.push(num + ' <b>' + escapeHtml_(timeRange) + '</b>  ' + escapeHtml_(b.bookingId));
      if (b.customerName) lines.push('   👤 ' + escapeHtml_(b.customerName));
      const veh = [b.vehicleType, b.vehicleName].filter(function(x){ return x; }).join(' / ');
      if (veh) lines.push('   🚙 ' + escapeHtml_(veh));
      if (b.plan) {
        var planLine = '   📦 ' + escapeHtml_(b.plan);
        if (b.price !== '' && b.price != null) planLine += ' / $' + b.price;
        lines.push(planLine);
      }
      if (b.mapUrl) lines.push('   📍 <a href="' + escapeHtml_(b.mapUrl) + '">ផែនទី / Map</a>');
      lines.push('');
    });
  } else {
    lines.push('🚗 <b>ការកក់ថ្ងៃនេះ / 本日の予約</b>');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('ℹ️ គ្មានការកក់ទេ / 予約はありません');
    lines.push('');
  }

  // ── タスクセクション ──
  if (tasks.length > 0) {
    lines.push('📋 <b>កិច្ចការថ្ងៃនេះ / 本日のタスク (' + tasks.length + '件)</b>');
    lines.push('━━━━━━━━━━━━━━━━━━');
    tasks.forEach(function(t, i) {
      const mark = t.overdue ? '🔴' : '🟡';
      lines.push((i + 1) + '. ' + mark + ' ' + escapeHtml_(t.desc) +
        ' <i>(期限 ' + t.due + ')</i>');
    });
    lines.push('');
    lines.push('↓ ប៊ូតុងខាងក្រោមដើម្បីរាយការណ៍ / 下のボタンで報告');
  }

  return lines.join('\n');
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
 * 全スタッフ（admin + field）のタスクを担当者別にグループ化（ミニアプリ admin 画面用）
 * 戻り値: [{ assignee, nameJp, role, tasks:[...] }, ...]
 * スタッフマスター未登録の担当者名もタスクがあれば返す。
 * 並び順: admin → field → 未登録
 *
 * @param {number} [daysAhead=0] 何日先まで含めるか
 */
function getAdminGroupedTasks_(daysAhead) {
  const all = getActiveStaff();
  const admins = all.filter(function(s) { return s.role === 'admin'; });
  const fields = all.filter(function(s) { return s.role === 'field'; });
  const groups = [];
  const seenNames = {};
  const ahead = Math.max(0, Number(daysAhead || 0));

  // ① admin を先に
  admins.forEach(function(a) {
    const tasks = getPendingTasksForStaff_(a, ahead);
    if (tasks.length > 0) {
      groups.push({ assignee: a.nameJp, nameJp: a.nameJp, role: 'admin', tasks: tasks });
    }
    seenNames[a.nameJp] = true;
  });

  // ② field を次に
  fields.forEach(function(f) {
    const tasks = getPendingTasksForStaff_(f, ahead);
    if (tasks.length > 0) {
      groups.push({ assignee: f.nameJp, nameJp: f.nameJp, role: 'field', tasks: tasks });
    }
    seenNames[f.nameJp] = true;
  });

  // ③ スタッフマスター未登録だがタスクがある担当者も拾う（飯泉さんがまだ未登録のケース等）
  try {
    const rows = getAllRows(SHEET_NAMES.TASKS);
    const tz = OPS_TZ;
    const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    var horizonStr = todayStr;
    if (ahead > 0) {
      const d = new Date();
      d.setDate(d.getDate() + ahead);
      horizonStr = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    }
    const unregGroups = {};
    const unregRoles  = {};
    rows.forEach(function(r) {
      if (String(r['ステータス']) !== '未着手') return;
      const name = String(r['担当者名'] || '').trim();
      if (!name || seenNames[name]) return;
      const role = String(r['担当 role'] || '').trim();
      const due = formatDateCellTz_(r['期限'], tz);
      if (!due || due > horizonStr) return;
      if (!unregGroups[name]) unregGroups[name] = [];
      unregRoles[name] = role;
      unregGroups[name].push({
        id:       String(r['タスクID']),
        desc:     String(r['タスク内容']),
        due:      due,
        overdue:  due < todayStr,
        today:    due === todayStr,
        assignee: name,
        role:     role
      });
    });
    Object.keys(unregGroups).forEach(function(name) {
      groups.push({ assignee: name, nameJp: name, role: unregRoles[name] || '', tasks: unregGroups[name] });
    });
  } catch (e) {
    Logger.log('⚠️ getAdminGroupedTasks_ 未登録担当者の走査失敗: ' + e);
  }

  return groups;
}

/**
 * 対象スタッフの未完了タスク一覧を取得
 *
 * @param {Object} staff スタッフオブジェクト
 * @param {number} [daysAhead=0] 何日先まで含めるか（0=今日以前、7=今日〜1週間先）
 *
 * - 朝通知からは daysAhead 省略（今日以前 = 本日期限 + 期限超過）
 * - ミニアプリからは daysAhead=7 で呼び、1週間先までのタスクを表示
 */
function getPendingTasksForStaff_(staff, daysAhead) {
  const rows = getAllRows(SHEET_NAMES.TASKS);
  const tz = staff.timezone || 'Asia/Phnom_Penh';
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  const ahead = Math.max(0, Number(daysAhead || 0));
  var horizonStr = todayStr;
  if (ahead > 0) {
    const d = new Date();
    d.setDate(d.getDate() + ahead);
    horizonStr = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  }

  return rows.filter(function(r) {
    if (String(r['ステータス']) !== '未着手') return false;
    if (String(r['担当者名'])   !== staff.nameJp) return false;
    const due = formatDateCellTz_(r['期限'], tz);
    if (!due) return false;
    return due <= horizonStr;
  }).map(function(r) {
    const due = formatDateCellTz_(r['期限'], tz);
    return {
      id:        String(r['タスクID']),
      desc:      String(r['タスク内容']),
      due:       due,
      overdue:   due < todayStr,
      today:     due === todayStr,
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
  // パートナー承認/却下（PartnerManager で処理）
  if (typeof handlePartnerCallback_ === 'function' &&
      (data.indexOf('partner_approve:') === 0 || data.indexOf('partner_reject:') === 0)) {
    if (handlePartnerCallback_(cb)) return;
  }
  // 撥水モニター（WaterRepellentManager で処理）
  if (typeof handleWaterRepellentCallback_ === 'function' &&
      (data.indexOf('wr_confirm:') === 0
       || data.indexOf('wr_cancel:') === 0
       || data.indexOf('wr_complete:') === 0)) {
    if (handleWaterRepellentCallback_(cb)) return;
  }
  // 撥水モニター: アンケート送付完了マーク
  if (typeof _handleWaterRepellentSurveyCallback_ === 'function' &&
      data.indexOf('wr_survey:') === 0) {
    if (_handleWaterRepellentSurveyCallback_(cb)) return;
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

  // Phase B: 関連経費ID があれば経費シートを連動更新（立替精算タスク完了時）
  const expenseId = String(row.data['関連経費ID'] || '').trim();
  if (expenseId) {
    try {
      settleExpenseByTask_(expenseId, row.data, actor);
    } catch (err) {
      Logger.log('⚠️ 経費連動更新失敗 expenseId=' + expenseId + ' err=' + err);
    }
  }
}

/**
 * Phase B: 立替精算タスク完了時に経費シートを更新し、立替者へDM通知する
 *   - 経費シート: ステータス→精算済み、精算日=today
 *   - 立替者（登録者）に Telegram DM で精算完了を通知
 */
function settleExpenseByTask_(expenseId, taskRow, actor) {
  const row = findRow(SHEET_NAMES.EXPENSES, '経費ID', expenseId);
  if (!row) { Logger.log('⚠️ 経費未発見 ' + expenseId); return; }

  const expense = row.data;
  if (String(expense['ステータス']) === '精算済み') return; // 冪等

  const tz = OPS_TZ;
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  updateRow(SHEET_NAMES.EXPENSES, row.row, {
    'ステータス': '精算済み',
    '精算日':     todayStr
  });

  // 立替者（登録者）に DM 通知
  const payerChatId = String(expense['登録者 Chat ID'] || '');
  const payerName   = String(expense['登録者'] || '');
  const reimburseBy = String(taskRow['担当者名'] || expense['精算先'] || '');
  const amount      = Number(expense['金額'] || 0);
  const currency    = String(expense['通貨'] || '');
  const desc        = String(expense['品目・摘要'] || '');

  // 経費トピックへ通知
  try {
    const cfg = getConfig();
    const thread = cfg.adminExpenseThreadId || cfg.adminDailyReportThreadId;
    if (thread) {
      const money = currency + ' ' + amount.toLocaleString('en-US');
      const text = [
        '✅ <b>立替精算 完了</b>',
        '━━━━━━━━━━━━━━━━━━',
        '💸 ' + escapeHtml_(reimburseBy) + ' → ' + escapeHtml_(payerName),
        '💵 <b>' + escapeHtml_(money) + '</b>',
        '📝 ' + escapeHtml_(desc.substring(0, 120)),
        '📅 精算日: ' + todayStr,
        'ID: <code>' + escapeHtml_(expenseId) + '</code>'
      ].join('\n');
      sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, text, {
        parse_mode: 'HTML',
        message_thread_id: Number(thread)
      });
    }
  } catch (err) {
    Logger.log('⚠️ 経費トピック通知失敗: ' + err);
  }

  // 立替者にDM
  if (payerChatId) {
    try {
      const money = currency + ' ' + amount.toLocaleString('en-US');
      const dm = [
        '✅ <b>ការទូទាត់បានចប់ / 立替精算 完了</b>',
        '━━━━━━━━━━━━━━━━━━',
        '💸 ' + escapeHtml_(reimburseBy) + ' さんから受け取り確認',
        '💵 <b>' + escapeHtml_(money) + '</b>',
        '📝 ' + escapeHtml_(desc.substring(0, 120)),
        '📅 ' + todayStr,
        '',
        'អរគុណ! / おつかれさまです'
      ].join('\n');
      sendMessage(BOT_TYPE.INTERNAL, payerChatId, dm, { parse_mode: 'HTML' });
    } catch (err) {
      Logger.log('⚠️ 立替者DM失敗 chatId=' + payerChatId + ' err=' + err);
    }
  }
}

/**
 * Phase B: 立替経費登録時に精算タスクを自動生成
 *
 * @param {{nameJp:string, chatId:string, role:string, timezone:string}} payerStaff 立替者（ロン等）
 * @param {{expenseId, amount, currency, desc, reimburseTo, reimburseDue}} data 経費データ
 * @return {{ok:boolean, taskId?:string, error?:string}}
 */
function createExpenseReimburseTask_(payerStaff, data) {
  if (!data || !data.reimburseTo)  return { ok: false, error: 'REIMBURSE_TO_REQUIRED' };
  if (!data.reimburseDue)          return { ok: false, error: 'DUE_REQUIRED' };

  // 精算先スタッフを解決（スタッフマスター未登録でもタスクは作る：chatId/role/tz は空欄）
  const assignee = (typeof findStaffByNameJp === 'function')
    ? findStaffByNameJp(data.reimburseTo)
    : null;
  const assigneeName = data.reimburseTo;
  const assigneeChatId = assignee ? assignee.chatId : '';
  const assigneeRole   = assignee ? assignee.role   : '';
  const assigneeTz     = (assignee && assignee.timezone) || OPS_TZ;

  const money = data.currency + ' ' + Number(data.amount).toLocaleString('en-US');
  const desc = payerStaff.nameJp + ' へ立替精算 ' + money +
    '（' + data.expenseId + (data.desc ? ' / ' + String(data.desc).substring(0, 60) : '') + '）';

  const taskId = generateDateSeqId('TASK', SHEET_NAMES.TASKS, 'タスクID');
  appendRow(SHEET_NAMES.TASKS, {
    'タスクID':      taskId,
    '作成日時':      new Date(),
    '担当者名':      assigneeName,
    '担当 Chat ID':  assigneeChatId,
    '担当 role':     assigneeRole,
    '担当 timezone': assigneeTz,
    '期限':          data.reimburseDue,
    'タスク内容':    desc,
    'ステータス':    '未着手',
    '完了日時':      '',
    '未完了理由':    '',
    '繰返しルール':  '',
    '親タスクID':    '',
    '関連経費ID':    data.expenseId
  });

  return { ok: true, taskId: taskId };
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
//  新規タスク入力シート - onEdit ハンドラ
// ============================================================

/**
 * 「新規タスク入力」シートの編集イベント。
 * E列（追加）のチェックが入ったら、その行をタスクシートに転記し、
 * 入力行をクリアしてチェックボックスも外す。
 *
 * 【インストール方法】Setup.gs の setupTaskInputOnEditTrigger() を1回実行
 */
function handleTaskInputEdit(e) {
  try {
    if (!e || !e.range) return;
    const sheet = e.range.getSheet();
    if (sheet.getName() !== SHEET_NAMES.TASK_INPUT) return;
    if (e.range.getColumn() !== 5) return;     // E列以外は無視
    if (e.value !== 'TRUE') return;            // チェックが入った時のみ
    const row = e.range.getRow();
    if (row < 2) return;                       // ヘッダー行は無視

    processTaskInputRow_(sheet, row);
  } catch (err) {
    Logger.log('❌ handleTaskInputEdit: ' + err);
  }
}

function processTaskInputRow_(sheet, row) {
  const values = sheet.getRange(row, 1, 1, 5).getValues()[0];
  const assigneeName = String(values[0] || '').trim();
  const dueRaw       = values[1];
  const desc         = String(values[2] || '').trim();
  const recurrence   = String(values[3] || '').trim();

  const resultCell = sheet.getRange(row, 6);
  const checkCell  = sheet.getRange(row, 5);

  if (!assigneeName || !dueRaw || !desc) {
    resultCell.setValue('⚠️ 担当者・期限・タスク内容は必須');
    checkCell.setValue(false);
    return;
  }

  const staff = findStaffByNameJp(assigneeName);
  if (!staff) {
    resultCell.setValue('⚠️ スタッフマスターに「' + assigneeName + '」未登録');
    checkCell.setValue(false);
    return;
  }

  const tz = staff.timezone || 'Asia/Phnom_Penh';
  const dueStr = (dueRaw instanceof Date)
    ? Utilities.formatDate(dueRaw, tz, 'yyyy-MM-dd')
    : String(dueRaw).trim();

  // 繰返しありかつ期限なし → テンプレート扱い
  // 通常は一回タスク
  const isTemplate = (recurrence && recurrence !== 'なし');
  const status = isTemplate ? '繰返し中' : '未着手';
  const taskId = generateDateSeqId('TASK', SHEET_NAMES.TASKS, 'タスクID');

  appendRow(SHEET_NAMES.TASKS, {
    'タスクID':      taskId,
    '作成日時':      new Date(),
    '担当者名':      staff.nameJp,
    '担当 Chat ID':  staff.chatId,
    '担当 role':     staff.role,
    '担当 timezone': tz,
    '期限':          isTemplate ? '' : dueStr,   // テンプレートは期限を持たない
    'タスク内容':    desc,
    'ステータス':    status,
    '完了日時':      '',
    '未完了理由':    '',
    '繰返しルール':  isTemplate ? recurrence : '',
    '親タスクID':    '',
    '関連経費ID':    ''
  });

  // 入力行クリア
  sheet.getRange(row, 1, 1, 5).clearContent();
  sheet.getRange(row, 5).insertCheckboxes();  // チェックボックス再挿入

  const label = isTemplate
    ? '✅ テンプレート登録: ' + taskId + ' (' + recurrence + ')'
    : '✅ タスク登録: ' + taskId + ' 期限=' + dueStr;
  resultCell.setValue(label);
}

// ============================================================
//  ミニアプリからのタスク作成
// ============================================================

/**
 * ミニアプリからのタスク作成
 *
 * @param {string} creatorChatId 作成者（通知の「作成者」表示用）
 * @param {{ assigneeName:string, targetDate:string, description:string, recurrence:string }} payload
 */
function createTaskFromUi(creatorChatId, payload) {
  const assigneeName = String((payload && payload.assigneeName) || '').trim();
  const desc         = String((payload && payload.description)  || '').trim();
  const targetDate   = String((payload && payload.targetDate)   || '').trim();
  const recurrence   = String((payload && payload.recurrence)   || 'なし').trim();

  if (!assigneeName) return { ok: false, error: 'ASSIGNEE_REQUIRED' };
  if (!desc)         return { ok: false, error: 'DESC_REQUIRED' };

  const staff = findStaffByNameJp(assigneeName);
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND', name: assigneeName };

  const isTemplate = (recurrence && recurrence !== 'なし');
  if (!isTemplate && !targetDate) return { ok: false, error: 'DATE_REQUIRED' };

  const tz = staff.timezone || OPS_TZ;
  const taskId = generateDateSeqId('TASK', SHEET_NAMES.TASKS, 'タスクID');
  const status = isTemplate ? '繰返し中' : '未着手';

  appendRow(SHEET_NAMES.TASKS, {
    'タスクID':      taskId,
    '作成日時':      new Date(),
    '担当者名':      staff.nameJp,
    '担当 Chat ID':  staff.chatId,
    '担当 role':     staff.role,
    '担当 timezone': tz,
    '期限':          isTemplate ? '' : targetDate,
    'タスク内容':    desc,
    'ステータス':    status,
    '完了日時':      '',
    '未完了理由':    '',
    '繰返しルール':  isTemplate ? recurrence : '',
    '親タスクID':    '',
    '関連経費ID':    ''
  });

  // 管理グループへ通知（成功時のみ／失敗してもユーザの作成自体は成功として返す）
  try {
    notifyTaskCreated_(staff, taskId, desc, isTemplate ? recurrence : targetDate, isTemplate, creatorChatId);
  } catch (err) {
    Logger.log('⚠️ タスク作成通知失敗: ' + err);
  }

  return {
    ok: true,
    taskId: taskId,
    isTemplate: isTemplate,
    assignee: staff.nameJp
  };
}

/**
 * 作成通知（管理グループ・タスクトピック）
 */
function notifyTaskCreated_(staff, taskId, desc, dueOrRule, isTemplate, creatorChatId) {
  const cfg = getConfig();
  if (!cfg.adminTaskThreadId) return;

  const creator = findStaffByChatId(String(creatorChatId || ''));
  const creatorName = creator ? creator.nameJp : ('chat_id=' + (creatorChatId || '?'));

  const header = isTemplate ? '🔁 <b>繰返しタスク登録</b>' : '➕ <b>タスク作成</b>';
  const dueLine = isTemplate ? '繰返し: ' + dueOrRule : '期限: ' + dueOrRule;
  const text = [
    header,
    '━━━━━━━━━━━━━━━━━━',
    '担当: ' + escapeHtml_(staff.nameJp),
    dueLine,
    '内容: ' + escapeHtml_(String(desc).substring(0, 200)),
    '作成者: ' + escapeHtml_(creatorName)
  ].join('\n');

  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, text, {
    parse_mode: 'HTML',
    message_thread_id: Number(cfg.adminTaskThreadId)
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
