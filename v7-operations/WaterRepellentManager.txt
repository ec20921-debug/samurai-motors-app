/**
 * WaterRepellentManager.gs — 撥水コーティング無料モニター施策
 *
 * 【施策概要】
 *   雨季開始前（〜2026-05-15）に、在カンボジア日系幹部層のお抱えドライバーに
 *   無料で窓ガラス撥水コーティングを施し、雨季中の体験を起点にリピート・口コミ・
 *   パートナー化につなげる「トロイの木馬」マーケティング施策。
 *
 * 【背景】
 *   2026-04-21 JICA訪問で得た気づき：
 *     - 日系大手・政府関係者は専属ドライバーを抱えている
 *     - ドライバーは平日昼間に時間がある
 *     - 「窓ガラス撥水」はカンボジアでまだ一般的でなく、提案で盛り上がる
 *   詳細: docs/WATER_REPELLENT_TROJAN_CAMPAIGN.md
 *
 * 【責務】
 *   - モニター申込フォーム経由の申請を受け付け、「撥水モニター」シートへ登録
 *   - モニターIDを自動採番（WRM-YYMMDD-NNN）
 *   - 管理グループ（撥水トピック or パートナートピック）へ予約確定ボタン付き通知
 *   - 確定/施工完了/アンケート送信の状態遷移
 *   - 雨季中（5/15〜10/31）の週次フォローアップ（時間トリガー）
 *   - アンケートフォームの自動作成・回答処理
 *
 * 【自動化フロー】
 *   1. 経営者 or ドライバー が Google Form に回答
 *   2. onFormSubmit → handleWaterRepellentFormSubmit が発火
 *   3. 「撥水モニター」シートに追記（ステータス=申込）
 *   4. 管理グループへ inline keyboard 付き通知
 *   5. Admin が ✅予約確定 / ❌キャンセル をタップ
 *   6. 施工完了は専用ボタン（または手動シート編集）
 *   7. 完了2週間後 + 雨季開始後にアンケートを自動送信
 */

// ====== 撥水モニターシート列定義 ======
const WATER_REPELLENT_HEADERS_ = [
  'モニターID',         // WRM-YYMMDD-NNN
  '申込日時',           // Form送信タイムスタンプ
  '会社名',             // 法人名
  '経営者氏名',         // コンタクト元
  '経営者連絡先',       // Telegram username or Email
  'ドライバー氏名',     // 来店者名
  'ドライバー連絡先',   // Telegram or 電話
  '車種・色',           // メーカー・モデル・色
  'ナンバープレート',   // 識別用
  '希望日',             // 第1希望
  '第2希望日',          // 第2希望
  '希望時間帯',         // 午前 / 午後
  'ステータス',         // 申込 / 予約確定 / 施工完了 / フォロー済み / キャンセル
  '予約確定日時',       // 確定タイムスタンプ
  '施工日時',           // 実施タイムスタンプ
  '施工担当',           // スタッフ名
  'アンケート送付日',   // 送信タイムスタンプ
  'アンケート回答日',   // 回答タイムスタンプ
  '視界改善評価',       // 1-5
  'リピート意向',       // ぜひ / たぶん / 不要
  '紹介意向',           // ぜひ / たぶん / 不要
  '経営者の反応',       // 自由記述
  '紹介元',             // JICA / ヒロさん / 直接 / その他
  'パートナー化候補',   // TRUE/FALSE
  '備考'                // 自由記述
];

// Form質問の namedValues キー（Form側ラベルと完全一致）
const WR_FORM_FIELDS_ = {
  COMPANY:           '会社名 / Company',
  OWNER_NAME:        '経営者・ご担当者様 お名前 / Manager Name',
  OWNER_CONTACT:     '経営者・ご担当者様 ご連絡先（Telegram or Email） / Manager Contact',
  DRIVER_NAME:       'ご来店ドライバー様 お名前 / Driver Name',
  DRIVER_CONTACT:    'ご来店ドライバー様 ご連絡先（電話 or Telegram） / Driver Contact',
  CAR_MODEL:         '車種・カラー / Car Model & Color',
  PLATE:             'ナンバープレート / License Plate',
  DESIRED_DATE_1:    'ご希望日（第1希望） / Preferred Date (1st choice)',
  DESIRED_DATE_2:    'ご希望日（第2希望） / Preferred Date (2nd choice)',
  TIME_SLOT:         'ご希望時間帯 / Preferred Time',
  REFERRAL_SOURCE:   '本キャンペーンを知ったきっかけ / How did you hear about us?',
  TERMS_AGREE:       '無料モニター条件に同意します / I agree to the monitor terms',
  NOTES:             'ご質問・ご要望 / Notes'
};

// アンケート Form のフィールド
const WR_SURVEY_FIELDS_ = {
  MONITOR_ID:        'モニターID / Monitor ID',
  VISIBILITY:        '雨の日の視界改善はいかがでしたか？ / Visibility improvement during rain?',
  REPEAT_INTENT:     '撥水コーティングを定期的にご希望ですか？ / Would you want this regularly?',
  REFERRAL_INTENT:   '同僚のドライバー様にご紹介いただけますか？ / Would you introduce to other drivers?',
  OWNER_REACTION:    '経営者・ご担当者様は何かおっしゃっていましたか？ / Any reaction from your manager?',
  ADDITIONAL_INTEREST:'追加でご興味のあるサービスはありますか？ / Any other services of interest?',
  FREE_TEXT:         'その他ご感想・ご要望（任意） / Additional comments (optional)'
};

// ====== 雨季フォローアップ期間 ======
const WR_RAINY_SEASON_START_MONTH_ = 5;   // 5月開始
const WR_RAINY_SEASON_END_MONTH_   = 10;  // 10月終了

// ============================================================
//  Google Form（申込）送信ハンドラ
// ============================================================

