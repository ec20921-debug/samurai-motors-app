/**
 * ReportManager.gs — 日報提出フロー（Phase 3）
 *
 * 【責務】
 *   - スタッフから送信された日報を「日報」シートに記録
 *   - 提出時に管理グループの日報トピックへフォーマット済みテキストを転送
 *   - 当日分の自分の日報取得（再編集用・API）
 *
 * 【Phase 2e との違い】
 *   - DailyReport.gs は Bot 側が毎日 JST 20:00 に「売上/タスク状況」を
 *     Admin グループへ自動投稿する“サマリー”。
 *   - ReportManager.gs は現場スタッフが「今日やったこと」を能動的に
 *     提出する“日報”。保存先は同じ Admin 日報トピック (157)。
 *
 * 【シート】
 *   SHEET_NAMES.DAILY_REPORTS = '日報'
 *   列: 日報ID / 提出日時 / 対象日 / 作成者名 / 作成者 Chat ID / 役割 /
 *       本日の作業内容 / 所感・気づき / 明日の予定 / 関連リンク / 状態
 */

const DAILY_REPORT_HEADERS_ = [
  '日報ID', '提出日時', '対象日', '作成者名', '作成者 Chat ID', '役割',
  '本日の作業内容', '所感・気づき', '明日の予定', '関連リンク', '状態'
];

// ============================================================
//  セットアップ（初回のみ）
// ============================================================

/**
 * 日報シートが無ければ作成し、ヘッダーを整える
 */
function ensureDailyReportsSheet() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  let sheet = ss.getSheetByName(SHEET_NAMES.DAILY_REPORTS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.DAILY_REPORTS);
    sheet.getRange(1, 1, 1, DAILY_REPORT_HEADERS_.length).setValues([DAILY_REPORT_HEADERS_]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, DAILY_REPORT_HEADERS_.length)
      .setFontWeight('bold')
      .setBackground('#2b2b2b')
      .setFontColor('#e8e8e8');
    // 列幅調整（読みやすさ）
    sheet.setColumnWidth(1, 170);   // 日報ID
    sheet.setColumnWidth(2, 140);   // 提出日時
    sheet.setColumnWidth(3, 100);   // 対象日
    sheet.setColumnWidth(4, 100);   // 作成者名
    sheet.setColumnWidth(7, 360);   // 作業内容
    sheet.setColumnWidth(8, 280);   // 所感
    sheet.setColumnWidth(9, 280);   // 明日の予定
    Logger.log('✅ 日報シート作成');
    return;
  }

  // 既存シートがあってもヘッダーが不足していたら補完
  const lastCol = sheet.getLastColumn() || 1;
  const existing = sheet.getRange(1, 1, 1, Math.max(lastCol, DAILY_REPORT_HEADERS_.length)).getValues()[0];
  let needsUpdate = false;
  DAILY_REPORT_HEADERS_.forEach(function(h, i) {
    if (existing[i] !== h) needsUpdate = true;
  });
  if (needsUpdate) {
    sheet.getRange(1, 1, 1, DAILY_REPORT_HEADERS_.length).setValues([DAILY_REPORT_HEADERS_]);
    sheet.setFrozenRows(1);
    Logger.log('♻️ 日報シート ヘッダーを整備');
  } else {
    Logger.log('ℹ️ 日報シート 既存・変更なし');
  }
}

// ============================================================
//  今日の日報取得（再編集用）
// ============================================================

/**
 * 指定 chatId の当日日報を取得。無ければ null。
 */
function getTodayReport(chatId) {
  const staff = findStaffByChatId(String(chatId));
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const tz = staff.timezone || OPS_TZ;
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  const rows = getAllRows(SHEET_NAMES.DAILY_REPORTS);
  const found = rows.find(function(r) {
    if (String(r['作成者 Chat ID']) !== String(chatId)) return false;
    const dateStr = formatDateCellTz_(r['対象日'], tz);
    return dateStr === todayStr;
  });

  return {
    ok: true,
    staff: { nameJp: staff.nameJp, nameEn: staff.nameEn, role: staff.role },
    today: todayStr,
    report: found ? {
      id:       String(found['日報ID']),
      date:     formatDateCellTz_(found['対象日'], tz),
      work:     String(found['本日の作業内容'] || ''),
      notes:    String(found['所感・気づき']   || ''),
      tomorrow: String(found['明日の予定']     || '')
    } : null
  };
}

// ============================================================
//  日報提出
// ============================================================

/**
 * 日報を提出（新規 or 当日分を上書き）
 *
 * @param {string} chatId
 * @param {{ work:string, notes:string, tomorrow:string, targetDate:string? }} payload
 */
