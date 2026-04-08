// ╔══════════════════════════════════════════════════════════════╗
// ║  Samurai Motors - 業務管理 Apps Script v5                    ║
// ║  ジョブ管理 + タスク管理 + 経費管理 + サマリー + Telegram通知  ║
// ╠══════════════════════════════════════════════════════════════╣
// ║                                                              ║
// ║  【v4 → v5 変更点】                                          ║
// ║  ① 日次サマリー配信時間をJST 20:00に変更                      ║
// ║  ② 日次サマリーから在庫セクション削除                          ║
// ║  ③ タスク管理機能追加（Admin→現場への指示・進捗管理）           ║
// ║  ④ 経費管理機能追加（レシートOCR→スプレッドシート記録）         ║
// ║  ⑤ Telegram対話機能（callback_query・朝タスク通知）            ║
// ║  ⑥ 複数スタッフ対応（STAFF_REGISTRY）                         ║
// ║                                                              ║
// ║  【更新手順】                                                 ║
// ║  ① Apps Script エディタで既存コードを全て削除                  ║
// ║  ② このコードを貼り付け → Ctrl+S で保存                      ║
// ║  ③ 「サービス」→ Drive API v2 を有効化                        ║
// ║  ④ 「デプロイ」→「デプロイを管理」→ 鉛筆アイコン              ║
// ║  ⑤ バージョン「新しいバージョン」→「デプロイ」                 ║
// ║  ⑥ setupV5Sheets() を実行 → シート・初期データ作成            ║
// ║  ⑦ setupV5Triggers() を実行 → トリガー一括設定                ║
// ║  ⑧ setupWebhook() を実行 → Telegram Webhook再設定            ║
// ║                                                              ║
// ╚══════════════════════════════════════════════════════════════╝

// ═══════════════════════════════════════════
//  設定
// ═══════════════════════════════════════════

// Google Driveフォルダ名
var PHOTO_FOLDER_NAME = 'SamuraiMotors_Photos';
var RECEIPT_FOLDER_NAME = 'SamuraiMotors_Receipts';

// シート名
var INVENTORY_SHEET_NAME = 'Inventory';
var TASKS_SHEET_NAME = 'Tasks';
var EXPENSES_SHEET_NAME = 'Expenses';
var DAILY_REPORTS_SHEET_NAME = 'DailyReports';
var ATTENDANCE_SHEET_NAME = 'Attendance';

// Telegram Bot設定
var TELEGRAM_BOT_TOKEN = '8248146123:AAEORbRSuqwLgZxcb-Pyc90DaDScH4W2j7w';
// 通知先チャットID（複数指定で両方に送信）
var TELEGRAM_CHAT_IDS = [
  '7500384947',   // 個人チャット（d suzuki）
  '-5178607881'   // グループ（【admin】Samurai motors業務管理）
];

// メッセージ転送設定
var ADMIN_GROUP_ID = '-5178607881';     // Adminグループ

// スタッフ登録（複数人対応）
// 追加時: Chat IDをキーとして { name, role } を追加
var STAFF_REGISTRY = {
  '7500384947': { name: 'ロン', nameKh: 'រ៉ន', role: 'field' }
};

// 全フィールドスタッフのChat IDリスト（自動生成）
var FIELD_STAFF_IDS = Object.keys(STAFF_REGISTRY).filter(function(id) {
  return STAFF_REGISTRY[id].role === 'field';
});

// ═══════════════════════════════════════════
//  正しいヘッダー定義（23列）
// ═══════════════════════════════════════════

var CORRECT_HEADERS = [
  'Job ID',
  'ថ្ងៃចុះបញ្ជី（登録日時）',
  'ឈ្មោះ（顧客名）',
  'ទូរស័ព្ទ（電話番号）',
  'អគារ（建物）',
  'បន្ទប់（部屋番号）',
  'រថយន្ត（車種）',
  'ស្លាកលេខ（ナンバー）',
  'គម្រោង（プラン）',
  'Google Maps',
  'កំណត់សម្គាល់（備考）',
  'កាលវិភាគ（予約日時）',
  'ចាប់ផ្តើម（開始時刻）',
  'បញ្ចប់（終了時刻）',
  'រយៈពេល（所要分）',
  'មុន 1（ビフォー1）',
  'មុន 2（ビフォー2）',
  'មុន 3（ビフォー3）',
  'មុន 4（ビフォー4）',
  'ក្រោយ 1（アフター1）',
  'ក្រោយ 2（アフター2）',
  'ក្រោយ 3（アフター3）',
  'ក្រោយ 4（アフター4）'
];

// ═══════════════════════════════════════════
//  メインルーター：action で処理を振り分け
// ═══════════════════════════════════════════

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    // Telegram Webhookからのメッセージ（update_idがある場合）
    if (data.update_id) {
      return handleTelegramWebhook(data);
    }

    // ミニアプリからのリクエスト（actionがある場合）
    var action = data.action || 'job';

    switch (action) {
      case 'job':
        return handleJobSubmit(data);
      case 'job_start':
        return handleJobStart(data);
      case 'job_end':
        return handleJobEnd(data);
      case 'task_create':
        return handleTaskCreateFromApp(data);
      case 'task_update':
        return handleTaskUpdateFromApp(data);
      case 'task_edit':
        return handleTaskEditFromApp(data);
      case 'expense_create':
        return handleExpenseCreateFromApp(data);
      case 'daily_report':
        return handleDailyReportFromApp(data);
      case 'attendance':
        return handleAttendanceFromApp(data);
      default:
        return jsonResponse({ status: 'error', message: 'Unknown action: ' + action });
    }
  } catch (error) {
    Logger.log('doPost error: ' + error.toString());
    return jsonResponse({ status: 'error', message: error.toString() });
  }
}

// ═══════════════════════════════════════════
//  Telegram Webhook：メッセージルーティング
// ═══════════════════════════════════════════

function handleTelegramWebhook(update) {
  // callback_query（インラインボタン押下）の処理
  if (update.callback_query) {
    return handleCallbackQuery(update.callback_query);
  }

  var message = update.message;
  if (!message) {
    return ContentService.createTextOutput('ok');
  }

  var chatId = String(message.chat.id);
  var fromBot = message.from && message.from.is_bot;

  // ボット自身のメッセージは無視（ループ防止）
  if (fromBot) {
    return ContentService.createTextOutput('ok');
  }

  var senderName = (message.from.first_name || '') + ' ' + (message.from.last_name || '');
  senderName = senderName.trim();

  // 会話状態チェック（対話フロー中の場合）
  var convState = getConversationState(chatId);
  if (convState) {
    handleConversationState(chatId, message, convState, senderName);
    return ContentService.createTextOutput('ok');
  }

  // --- Adminグループからのメッセージ ---
  if (chatId === ADMIN_GROUP_ID) {
    // /task コマンド: タスク作成対話開始
    if (message.text && message.text.indexOf('/task') === 0) {
      handleAdminTaskCommand(chatId, message);
      return ContentService.createTextOutput('ok');
    }

    // /tasklist コマンド: タスク一覧表示
    if (message.text && message.text.indexOf('/tasklist') === 0) {
      showAllTasks(chatId);
      return ContentService.createTextOutput('ok');
    }

    // テキストメッセージ転送
    if (message.text) {
      // /start等のコマンドは転送しない
      if (message.text.indexOf('/') === 0) {
        return ContentService.createTextOutput('ok');
      }
      // 全フィールドスタッフに転送
      FIELD_STAFF_IDS.forEach(function(staffId) {
        sendTelegramTo(staffId,
          '📩 *管理者メッセージ*\n'
          + '━━━━━━━━━━━━━━━\n'
          + '👤 ' + senderName + '\n'
          + '💬 ' + message.text
        );
      });
    }

    // スタンプ・写真・ドキュメント・音声は全スタッフに転送
    if (message.sticker || message.photo || message.document || message.voice) {
      FIELD_STAFF_IDS.forEach(function(staffId) {
        forwardMessage(staffId, chatId, message.message_id);
      });
    }
  }

  // --- 現場スタッフからのメッセージ ---
  if (STAFF_REGISTRY[chatId]) {
    var staffName = STAFF_REGISTRY[chatId].name;

    // /receipt コマンド: レシート経費登録モード開始
    if (message.text && message.text.indexOf('/receipt') === 0) {
      setConversationState(chatId, { type: 'receipt_pending', step: 'waiting_photo' });
      sendTelegramTo(chatId, '📸 *レシート経費登録*\n━━━━━━━━━━━━━━━\nレシートの写真を送ってください。\nOCRで読み取り、経費を自動登録します。');
      return ContentService.createTextOutput('ok');
    }

    // /tasks コマンド: 自分のタスク一覧表示
    if (message.text && message.text.indexOf('/tasks') === 0) {
      showMyTasks(chatId, staffName);
      return ContentService.createTextOutput('ok');
    }

    // テキストメッセージをAdminに転送
    if (message.text) {
      if (message.text.indexOf('/start') === 0) {
        return ContentService.createTextOutput('ok');
      }
      sendTelegramTo(ADMIN_GROUP_ID,
        '📩 *現場スタッフ*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '👤 ' + staffName + '\n'
        + '💬 ' + message.text
      );
    }

    // スタンプ・写真・ドキュメント・音声をAdminに転送
    if (message.sticker || message.photo || message.document || message.voice) {
      forwardMessage(ADMIN_GROUP_ID, chatId, message.message_id);
    }
  }

  return ContentService.createTextOutput('ok');
}

// ═══════════════════════════════════════════
//  会話状態管理（PropertiesService）
// ═══════════════════════════════════════════

function setConversationState(chatId, stateObj) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('conv_' + chatId, JSON.stringify(stateObj));
}