function handleWaterRepellentFormSubmit(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20 * 1000);
  } catch (err) {
    Logger.log('⚠️ WR Form: Lock 取得失敗（処理継続するが採番衝突リスクあり）: ' + err);
  }

  try {
    const values = (e && e.namedValues) || {};
    const get = function(key) {
      const v = values[key];
      if (!v) return '';
      return String((Array.isArray(v) ? v[0] : v) || '').trim();
    };

    const company         = get(WR_FORM_FIELDS_.COMPANY);
    const ownerName       = get(WR_FORM_FIELDS_.OWNER_NAME);
    const ownerContact    = get(WR_FORM_FIELDS_.OWNER_CONTACT);
    const driverName      = get(WR_FORM_FIELDS_.DRIVER_NAME);
    const driverContact   = get(WR_FORM_FIELDS_.DRIVER_CONTACT);
    const carModel        = get(WR_FORM_FIELDS_.CAR_MODEL);
    const plate           = get(WR_FORM_FIELDS_.PLATE);
    const desiredDate1    = get(WR_FORM_FIELDS_.DESIRED_DATE_1);
    const desiredDate2    = get(WR_FORM_FIELDS_.DESIRED_DATE_2);
    const timeSlot        = get(WR_FORM_FIELDS_.TIME_SLOT);
    const referralSource  = get(WR_FORM_FIELDS_.REFERRAL_SOURCE);
    const agree           = get(WR_FORM_FIELDS_.TERMS_AGREE);
    const notes           = get(WR_FORM_FIELDS_.NOTES);

    if (!ownerName && !driverName) {
      Logger.log('⚠️ WR Form: 経営者氏名・ドライバー氏名 ともに空のため処理中断');
      return;
    }
    if (!agree) {
      Logger.log('⚠️ WR Form: 同意未取得のため処理中断（owner=' + ownerName + '）');
      return;
    }

    const monitorId = generateMonitorId_();

    appendRow(SHEET_NAMES.WATER_REPELLENT, {
      'モニターID':         monitorId,
      '申込日時':           new Date(),
      '会社名':             company,
      '経営者氏名':         ownerName,
      '経営者連絡先':       ownerContact,
      'ドライバー氏名':     driverName,
      'ドライバー連絡先':   driverContact,
      '車種・色':           carModel,
      'ナンバープレート':   plate,
      '希望日':             desiredDate1,
      '第2希望日':          desiredDate2,
      '希望時間帯':         timeSlot,
      'ステータス':         '申込',
      '予約確定日時':       '',
      '施工日時':           '',
      '施工担当':           '',
      'アンケート送付日':   '',
      'アンケート回答日':   '',
      '視界改善評価':       '',
      'リピート意向':       '',
      '紹介意向':           '',
      '経営者の反応':       '',
      '紹介元':             referralSource,
      'パートナー化候補':   false,
      '備考':               notes
    });

    Logger.log('✅ 撥水モニター申込登録: ' + monitorId + ' company=' + company + ' driver=' + driverName);

    try { lock.releaseLock(); } catch (_e) { /* ignore */ }

    notifyWaterRepellentApplicationForApproval_(monitorId);

  } catch (err) {
    Logger.log('❌ handleWaterRepellentFormSubmit: ' + err + '\n' + (err && err.stack));
  } finally {
    try { lock.releaseLock(); } catch (_e) { /* すでに解放済なら無視 */ }
  }
}

// ============================================================
//  ID 採番
// ============================================================