function submitDailyReport(chatId, payload) {
  const staff = findStaffByChatId(String(chatId));
  if (!staff) return { ok: false, error: 'STAFF_NOT_FOUND' };

  const work = String((payload && payload.work) || '').trim();
  if (!work) return { ok: false, error: 'WORK_REQUIRED' };

  const notes    = String((payload && payload.notes)    || '').trim();
  const tomorrow = String((payload && payload.tomorrow) || '').trim();

  const tz = staff.timezone || OPS_TZ;
  const todayStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const targetDate = String((payload && payload.targetDate) || todayStr).trim() || todayStr;

  // 同一 chatId × 対象日 の既存行があれば上書き、なければ新規
  const sheet = getSheet(SHEET_NAMES.DAILY_REPORTS);
  const rows = getAllRows(SHEET_NAMES.DAILY_REPORTS);
  let existingRowNumber = -1;
  let existingId = '';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ds = formatDateCellTz_(r['対象日'], tz);
    if (String(r['作成者 Chat ID']) === String(chatId) && ds === targetDate) {
      existingRowNumber = i + 2; // ヘッダー分
      existingId = String(r['日報ID'] || '');
      break;
    }
  }

  const now = new Date();
  let reportId;

  if (existingRowNumber > 0) {
    reportId = existingId || generateDateSeqId('DR', SHEET_NAMES.DAILY_REPORTS, '日報ID');
    updateRow(SHEET_NAMES.DAILY_REPORTS, existingRowNumber, {
      '日報ID':          reportId,
      '提出日時':        now,
      '対象日':          targetDate,
      '作成者名':        staff.nameJp,
      '作成者 Chat ID':  String(chatId),
      '役割':            staff.role,
      '本日の作業内容':  work,
      '所感・気づき':    notes,
      '明日の予定':      tomorrow,
      '状態':            '提出済み（更新）'
    });
  } else {
    reportId = generateDateSeqId('DR', SHEET_NAMES.DAILY_REPORTS, '日報ID');
    appendRow(SHEET_NAMES.DAILY_REPORTS, {
      '日報ID':          reportId,
      '提出日時':        now,
      '対象日':          targetDate,
      '作成者名':        staff.nameJp,
      '作成者 Chat ID':  String(chatId),
      '役割':            staff.role,
      '本日の作業内容':  work,
      '所感・気づき':    notes,
      '明日の予定':      tomorrow,
      '関連リンク':      '',
      '状態':            '提出済み'
    });
  }

  // Admin 日報トピックへ転送（失敗してもユーザーの提出自体は成功として返す）
  try {
    forwardReportToAdmin_(staff, targetDate, work, notes, tomorrow, !!(existingRowNumber > 0));
  } catch (err) {
    Logger.log('⚠️ 日報 Admin 転送失敗: ' + err);
  }

  return {
    ok: true,
    reportId: reportId,
    targetDate: targetDate,
    updated: existingRowNumber > 0
  };
}

/**
 * Admin 日報トピックへ整形したメッセージを送る
 */
function forwardReportToAdmin_(staff, targetDate, work, notes, tomorrow, isUpdate) {
  const cfg = getConfig();
  if (!cfg.adminDailyReportThreadId) return;

  const flag = isUpdate ? '📝 <b>日報（更新）</b>' : '📝 <b>日報提出</b>';
  const lines = [
    flag,
    '━━━━━━━━━━━━━━━━━━',
    '👤 ' + escapeHtml_(staff.nameJp) + '（' + (staff.role === 'admin' ? '日本側' : '現場') + '）',
    '📅 ' + escapeHtml_(targetDate),
    '',
    '<b>🔧 本日の作業</b>',
    escapeHtml_(work)
  ];
  if (notes) {
    lines.push('');
    lines.push('<b>💭 所感・気づき</b>');
    lines.push(escapeHtml_(notes));
  }
  if (tomorrow) {
    lines.push('');
    lines.push('<b>📆 明日の予定</b>');
    lines.push(escapeHtml_(tomorrow));
  }

  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), {
    parse_mode: 'HTML',
    message_thread_id: Number(cfg.adminDailyReportThreadId),
    disable_web_page_preview: true
  });
}

// ============================================================
//  デバッグ
// ============================================================

function debugEnsureDailyReportsSheet() {
  ensureDailyReportsSheet();
}

function debugSubmitTestReport() {
  // ロンの chatId で試す想定
  const staff = getActiveStaff().find(function(s) { return s.role === 'field'; });
  if (!staff) { Logger.log('⚠️ field スタッフなし'); return; }
  const r = submitDailyReport(staff.chatId, {
    work: 'テスト: 3件の洗車を実施（清 KIYOME ×2, 匠 TAKUMI ×1）',
    notes: 'テスト: 洗車機のホースが摩耗気味。要交換検討。',
    tomorrow: 'テスト: 10:00 予約 2件対応予定'
  });
  Logger.log(JSON.stringify(r));
}