function getConversationState(chatId) {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('conv_' + chatId);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function clearConversationState(chatId) {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('conv_' + chatId);
}

// 会話状態に応じた処理ルーター
function handleConversationState(chatId, message, state, senderName) {
  // キャンセルコマンド
  if (message.text && message.text === '/cancel') {
    clearConversationState(chatId);
    sendTelegramTo(chatId, '❌ 操作をキャンセルしました。');
    return;
  }

  switch (state.type) {
    case 'task_create':
      handleTaskCreateFlow(chatId, message, state);
      break;
    case 'receipt_pending':
      handleReceiptFlow(chatId, message, state, senderName);
      break;
    case 'pending_reason':
      handlePendingReasonFlow(chatId, message, state);
      break;
    default:
      clearConversationState(chatId);
      break;
  }
}

// ═══════════════════════════════════════════
//  タスク管理
// ═══════════════════════════════════════════

// Tasksシート取得（なければ作成）
function getTasksSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TASKS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(TASKS_SHEET_NAME);
    var headers = [
      'Task ID', '作成日時', '担当者', '担当者ChatID', '期限',
      'やるべきこと', 'ステータス', '完了日時', '未完了理由',
      '繰返しルール', '親タスクID', '関連経費ID'
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#2196F3');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);  // Task ID
    sheet.setColumnWidth(6, 300);  // やるべきこと
  }

  return sheet;
}

// タスク作成
function createTask(assignee, assigneeChatId, deadline, description, recurrence, expenseId) {
  var sheet = getTasksSheet();
  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');

  // Task ID生成
  var lastRow = sheet.getLastRow();
  var count = 1;
  if (lastRow >= 2) {
    // 同日のタスク数をカウント
    var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    data.forEach(function(row) {
      if (row[0] && row[0].toString().indexOf('TASK-' + dateStr) === 0) {
        count++;
      }
    });
  }
  var taskId = 'TASK-' + dateStr + '-' + String(count).padStart(3, '0');

  sheet.appendRow([
    taskId,
    formatCambodiaTime(now),
    assignee || '',
    assigneeChatId || '',
    deadline || '',
    description || '',
    '未着手',
    '',  // 完了日時
    '',  // 未完了理由
    recurrence || '',
    '',  // 親タスクID
    expenseId || ''
  ]);

  return taskId;
}

// タスクステータス絵文字判定
function getTaskStatusEmoji(deadline, status) {
  if (status === '完了') return '🟢';

  var now = new Date();
  var today = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyy-MM-dd');

  if (!deadline) return '🟡';

  // 期限との差を計算
  var deadlineDate = new Date(deadline + 'T23:59:59+07:00');
  var diffDays = Math.floor((deadlineDate - now) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) return '🔴';  // 期限超過
  if (diffDays <= 2) return '🟡';  // 期限近い
  return '🟢';  // 余裕あり
}

// --- タスク作成対話フロー ---

// /task コマンド処理（Admin用）
function handleAdminTaskCommand(chatId, message) {
  // 対話フロー開始
  setConversationState(chatId, {
    type: 'task_create',
    step: 'assignee',
    data: {}
  });

  // スタッフ一覧を表示
  var staffList = Object.keys(STAFF_REGISTRY).map(function(id) {
    return '• ' + STAFF_REGISTRY[id].name;
  }).join('\n');

  sendTelegramTo(chatId,
    '📝 *タスク作成*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '担当者を入力してください。\n\n'
    + '登録スタッフ:\n' + staffList + '\n• 飯泉\n\n'
    + '（/cancel でキャンセル）'
  );
}

// タスク作成の対話ステップ処理
function handleTaskCreateFlow(chatId, message, state) {
  var text = (message.text || '').trim();
  if (!text) {
    sendTelegramTo(chatId, 'テキストで入力してください。');
    return;
  }

  var data = state.data || {};

  switch (state.step) {
    case 'assignee':
      data.assignee = text;
      // Chat IDを検索
      data.assigneeChatId = '';
      Object.keys(STAFF_REGISTRY).forEach(function(id) {
        if (STAFF_REGISTRY[id].name === text) {
          data.assigneeChatId = id;
        }
      });
      // 飯泉さんの場合はAdminグループに通知
      if (text === '飯泉') {
        data.assigneeChatId = ADMIN_GROUP_ID;
      }

      setConversationState(chatId, { type: 'task_create', step: 'deadline', data: data });
      sendTelegramTo(chatId, '📅 期限を入力してください。\n例: 2026-04-15\n（期限なしの場合は「なし」）');
      break;

    case 'deadline':
      if (text === 'なし' || text === '無し') {
        data.deadline = '';
      } else {
        data.deadline = text;
      }
      setConversationState(chatId, { type: 'task_create', step: 'description', data: data });
      sendTelegramTo(chatId, '📋 やるべきことを入力してください。');
      break;

    case 'description':
      data.description = text;
      // タスク作成実行
      var taskId = createTask(
        data.assignee,
        data.assigneeChatId,
        data.deadline,
        data.description,
        '',  // 繰返しルール
        ''   // 関連経費ID
      );

      clearConversationState(chatId);

      var emoji = getTaskStatusEmoji(data.deadline, '未着手');
      var msg = '✅ *タスク作成完了*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '🆔 ' + taskId + '\n'
        + '👤 担当: ' + data.assignee + '\n'
        + '📅 期限: ' + (data.deadline || 'なし') + '\n'
        + emoji + ' ' + data.description;

      sendTelegramTo(chatId, msg);

      // 担当者にも通知（スタッフの場合：クメール語翻訳付き）
      if (data.assigneeChatId && data.assigneeChatId !== ADMIN_GROUP_ID && data.assigneeChatId !== chatId) {
        var descKh = translateToKhmer(data.description);
        sendTelegramTo(data.assigneeChatId,
          '📌 *ការងារថ្មីត្រូវបានបន្ថែម*\n'
          + '━━━━━━━━━━━━━━━\n'
          + '📅 ថ្ងៃកំណត់: ' + (data.deadline || 'គ្មាន') + '\n'
          + '📋 ' + descKh + '\n'
          + '🇯🇵 ' + data.description
        );
      }
      break;
  }
}

// タスク一覧表示（Admin用 - 全タスク）
function showAllTasks(chatId) {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    sendTelegramTo(chatId, '📋 タスクはまだありません。');
    return;
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  var activeTasks = data.filter(function(row) {
    return row[6] !== '完了';  // ステータスが完了でないもの
  });

  if (activeTasks.length === 0) {
    sendTelegramTo(chatId, '✅ 未完了のタスクはありません。');
    return;
  }

  var msg = '📋 *タスク一覧（未完了）*\n━━━━━━━━━━━━━━━\n\n';
  activeTasks.forEach(function(row, idx) {
    var emoji = getTaskStatusEmoji(row[4], row[6]);
    msg += (idx + 1) + '. ' + emoji + ' ' + row[5] + '\n'
      + '   👤 ' + row[2] + ' | 📅 ' + (row[4] || 'なし') + '\n\n';
  });

  sendTelegramTo(chatId, msg);
}

// タスク一覧表示（スタッフ用 - 自分のタスクのみ、インラインキーボード付き）
function showMyTasks(chatId, staffName) {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    sendTelegramTo(chatId, '📋 タスクはありません。');
    return;
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  var myTasks = data.filter(function(row) {
    return row[2] === staffName && row[6] !== '完了';
  });

  if (myTasks.length === 0) {
    sendTelegramTo(chatId, '✅ គ្មានការងារមិនទាន់រួច។ អរគុណ!\n（未完了のタスクはありません。お疲れ様です！）');
    return;
  }

  var msg = '📋 *ការងាររបស់អ្នក*\n（あなたのタスク）\n━━━━━━━━━━━━━━━\n\n';
  var keyboard = [];

  myTasks.forEach(function(row, idx) {
    var emoji = getTaskStatusEmoji(row[4], row[6]);
    var descJp = row[5];
    var descKh = translateToKhmer(descJp);
    msg += (idx + 1) + '. ' + emoji + ' ' + descKh + '\n'
      + '   🇯🇵 ' + descJp + '\n'
      + '   📅 ថ្ងៃកំណត់: ' + (row[4] || 'គ្មាន') + '\n\n';

    keyboard.push([
      { text: '✅ ' + descKh.substring(0, 15), callback_data: 'task_done:' + row[0] },
      { text: '❌ មិនទាន់រួច', callback_data: 'task_notdone:' + row[0] }
    ]);
  });

  sendTelegramWithKeyboard(chatId, msg, { inline_keyboard: keyboard });
}

// 繰返しタスクの自動生成（毎日UTC 0:00に実行）
function generateRecurringTasks() {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  var today = new Date();
  var dayOfMonth = today.getDate();
  var currentMonth = Utilities.formatDate(today, 'Asia/Phnom_Penh', 'yyyy-MM');

  data.forEach(function(row) {
    var recurrence = row[9]; // 繰返しルール
    if (!recurrence) return;

    // monthly:DD パターン
    var monthlyMatch = recurrence.match(/^monthly:(\d+)$/);
    if (monthlyMatch) {
      var targetDay = parseInt(monthlyMatch[1], 10);
      if (dayOfMonth !== targetDay) return;

      // 今月既に生成済みか確認
      var parentId = row[0]; // 親タスクID
      var alreadyExists = data.some(function(r) {
        return r[10] === parentId && r[1].toString().indexOf(currentMonth) === 0;
      });

      if (!alreadyExists) {
        var taskId = createTask(
          row[2],  // 担当者
          row[3],  // ChatID
          Utilities.formatDate(today, 'Asia/Phnom_Penh', 'yyyy-MM-dd'), // 期限=当日
          row[5],  // やるべきこと
          '',      // 繰返しなし（インスタンス）
          ''
        );

        // 親タスクIDを設定
        var newLastRow = sheet.getLastRow();
        sheet.getRange(newLastRow, 11).setValue(parentId);

        Logger.log('繰返しタスク生成: ' + taskId + ' (親: ' + parentId + ')');
      }
    }
  });
}

// 初期繰返しタスク登録
function seedRecurringTasks() {
  // ABA給与支払い（毎月10日）
  createTask(
    '飯泉',
    ADMIN_GROUP_ID,
    '',  // 期限は生成時に設定
    'ABA給与支払い',
    'monthly:10',
    ''
  );
  Logger.log('繰返しタスクテンプレートを登録しました。');
}

// ═══════════════════════════════════════════
//  Telegram Callback Query（インラインボタン）
// ═══════════════════════════════════════════