function generateMonitorId_() {
  const dateStr = Utilities.formatDate(new Date(), OPS_TZ, 'yyMMdd');
  const headPrefix = 'WRM-' + dateStr + '-';
  const rows = getAllRows(SHEET_NAMES.WATER_REPELLENT);
  let maxSeq = 0;
  rows.forEach(function(r) {
    const id = String(r['モニターID'] || '');
    if (id.indexOf(headPrefix) === 0) {
      const seq = parseInt(id.substring(headPrefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  return headPrefix + ('00' + (maxSeq + 1)).slice(-3);
}

// ============================================================
//  管理グループへの確定依頼
// ============================================================

function notifyWaterRepellentApplicationForApproval_(monitorId) {
  const cfg = getConfig();
  const row = findRow(SHEET_NAMES.WATER_REPELLENT, 'モニターID', monitorId);
  if (!row) { Logger.log('⚠️ notifyWR: 未発見 ' + monitorId); return; }
  const m = row.data;

  // 送信先（撥水トピック → パートナートピック → タスクトピック の優先順位）
  const threadId = cfg.adminWaterRepellentThreadId
    || cfg.adminPartnerThreadId
    || cfg.adminTaskThreadId
    || cfg.adminDailyReportThreadId
    || '';

  const lines = [
    '💧 <b>撥水モニター 新規申込</b>',
    '━━━━━━━━━━━━━━━━━━',
    '🆔 ' + escapeHtml_(monitorId),
    m['会社名']           ? '🏢 ' + escapeHtml_(m['会社名']) : '',
    m['経営者氏名']       ? '👤 経営者: ' + escapeHtml_(m['経営者氏名']) +
                            (m['経営者連絡先'] ? '（' + escapeHtml_(m['経営者連絡先']) + '）' : '') : '',
    m['ドライバー氏名']   ? '🚗 ドライバー: ' + escapeHtml_(m['ドライバー氏名']) +
                            (m['ドライバー連絡先'] ? '（' + escapeHtml_(m['ドライバー連絡先']) + '）' : '') : '',
    m['車種・色']         ? '🚙 車両: ' + escapeHtml_(m['車種・色']) +
                            (m['ナンバープレート'] ? ' / ' + escapeHtml_(m['ナンバープレート']) : '') : '',
    m['希望日']           ? '📅 第1希望: ' + escapeHtml_(m['希望日']) +
                            (m['希望時間帯'] ? '（' + escapeHtml_(m['希望時間帯']) + '）' : '') : '',
    m['第2希望日']        ? '📅 第2希望: ' + escapeHtml_(m['第2希望日']) : '',
    m['紹介元']           ? '📣 きっかけ: ' + escapeHtml_(m['紹介元']) : '',
    m['備考']             ? '📝 ' + escapeHtml_(String(m['備考']).substring(0, 200)) : ''
  ].filter(Boolean);

  const kb = [[
    { text: '✅ 予約確定',  callback_data: 'wr_confirm:' + monitorId },
    { text: '❌ キャンセル', callback_data: 'wr_cancel:' + monitorId }
  ]];

  const opts = {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: kb },
    disable_web_page_preview: true
  };
  if (threadId) opts.message_thread_id = Number(threadId);

  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), opts);
}

// ============================================================
//  コールバック処理
// ============================================================

/**
 * 撥水モニター関連のコールバック処理
 *   wr_confirm:WRM-XXX  — 予約確定
 *   wr_cancel:WRM-XXX   — キャンセル
 *   wr_complete:WRM-XXX — 施工完了マーク（任意）
 *   wr_survey:WRM-XXX   — アンケート送付ログ（任意）
 */
function handleWaterRepellentCallback_(cb) {
  const data = String(cb.data || '');
  const cbId = cb.id;

  if (data.indexOf('wr_confirm:') === 0) {
    const id = data.substring('wr_confirm:'.length);
    const res = confirmMonitorBooking(id, cb.from);
    const tip = res.ok ? '✅ 予約確定' : ('⚠️ ' + (res.error || '失敗'));
    answerCallbackQuery(BOT_TYPE.INTERNAL, cbId, { text: tip });
    if (res.ok) editWaterRepellentMessage_(cb, 'confirmed', id);
    return true;
  }
  if (data.indexOf('wr_cancel:') === 0) {
    const id = data.substring('wr_cancel:'.length);
    const res = cancelMonitorBooking(id, cb.from);
    const tip = res.ok ? '❌ キャンセル' : ('⚠️ ' + (res.error || '失敗'));
    answerCallbackQuery(BOT_TYPE.INTERNAL, cbId, { text: tip });
    if (res.ok) editWaterRepellentMessage_(cb, 'cancelled', id);
    return true;
  }
  if (data.indexOf('wr_complete:') === 0) {
    const id = data.substring('wr_complete:'.length);
    const res = markMonitorServiceCompleted(id, cb.from);
    const tip = res.ok ? '🎉 施工完了' : ('⚠️ ' + (res.error || '失敗'));
    answerCallbackQuery(BOT_TYPE.INTERNAL, cbId, { text: tip });
    if (res.ok) editWaterRepellentMessage_(cb, 'completed', id);
    return true;
  }
  return false;
}

function editWaterRepellentMessage_(cb, result, monitorId) {
  try {
    if (!cb || !cb.message || !cb.message.chat) return;
    const actor = cb.from || {};
    const actorName = actor.username ? '@' + actor.username : (actor.first_name || '?');
    const stamp = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd HH:mm');

    const iconMap = {
      confirmed: '✅ 予約確定',
      cancelled: '❌ キャンセル',
      completed: '🎉 施工完了'
    };
    const iconLine = iconMap[result] || '✓ 処理済み';

    const original = String(cb.message.text || '');
    const newText = original +
      '\n━━━━━━━━━━━━━━━━━━\n' +
      iconLine + ' by ' + actorName + '（' + stamp + '）';

    const payload = {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: newText
    };

    // 確定後は「施工完了」ボタンを残す
    if (result === 'confirmed') {
      payload.reply_markup = { inline_keyboard: [[
        { text: '🎉 施工完了', callback_data: 'wr_complete:' + monitorId }
      ]] };
    } else {
      payload.reply_markup = { inline_keyboard: [] };
    }
    if (cb.message.message_thread_id) payload.message_thread_id = cb.message.message_thread_id;

    callTelegramApi(BOT_TYPE.INTERNAL, 'editMessageText', payload);
  } catch (err) {
    Logger.log('⚠️ editWaterRepellentMessage_: ' + err);
  }
}

// ============================================================
//  状態遷移 API
// ============================================================

function confirmMonitorBooking(monitorId, actor) {
  const row = findRow(SHEET_NAMES.WATER_REPELLENT, 'モニターID', monitorId);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  if (String(row.data['ステータス']) === '予約確定') return { ok: false, error: 'ALREADY_CONFIRMED' };
  if (String(row.data['ステータス']) === 'キャンセル') return { ok: false, error: 'ALREADY_CANCELLED' };

  updateRow(SHEET_NAMES.WATER_REPELLENT, row.row, {
    'ステータス':     '予約確定',
    '予約確定日時':   new Date()
  });
  return { ok: true, monitorId: monitorId };
}

function cancelMonitorBooking(monitorId, actor) {
  const row = findRow(SHEET_NAMES.WATER_REPELLENT, 'モニターID', monitorId);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  if (String(row.data['ステータス']) === 'キャンセル') return { ok: false, error: 'ALREADY_CANCELLED' };

  updateRow(SHEET_NAMES.WATER_REPELLENT, row.row, {
    'ステータス': 'キャンセル'
  });
  return { ok: true, monitorId: monitorId };
}

function markMonitorServiceCompleted(monitorId, actor) {
  const row = findRow(SHEET_NAMES.WATER_REPELLENT, 'モニターID', monitorId);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  if (String(row.data['ステータス']) === '施工完了') return { ok: false, error: 'ALREADY_COMPLETED' };

  const actorName = actor
    ? (actor.username ? '@' + actor.username : (actor.first_name || '?'))
    : '?';

  updateRow(SHEET_NAMES.WATER_REPELLENT, row.row, {
    'ステータス': '施工完了',
    '施工日時':   new Date(),
    '施工担当':   actorName
  });

  // 施工完了の確認通知（任意：シンプルなお礼ログ）
  notifyMonitorServiceCompleted_(monitorId);

  return { ok: true, monitorId: monitorId };
}

function notifyMonitorServiceCompleted_(monitorId) {
  const cfg = getConfig();
  const row = findRow(SHEET_NAMES.WATER_REPELLENT, 'モニターID', monitorId);
  if (!row) return;
  const m = row.data;

  const threadId = cfg.adminWaterRepellentThreadId
    || cfg.adminPartnerThreadId
    || cfg.adminTaskThreadId
    || '';

  const lines = [
    '🎉 <b>撥水モニター 施工完了</b>',
    '━━━━━━━━━━━━━━━━━━',
    '🆔 ' + escapeHtml_(monitorId),
    m['会社名']         ? '🏢 ' + escapeHtml_(m['会社名']) : '',
    m['ドライバー氏名'] ? '🚗 ' + escapeHtml_(m['ドライバー氏名']) : '',
    m['車種・色']       ? '🚙 ' + escapeHtml_(m['車種・色']) : '',
    '',
    '✅ 雨季後（5/15以降）に自動でアンケートを送付します'
  ].filter(Boolean);

  const opts = { parse_mode: 'HTML' };
  if (threadId) opts.message_thread_id = Number(threadId);
  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), opts);
}

// ============================================================
//  雨季フォローアップ（時間トリガーで実行）
// ============================================================

/**
 * 雨季フォローアップ通知（週次トリガー想定）
 *   - 5月15日〜10月31日 のみ動作（雨季外は no-op）
 *   - 「施工完了」かつ「アンケート未送付」のモニターに対して
 *     アンケートURL付きの通知を管理グループに出す
 *
 * 注意：パートナーと違い、ドライバー本人の Telegram chat_id を
 *      確実に保有していない可能性が高いため、まずは管理グループに
 *      「アンケート送付タスク」を出す方式とする。
 *      将来的にドライバー本人へ Telegram で直接送付する仕組みを検討。
 */
function sendRainySeasonFollowUp() {
  const today = new Date();
  const tz = OPS_TZ;
  const month = Number(Utilities.formatDate(today, tz, 'M'));
  if (month < WR_RAINY_SEASON_START_MONTH_ || month > WR_RAINY_SEASON_END_MONTH_) {
    Logger.log('ℹ️ 雨季外（' + month + '月）のため WR フォローアップをスキップ');
    return;
  }

  const cfg = getConfig();
  const surveyUrl = cfg.waterRepellentSurveyUrl || '';

  const rows = getAllRows(SHEET_NAMES.WATER_REPELLENT);
  const targets = rows.filter(function(r) {
    return String(r['ステータス']) === '施工完了'
        && !String(r['アンケート送付日'] || '').trim()
        && !String(r['アンケート回答日'] || '').trim();
  });

  if (targets.length === 0) {
    Logger.log('ℹ️ WR フォローアップ対象なし');
    return;
  }

  Logger.log('💧 WR フォローアップ対象: ' + targets.length + '件');

  const threadId = cfg.adminWaterRepellentThreadId
    || cfg.adminPartnerThreadId
    || cfg.adminTaskThreadId
    || '';

  targets.forEach(function(m) {
    const monitorId = String(m['モニターID']);
    const lines = [
      '💧 <b>撥水モニター フォローアップ依頼</b>',
      '━━━━━━━━━━━━━━━━━━',
      '🆔 ' + escapeHtml_(monitorId),
      m['会社名']         ? '🏢 ' + escapeHtml_(m['会社名']) : '',
      m['ドライバー氏名'] ? '🚗 ' + escapeHtml_(m['ドライバー氏名']) +
                            (m['ドライバー連絡先'] ? '（' + escapeHtml_(m['ドライバー連絡先']) + '）' : '') : '',
      m['経営者連絡先']   ? '👤 経営者連絡先: ' + escapeHtml_(m['経営者連絡先']) : '',
      m['施工日時']       ? '📅 施工日: ' + formatDateForLog_(m['施工日時']) : '',
      '',
      '雨季が始まりました。下記のアンケート URL をドライバー様に送付してください。',
      surveyUrl ? '🔗 ' + surveyUrl : '⚠️ アンケートURL 未設定（createWaterRepellentSurveyForm を実行してください）',
      '',
      '送付完了後は下のボタンを押してください。'
    ].filter(Boolean);

    const kb = [[
      { text: '📤 送付完了マーク', callback_data: 'wr_survey:' + monitorId }
    ]];

    const opts = {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: kb },
      disable_web_page_preview: true
    };
    if (threadId) opts.message_thread_id = Number(threadId);

    sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), opts);
  });
}

function formatDateForLog_(v) {
  try {
    if (v instanceof Date) return Utilities.formatDate(v, OPS_TZ, 'yyyy-MM-dd');
    if (typeof v === 'string') return v;
    return String(v || '');
  } catch (_e) { return String(v || ''); }
}

/**
 * アンケート送付完了マークのコールバック（wr_survey:WRM-XXX）
 */
function markSurveySent(monitorId, actor) {
  const row = findRow(SHEET_NAMES.WATER_REPELLENT, 'モニターID', monitorId);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  updateRow(SHEET_NAMES.WATER_REPELLENT, row.row, {
    'アンケート送付日': new Date()
  });
  return { ok: true, monitorId: monitorId };
}

// wr_survey: コールバック対応を handleWaterRepellentCallback_ に追加
function _handleWaterRepellentSurveyCallback_(cb) {
  const data = String(cb.data || '');
  if (data.indexOf('wr_survey:') !== 0) return false;
  const id = data.substring('wr_survey:'.length);
  const res = markSurveySent(id, cb.from);
  const tip = res.ok ? '📤 送付完了' : ('⚠️ ' + (res.error || '失敗'));
  answerCallbackQuery(BOT_TYPE.INTERNAL, cb.id, { text: tip });
  if (res.ok) {
    try {
      const original = String(cb.message.text || '');
      const stamp = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd HH:mm');
      const actor = cb.from || {};
      const actorName = actor.username ? '@' + actor.username : (actor.first_name || '?');
      const newText = original +
        '\n━━━━━━━━━━━━━━━━━━\n' +
        '📤 アンケート送付済み by ' + actorName + '（' + stamp + '）';
      const payload = {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: newText,
        reply_markup: { inline_keyboard: [] }
      };
      if (cb.message.message_thread_id) payload.message_thread_id = cb.message.message_thread_id;
      callTelegramApi(BOT_TYPE.INTERNAL, 'editMessageText', payload);
    } catch (err) { Logger.log('⚠️ wr_survey edit: ' + err); }
  }
  return true;
}

// ============================================================
//  アンケート（雨季体験）回答ハンドラ
// ============================================================

/**
 * アンケートフォームの onFormSubmit ハンドラ
 *   モニターIDをキーに、評価・自由記述を撥水モニターシートに反映する
 */