function handleCallbackQuery(callbackQuery) {
  var callbackId = callbackQuery.id;
  var data = callbackQuery.data;
  var chatId = String(callbackQuery.message.chat.id);
  var messageId = callbackQuery.message.message_id;

  // task_done:TASK-XXXXXXX
  if (data.indexOf('task_done:') === 0) {
    var taskId = data.replace('task_done:', '');
    updateTaskStatus(taskId, '完了');

    answerCallbackQuery(callbackId, '✅ タスク完了！');

    // メッセージを更新（ボタンを削除して完了表示）
    editMessageText(chatId, messageId,
      '✅ *タスク完了*: ' + taskId + '\n完了時刻: ' + formatCambodiaTime(new Date())
    );

    // Adminグループにも通知
    sendTelegramTo(ADMIN_GROUP_ID,
      '✅ *タスク完了通知*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🆔 ' + taskId + '\n'
      + '⏰ ' + formatCambodiaTime(new Date())
    );

    return ContentService.createTextOutput('ok');
  }

  // task_notdone:TASK-XXXXXXX
  if (data.indexOf('task_notdone:') === 0) {
    var taskId = data.replace('task_notdone:', '');

    answerCallbackQuery(callbackId, '理由を入力してください');

    // 理由入力待ちの会話状態を設定
    setConversationState(chatId, {
      type: 'pending_reason',
      taskId: taskId
    });

    sendTelegramTo(chatId,
      '❌ *タスク未完了*: ' + taskId + '\n\n'
      + 'なぜ完了できなかったか、理由を入力してください。\n'
      + '（例: 部品が届いていない、時間が足りなかった 等）'
    );

    return ContentService.createTextOutput('ok');
  }

  // expense_confirm:EXP-XXXXXXX
  if (data.indexOf('expense_confirm:') === 0) {
    var expenseId = data.replace('expense_confirm:', '');
    answerCallbackQuery(callbackId, '✅ 経費確認済み');
    editMessageText(chatId, messageId, '✅ 経費 ' + expenseId + ' を確認しました。');
    return ContentService.createTextOutput('ok');
  }

  answerCallbackQuery(callbackId, '');
  return ContentService.createTextOutput('ok');
}

// タスクステータス更新
function updateTaskStatus(taskId, newStatus, reason) {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();

  for (var r = 2; r <= lastRow; r++) {
    if (sheet.getRange(r, 1).getValue() === taskId) {
      sheet.getRange(r, 7).setValue(newStatus);  // ステータス
      if (newStatus === '完了') {
        sheet.getRange(r, 8).setValue(formatCambodiaTime(new Date()));  // 完了日時
      }
      if (reason) {
        sheet.getRange(r, 9).setValue(reason);  // 未完了理由
      }
      return true;
    }
  }
  return false;
}

// 未完了理由入力処理
function handlePendingReasonFlow(chatId, message, state) {
  var reason = (message.text || '').trim();
  if (!reason) {
    sendTelegramTo(chatId, 'テキストで理由を入力してください。');
    return;
  }

  var taskId = state.taskId;
  updateTaskStatus(taskId, '未完了', reason);
  clearConversationState(chatId);

  sendTelegramTo(chatId,
    '📝 未完了理由を記録しました。\n'
    + '🆔 ' + taskId + '\n'
    + '💬 ' + reason
  );

  // Adminグループにも通知
  sendTelegramTo(ADMIN_GROUP_ID,
    '⚠️ *タスク未完了報告*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + taskId + '\n'
    + '💬 理由: ' + reason
  );
}

// 朝タスク通知（毎朝カンボジア8:00 AM）
function sendMorningTaskNotification() {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  var today = Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd');

  // スタッフごとにタスクを抽出して通知
  FIELD_STAFF_IDS.forEach(function(staffId) {
    var staffName = STAFF_REGISTRY[staffId].name;

    var myTasks = data.filter(function(row) {
      if (row[6] === '完了') return false;  // 完了済みは除外
      if (row[2] !== staffName) return false;  // 他人のタスクは除外
      // 期限が今日以前、または期限なしのタスク
      var deadline = row[4] ? row[4].toString() : '';
      if (!deadline) return true;
      return deadline <= today;
    });

    if (myTasks.length === 0) return;

    var msg = '🌅 *អរុណសួស្តី! ការងារថ្ងៃនេះ*\n'
      + '（おはようございます！今日のタスク）\n'
      + '━━━━━━━━━━━━━━━━━━\n\n';

    var keyboard = [];

    myTasks.forEach(function(row, idx) {
      var emoji = getTaskStatusEmoji(row[4], row[6]);
      var descJp = row[5];
      var descKh = translateToKhmer(descJp);
      msg += (idx + 1) + '. ' + emoji + ' ' + descKh + '\n'
        + '   🇯🇵 ' + descJp + '\n'
        + '   📅 ថ្ងៃកំណត់: ' + (row[4] || 'គ្មាន') + '\n\n';

      keyboard.push([
        { text: '✅ ' + descKh.substring(0, 15), callback_data: 'task_done:' + row[0] },
        { text: '❌ មិនទាន់រួច', callback_data: 'task_notdone:' + row[0] }
      ]);
    });

    msg += 'សូមចុចប៊ូតុងពេលរួចរាល់ 👇\n（完了したらボタンを押してください）';

    sendTelegramWithKeyboard(staffId, msg, { inline_keyboard: keyboard });
  });

  // 飯泉さん宛のタスクもAdminグループに通知
  var iizumiTasks = data.filter(function(row) {
    if (row[6] === '完了') return false;
    if (row[2] !== '飯泉') return false;
    var deadline = row[4] ? row[4].toString() : '';
    if (!deadline) return true;
    return deadline <= today;
  });

  if (iizumiTasks.length > 0) {
    var adminMsg = '🌅 *飯泉さんの今日のタスク*\n'
      + '━━━━━━━━━━━━━━━━━━\n\n';

    iizumiTasks.forEach(function(row, idx) {
      var emoji = getTaskStatusEmoji(row[4], row[6]);
      adminMsg += (idx + 1) + '. ' + emoji + ' ' + row[5] + '\n'
        + '   📅 期限: ' + (row[4] || 'なし') + '\n\n';
    });

    sendTelegramTo(ADMIN_GROUP_ID, adminMsg);
  }
}

// ═══════════════════════════════════════════
//  経費管理（レシートOCR）
// ═══════════════════════════════════════════

// Expensesシート取得（なければ作成）
function getExpensesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(EXPENSES_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(EXPENSES_SHEET_NAME);
    var headers = [
      'Expense ID', '登録日時', '取引日', '品目・摘要', '金額',
      '通貨', '取引先', '勘定科目', '登録者', 'レシート写真',
      'OCR原文', 'ステータス', '関連タスクID'
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#4CAF50');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);   // Expense ID
    sheet.setColumnWidth(4, 250);   // 品目・摘要
    sheet.setColumnWidth(10, 200);  // レシート写真
    sheet.setColumnWidth(11, 300);  // OCR原文
  }

  return sheet;
}

// レシート処理フロー
function handleReceiptFlow(chatId, message, state, senderName) {
  if (state.step === 'waiting_photo') {
    // 写真が送信されたか確認
    if (!message.photo || message.photo.length === 0) {
      sendTelegramTo(chatId, '📸 写真を送ってください。テキストではなくレシートの写真が必要です。');
      return;
    }

    // 処理中メッセージ
    sendTelegramTo(chatId, '⏳ レシートを処理中...');

    try {
      // Telegramから写真をダウンロード
      var photoArray = message.photo;
      var largestPhoto = photoArray[photoArray.length - 1]; // 最大解像度
      var fileId = largestPhoto.file_id;

      // getFile APIでファイルパス取得
      var fileInfo = getTelegramFile(fileId);
      if (!fileInfo || !fileInfo.result || !fileInfo.result.file_path) {
        sendTelegramTo(chatId, '❌ 写真の取得に失敗しました。もう一度送ってください。');
        clearConversationState(chatId);
        return;
      }

      // 写真をダウンロード
      var fileUrl = 'https://api.telegram.org/file/bot' + TELEGRAM_BOT_TOKEN + '/' + fileInfo.result.file_path;
      var imageBlob = UrlFetchApp.fetch(fileUrl).getBlob();

      // Google Driveに保存
      var receiptFolder = getOrCreateFolder(RECEIPT_FOLDER_NAME);
      var now = new Date();
      var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd_HHmmss');
      var staffName = STAFF_REGISTRY[chatId] ? STAFF_REGISTRY[chatId].name : senderName;
      var fileName = 'receipt_' + dateStr + '_' + staffName + '.jpg';

      imageBlob.setName(fileName);
      var savedFile = receiptFolder.createFile(imageBlob);
      savedFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      var photoUrl = savedFile.getUrl();

      // OCR実行
      var ocrText = performOCR(imageBlob);
      var parsed = parseReceiptText(ocrText);

      // 経費レコード作成
      var expenseId = createExpenseRecord({
        date: parsed.date || Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyy-MM-dd'),
        description: parsed.description || '',
        amount: parsed.amount || 0,
        currency: parsed.currency || 'USD',
        vendor: parsed.vendor || '',
        category: parsed.category || '消耗品費',
        registeredBy: staffName,
        photoUrl: photoUrl,
        ocrText: ocrText
      });

      clearConversationState(chatId);

      // 確認メッセージ
      var confirmMsg = '✅ *経費登録完了*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '🆔 ' + expenseId + '\n'
        + '📅 取引日: ' + (parsed.date || '不明') + '\n'
        + '🏪 取引先: ' + (parsed.vendor || '不明') + '\n'
        + '📝 品目: ' + (parsed.description || '不明') + '\n'
        + '💰 金額: ' + (parsed.amount || '不明') + ' ' + (parsed.currency || 'USD') + '\n'
        + '📂 勘定科目: ' + (parsed.category || '消耗品費') + '\n'
        + '📷 [レシート写真](' + photoUrl + ')\n\n'
        + '※ 内容に間違いがあれば管理者にお知らせください。';

      sendTelegramTo(chatId, confirmMsg);

      // Adminグループにも通知
      sendTelegramTo(ADMIN_GROUP_ID,
        '💰 *新規経費登録*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '🆔 ' + expenseId + '\n'
        + '👤 登録者: ' + staffName + '\n'
        + '📅 ' + (parsed.date || '不明') + '\n'
        + '🏪 ' + (parsed.vendor || '不明') + '\n'
        + '💰 ' + (parsed.amount || '?') + ' ' + (parsed.currency || 'USD') + '\n'
        + '📷 [レシート](' + photoUrl + ')'
      );

    } catch (err) {
      Logger.log('handleReceiptFlow error: ' + err.toString());
      clearConversationState(chatId);
      sendTelegramTo(chatId, '❌ レシート処理中にエラーが発生しました: ' + err.toString());
    }
  }
}