function handleWaterRepellentSurveySubmit(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20 * 1000);
  } catch (err) {
    Logger.log('⚠️ WR Survey: Lock 取得失敗: ' + err);
  }

  try {
    const values = (e && e.namedValues) || {};
    const get = function(key) {
      const v = values[key];
      if (!v) return '';
      return String((Array.isArray(v) ? v[0] : v) || '').trim();
    };

    const monitorId          = get(WR_SURVEY_FIELDS_.MONITOR_ID);
    const visibility         = get(WR_SURVEY_FIELDS_.VISIBILITY);
    const repeatIntent       = get(WR_SURVEY_FIELDS_.REPEAT_INTENT);
    const referralIntent     = get(WR_SURVEY_FIELDS_.REFERRAL_INTENT);
    const ownerReaction      = get(WR_SURVEY_FIELDS_.OWNER_REACTION);
    const additionalInterest = get(WR_SURVEY_FIELDS_.ADDITIONAL_INTEREST);
    const freeText           = get(WR_SURVEY_FIELDS_.FREE_TEXT);

    if (!monitorId) {
      Logger.log('⚠️ WR Survey: モニターID 未指定（無記名回答として保存）');
      // 後で手動マッピングするため、備考欄に放り込む独立行を作る
      appendRow(SHEET_NAMES.WATER_REPELLENT, {
        'モニターID':         generateMonitorId_(),
        '申込日時':           new Date(),
        'ステータス':         '匿名アンケート',
        '視界改善評価':       parseVisibilityScore_(visibility),
        'リピート意向':       repeatIntent,
        '紹介意向':           referralIntent,
        '経営者の反応':       ownerReaction,
        'アンケート回答日':   new Date(),
        '備考':               '【匿名回答】' + freeText + '\n追加興味: ' + additionalInterest
      });
      return;
    }

    const row = findRow(SHEET_NAMES.WATER_REPELLENT, 'モニターID', monitorId);
    if (!row) {
      Logger.log('⚠️ WR Survey: モニターID 未発見 ' + monitorId);
      return;
    }

    const score = parseVisibilityScore_(visibility);
    const isPartnerCandidate =
      (referralIntent.indexOf('ぜひ') >= 0 || referralIntent.toLowerCase().indexOf('definitely') >= 0)
      && (repeatIntent.indexOf('ぜひ') >= 0 || repeatIntent.toLowerCase().indexOf('definitely') >= 0);

    updateRow(SHEET_NAMES.WATER_REPELLENT, row.row, {
      'アンケート回答日':   new Date(),
      '視界改善評価':       score,
      'リピート意向':       repeatIntent,
      '紹介意向':           referralIntent,
      '経営者の反応':       ownerReaction,
      'パートナー化候補':   isPartnerCandidate,
      'ステータス':         'フォロー済み',
      '備考':               (row.data['備考'] || '') +
                            (freeText ? '\n【アンケート】' + freeText : '') +
                            (additionalInterest ? '\n追加興味: ' + additionalInterest : '')
    });

    Logger.log('✅ WR アンケート回答記録: ' + monitorId + ' visibility=' + score +
               ' repeat=' + repeatIntent + ' referral=' + referralIntent);

    try { lock.releaseLock(); } catch (_e) { /* ignore */ }

    // 高評価＆紹介意向ありなら管理グループに即時アラート
    if (isPartnerCandidate || score >= 4) {
      notifyHighValueSurveyResponse_(monitorId);
    }

  } catch (err) {
    Logger.log('❌ handleWaterRepellentSurveySubmit: ' + err + '\n' + (err && err.stack));
  } finally {
    try { lock.releaseLock(); } catch (_e) { /* ignore */ }
  }
}

function parseVisibilityScore_(text) {
  if (!text) return '';
  const s = String(text).trim();
  // 「5 - とても良かった」のような形式から先頭の数値を取り出す
  const match = s.match(/^([1-5])/);
  if (match) return Number(match[1]);
  // クメール語/英語のキーワードからフォールバック
  if (s.indexOf('とても') >= 0 || s.toLowerCase().indexOf('excellent') >= 0) return 5;
  if (s.indexOf('良かった') >= 0 || s.toLowerCase().indexOf('good') >= 0) return 4;
  if (s.indexOf('普通') >= 0 || s.toLowerCase().indexOf('average') >= 0) return 3;
  return '';
}

function notifyHighValueSurveyResponse_(monitorId) {
  const cfg = getConfig();
  const row = findRow(SHEET_NAMES.WATER_REPELLENT, 'モニターID', monitorId);
  if (!row) return;
  const m = row.data;

  const threadId = cfg.adminWaterRepellentThreadId
    || cfg.adminPartnerThreadId
    || cfg.adminTaskThreadId
    || '';

  const lines = [
    '⭐ <b>WR 高評価アンケート回答</b>',
    '━━━━━━━━━━━━━━━━━━',
    '🆔 ' + escapeHtml_(monitorId),
    m['会社名']         ? '🏢 ' + escapeHtml_(m['会社名']) : '',
    m['ドライバー氏名'] ? '🚗 ' + escapeHtml_(m['ドライバー氏名']) : '',
    m['経営者氏名']     ? '👤 経営者: ' + escapeHtml_(m['経営者氏名']) : '',
    '',
    '🌟 視界改善: ' + escapeHtml_(String(m['視界改善評価'] || '')) + '/5',
    '🔁 リピート: ' + escapeHtml_(String(m['リピート意向'] || '')),
    '📣 紹介意向: ' + escapeHtml_(String(m['紹介意向'] || '')),
    m['経営者の反応'] ? '💬 経営者の反応: ' + escapeHtml_(String(m['経営者の反応']).substring(0, 250)) : '',
    '',
    '🎯 推奨アクション:',
    '  ① 経営者へお礼＋月額メンテナンス案内',
    '  ② パートナーシップ案内（タイミングを見て）',
    '  ③ ドライバーへお礼カード送付'
  ].filter(Boolean);

  const opts = { parse_mode: 'HTML' };
  if (threadId) opts.message_thread_id = Number(threadId);
  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), opts);
}

// ============================================================
//  Form 自動生成（申込フォーム）
// ============================================================

/**
 * 撥水モニター申込フォームを自動生成し、onFormSubmit トリガーまで一括登録
 */
function createWaterRepellentMonitorForm() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('💧 撥水モニター申込フォーム 自動生成');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  const form = FormApp.create('Samurai Motors 撥水コーティング 無料モニター申込');

  form.setDescription(
    'Samurai Motors より、雨季対策の特別ご招待です。\n' +
    'プノンペンでまだ珍しい「窓ガラス撥水コーティング」を、\n' +
    'ご来店いただける日系・現地企業の社用車を対象に、\n' +
    '【無料】 で施工いたします。\n\n' +
    '所要時間：30分／台\n' +
    '対象期間：2026年4月28日 〜 5月31日\n' +
    '対象台数：1社あたり最大4台\n\n' +
    'カンボジアの雨季は、ワイパーが追いつかないほどの豪雨が続きます。\n' +
    '撥水コーティングを施すと、時速60km/h で走行するだけで\n' +
    '雨粒が自然に流れ落ち、視界が劇的に改善されます。\n\n' +
    'ドライバー様の安全運転にもつながりますので、\n' +
    'ぜひ雨季の本格化前にご体験ください。\n\n' +
    'ご記入いただいた後、3営業日以内に Samurai Motors より\n' +
    '日時調整のご連絡を差し上げます。'
  );

  form.setCollectEmail(true);
  form.setAllowResponseEdits(false);
  form.setShowLinkToRespondAgain(false);
  form.setProgressBar(true);
  form.setConfirmationMessage(
    '✅ お申込みを受け付けました。\n' +
    '3営業日以内に Samurai Motors より日時調整のご連絡を差し上げます。\n\n' +
    'Thank you for your application! We will contact you within 3 business days.'
  );

  // ── セクション1: お会社・ご担当者様 ───────────────────
  form.addSectionHeaderItem()
    .setTitle('① ご会社・ご担当者様 / Company & Manager');

  form.addTextItem()
    .setTitle(WR_FORM_FIELDS_.COMPANY)
    .setHelpText('例: 株式会社サムライモーターズ / Samurai Motors Co., Ltd.')
    .setRequired(true);

  form.addTextItem()
    .setTitle(WR_FORM_FIELDS_.OWNER_NAME)
    .setHelpText('お申込みのご担当者様 or 経営者様のお名前')
    .setRequired(true);

  form.addTextItem()
    .setTitle(WR_FORM_FIELDS_.OWNER_CONTACT)
    .setHelpText('Telegram username（@yamada）または メールアドレス')
    .setRequired(true);

  // ── セクション2: ご来店ドライバー様 ───────────────────
  form.addSectionHeaderItem()
    .setTitle('② ご来店ドライバー様 / Driver Information')
    .setHelpText('当日 Samurai Motors にご来店いただくドライバー様の情報です。\nIf you are coming yourself, please enter your own info.');

  form.addTextItem()
    .setTitle(WR_FORM_FIELDS_.DRIVER_NAME)
    .setRequired(true);

  form.addTextItem()
    .setTitle(WR_FORM_FIELDS_.DRIVER_CONTACT)
    .setHelpText('当日のご連絡用。電話 or Telegram')
    .setRequired(true);

  // ── セクション3: 車両情報 ───────────────────
  form.addSectionHeaderItem()
    .setTitle('③ 車両情報 / Vehicle Information');

  form.addTextItem()
    .setTitle(WR_FORM_FIELDS_.CAR_MODEL)
    .setHelpText('例: TOYOTA Camry 2022 / White')
    .setRequired(true);

  form.addTextItem()
    .setTitle(WR_FORM_FIELDS_.PLATE)
    .setHelpText('当日の照合用')
    .setRequired(true);

  // ── セクション4: ご希望日時 ───────────────────
  form.addSectionHeaderItem()
    .setTitle('④ ご希望日時 / Preferred Date & Time')
    .setHelpText('ドライバー様のお手すきの平日 10:00〜16:00 でお選びください。');

  form.addTextItem()
    .setTitle(WR_FORM_FIELDS_.DESIRED_DATE_1)
    .setHelpText('例: 2026-04-30')
    .setRequired(true);

  form.addTextItem()
    .setTitle(WR_FORM_FIELDS_.DESIRED_DATE_2)
    .setHelpText('例: 2026-05-02')
    .setRequired(false);

  form.addMultipleChoiceItem()
    .setTitle(WR_FORM_FIELDS_.TIME_SLOT)
    .setChoiceValues([
      '午前 10:00〜12:00 / Morning',
      '午後 13:00〜16:00 / Afternoon',
      'どちらでも可 / Either is fine'
    ])
    .setRequired(true);

  // ── セクション5: きっかけ ───────────────────
  form.addSectionHeaderItem()
    .setTitle('⑤ きっかけ / How did you hear about us?');

  form.addMultipleChoiceItem()
    .setTitle(WR_FORM_FIELDS_.REFERRAL_SOURCE)
    .setChoiceValues([
      'JICA関係者からの紹介',
      '日本人会・JETRO・大使館',
      '飯泉さん（ヒロさん）から',
      '既存パートナーから',
      '直接ご案内をいただいた',
      'SNS / Web',
      'その他'
    ])
    .showOtherOption(true)
    .setRequired(false);

  // ── セクション6: 同意 ───────────────────
  form.addSectionHeaderItem()
    .setTitle('⑥ 無料モニター条件 / Monitor Terms')
    .setHelpText(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      '【無料モニター条件】\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      '1. 施工\n' +
      '   窓ガラス撥水コーティング（フロント・サイド・リア）\n\n' +
      '2. 所要時間\n' +
      '   1台あたり 30分（前後 5〜10分の余裕を見てください）\n\n' +
      '3. 価格\n' +
      '   無料（モニター価格）\n\n' +
      '4. 対象台数\n' +
      '   1社あたり最大4台\n\n' +
      '5. 対象期間\n' +
      '   2026年4月28日 〜 5月31日\n\n' +
      '6. アンケートご協力のお願い\n' +
      '   雨季開始後（5月中旬以降）に、\n' +
      '   雨の日の視界改善体験についてアンケートをお送りします。\n' +
      '   3問・1分でお答えいただけます。\n\n' +
      '7. 保証\n' +
      '   施工後の効果や色合いに万一ご満足いただけない場合は、\n' +
      '   ご来店いただければ即時に再施工 or 除去いたします。\n\n' +
      '8. 個人情報\n' +
      '   ご記入の情報は、本キャンペーンの運営および\n' +
      '   今後のサービスご案内のためのみに使用します。\n' +
      '   第三者への提供はいたしません。\n\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    );

  form.addCheckboxItem()
    .setTitle(WR_FORM_FIELDS_.TERMS_AGREE)
    .setChoiceValues(['同意します / I agree'])
    .setRequired(true);

  // ── セクション7: その他 ───────────────────
  form.addSectionHeaderItem()
    .setTitle('⑦ ご質問・ご要望 / Notes');

  form.addParagraphTextItem()
    .setTitle(WR_FORM_FIELDS_.NOTES)
    .setHelpText('複数台お申込みの場合は、車両ごとの情報も自由にご記入ください。')
    .setRequired(false);

  // フォーム情報
  const formId = form.getId();
  const editUrl = form.getEditUrl();
  const publishedUrl = form.getPublishedUrl();
  let shortUrl = publishedUrl;
  try {
    shortUrl = form.shortenFormUrl(publishedUrl);
  } catch (err) {
    Logger.log('⚠️ 短縮URL生成失敗（無視可）: ' + err);
  }

  // onFormSubmit トリガー登録
  try {
    setupWaterRepellentFormTrigger(formId);
  } catch (err) {
    Logger.log('⚠️ トリガー登録に失敗: ' + err);
    Logger.log('   → 手動で setupWaterRepellentFormTrigger("' + formId + '") を実行してください');
  }

  // ScriptProperties に記録
  PropertiesService.getScriptProperties().setProperty(
    CONFIG_KEYS.WATER_REPELLENT_FORM_URL, shortUrl
  );

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ 撥水モニター申込フォーム 生成完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('フォームID:     ' + formId);
  Logger.log('編集URL:        ' + editUrl);
  Logger.log('公開URL(長):    ' + publishedUrl);
  Logger.log('公開URL(短):    ' + shortUrl);
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  return { formId: formId, editUrl: editUrl, publishedUrl: publishedUrl, shortUrl: shortUrl };
}