// Telegram getFile API
function getTelegramFile(fileId) {
  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/getFile?file_id=' + fileId;
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    return JSON.parse(response.getContentText());
  } catch (err) {
    Logger.log('getTelegramFile error: ' + err.toString());
    return null;
  }
}

// OCR実行（Google Drive API v2）
function performOCR(imageBlob) {
  try {
    var resource = {
      title: 'ocr_temp_' + Date.now(),
      mimeType: imageBlob.getContentType() || 'image/jpeg'
    };

    // Drive API v2でOCRアップロード
    var file = Drive.Files.insert(resource, imageBlob, {
      ocr: true,
      ocrLanguage: 'en'
    });

    // テキスト抽出
    var doc = DocumentApp.openById(file.id);
    var text = doc.getBody().getText();

    // 一時ファイル削除
    DriveApp.getFileById(file.id).setTrashed(true);

    return text || '';
  } catch (err) {
    Logger.log('performOCR error: ' + err.toString());
    return '';
  }
}

// OCRテキストからレシート情報をパース
function parseReceiptText(ocrText) {
  var result = {
    date: '',
    description: '',
    amount: 0,
    currency: 'USD',
    vendor: '',
    category: '消耗品費'
  };

  if (!ocrText) return result;

  // 日付パターン検索
  var datePatterns = [
    /(\d{4}[-\/]\d{2}[-\/]\d{2})/,           // 2026-04-07 or 2026/04/07
    /(\d{2}[-\/]\d{2}[-\/]\d{4})/,           // 07-04-2026 or 07/04/2026
    /(\d{2}[-\/]\d{2}[-\/]\d{2})\s/          // 07/04/26
  ];

  for (var i = 0; i < datePatterns.length; i++) {
    var dateMatch = ocrText.match(datePatterns[i]);
    if (dateMatch) {
      result.date = dateMatch[1];
      break;
    }
  }

  // 金額パターン検索
  var amountPatterns = [
    /(?:TOTAL|Total|total|AMOUNT|Amount)[:\s]*\$?\s*([\d,]+\.?\d*)/i,
    /\$\s*([\d,]+\.?\d*)/,
    /USD\s*([\d,]+\.?\d*)/i,
    /KHR\s*([\d,]+\.?\d*)/i,
    /([\d,]+\.?\d*)\s*(?:USD|usd)/
  ];

  for (var i = 0; i < amountPatterns.length; i++) {
    var amountMatch = ocrText.match(amountPatterns[i]);
    if (amountMatch) {
      result.amount = parseFloat(amountMatch[1].replace(/,/g, ''));
      // 通貨判定
      if (amountPatterns[i].toString().indexOf('KHR') >= 0) {
        result.currency = 'KHR';
      }
      break;
    }
  }

  // 取引先（最初の行を取得）
  var lines = ocrText.split('\n').filter(function(l) { return l.trim().length > 0; });
  if (lines.length > 0) {
    result.vendor = lines[0].trim().substring(0, 50);
  }

  // 品目・摘要（2行目以降のキーワード）
  if (lines.length > 1) {
    // 商品名らしい行を探す
    var descLines = lines.slice(1, 4).join(' ').substring(0, 100);
    result.description = descLines;
  }

  // 勘定科目の自動判定
  var lowerText = ocrText.toLowerCase();
  if (lowerText.indexOf('electric') >= 0 || lowerText.indexOf('ភ្លើង') >= 0 || lowerText.indexOf('power') >= 0) {
    result.category = '水道光熱費';
  } else if (lowerText.indexOf('water') >= 0 || lowerText.indexOf('ទឹក') >= 0) {
    result.category = '水道光熱費';
  } else if (lowerText.indexOf('phone') >= 0 || lowerText.indexOf('internet') >= 0 || lowerText.indexOf('wifi') >= 0) {
    result.category = '通信費';
  } else if (lowerText.indexOf('fuel') >= 0 || lowerText.indexOf('gas') >= 0 || lowerText.indexOf('petrol') >= 0) {
    result.category = '旅費交通費';
  } else if (lowerText.indexOf('food') >= 0 || lowerText.indexOf('restaurant') >= 0 || lowerText.indexOf('meal') >= 0) {
    result.category = '会議費';
  }

  return result;
}

// 経費レコード作成
function createExpenseRecord(data) {
  var sheet = getExpensesSheet();
  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');

  // Expense ID生成
  var lastRow = sheet.getLastRow();
  var count = 1;
  if (lastRow >= 2) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    ids.forEach(function(row) {
      if (row[0] && row[0].toString().indexOf('EXP-' + dateStr) === 0) {
        count++;
      }
    });
  }
  var expenseId = 'EXP-' + dateStr + '-' + String(count).padStart(3, '0');

  // 精算タスクを作成（飯泉さん宛）
  var taskId = createTask(
    '飯泉',
    ADMIN_GROUP_ID,
    '', // 期限は明示しない
    '精算: ' + (data.vendor || '不明') + ' ' + (data.amount || '?') + ' ' + (data.currency || 'USD') + ' (' + expenseId + ')',
    '',
    expenseId
  );

  // レシート写真をHYPERLINK形式に
  var photoFormula = data.photoUrl
    ? '=HYPERLINK("' + data.photoUrl + '","📷 レシート")'
    : '';

  sheet.appendRow([
    expenseId,
    formatCambodiaTime(now),
    data.date || '',
    data.description || '',
    data.amount || 0,
    data.currency || 'USD',
    data.vendor || '',
    data.category || '消耗品費',
    data.registeredBy || '',
    '',  // レシート写真（HYPERLINK式で後書き）
    data.ocrText || '',
    '未精算',
    taskId
  ]);

  // HYPERLINK式をセルに書き込み
  if (data.photoUrl) {
    var newRow = sheet.getLastRow();
    sheet.getRange(newRow, 10).setFormula(
      '=HYPERLINK("' + data.photoUrl + '","📷 レシート")'
    );
  }

  return expenseId;
}

// ═══════════════════════════════════════════
//  Telegram送信ヘルパー
// ═══════════════════════════════════════════

// 特定チャットにメッセージ送信
function sendTelegramTo(chatId, message) {
  if (!TELEGRAM_BOT_TOKEN) return;

  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
  var payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  };

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('sendTelegramTo error: ' + err.toString());
  }
}

// インラインキーボード付きメッセージ送信
function sendTelegramWithKeyboard(chatId, text, replyMarkup) {
  if (!TELEGRAM_BOT_TOKEN) return;

  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
  var payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  };

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('sendTelegramWithKeyboard error: ' + err.toString());
  }
}

// callback_query応答
function answerCallbackQuery(callbackQueryId, text) {
  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/answerCallbackQuery';
  var payload = {
    callback_query_id: callbackQueryId,
    text: text || ''
  };

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('answerCallbackQuery error: ' + err.toString());
  }
}

// メッセージテキスト更新（ボタン削除用）
function editMessageText(chatId, messageId, newText) {
  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/editMessageText';
  var payload = {
    chat_id: chatId,
    message_id: messageId,
    text: newText,
    parse_mode: 'Markdown'
  };

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('editMessageText error: ' + err.toString());
  }
}

// メッセージ転送
function forwardMessage(toChatId, fromChatId, messageId) {
  if (!TELEGRAM_BOT_TOKEN) return;

  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/forwardMessage';
  var payload = {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId
  };

  try {
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log('forwardMessage error: ' + err.toString());
  }
}

// 全チャットIDに一括送信
function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_IDS || TELEGRAM_CHAT_IDS.length === 0) {
    Logger.log('Telegram未設定。');
    return;
  }

  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';

  TELEGRAM_CHAT_IDS.forEach(function(chatId) {
    var payload = {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    };

    try {
      var response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
      var result = JSON.parse(response.getContentText());
      if (!result.ok) {
        Logger.log('Telegram error (chat ' + chatId + '): ' + response.getContentText());
      }
    } catch (err) {
      Logger.log('Telegram fetch error (chat ' + chatId + '): ' + err.toString());
    }
  });
}

// Drive写真をTelegramに送信
function sendPhotoGroupToTelegram(links, caption) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_IDS || TELEGRAM_CHAT_IDS.length === 0) return false;

  var validLinks = links.filter(function(l) { return l && l.length > 0; });
  if (validLinks.length === 0) return false;

  var fileIds = validLinks.map(function(link) {
    var match = link.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    match = link.match(/id=([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    return null;
  }).filter(function(id) { return id !== null; });

  if (fileIds.length === 0) return false;

  var photoBlobs = [];
  if (fileIds.length === 1) {
    try {
      photoBlobs.push(DriveApp.getFileById(fileIds[0]).getBlob());
    } catch (err) {
      Logger.log('sendPhoto getBlob error: ' + err.toString());
      return false;
    }
  } else {
    try {
      for (var i = 0; i < fileIds.length; i++) {
        photoBlobs.push(DriveApp.getFileById(fileIds[i]).getBlob().setName('photo_' + i + '.jpg'));
      }
    } catch (err) {
      Logger.log('sendMediaGroup getBlob error: ' + err.toString());
      return false;
    }
  }

  TELEGRAM_CHAT_IDS.forEach(function(chatId) {
    try {
      if (fileIds.length === 1) {
        var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendPhoto';
        UrlFetchApp.fetch(url, {
          method: 'post',
          payload: { 'chat_id': chatId, 'caption': caption, 'photo': photoBlobs[0] },
          muteHttpExceptions: true
        });
      } else {
        var media = [];
        var formData = { 'chat_id': chatId };
        for (var i = 0; i < photoBlobs.length; i++) {
          var mediaItem = { type: 'photo', media: 'attach://photo_' + i };
          if (i === 0) mediaItem.caption = caption;
          media.push(mediaItem);
          formData['photo_' + i] = photoBlobs[i];
        }
        formData['media'] = JSON.stringify(media);
        var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMediaGroup';
        UrlFetchApp.fetch(url, {
          method: 'post',
          payload: formData,
          muteHttpExceptions: true
        });
      }
    } catch (err) {
      Logger.log('sendPhoto/MediaGroup error (chat ' + chatId + '): ' + err.toString());
    }
  });
  return true;
}

// ═══════════════════════════════════════════
//  GETリクエスト
// ═══════════════════════════════════════════

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'status';

  if (action === 'inventory') {
    return handleInventoryGet();
  }

  if (action === 'tasks') {
    return handleTasksGet();
  }

  if (action === 'expenses') {
    return handleExpensesGet();
  }

  if (action === 'daily_reports') {
    return handleDailyReportsGet(e);
  }

  if (action === 'attendance') {
    return handleAttendanceGet(e);
  }

  return ContentService
    .createTextOutput('Samurai Motors Job Manager v5 is active.')
    .setMimeType(ContentService.MimeType.TEXT);
}

// タスク一覧API（ミニアプリ用）
function handleTasksGet() {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse({ status: 'ok', tasks: [] });
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 12).getValues();
  var tasks = data.map(function(row) {
    return {
      id: row[0],
      created: row[1],
      assignee: row[2],
      assigneeChatId: row[3],
      deadline: row[4] ? row[4].toString().substring(0, 10) : '',
      description: row[5],
      status: row[6],
      completedAt: row[7],
      reason: row[8],
      recurrence: row[9],
      parentId: row[10],
      expenseId: row[11]
    };
  });

  return jsonResponse({ status: 'ok', tasks: tasks });
}