function setupWaterRepellentFormTrigger(formId) {
  if (!formId) throw new Error('❌ formId が必要です');
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'handleWaterRepellentFormSubmit') ScriptApp.deleteTrigger(t);
  });
  const form = FormApp.openById(formId);
  ScriptApp.newTrigger('handleWaterRepellentFormSubmit')
    .forForm(form)
    .onFormSubmit()
    .create();
  Logger.log('✅ handleWaterRepellentFormSubmit の onFormSubmit トリガーを登録 (form=' + formId + ')');
}

// ============================================================
//  Form 自動生成（雨季体験アンケート）
// ============================================================

function createWaterRepellentSurveyForm() {
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📋 撥水モニター 雨季体験アンケート 自動生成');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  const form = FormApp.create('Samurai Motors 撥水コーティング 雨季体験アンケート');

  form.setDescription(
    '撥水コーティング無料モニターにご協力いただき、ありがとうございました。\n' +
    '雨季の体験について、3問・1分ほどお聞かせください。\n' +
    'いただいたご感想は、今後のサービス改善に活用させていただきます。\n\n' +
    'Thank you for participating in our water-repellent coating monitor program.\n' +
    'Please share your experience during the rainy season — 3 questions, takes ~1 minute.'
  );

  form.setCollectEmail(false);
  form.setAllowResponseEdits(false);
  form.setShowLinkToRespondAgain(false);
  form.setProgressBar(true);
  form.setConfirmationMessage(
    'ご回答ありがとうございました🙏\n' +
    'いただいた声は、Samurai Motors のサービス向上に活用させていただきます。\n\n' +
    'Thank you for your feedback! We appreciate it sincerely.'
  );

  // ── 1. モニターID（隠しではなく明示記入。アンケート送付時に管理者がペースト or 印刷紙に記載） ──
  form.addTextItem()
    .setTitle(WR_SURVEY_FIELDS_.MONITOR_ID)
    .setHelpText('Samurai Motors からお送りした「WRM-」で始まる番号をご記入ください。\n例: WRM-260428-001')
    .setRequired(false);

  // ── 2. 雨の日の視界改善 ──
  form.addMultipleChoiceItem()
    .setTitle(WR_SURVEY_FIELDS_.VISIBILITY)
    .setChoiceValues([
      '5 - とても良かった / Excellent',
      '4 - 良かった / Good',
      '3 - 普通 / Average',
      '2 - あまり変わらない / Not much different',
      '1 - 効果を感じない / No effect'
    ])
    .setRequired(true);

  // ── 3. リピート意向 ──
  form.addMultipleChoiceItem()
    .setTitle(WR_SURVEY_FIELDS_.REPEAT_INTENT)
    .setChoiceValues([
      'ぜひ定期的にお願いしたい / Definitely want regular service',
      'たぶん / Probably',
      '今のところ不要 / Not for now'
    ])
    .setRequired(true);

  // ── 4. 紹介意向 ──
  form.addMultipleChoiceItem()
    .setTitle(WR_SURVEY_FIELDS_.REFERRAL_INTENT)
    .setChoiceValues([
      'ぜひ紹介したい / Definitely would introduce',
      'たぶん / Probably',
      'まだわからない / Not sure yet'
    ])
    .setRequired(true);

  // ── 5. 経営者の反応 ──
  form.addParagraphTextItem()
    .setTitle(WR_SURVEY_FIELDS_.OWNER_REACTION)
    .setHelpText('経営者・ご担当者様より、何かコメントはございましたか？\n（任意）')
    .setRequired(false);

  // ── 6. 追加サービスへの興味 ──
  form.addCheckboxItem()
    .setTitle(WR_SURVEY_FIELDS_.ADDITIONAL_INTEREST)
    .setChoiceValues([
      'ボディコーティング / Body coating',
      '車内クリーニング / Interior cleaning',
      'エアコン洗浄 / AC cleaning',
      '出張洗車（オフィス・ご自宅） / Mobile wash',
      '月額メンテナンスプラン / Monthly maintenance plan',
      '特になし / None'
    ])
    .setRequired(false);

  // ── 7. 自由記述 ──
  form.addParagraphTextItem()
    .setTitle(WR_SURVEY_FIELDS_.FREE_TEXT)
    .setRequired(false);

  const formId = form.getId();
  const editUrl = form.getEditUrl();
  const publishedUrl = form.getPublishedUrl();
  let shortUrl = publishedUrl;
  try {
    shortUrl = form.shortenFormUrl(publishedUrl);
  } catch (err) {
    Logger.log('⚠️ 短縮URL生成失敗（無視可）: ' + err);
  }

  // onFormSubmit トリガー登録
  try {
    setupWaterRepellentSurveyTrigger(formId);
  } catch (err) {
    Logger.log('⚠️ アンケートトリガー登録失敗: ' + err);
    Logger.log('   → 手動で setupWaterRepellentSurveyTrigger("' + formId + '") を実行してください');
  }

  // ScriptProperties に記録
  PropertiesService.getScriptProperties().setProperty(
    CONFIG_KEYS.WATER_REPELLENT_SURVEY_URL, shortUrl
  );

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ 雨季体験アンケート 生成完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('フォームID:     ' + formId);
  Logger.log('編集URL:        ' + editUrl);
  Logger.log('公開URL(短):    ' + shortUrl);
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  return { formId: formId, editUrl: editUrl, publishedUrl: publishedUrl, shortUrl: shortUrl };
}