// ミニアプリからのタスク作成
function handleTaskCreateFromApp(data) {
  var taskId = createTask(
    data.assignee || '',
    data.assigneeChatId || '',
    data.deadline || '',
    data.description || '',
    data.recurrence || '',
    ''
  );

  // 担当者に通知（クメール語+日本語）
  if (data.assigneeChatId && data.assigneeChatId !== ADMIN_GROUP_ID) {
    var descKh = translateToKhmer(data.description || '');
    sendTelegramTo(data.assigneeChatId,
      '📌 *ការងារថ្មីត្រូវបានបន្ថែម*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '📅 ថ្ងៃកំណត់: ' + (data.deadline || 'គ្មាន') + '\n'
      + '📋 ' + descKh + '\n'
      + '🇯🇵 ' + (data.description || '')
    );
  }

  // Adminグループにも通知
  var emoji = getTaskStatusEmoji(data.deadline || '', '未着手');
  sendTelegramTo(ADMIN_GROUP_ID,
    '📝 *タスク作成（ミニアプリ）*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + taskId + '\n'
    + '👤 担当: ' + (data.assignee || '') + '\n'
    + '📅 期限: ' + (data.deadline || 'なし') + '\n'
    + emoji + ' ' + (data.description || '')
  );

  return jsonResponse({ status: 'ok', taskId: taskId });
}

// ミニアプリからのタスク更新
function handleTaskUpdateFromApp(data) {
  var taskId = data.taskId;
  var newStatus = data.status;
  var reason = data.reason || '';

  var success = updateTaskStatus(taskId, newStatus, reason);

  if (!success) {
    return jsonResponse({ status: 'error', message: 'Task not found: ' + taskId });
  }

  // Adminグループに通知
  if (newStatus === '完了') {
    sendTelegramTo(ADMIN_GROUP_ID,
      '✅ *タスク完了通知*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🆔 ' + taskId + '\n'
      + '⏰ ' + formatCambodiaTime(new Date())
    );
  } else if (newStatus === '未完了' && reason) {
    sendTelegramTo(ADMIN_GROUP_ID,
      '⚠️ *タスク未完了報告*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '🆔 ' + taskId + '\n'
      + '💬 理由: ' + reason
    );
  }

  return jsonResponse({ status: 'ok', taskId: taskId, newStatus: newStatus });
}

// ミニアプリからのタスク編集
function handleTaskEditFromApp(data) {
  var taskId = data.taskId;
  if (!taskId) {
    return jsonResponse({ status: 'error', message: 'taskId is required' });
  }

  var updates = {};
  if (data.assignee !== undefined) updates.assignee = data.assignee;
  if (data.assigneeChatId !== undefined) updates.assigneeChatId = data.assigneeChatId;
  if (data.deadline !== undefined) updates.deadline = data.deadline;
  if (data.description !== undefined) updates.description = data.description;

  var success = editTaskDetails(taskId, updates);
  if (!success) {
    return jsonResponse({ status: 'error', message: 'Task not found: ' + taskId });
  }

  // Adminグループに編集通知
  var parts = ['✏️ *タスク編集*\n━━━━━━━━━━━━━━━\n🆔 ' + taskId];
  if (updates.assignee) parts.push('👤 担当: ' + updates.assignee);
  if (updates.deadline !== undefined) parts.push('📅 期限: ' + (updates.deadline || 'なし'));
  if (updates.description) parts.push('📋 ' + updates.description);
  sendTelegramTo(ADMIN_GROUP_ID, parts.join('\n'));

  // 担当者が変わった場合や内容が変わった場合、担当者にも通知
  var chatId = data.assigneeChatId || '';
  if (chatId && chatId !== ADMIN_GROUP_ID) {
    var descKh = translateToKhmer(updates.description || data.currentDescription || '');
    sendTelegramTo(chatId,
      '✏️ *ការងារត្រូវបានកែប្រែ*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '📅 ថ្ងៃកំណត់: ' + (updates.deadline !== undefined ? (updates.deadline || 'គ្មាន') : '') + '\n'
      + '📋 ' + descKh + '\n'
      + '🇯🇵 ' + (updates.description || data.currentDescription || '')
    );
  }

  return jsonResponse({ status: 'ok', taskId: taskId });
}

// タスク詳細を更新する汎用関数
function editTaskDetails(taskId, updates) {
  var sheet = getTasksSheet();
  var lastRow = sheet.getLastRow();

  for (var r = 2; r <= lastRow; r++) {
    if (sheet.getRange(r, 1).getValue() === taskId) {
      // C列=担当者, D列=担当者ChatID, E列=期限, F列=やるべきこと
      if (updates.assignee !== undefined) sheet.getRange(r, 3).setValue(updates.assignee);
      if (updates.assigneeChatId !== undefined) sheet.getRange(r, 4).setValue(updates.assigneeChatId);
      if (updates.deadline !== undefined) sheet.getRange(r, 5).setValue(updates.deadline);
      if (updates.description !== undefined) sheet.getRange(r, 6).setValue(updates.description);
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════
//  勤怠管理
// ═══════════════════════════════════════════

// Attendanceシート取得（なければ作成）
function getAttendanceSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ATTENDANCE_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(ATTENDANCE_SHEET_NAME);
    var headers = [
      'Record ID', '日付', 'スタッフ名', 'ChatID',
      '出勤時刻', '退勤時刻', '勤務時間（分）', 'メモ'
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#00695C');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(5, 140);
    sheet.setColumnWidth(6, 140);
  }

  return sheet;
}

// ミニアプリからの勤怠打刻
function handleAttendanceFromApp(data) {
  var sheet = getAttendanceSheet();
  var now = new Date();
  var todayStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyy-MM-dd');
  var timeStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'HH:mm:ss');
  var staff = data.staff || '';
  var chatId = data.chatId || '';
  var type = data.type || ''; // 'clock_in' or 'clock_out'
  var memo = data.memo || '';

  if (!staff || !type) {
    return jsonResponse({ status: 'error', message: 'staff and type are required' });
  }

  var lastRow = sheet.getLastRow();

  if (type === 'clock_in') {
    // 既に今日出勤済みか確認
    var existing = findTodayAttendance(sheet, todayStr, staff, lastRow);
    if (existing > 0) {
      return jsonResponse({ status: 'error', message: '本日すでに出勤打刻済みです' });
    }

    var recordId = 'ATT-' + Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd-HHmmss');
    sheet.appendRow([recordId, todayStr, staff, chatId, timeStr, '', '', memo]);

    // Admin通知
    sendTelegramTo(ADMIN_GROUP_ID,
      '🟢 *出勤打刻*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '👤 ' + staff + '\n'
      + '⏰ ' + timeStr + '\n'
      + '📅 ' + todayStr
    );

    return jsonResponse({ status: 'ok', type: 'clock_in', time: timeStr, recordId: recordId });

  } else if (type === 'clock_out') {
    // 今日の出勤レコードを探す
    var row = findTodayAttendance(sheet, todayStr, staff, lastRow);
    if (row <= 0) {
      return jsonResponse({ status: 'error', message: '本日の出勤記録がありません' });
    }

    // 既に退勤済みか確認
    var existingOut = sheet.getRange(row, 6).getValue();
    if (existingOut) {
      return jsonResponse({ status: 'error', message: '本日すでに退勤打刻済みです' });
    }

    sheet.getRange(row, 6).setValue(timeStr);
    if (memo) sheet.getRange(row, 8).setValue(memo);

    // 勤務時間を計算
    var clockInStr = sheet.getRange(row, 5).getValue().toString();
    var inParts = clockInStr.split(':');
    var outParts = timeStr.split(':');
    var inMin = parseInt(inParts[0]) * 60 + parseInt(inParts[1]);
    var outMin = parseInt(outParts[0]) * 60 + parseInt(outParts[1]);
    var workMin = outMin - inMin;
    if (workMin < 0) workMin += 1440; // 日跨ぎ対応
    sheet.getRange(row, 7).setValue(workMin);

    var hours = Math.floor(workMin / 60);
    var mins = workMin % 60;

    // Admin通知
    sendTelegramTo(ADMIN_GROUP_ID,
      '🔴 *退勤打刻*\n'
      + '━━━━━━━━━━━━━━━\n'
      + '👤 ' + staff + '\n'
      + '⏰ ' + timeStr + '\n'
      + '📅 ' + todayStr + '\n'
      + '⏱ 勤務時間: ' + hours + '時間' + mins + '分'
    );

    return jsonResponse({ status: 'ok', type: 'clock_out', time: timeStr, workMinutes: workMin });
  }

  return jsonResponse({ status: 'error', message: 'Invalid type: ' + type });
}

// 今日の出勤レコード行を探す
function findTodayAttendance(sheet, todayStr, staff, lastRow) {
  for (var r = 2; r <= lastRow; r++) {
    var date = sheet.getRange(r, 2).getValue().toString();
    var name = sheet.getRange(r, 3).getValue().toString();
    if (date === todayStr && name === staff) {
      return r;
    }
  }
  return -1;
}

// 勤怠一覧API（ミニアプリ用）
function handleAttendanceGet(e) {
  var sheet = getAttendanceSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse({ status: 'ok', records: [] });
  }

  var filterStaff = (e && e.parameter && e.parameter.staff) ? e.parameter.staff : '';
  var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var records = [];

  data.forEach(function(row) {
    if (filterStaff && row[2] !== filterStaff) return;
    records.push({
      id: row[0],
      date: row[1],
      staff: row[2],
      chatId: row[3],
      clockIn: row[4],
      clockOut: row[5],
      workMinutes: row[6],
      memo: row[7]
    });
  });

  return jsonResponse({ status: 'ok', records: records });
}