function setupWaterRepellentSurveyTrigger(formId) {
  if (!formId) throw new Error('❌ formId が必要です');
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'handleWaterRepellentSurveySubmit') ScriptApp.deleteTrigger(t);
  });
  const form = FormApp.openById(formId);
  ScriptApp.newTrigger('handleWaterRepellentSurveySubmit')
    .forForm(form)
    .onFormSubmit()
    .create();
  Logger.log('✅ handleWaterRepellentSurveySubmit の onFormSubmit トリガーを登録 (form=' + formId + ')');
}

// ============================================================
//  時間トリガー登録（雨季フォローアップ）
// ============================================================

/**
 * 雨季フォローアップ用の時間トリガーを登録
 *   毎週月曜 9:00 (Asia/Phnom_Penh) に sendRainySeasonFollowUp を実行
 */
function setupWaterRepellentFollowUpTrigger() {
  // 既存トリガーを削除
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'sendRainySeasonFollowUp') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('sendRainySeasonFollowUp')
    .timeBased()
    .everyWeeks(1)
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .inTimezone(OPS_TZ)
    .create();

  Logger.log('✅ sendRainySeasonFollowUp の週次トリガーを登録（毎週月曜 9:00 ' + OPS_TZ + '）');
}

function removeWaterRepellentFollowUpTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'sendRainySeasonFollowUp') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log('🧹 sendRainySeasonFollowUp トリガー削除: ' + removed + '件');
}

// ============================================================
//  参照用クエリ
// ============================================================

function getWaterRepellentMonitorById(monitorId) {
  const row = findRow(SHEET_NAMES.WATER_REPELLENT, 'モニターID', monitorId);
  return row ? row.data : null;
}

function getWaterRepellentStats() {
  const rows = getAllRows(SHEET_NAMES.WATER_REPELLENT);
  const byStatus = {};
  rows.forEach(function(r) {
    const s = String(r['ステータス'] || '不明');
    byStatus[s] = (byStatus[s] || 0) + 1;
  });
  const partnerCandidates = rows.filter(function(r) {
    return r['パートナー化候補'] === true || String(r['パートナー化候補']).toUpperCase() === 'TRUE';
  }).length;
  return {
    total:             rows.length,
    byStatus:          byStatus,
    partnerCandidates: partnerCandidates
  };
}

// ============================================================
//  デバッグ
// ============================================================

function debugMockWaterRepellentFormSubmit() {
  const namedValues = {};
  namedValues[WR_FORM_FIELDS_.COMPANY]          = ['JICAプノンペン事務所'];
  namedValues[WR_FORM_FIELDS_.OWNER_NAME]       = ['田中 太郎'];
  namedValues[WR_FORM_FIELDS_.OWNER_CONTACT]    = ['@tanaka_jica'];
  namedValues[WR_FORM_FIELDS_.DRIVER_NAME]      = ['SOK Channary'];
  namedValues[WR_FORM_FIELDS_.DRIVER_CONTACT]   = ['+855 12 345 678'];
  namedValues[WR_FORM_FIELDS_.CAR_MODEL]        = ['TOYOTA Camry 2022 / White'];
  namedValues[WR_FORM_FIELDS_.PLATE]            = ['プノンペン 2A-1234'];
  namedValues[WR_FORM_FIELDS_.DESIRED_DATE_1]   = ['2026-04-30'];
  namedValues[WR_FORM_FIELDS_.DESIRED_DATE_2]   = ['2026-05-02'];
  namedValues[WR_FORM_FIELDS_.TIME_SLOT]        = ['午後 13:00〜16:00 / Afternoon'];
  namedValues[WR_FORM_FIELDS_.REFERRAL_SOURCE]  = ['JICA関係者からの紹介'];
  namedValues[WR_FORM_FIELDS_.TERMS_AGREE]      = ['同意します / I agree'];
  namedValues[WR_FORM_FIELDS_.NOTES]            = ['テスト申込です'];
  handleWaterRepellentFormSubmit({ namedValues: namedValues });
}

function debugMockWaterRepellentSurveySubmit() {
  // 直近の「施工完了」モニターIDを使う
  const rows = getAllRows(SHEET_NAMES.WATER_REPELLENT);
  const completed = rows.filter(function(r) { return String(r['ステータス']) === '施工完了'; });
  const latest = completed[completed.length - 1];
  if (!latest) {
    Logger.log('⚠️ デバッグ: 施工完了のモニターが存在しません');
    return;
  }
  const namedValues = {};
  namedValues[WR_SURVEY_FIELDS_.MONITOR_ID]           = [String(latest['モニターID'])];
  namedValues[WR_SURVEY_FIELDS_.VISIBILITY]           = ['5 - とても良かった / Excellent'];
  namedValues[WR_SURVEY_FIELDS_.REPEAT_INTENT]        = ['ぜひ定期的にお願いしたい / Definitely want regular service'];
  namedValues[WR_SURVEY_FIELDS_.REFERRAL_INTENT]      = ['ぜひ紹介したい / Definitely would introduce'];
  namedValues[WR_SURVEY_FIELDS_.OWNER_REACTION]       = ['「これすごい！もっとやってくれ」と言ってました'];
  namedValues[WR_SURVEY_FIELDS_.ADDITIONAL_INTEREST]  = ['月額メンテナンスプラン / Monthly maintenance plan'];
  namedValues[WR_SURVEY_FIELDS_.FREE_TEXT]            = ['とても良かったです。雨の日が楽しみになりました。'];
  handleWaterRepellentSurveySubmit({ namedValues: namedValues });
}

function debugShowWaterRepellentStats() {
  const stats = getWaterRepellentStats();
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('💧 撥水モニター 集計');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('合計件数: ' + stats.total);
  Logger.log('ステータス別:');
  Object.keys(stats.byStatus).forEach(function(k) {
    Logger.log('  ' + k + ': ' + stats.byStatus[k]);
  });
  Logger.log('パートナー化候補: ' + stats.partnerCandidates + '名');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
}