// 本日の勤怠サマリー取得（日次サマリー用）
function getTodayAttendance(today) {
  var result = [];
  try {
    var sheet = getAttendanceSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return result;

    var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    data.forEach(function(row) {
      if (row[1].toString() === today) {
        result.push({
          staff: row[2],
          clockIn: row[4],
          clockOut: row[5],
          workMinutes: row[6]
        });
      }
    });
  } catch (e) {
    Logger.log('getTodayAttendance error: ' + e.toString());
  }
  return result;
}

// ═══════════════════════════════════════════
//  日報管理
// ═══════════════════════════════════════════

// DailyReportsシート取得（なければ作成）
function getDailyReportsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(DAILY_REPORTS_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(DAILY_REPORTS_SHEET_NAME);
    var headers = [
      'Report ID', '登録日時', '報告日', '報告者', '報告者ChatID',
      '洗車以外の業務', '特記事項・連絡', 'ステータス'
    ];
    sheet.appendRow(headers);
    var hdr = sheet.getRange(1, 1, 1, headers.length);
    hdr.setFontWeight('bold');
    hdr.setBackground('#7B1FA2');
    hdr.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(6, 350);
    sheet.setColumnWidth(7, 250);
  }

  return sheet;
}

// ミニアプリからの日報登録
function handleDailyReportFromApp(data) {
  var sheet = getDailyReportsSheet();
  var now = new Date();
  var reportId = 'RPT-' + Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd-HHmmss');
  var timestamp = formatCambodiaTime(now);

  var reportDate = data.reportDate || Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyy-MM-dd');
  var reporter = data.reporter || '';
  var reporterChatId = data.reporterChatId || '';
  var otherWork = data.otherWork || '';
  var notes = data.notes || '';

  sheet.appendRow([
    reportId, timestamp, reportDate, reporter, reporterChatId,
    otherWork, notes, '提出済'
  ]);

  // Adminグループに通知
  var msg = '📝 *日報提出*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '👤 報告者: ' + reporter + '\n'
    + '📅 日付: ' + reportDate + '\n';

  if (otherWork) {
    msg += '🔧 洗車以外の業務:\n' + otherWork + '\n';
  }
  if (notes) {
    msg += '📌 特記事項:\n' + notes + '\n';
  }

  sendTelegramTo(ADMIN_GROUP_ID, msg);

  return jsonResponse({ status: 'ok', reportId: reportId });
}

// 日報一覧API（ミニアプリ用）
function handleDailyReportsGet(e) {
  var sheet = getDailyReportsSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse({ status: 'ok', reports: [] });
  }

  // 日付フィルター（オプション）
  var filterDate = (e && e.parameter && e.parameter.date) ? e.parameter.date : '';
  var filterReporter = (e && e.parameter && e.parameter.reporter) ? e.parameter.reporter : '';

  var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
  var reports = [];

  data.forEach(function(row) {
    var report = {
      id: row[0],
      timestamp: row[1],
      reportDate: row[2] ? row[2].toString().substring(0, 10) : '',
      reporter: row[3],
      reporterChatId: row[4],
      otherWork: row[5],
      notes: row[6],
      status: row[7]
    };

    // フィルター適用
    if (filterDate && report.reportDate !== filterDate) return;
    if (filterReporter && report.reporter !== filterReporter) return;

    reports.push(report);
  });

  return jsonResponse({ status: 'ok', reports: reports });
}

// 本日の日報サマリー取得（日次サマリー用）
function getTodayDailyReports(today) {
  var result = [];
  try {
    var sheet = getDailyReportsSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return result;

    var data = sheet.getRange(2, 1, lastRow - 1, 8).getValues();
    data.forEach(function(row) {
      var reportDate = row[2] ? row[2].toString().substring(0, 10) : '';
      if (reportDate === today) {
        result.push({
          reporter: row[3],
          otherWork: row[5],
          notes: row[6]
        });
      }
    });
  } catch (e) {
    Logger.log('getTodayDailyReports error: ' + e.toString());
  }
  return result;
}

// ミニアプリからの経費登録
function handleExpenseCreateFromApp(data) {
  var photoUrl = '';

  // レシート写真をDriveに保存
  if (data.receiptPhoto) {
    try {
      var receiptFolder = getOrCreateFolder(RECEIPT_FOLDER_NAME);
      var now = new Date();
      var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd_HHmmss');
      var fileName = 'receipt_' + dateStr + '_' + (data.registeredBy || 'unknown') + '.jpg';
      var link = saveBase64Image(receiptFolder, data.receiptPhoto, fileName.replace('.jpg', ''));
      photoUrl = link;
    } catch (photoErr) {
      Logger.log('handleExpenseCreateFromApp photo error: ' + photoErr.toString());
    }
  }

  var expenseId = createExpenseRecord({
    date: data.date || '',
    description: data.description || '',
    amount: data.amount || 0,
    currency: data.currency || 'USD',
    vendor: data.vendor || '',
    category: data.category || '消耗品費',
    registeredBy: data.registeredBy || '',
    photoUrl: photoUrl,
    ocrText: ''
  });

  // Adminグループに通知
  sendTelegramTo(ADMIN_GROUP_ID,
    '💰 *新規経費登録（ミニアプリ）*\n'
    + '━━━━━━━━━━━━━━━\n'
    + '🆔 ' + expenseId + '\n'
    + '👤 登録者: ' + (data.registeredBy || '-') + '\n'
    + '📅 ' + (data.date || '-') + '\n'
    + '🏪 ' + (data.vendor || '-') + '\n'
    + '📝 ' + (data.description || '-') + '\n'
    + '💰 ' + (data.amount || '?') + ' ' + (data.currency || 'USD')
    + (photoUrl ? '\n📷 [レシート](' + photoUrl + ')' : '')
  );

  return jsonResponse({ status: 'ok', expenseId: expenseId });
}

// 経費一覧API（ミニアプリ用）
function handleExpensesGet() {
  var sheet = getExpensesSheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse({ status: 'ok', expenses: [] });
  }

  var data = sheet.getRange(2, 1, lastRow - 1, 13).getValues();
  var expenses = data.map(function(row) {
    return {
      id: row[0],
      created: row[1],
      date: row[2] ? row[2].toString().substring(0, 10) : '',
      description: row[3],
      amount: row[4],
      currency: row[5],
      vendor: row[6],
      category: row[7],
      registeredBy: row[8],
      photoUrl: row[9],
      status: row[11],
      taskId: row[12]
    };
  });

  return jsonResponse({ status: 'ok', expenses: expenses });
}

// ═══════════════════════════════════════════
//  ヘッダー修正
// ═══════════════════════════════════════════

function fixHeaders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];

  var headerRange = sheet.getRange(1, 1, 1, CORRECT_HEADERS.length);
  headerRange.setValues([CORRECT_HEADERS]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#c8102e');
  headerRange.setFontColor('#ffffff');
  sheet.setFrozenRows(1);

  sheet.setColumnWidth(1, 140);
  for (var c = 2; c <= 14; c++) sheet.setColumnWidth(c, 160);
  sheet.setColumnWidth(15, 100);
  for (var c = 16; c <= 23; c++) sheet.setColumnWidth(c, 200);

  Logger.log('ヘッダーを23列に修正しました。');
}

// ═══════════════════════════════════════════
//  ジョブ管理（v4から継承）
// ═══════════════════════════════════════════

function handleJobSubmit(data) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];

  if (sheet.getLastRow() === 0) {
    var headerRange = sheet.getRange(1, 1, 1, CORRECT_HEADERS.length);
    headerRange.setValues([CORRECT_HEADERS]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#c8102e');
    headerRange.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 140);
    for (var c = 2; c <= 14; c++) sheet.setColumnWidth(c, 160);
    sheet.setColumnWidth(15, 100);
    for (var c = 16; c <= 23; c++) sheet.setColumnWidth(c, 200);
  }

  var now = new Date();
  var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');
  var jobId = 'SM-' + dateStr + '-' + String(sheet.getLastRow()).padStart(3, '0');

  var registered = data.registered ? formatCambodiaTime(new Date(data.registered)) : formatCambodiaTime(now);
  var startTime = data.startTime ? formatCambodiaTime(new Date(data.startTime)) : '';
  var endTime = data.endTime ? formatCambodiaTime(new Date(data.endTime)) : '';

  var duration = data.duration || 0;
  if (!duration && data.startTime && data.endTime) {
    var startMs = new Date(data.startTime).getTime();
    var endMs = new Date(data.endTime).getTime();
    duration = Math.round((endMs - startMs) / 60000);
  }

  var beforeLinks = ['','','',''];
  var afterLinks = ['','','',''];
  var hasNewPhotos = (data.beforePhotos && data.beforePhotos.length > 0) ||
                     (data.afterPhotos && data.afterPhotos.length > 0);

  try {
    if (hasNewPhotos) {
      var parentFolder = getOrCreateFolder(PHOTO_FOLDER_NAME);
      var jobFolder = parentFolder.createFolder(jobId + '_' + (data.name || 'unknown'));
      jobFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

      if (data.beforePhotos) {
        for (var i = 0; i < data.beforePhotos.length && i < 4; i++) {
          if (data.beforePhotos[i]) {
            var link = saveBase64Image(jobFolder, data.beforePhotos[i], 'before_' + (i+1));
            beforeLinks[i] = link;
          }
        }
      }

      if (data.afterPhotos) {
        for (var i = 0; i < data.afterPhotos.length && i < 4; i++) {
          if (data.afterPhotos[i]) {
            var link = saveBase64Image(jobFolder, data.afterPhotos[i], 'after_' + (i+1));
            afterLinks[i] = link;
          }
        }
      }
    } else {
      var existingLinks = findExistingPhotoLinks(dateStr, data.name || 'unknown');
      if (existingLinks) {
        beforeLinks = existingLinks.before;
        afterLinks = existingLinks.after;
      }
    }
  } catch (photoErr) {
    Logger.log('Photo save error: ' + photoErr.toString());
  }

  var newRow = sheet.getLastRow() + 1;
  sheet.appendRow([
    jobId, registered,
    data.name || '', data.phone || '',
    data.building || '', data.room || '',
    data.carModel || '', data.plate || '',
    data.plan || '', data.mapUrl || '',
    data.notes || '', data.scheduled || '',
    startTime, endTime, duration,
    '', '', '', '',
    '', '', '', ''
  ]);

  setPhotoHyperlinks(sheet, newRow, beforeLinks, afterLinks);

  try {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS && TELEGRAM_CHAT_IDS.length > 0) {
      var msg = '📋 *記録保存完了（កំណត់ត្រាបានរក្សាទុក）*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '🆔 ' + jobId + '\n'
        + '👤 ' + (data.name || '-') + '\n'
        + '🏢 ' + (data.building || '-') + ' ' + (data.room || '') + '\n'
        + '🚘 ' + (data.carModel || '-') + ' | ' + (data.plate || '-') + '\n'
        + '📦 ' + (data.plan || '-') + '\n'
        + '⏱ ' + duration + ' 分（នាទី）\n';

      sendTelegram(msg);
    }
  } catch (tgErr) {
    Logger.log('Telegram notify error: ' + tgErr.toString());
  }

  return jsonResponse({ status: 'ok', jobId: jobId });
}

// ═══════════════════════════════════════════
//  作業開始・完了ハンドラー（v4から継承）
// ═══════════════════════════════════════════

function handleJobStart(data) {
  var beforeLinks = [];
  var folderUrl = '';

  try {
    var parentFolder = getOrCreateFolder(PHOTO_FOLDER_NAME);
    var now = new Date();
    var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');
    var folderName = dateStr + '_' + (data.name || 'unknown');

    var jobFolder = parentFolder.createFolder(folderName);
    jobFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    folderUrl = jobFolder.getUrl();

    if (data.beforePhotos && data.beforePhotos.length > 0) {
      for (var i = 0; i < data.beforePhotos.length; i++) {
        if (data.beforePhotos[i]) {
          var link = saveBase64Image(jobFolder, data.beforePhotos[i], 'before_' + (i + 1));
          beforeLinks.push(link);
        }
      }
    }
  } catch (photoErr) {
    Logger.log('handleJobStart photo save error: ' + photoErr.toString());
  }

  try {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS && TELEGRAM_CHAT_IDS.length > 0) {
      var startFormatted = data.startTime ? formatCambodiaTime(new Date(data.startTime)) : formatCambodiaTime(new Date());

      var msg = '🚗 *作業スタート（ការងារចាប់ផ្តើម）*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '👤 ' + (data.name || '-') + '\n'
        + '🏢 ' + (data.building || '-') + ' ' + (data.room || '') + '\n'
        + '🚘 ' + (data.carModel || '-') + ' | ' + (data.plate || '-') + '\n'
        + '📦 ' + (data.plan || '-') + '\n'
        + '▶ 開始（ចាប់ផ្តើម）: ' + startFormatted + '\n';

      sendTelegram(msg);

      if (beforeLinks.length > 0) {
        sendPhotoGroupToTelegram(beforeLinks, '📸 ビフォー写真（រូបថតមុន）');
      }
    }
  } catch (tgErr) {
    Logger.log('handleJobStart Telegram error: ' + tgErr.toString());
  }

  return jsonResponse({ status: 'ok', photoLinks: beforeLinks, folderUrl: folderUrl });
}

function handleJobEnd(data) {
  var afterLinks = [];

  try {
    var parentFolder = getOrCreateFolder(PHOTO_FOLDER_NAME);
    var now = new Date();
    var dateStr = Utilities.formatDate(now, 'Asia/Phnom_Penh', 'yyyyMMdd');
    var folderName = dateStr + '_' + (data.name || 'unknown');

    var jobFolder = null;
    var folders = parentFolder.getFoldersByName(folderName);
    if (folders.hasNext()) {
      jobFolder = folders.next();
    } else {
      jobFolder = parentFolder.createFolder(folderName);
      jobFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }

    if (data.afterPhotos && data.afterPhotos.length > 0) {
      for (var i = 0; i < data.afterPhotos.length; i++) {
        if (data.afterPhotos[i]) {
          var link = saveBase64Image(jobFolder, data.afterPhotos[i], 'after_' + (i + 1));
          afterLinks.push(link);
        }
      }
    }
  } catch (photoErr) {
    Logger.log('handleJobEnd photo save error: ' + photoErr.toString());
  }

  try {
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS && TELEGRAM_CHAT_IDS.length > 0) {
      var endFormatted = data.endTime ? formatCambodiaTime(new Date(data.endTime)) : formatCambodiaTime(new Date());
      var durationMin = data.duration || 0;

      var msg = '✅ *作業完了（ការងារបានបញ្ចប់）*\n'
        + '━━━━━━━━━━━━━━━\n'
        + '👤 ' + (data.name || '-') + '\n'
        + '🏢 ' + (data.building || '-') + ' ' + (data.room || '') + '\n'
        + '🚘 ' + (data.carModel || '-') + ' | ' + (data.plate || '-') + '\n'
        + '📦 ' + (data.plan || '-') + '\n'
        + '⏹ 終了（បញ្ចប់）: ' + endFormatted + '\n'
        + '⏱ 所要時間（រយៈពេល）: ' + durationMin + ' 分\n';

      sendTelegram(msg);

      if (afterLinks.length > 0) {
        sendPhotoGroupToTelegram(afterLinks, '✨ アフター写真（រូបថតក្រោយ）');
      }
    }
  } catch (tgErr) {
    Logger.log('handleJobEnd Telegram error: ' + tgErr.toString());
  }

  return jsonResponse({ status: 'ok', photoLinks: afterLinks });
}

// ═══════════════════════════════════════════
//  写真関連ヘルパー（v4から継承）
// ═══════════════════════════════════════════

function findExistingPhotoLinks(dateStr, name) {
  try {
    var parentFolders = DriveApp.getFoldersByName(PHOTO_FOLDER_NAME);
    if (!parentFolders.hasNext()) return null;
    var parentFolder = parentFolders.next();

    var folderName = dateStr + '_' + name;
    var folders = parentFolder.getFoldersByName(folderName);
    if (!folders.hasNext()) return null;

    var jobFolder = folders.next();
    var files = jobFolder.getFiles();

    var beforeLinks = ['', '', '', ''];
    var afterLinks = ['', '', '', ''];

    while (files.hasNext()) {
      var file = files.next();
      var fileName = file.getName();
      var url = file.getUrl();

      if (fileName.indexOf('before_') === 0) {
        var numMatch = fileName.match(/before_(\d+)/);
        if (numMatch) {
          var idx = parseInt(numMatch[1], 10) - 1;
          if (idx >= 0 && idx < 4) beforeLinks[idx] = url;
        }
      } else if (fileName.indexOf('after_') === 0) {
        var numMatch = fileName.match(/after_(\d+)/);
        if (numMatch) {
          var idx = parseInt(numMatch[1], 10) - 1;
          if (idx >= 0 && idx < 4) afterLinks[idx] = url;
        }
      }
    }

    var hasAny = beforeLinks.some(function(l) { return l !== ''; }) ||
                 afterLinks.some(function(l) { return l !== ''; });

    if (hasAny) {
      return { before: beforeLinks, after: afterLinks };
    }
    return null;
  } catch (e) {
    Logger.log('findExistingPhotoLinks error: ' + e.toString());
    return null;
  }
}

function setPhotoHyperlinks(sheet, row, beforeLinks, afterLinks) {
  for (var i = 0; i < 4; i++) {
    if (beforeLinks[i]) {
      var cell = sheet.getRange(row, 16 + i);
      cell.setFormula('=HYPERLINK("' + beforeLinks[i] + '","📷 Before ' + (i+1) + '")');
    }
  }
  for (var i = 0; i < 4; i++) {
    if (afterLinks[i]) {
      var cell = sheet.getRange(row, 20 + i);
      cell.setFormula('=HYPERLINK("' + afterLinks[i] + '","📷 After ' + (i+1) + '")');
    }
  }
}

// ═══════════════════════════════════════════
//  日次サマリー（v5: 時間変更、在庫削除、経費追加）
// ═══════════════════════════════════════════

function sendDailySummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheets()[0];
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    Logger.log('データがありません');
    return;
  }

  var today = Utilities.formatDate(new Date(), 'Asia/Phnom_Penh', 'yyyy-MM-dd');

  var data = sheet.getRange(2, 1, lastRow - 1, 23).getValues();

  var todayJobs = [];
  var totalDuration = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var regDate = row[1].toString();
    if (regDate.indexOf(today) === 0) {
      var duration = parseInt(row[14]) || 0;
      totalDuration += duration;
      todayJobs.push({
        jobId: row[0],
        name: row[2],
        building: row[4],
        room: row[5],
        carModel: row[6],
        plate: row[7],
        plan: row[8],
        start: row[12],
        end: row[13],
        duration: duration
      });
    }
  }

  // DailySummaryシートに書き込み
  var summarySheet = ss.getSheetByName('DailySummary');
  if (!summarySheet) {
    summarySheet = ss.insertSheet('DailySummary');
    summarySheet.appendRow([
      '日付', '総ジョブ数', '総所要時間（分）', '平均所要時間（分）',
      '使用プラン内訳'
    ]);
    var hdr = summarySheet.getRange(1, 1, 1, 5);
    hdr.setFontWeight('bold');
    hdr.setBackground('#1a5276');
    hdr.setFontColor('#ffffff');
    summarySheet.setFrozenRows(1);
  }

  // プラン別集計
  var planCount = {};
  todayJobs.forEach(function(job) {
    var plan = job.plan || 'その他';
    planCount[plan] = (planCount[plan] || 0) + 1;
  });
  var planSummary = Object.keys(planCount).map(function(k) {
    return k + ': ' + planCount[k] + '件';
  }).join(' / ');

  var avgDuration = todayJobs.length > 0 ? Math.round(totalDuration / todayJobs.length) : 0;

  // 既存の同日行を探す
  var summaryLastRow = summarySheet.getLastRow();
  var existingRow = -1;
  for (var r = 2; r <= summaryLastRow; r++) {
    if (summarySheet.getRange(r, 1).getValue().toString() === today) {
      existingRow = r;
      break;
    }
  }

  var summaryData = [today, todayJobs.length, totalDuration, avgDuration, planSummary];
  if (existingRow > 0) {
    summarySheet.getRange(existingRow, 1, 1, 5).setValues([summaryData]);
  } else {
    summarySheet.appendRow(summaryData);
  }

  // 経費サマリー取得
  var expenseSummary = getTodayExpenseSummary(today);

  // Telegram送信
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS && TELEGRAM_CHAT_IDS.length > 0) {
    var sheetUrl = ss.getUrl();

    var msg = '📊 *' + today + ' 日次サマリー（សង្ខេបប្រចាំថ្ងៃ）*\n'
      + '━━━━━━━━━━━━━━━━━━\n\n'
      + '🚗 総ジョブ数（ការងារសរុប）: *' + todayJobs.length + '件*\n'
      + '⏱ 総所要時間（ពេលវេលាសរុប）: *' + totalDuration + '分*\n'
      + '📐 平均所要時間（មធ្យមក្នុងមួយគ្រឿង）: *' + avgDuration + '分/台*\n\n';

    if (todayJobs.length > 0) {
      msg += '📋 *ジョブ詳細（ព័ត៌មានលម្អិត）*\n';
      todayJobs.forEach(function(job, idx) {
        msg += (idx + 1) + '. ' + (job.name || '-')
          + ' | ' + (job.building || '') + ' ' + (job.room || '')
          + ' | ' + (job.carModel || '-')
          + ' | ' + job.duration + '分'
          + ' | ' + (job.plan || '-') + '\n';
      });
      msg += '\n';
    }

    msg += '📦 *プラン内訳（ការបែងចែកគម្រោង）*\n' + (planSummary || 'なし') + '\n\n';

    // 勤怠セクション
    var attendance = getTodayAttendance(today);
    if (attendance.length > 0) {
      msg += '🕐 *勤怠*\n';
      attendance.forEach(function(a) {
        var hours = Math.floor((a.workMinutes || 0) / 60);
        var mins = (a.workMinutes || 0) % 60;
        var workStr = a.clockOut ? hours + 'h' + mins + 'm' : '勤務中';
        msg += '👤 ' + a.staff
          + ' | 出勤 ' + a.clockIn
          + (a.clockOut ? ' | 退勤 ' + a.clockOut : '')
          + ' | ' + workStr + '\n';
      });
      msg += '\n';
    }

    // 日報セクション
    var dailyReports = getTodayDailyReports(today);
    if (dailyReports.length > 0) {
      msg += '📝 *日報*\n';
      dailyReports.forEach(function(report) {
        msg += '👤 ' + report.reporter + '\n';
        if (report.otherWork) {
          msg += '  🔧 ' + report.otherWork + '\n';
        }
        if (report.notes) {
          msg += '  📌 ' + report.notes + '\n';
        }
      });
      msg += '\n';
    } else {
      msg += '📝 *日報*\n⚠️ 本日の日報提出なし\n\n';
    }

    // 経費セクション
    if (expenseSummary.count > 0) {
      msg += '💰 *本日の経費*\n'
        + '件数: ' + expenseSummary.count + '件\n'
        + '合計: ' + expenseSummary.totalUSD + ' USD';
      if (expenseSummary.totalKHR > 0) {
        msg += ' / ' + expenseSummary.totalKHR + ' KHR';
      }
      msg += '\n';

      // Expensesシートへのリンク
      var expensesSheet = ss.getSheetByName(EXPENSES_SHEET_NAME);
      if (expensesSheet) {
        msg += '📄 [経費詳細を開く](' + sheetUrl + '#gid=' + expensesSheet.getSheetId() + ')\n';
      }
      msg += '\n';
    }

    msg += '📄 [スプレッドシートを開く（បើកសៀវភៅបញ្ជី）](' + sheetUrl + ')';

    sendTelegram(msg);
  }

  Logger.log('日次サマリー生成完了: ' + today + ' / ' + todayJobs.length + '件');
  return todayJobs.length;
}

// 本日の経費サマリー取得
function getTodayExpenseSummary(today) {
  var result = { count: 0, totalUSD: 0, totalKHR: 0 };

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(EXPENSES_SHEET_NAME);
    if (!sheet) return result;

    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return result;

    var data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    data.forEach(function(row) {
      var regDate = row[1] ? row[1].toString() : '';
      if (regDate.indexOf(today) === 0) {
        result.count++;
        var amount = parseFloat(row[4]) || 0;
        var currency = row[5] || 'USD';
        if (currency === 'KHR') {
          result.totalKHR += amount;
        } else {
          result.totalUSD += amount;
        }
      }
    });
  } catch (e) {
    Logger.log('getTodayExpenseSummary error: ' + e.toString());
  }

  return result;
}

// ═══════════════════════════════════════════
//  在庫管理（v4から継承・参照用に残す）
// ═══════════════════════════════════════════

function getInventorySheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INVENTORY_SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(INVENTORY_SHEET_NAME);
    var headers = [
      'Item ID', 'ឈ្មោះផលិតផល（品名）', 'ប្រភេទ（カテゴリ）',
      'ចំនួនបច្ចុប្បន្ន（現在庫数）', 'ឯកតា（単位）',
      'កម្រិតព្រមាន（発注閾値）', 'កាលបរិច្ឆេទធ្វើបច្ចុប្បន្នភាព（最終更新）'
    ];
    sheet.appendRow(headers);
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#c9a84c');
    headerRange.setFontColor('#000000');
    sheet.setFrozenRows(1);
  }

  return sheet;
}

function handleInventoryGet() {
  var sheet = getInventorySheet();
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) {
    return jsonResponse({ status: 'ok', items: [] });
  }

  var dataRange = sheet.getRange(2, 1, lastRow - 1, 7);
  var values = dataRange.getValues();

  var items = values.map(function(row) {
    return {
      id: row[0], name: row[1], category: row[2],
      qty: row[3], unit: row[4], threshold: row[5], updated: row[6]
    };
  });

  return jsonResponse({ status: 'ok', items: items });
}

// ═══════════════════════════════════════════
//  ユーティリティ
// ═══════════════════════════════════════════

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function formatCambodiaTime(date) {
  return Utilities.formatDate(date, 'Asia/Phnom_Penh', 'yyyy-MM-dd HH:mm:ss');
}

// 日本語→クメール語翻訳（スタッフ通知用）
function translateToKhmer(japaneseText) {
  if (!japaneseText) return '';
  try {
    return LanguageApp.translate(japaneseText, 'ja', 'km');
  } catch (err) {
    Logger.log('翻訳エラー: ' + err.toString());
    return japaneseText; // 翻訳失敗時は原文を返す
  }
}

function getOrCreateFolder(folderName) {
  var folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) {
    return folders.next();
  }
  return DriveApp.createFolder(folderName);
}

function saveBase64Image(folder, base64Data, filename) {
  var parts = base64Data.split(',');
  var mimeMatch = parts[0].match(/:(.*?);/);
  var mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
  var raw = parts.length > 1 ? parts[1] : parts[0];

  var blob = Utilities.newBlob(Utilities.base64Decode(raw), mimeType, filename + '.jpg');
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return file.getUrl();
}

// ═══════════════════════════════════════════
//  セットアップ・トリガー（v5）
// ═══════════════════════════════════════════

// v5トリガー一括設定
function setupV5Triggers() {
  // 既存トリガーを全削除
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }

  // 1. 繰返しタスク生成: 毎日 UTC 0:00 (JST 9:00, カンボジア 7:00)
  ScriptApp.newTrigger('generateRecurringTasks')
    .timeBased()
    .everyDays(1)
    .atHour(0)
    .create();

  // 2. 朝タスク通知: 毎日 UTC 1:00 (JST 10:00, カンボジア 8:00)
  ScriptApp.newTrigger('sendMorningTaskNotification')
    .timeBased()
    .everyDays(1)
    .atHour(1)
    .create();

  // 3. 日次サマリー: 毎日 UTC 11:00 (JST 20:00, カンボジア 18:00)
  ScriptApp.newTrigger('sendDailySummary')
    .timeBased()
    .everyDays(1)
    .atHour(11)
    .create();

  Logger.log('v5トリガーを設定しました:');
  Logger.log('  繰返しタスク生成: 毎日 JST 9:00');
  Logger.log('  朝タスク通知: 毎日 JST 10:00 / カンボジア 8:00');
  Logger.log('  日次サマリー: 毎日 JST 20:00 / カンボジア 18:00');
}

// v5シート・初期データ一括セットアップ
function setupV5Sheets() {
  getTasksSheet();
  getExpensesSheet();
  getDailyReportsSheet();
  getAttendanceSheet();
  seedRecurringTasks();
  Logger.log('v5シートと初期データを作成しました。');
}

// Telegram Webhook設定
function setupWebhook() {
  var gasUrl = ScriptApp.getService().getUrl();
  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/setWebhook?url=' + encodeURIComponent(gasUrl);

  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('Webhook設定結果: ' + response.getContentText());
}

function removeWebhook() {
  var url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/deleteWebhook';
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  Logger.log('Webhook解除結果: ' + response.getContentText());
}

// ═══════════════════════════════════════════
//  テスト関数
// ═══════════════════════════════════════════

function testFixHeaders() {
  fixHeaders();
}

function testDailySummary() {
  sendDailySummary();
}

function testCreateTask() {
  var taskId = createTask('ロン', '7500384947', '2026-04-15', 'テストタスク: 倉庫清掃', '', '');
  Logger.log('テストタスク作成: ' + taskId);
}

function testMorningNotification() {
  sendMorningTaskNotification();
}

function testTelegram() {
  sendTelegram('🧪 テスト通知\nSamurai Motors v5 Telegram連携テストです。');
}

function testReceiptOCR() {
  Logger.log('レシートOCRテストは実際のレシート写真で /receipt コマンドを使って実行してください。');
}
