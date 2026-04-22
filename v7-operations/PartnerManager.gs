/**
 * PartnerManager.gs — パートナープログラム管理
 *
 * 【責務】
 *   - Google Form 経由のパートナー申請を受け付け、「パートナー」シートへ登録
 *   - パートナーID・紹介コード・無料体験コードを自動採番
 *   - 管理グループ（パートナートピック）へ承認依頼 inline keyboard を送信
 *   - 承認/却下のコールバックを処理し、結果DMを送付
 *   - 紹介履歴（referrals）のシート操作ユーティリティを提供
 *
 * 【対象パートナー】
 *   - カンボジア在住の経営者・起業家・在住日本人の協力者
 *   - コミッションは一律 30%（案件別上乗せは 備考 で管理）
 *
 * 【自動化フロー】
 *   1. 申請者が Google Form に回答
 *   2. onFormSubmit → handlePartnerFormSubmit_(e) が発火
 *   3. 「パートナー」シートに追記（ステータス=承認待ち）
 *   4. 管理グループ・パートナートピックに承認ボタン付きメッセージを送信
 *   5. Admin が ✅承認 / ❌却下 をタップ
 *   6. ステータス更新 + Welcome DM（承認時のみ）
 *
 * 【注意】
 *   - パートナーシートは openById で v7-ops スプレッドシートを対象にする
 *   - Form の送信先スプレッドシートはこれとは別。申請データは Form 側の回答シートから
 *     受け取るので、handlePartnerFormSubmit_ は e.namedValues で処理する
 */

// ====== パートナーシート列定義 ======
const PARTNER_HEADERS_ = [
  'パートナーID',       // PTR-YYMMDD-NNN
  '登録日時',            // Form送信タイムスタンプ
  '氏名',                // 本名 or 表示名
  '表示名',              // 紹介時の「XXXさんから紹介されました」に使う名前
  '国籍',                // 日本/カンボジア/その他
  '会社名',              // 自社名（任意）
  '役職',                // 代表、CEO、店長など
  'コミュニティ',        // 所属コミュニティ（ロータリー、日本人会、等）
  '電話',                // +855-xxx...
  'Telegram Username',   // @xxx（@無しで保存）
  'Telegram Chat ID',    // 承認後に判明する場合は空欄で OK
  'メール',              // email
  '紹介コード',          // SM-XXXX（本人がシェアする用）
  '無料体験コード',      // SMTRY-XXXX（お客さんへ配布できる初回割引）
  'ABA口座番号',         // 払込先
  '口座名義',            // 名義
  'コミッション率',      // 既定 30
  'ステータス',          // 承認待ち / 承認済み / 却下 / 停止
  '契約開始日',          // 承認日
  '契約終了日',          // 6ヶ月先をデフォルト
  '承認者',              // 承認したAdminの氏名
  '紹介元',              // どこで知ったか（アンケート）
  '備考'                 // 自由記述・却下理由など
];

const REFERRAL_HISTORY_HEADERS_ = [
  '紹介ID',              // REF-YYMMDD-NNN
  '登録日時',
  'パートナーID',
  'パートナー名',
  '紹介コード',
  '顧客名',              // お客さんの名前
  '顧客 Chat ID',        // 予約Botで捕捉できれば
  '予約ID',              // v7 BK-XXXXX
  '洗車日',
  '売上(USD)',
  'コミッション率',
  'コミッション額(USD)',
  '支払ステータス',      // 未払い / 支払済み
  '支払日',
  '支払方法',            // ABA / 現金 / 他
  '備考'
];

// Form質問の namedValues キー（Form側ラベルと一致させる）
// Google Form 作成時にラベルをこれと同じにすると自動マッピングされる
const PARTNER_FORM_FIELDS_ = {
  NAME:            'お名前 / Full Name',
  DISPLAY_NAME:    '表示名 / Display Name',
  NATIONALITY:     '国籍 / Nationality',
  COMPANY:         '会社名 / Company',
  TITLE:           '役職 / Title',
  COMMUNITY:       'コミュニティ・所属 / Community',
  PHONE:           '電話番号 / Phone',
  TELEGRAM:        'Telegram Username（@なし） / Telegram Username',
  EMAIL:           'メールアドレス / Email',
  ABA_ACCOUNT:     'ABA口座番号 / ABA Account Number',
  ABA_NAME:        '口座名義 / Account Name',
  CODE_HINT:       '希望する紹介コード（任意・4〜12文字英数字） / Preferred Referral Code (optional)',
  REFERRER_SOURCE: 'どこで本プログラムを知りましたか？ / How did you hear about this?',
  TERMS_AGREE:     '契約条件に同意します / I agree to the terms',
  NOTES:           '連絡事項・ご要望 / Notes'
};

// ============================================================
//  Google Form 送信ハンドラ
// ============================================================

/**
 * Google Form の onFormSubmit トリガーから呼ばれるハンドラ
 *
 * e.namedValues は { 'ラベル': ['回答'] } の形式。各値を取り出してシートへ保存する。
 *
 * ★ 設定手順（Setup.gs の setupPartnerFormTrigger_ から登録）:
 *   1. Google Form を作成し、回答先スプレッドシートを v7-ops 用に設定
 *   2. GAS プロジェクトから「トリガー」→「handlePartnerFormSubmit に対する onFormSubmit」を追加
 *   3. 初回は setupPartnerFormTrigger_(formId) を実行してトリガーを一括設定
 */
function handlePartnerFormSubmit(e) {
  // 採番レース対策: ScriptLock で排他制御
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20 * 1000); // 最大20秒待機
  } catch (err) {
    Logger.log('⚠️ PartnerForm: Lock 取得失敗 — 処理継続するが採番衝突リスクあり: ' + err);
  }

  try {
    const values = (e && e.namedValues) || {};
    const get = function(key) {
      const v = values[key];
      if (!v) return '';
      return String((Array.isArray(v) ? v[0] : v) || '').trim();
    };

    // 入力抽出
    const name          = get(PARTNER_FORM_FIELDS_.NAME);
    const displayName   = get(PARTNER_FORM_FIELDS_.DISPLAY_NAME) || name;
    const nationality   = get(PARTNER_FORM_FIELDS_.NATIONALITY);
    const company       = get(PARTNER_FORM_FIELDS_.COMPANY);
    const title         = get(PARTNER_FORM_FIELDS_.TITLE);
    const community     = get(PARTNER_FORM_FIELDS_.COMMUNITY);
    const phone         = get(PARTNER_FORM_FIELDS_.PHONE);
    const telegram      = sanitizeTelegramUsername_(get(PARTNER_FORM_FIELDS_.TELEGRAM));
    const email         = get(PARTNER_FORM_FIELDS_.EMAIL);
    const abaAccount    = get(PARTNER_FORM_FIELDS_.ABA_ACCOUNT);
    const abaName       = get(PARTNER_FORM_FIELDS_.ABA_NAME);
    const codeHint      = get(PARTNER_FORM_FIELDS_.CODE_HINT);
    const source        = get(PARTNER_FORM_FIELDS_.REFERRER_SOURCE);
    const agree         = get(PARTNER_FORM_FIELDS_.TERMS_AGREE);
    const notes         = get(PARTNER_FORM_FIELDS_.NOTES);

    // バリデーション
    if (!name) {
      Logger.log('⚠️ PartnerForm: 氏名が空のため処理中断');
      return;
    }
    // 「同意欄が空」のみ中断。文面はフォーム側で必須化しているので存在すれば同意済みとみなす
    if (!agree) {
      Logger.log('⚠️ PartnerForm: 契約条件に未同意のため処理中断（name=' + name + '）');
      return;
    }

    // ID・コード採番（Lock 内で実行済み）
    const partnerId    = generatePartnerId_();
    const referralCode = generateReferralCode_(codeHint || displayName || name);
    const trialCode    = generateTrialVoucherCode_(referralCode);

    // 契約期間（承認時点で 6ヶ月）は承認時に埋める（申請時は空）
    appendRow(SHEET_NAMES.PARTNERS, {
      'パートナーID':       partnerId,
      '登録日時':           new Date(),
      '氏名':               name,
      '表示名':             displayName,
      '国籍':               nationality,
      '会社名':             company,
      '役職':               title,
      'コミュニティ':       community,
      '電話':               phone,
      'Telegram Username':  telegram,
      'Telegram Chat ID':   '',
      'メール':             email,
      '紹介コード':         referralCode,
      '無料体験コード':     trialCode,
      'ABA口座番号':        abaAccount,
      '口座名義':           abaName,
      'コミッション率':     30,
      'ステータス':         '承認待ち',
      '契約開始日':         '',
      '契約終了日':         '',
      '承認者':             '',
      '紹介元':             source,
      '備考':               notes
    });

    Logger.log('✅ パートナー申請登録: ' + partnerId + ' ' + name);

    // Lock を早めに解放（Telegram 送信は外で OK）
    try { lock.releaseLock(); } catch (_e) { /* ignore */ }

    // 管理グループに承認ボタン付きで通知
    notifyPartnerApplicationForApproval_(partnerId);

  } catch (err) {
    Logger.log('❌ handlePartnerFormSubmit: ' + err + '\n' + (err && err.stack));
  } finally {
    try { lock.releaseLock(); } catch (_e) { /* すでに解放済なら無視 */ }
  }
}

// ============================================================
//  ID / コード採番
// ============================================================

/**
 * パートナーIDを採番
 *   形式: PTR-YYMMDD-NNN
 */
function generatePartnerId_() {
  const dateStr = Utilities.formatDate(new Date(), OPS_TZ, 'yyMMdd');
  const headPrefix = 'PTR-' + dateStr + '-';
  const rows = getAllRows(SHEET_NAMES.PARTNERS);
  let maxSeq = 0;
  rows.forEach(function(r) {
    const id = String(r['パートナーID'] || '');
    if (id.indexOf(headPrefix) === 0) {
      const seq = parseInt(id.substring(headPrefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  return headPrefix + ('00' + (maxSeq + 1)).slice(-3);
}

/**
 * 紹介コードを採番
 *   - 希望コードがあれば最優先（英数字4〜12文字、重複なし）
 *   - それ以外は名前の先頭英字から生成 → 重複なければそのまま
 *
 * 形式: SM-XXXX（例: SM-YAMADA, SM-JOHN）
 */
function generateReferralCode_(hint) {
  const existing = getAllRows(SHEET_NAMES.PARTNERS).map(function(r) {
    return String(r['紹介コード'] || '').toUpperCase();
  });
  const isAvail = function(code) { return code && existing.indexOf(code.toUpperCase()) < 0; };

  // 1. ヒント正規化
  const normalized = String(hint || '')
    .replace(/[^A-Za-z0-9\u3040-\u30FF\u4E00-\u9FFF]/g, '')   // 記号除去（カナ漢字も一旦残す）
    .toUpperCase();

  // 英数字だけ抽出（カナ・漢字は BASE→ローマ字変換できないので切る）
  let alnumOnly = normalized.replace(/[^A-Z0-9]/g, '');

  // 英数字4〜12文字の場合はそのまま候補に
  if (alnumOnly.length >= 4 && alnumOnly.length <= 12) {
    const candidate = 'SM-' + alnumOnly;
    if (isAvail(candidate)) return candidate;

    // 重複なら末尾に2桁追加
    for (let i = 2; i < 100; i++) {
      const c = 'SM-' + alnumOnly + ('0' + i).slice(-2);
      if (isAvail(c)) return c;
    }
  }

  // フォールバック: ランダム6桁英数字
  for (let i = 0; i < 50; i++) {
    const rnd = randomAlnum_(6);
    const c = 'SM-' + rnd;
    if (isAvail(c)) return c;
  }
  // 究極フォールバック
  return 'SM-' + Utilities.formatDate(new Date(), OPS_TZ, 'yyMMddHHmm');
}

/**
 * 無料体験コード採番
 *   形式: {prefix}-XXXX（prefix は Config の PARTNER_TRIAL_VOUCHER_PREFIX 既定 SMTRY）
 *   紹介コードと紐付けて、使用時にパートナーの成果として計上できるようにする
 *   既存の体験コードと重複しないことを保証する（最大50回リトライ）
 */
function generateTrialVoucherCode_(referralCode) {
  const cfg = getConfig();
  const prefix = (cfg.partnerTrialVoucherPrefix || 'SMTRY').toUpperCase();
  const existing = getAllRows(SHEET_NAMES.PARTNERS).map(function(r) {
    return String(r['無料体験コード'] || '').toUpperCase();
  });
  const isAvail = function(code) { return code && existing.indexOf(code.toUpperCase()) < 0; };

  const tail = String(referralCode || '').replace(/^SM-/i, '').substring(0, 6).toUpperCase();
  for (let i = 0; i < 50; i++) {
    const random = randomAlnum_(3);
    const candidate = prefix + '-' + (tail || randomAlnum_(4)) + random;
    if (isAvail(candidate)) return candidate;
  }
  // 究極フォールバック（タイムスタンプで一意化）
  return prefix + '-' + Utilities.formatDate(new Date(), OPS_TZ, 'yyMMddHHmmss');
}

function randomAlnum_(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 見間違えやすい 0,O,1,I を除外
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function sanitizeTelegramUsername_(raw) {
  return String(raw || '').replace(/^@+/, '').trim();
}

// ============================================================
//  管理グループへの承認依頼
// ============================================================

function notifyPartnerApplicationForApproval_(partnerId) {
  const cfg = getConfig();
  const row = findRow(SHEET_NAMES.PARTNERS, 'パートナーID', partnerId);
  if (!row) { Logger.log('⚠️ notifyPartnerApplicationForApproval_: 未発見 ' + partnerId); return; }
  const p = row.data;

  // 送信先（パートナートピック指定がなければタスクトピック or デイリーレポートへフォールバック）
  const threadId = cfg.adminPartnerThreadId || cfg.adminTaskThreadId || cfg.adminDailyReportThreadId || '';

  const lines = [
    '🤝 <b>新規パートナー申請</b>',
    '━━━━━━━━━━━━━━━━━━',
    '🆔 ' + escapeHtml_(partnerId),
    '👤 ' + escapeHtml_(p['氏名'] || '') +
           (p['表示名'] && p['表示名'] !== p['氏名'] ? '（' + escapeHtml_(p['表示名']) + '）' : ''),
    p['国籍']         ? '🌐 ' + escapeHtml_(p['国籍']) : '',
    p['会社名']       ? '🏢 ' + escapeHtml_(p['会社名']) + (p['役職'] ? ' / ' + escapeHtml_(p['役職']) : '') : '',
    p['コミュニティ'] ? '🪢 ' + escapeHtml_(p['コミュニティ']) : '',
    p['電話']         ? '📞 ' + escapeHtml_(p['電話']) : '',
    p['Telegram Username']
                       ? '✈️ @' + escapeHtml_(p['Telegram Username'])
                       : '',
    p['メール']       ? '✉️ ' + escapeHtml_(p['メール']) : '',
    '',
    '🔑 紹介コード: <code>' + escapeHtml_(p['紹介コード']) + '</code>',
    '🎟️ 体験コード: <code>' + escapeHtml_(p['無料体験コード']) + '</code>',
    '💰 コミッション率: ' + (p['コミッション率'] || 30) + '%',
    p['紹介元']       ? '📣 きっかけ: ' + escapeHtml_(p['紹介元']) : '',
    p['備考']         ? '📝 ' + escapeHtml_(String(p['備考']).substring(0, 200)) : ''
  ].filter(Boolean);

  const kb = [[
    { text: '✅ 承認する',   callback_data: 'partner_approve:' + partnerId },
    { text: '❌ 却下する',   callback_data: 'partner_reject:' + partnerId }
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
//  承認 / 却下 コールバック
// ============================================================

/**
 * コールバック処理（TaskManager.handleTaskCallback_ から派遣）
 *   data: partner_approve:PTR-XXX | partner_reject:PTR-XXX
 */
function handlePartnerCallback_(cb) {
  const data = String(cb.data || '');
  const cbId = cb.id;

  if (data.indexOf('partner_approve:') === 0) {
    const pid = data.substring('partner_approve:'.length);
    const res = approvePartner(pid, cb.from);
    const tip = res.ok ? '✅ 承認しました' : ('⚠️ ' + (res.error || '失敗'));
    answerCallbackQuery(BOT_TYPE.INTERNAL, cbId, { text: tip });
    if (res.ok) editPartnerApprovalMessage_(cb, 'approved', pid);
    return true;
  }
  if (data.indexOf('partner_reject:') === 0) {
    const pid = data.substring('partner_reject:'.length);
    const res = rejectPartner(pid, cb.from);
    const tip = res.ok ? '❌ 却下しました' : ('⚠️ ' + (res.error || '失敗'));
    answerCallbackQuery(BOT_TYPE.INTERNAL, cbId, { text: tip });
    if (res.ok) editPartnerApprovalMessage_(cb, 'rejected', pid);
    return true;
  }
  return false;
}

function editPartnerApprovalMessage_(cb, result, partnerId) {
  // 承認/却下後はボタンを無効化し、結果の追記を試みる（2度押し防止）
  try {
    // 古い callback で cb.message が欠落することがある
    if (!cb || !cb.message || !cb.message.chat) {
      Logger.log('ℹ️ editPartnerApprovalMessage_: cb.message 欠落のためスキップ');
      return;
    }

    // Plain text で置換（元メッセージは HTML で送ったが cb.message.text はプレーンなので
    // HTML モードで再送すると 400 になるリスクがある → parse_mode なしの純テキストで送る）
    const actor = cb.from || {};
    const actorName = actor.username ? '@' + actor.username : (actor.first_name || '?');
    const iconLine = result === 'approved' ? '✅ 承認済み' : '❌ 却下';
    const stamp = Utilities.formatDate(new Date(), OPS_TZ, 'yyyy-MM-dd HH:mm');

    const original = String(cb.message.text || '');
    const newText = original +
      '\n━━━━━━━━━━━━━━━━━━\n' +
      iconLine + ' by ' + actorName + '（' + stamp + '）';

    const payload = {
      chat_id: cb.message.chat.id,
      message_id: cb.message.message_id,
      text: newText,
      reply_markup: { inline_keyboard: [] }
    };
    if (cb.message.message_thread_id) payload.message_thread_id = cb.message.message_thread_id;

    callTelegramApi(BOT_TYPE.INTERNAL, 'editMessageText', payload);
  } catch (err) {
    Logger.log('⚠️ editPartnerApprovalMessage_: ' + err);
  }
}

/**
 * パートナー承認
 *   - ステータスを「承認済み」に
 *   - 契約期間（6ヶ月）を埋める
 *   - 承認者を記録
 *   - 申請者に Welcome DM（Telegram username が判っていれば、Chat ID が後で分かる想定で Username 使用不可）
 *     → Telegram は Username→send 不可なので、申請者が予約Botや業務Botに初回アクセス時に chat_id を紐付ける運用
 *     → 本関数では Chat ID が埋まっていれば DM、無ければ管理者にメール/電話フォロー指示を出す
 */
function approvePartner(partnerId, actor) {
  const row = findRow(SHEET_NAMES.PARTNERS, 'パートナーID', partnerId);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  if (String(row.data['ステータス']) === '承認済み') {
    return { ok: false, error: 'ALREADY_APPROVED' };
  }

  const today = new Date();
  const endDate = new Date(today.getTime());
  endDate.setMonth(endDate.getMonth() + 6);
  const fmt = function(d) { return Utilities.formatDate(d, OPS_TZ, 'yyyy-MM-dd'); };

  const actorName = actor
    ? (actor.username ? '@' + actor.username : (actor.first_name || '?'))
    : '?';

  updateRow(SHEET_NAMES.PARTNERS, row.row, {
    'ステータス':    '承認済み',
    '契約開始日':    fmt(today),
    '契約終了日':    fmt(endDate),
    '承認者':        actorName
  });

  // Welcome DM（Chat ID が既に判っている場合のみ）
  try {
    sendPartnerWelcomeDm_(partnerId);
  } catch (err) {
    Logger.log('⚠️ sendPartnerWelcomeDm_: ' + err);
  }

  return { ok: true, partnerId: partnerId };
}

function rejectPartner(partnerId, actor) {
  const row = findRow(SHEET_NAMES.PARTNERS, 'パートナーID', partnerId);
  if (!row) return { ok: false, error: 'NOT_FOUND' };
  if (String(row.data['ステータス']) === '却下') return { ok: false, error: 'ALREADY_REJECTED' };

  const actorName = actor
    ? (actor.username ? '@' + actor.username : (actor.first_name || '?'))
    : '?';
  updateRow(SHEET_NAMES.PARTNERS, row.row, {
    'ステータス': '却下',
    '承認者':     actorName
  });
  return { ok: true, partnerId: partnerId };
}

// ============================================================
//  Welcome DM（承認時の自動配信）
// ============================================================

/**
 * パートナーへ Welcome DM を送信
 *   - Chat ID が埋まっていれば直接 DM
 *   - 埋まっていない場合は管理トピックに「Chat ID 未登録のため手動送付が必要」と通知
 */
function sendPartnerWelcomeDm_(partnerId) {
  const row = findRow(SHEET_NAMES.PARTNERS, 'パートナーID', partnerId);
  if (!row) return;
  const p = row.data;

  const chatId = String(p['Telegram Chat ID'] || '').trim();
  const text = buildPartnerWelcomeText_(p);

  if (chatId) {
    const res = sendMessage(BOT_TYPE.INTERNAL, chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: false
    });
    if (!res || !res.ok) {
      Logger.log('⚠️ Welcome DM 送信失敗 (chat_id=' + chatId + '): ' + JSON.stringify(res));
      notifyAdminPartnerDmFailed_(partnerId, 'DM送信失敗');
    }
    return;
  }

  // Chat ID 未登録 → 管理グループに Username 案内をポスト
  notifyAdminPartnerDmFailed_(partnerId, 'Chat ID 未登録（手動でフォロー要）');
}

function notifyAdminPartnerDmFailed_(partnerId, reason) {
  const cfg = getConfig();
  const threadId = cfg.adminPartnerThreadId || cfg.adminTaskThreadId || '';
  const row = findRow(SHEET_NAMES.PARTNERS, 'パートナーID', partnerId);
  if (!row) return;
  const p = row.data;
  const lines = [
    '⚠️ <b>Welcome DM 未送信</b>',
    '━━━━━━━━━━━━━━━━━━',
    '🆔 ' + escapeHtml_(partnerId) + ' / ' + escapeHtml_(p['氏名'] || ''),
    p['Telegram Username'] ? '✈️ @' + escapeHtml_(p['Telegram Username']) : '',
    p['電話']              ? '📞 ' + escapeHtml_(p['電話']) : '',
    p['メール']            ? '✉️ ' + escapeHtml_(p['メール']) : '',
    '',
    '理由: ' + escapeHtml_(reason),
    '対応: @' + escapeHtml_(p['Telegram Username'] || '（未登録）') + ' へ手動で Welcome 送付し、Chat ID を後でシートに記入してください。'
  ].filter(Boolean);
  const opts = { parse_mode: 'HTML' };
  if (threadId) opts.message_thread_id = Number(threadId);
  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), opts);
}

function buildPartnerWelcomeText_(p) {
  const cfg = getConfig();
  const kitLine = cfg.partnerWelcomeKitUrl
    ? '\n📎 Welcome Kit: ' + cfg.partnerWelcomeKitUrl
    : '';

  return [
    '🎉 <b>Welcome to the Samurai Motors Partner Program</b>',
    'ようこそ Samurai Motors パートナープログラムへ',
    '━━━━━━━━━━━━━━━━━━',
    '',
    '<b>' + escapeHtml_(p['表示名'] || p['氏名']) + ' さん</b>',
    'ご申請ありがとうございます。パートナー登録が承認されました。',
    '',
    '<b>🆔 あなたのパートナーID</b>',
    '<code>' + escapeHtml_(p['パートナーID']) + '</code>',
    '',
    '<b>🔑 紹介コード（ご自身でシェア）</b>',
    '<code>' + escapeHtml_(p['紹介コード']) + '</code>',
    '→ お客さまがご予約時にこのコードをお伝えいただくと、売上がパートナー実績として記録されます。',
    '',
    '<b>🎟️ 無料体験コード（お客さまへの配布用）</b>',
    '<code>' + escapeHtml_(p['無料体験コード']) + '</code>',
    '→ お客さまの初回ご利用時の特別割引に使えます。紹介時の「お土産」としてご活用ください。',
    '',
    '<b>💰 コミッション</b>',
    '売上の ' + (p['コミッション率'] || 30) + '% を月末締め・翌月 ABA 送金',
    '',
    '<b>📅 契約期間</b>',
    (p['契約開始日'] || '') + ' ～ ' + (p['契約終了日'] || '') + '（自動更新）',
    '',
    '<b>📝 大切なご案内</b>',
    '・コミッションは「紹介コード経由の予約が完了・清算済みになった売上」を対象とします',
    '・お客さまが複数回ご利用された場合は「初回ご利用分のみ」対象です',
    '・紹介コードを公にSNSで広く拡散する行為はご遠慮ください（1対1での紹介が理想）',
    '',
    '<b>🙋 ご不明点</b>',
    '管理者（飯泉）まで直接ご連絡ください。',
    kitLine,
    '',
    '今後ともよろしくお願いいたします！'
  ].join('\n');
}

// ============================================================
//  参照用クエリ
// ============================================================

/**
 * 有効なパートナー一覧（承認済みのみ）
 */
function getActivePartners() {
  const rows = getAllRows(SHEET_NAMES.PARTNERS);
  return rows.filter(function(r) { return String(r['ステータス']) === '承認済み'; });
}

/**
 * 紹介コードからパートナー検索（大文字小文字ゆらぎ対応）
 */
function findPartnerByCode(code) {
  const target = String(code || '').trim().toUpperCase();
  if (!target) return null;
  const rows = getAllRows(SHEET_NAMES.PARTNERS);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]['紹介コード'] || '').toUpperCase() === target) return rows[i];
    if (String(rows[i]['無料体験コード'] || '').toUpperCase() === target) return rows[i];
  }
  return null;
}

/**
 * Telegram Username（@ なし）からパートナー検索
 */
function findPartnerByTelegramUsername(username) {
  const target = sanitizeTelegramUsername_(username).toLowerCase();
  if (!target) return null;
  const rows = getAllRows(SHEET_NAMES.PARTNERS);
  for (let i = 0; i < rows.length; i++) {
    if (sanitizeTelegramUsername_(rows[i]['Telegram Username']).toLowerCase() === target) return rows[i];
  }
  return null;
}

/**
 * Telegram Chat ID からパートナー検索
 */
function findPartnerByChatId(chatId) {
  const target = String(chatId || '').trim();
  if (!target) return null;
  const rows = getAllRows(SHEET_NAMES.PARTNERS);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i]['Telegram Chat ID'] || '').trim() === target) return rows[i];
  }
  return null;
}

// ============================================================
//  紹介履歴 API（後続 Phase: 紹介実績の記録）
// ============================================================

/**
 * 紹介履歴シートに1件追記（コミッション対象発生時）
 * @param {Object} data { partnerId, partnerName, referralCode, customerName, customerChatId, bookingId, serviceDate, revenue, commissionRate, memo }
 */
function recordReferralHistory(data) {
  const rate = Number(data.commissionRate || 30);
  const commission = Math.round(Number(data.revenue || 0) * rate / 100 * 100) / 100;
  const id = generateReferralId_();
  appendRow(SHEET_NAMES.REFERRAL_HISTORY, {
    '紹介ID':              id,
    '登録日時':            new Date(),
    'パートナーID':        data.partnerId || '',
    'パートナー名':        data.partnerName || '',
    '紹介コード':          data.referralCode || '',
    '顧客名':              data.customerName || '',
    '顧客 Chat ID':        data.customerChatId || '',
    '予約ID':              data.bookingId || '',
    '洗車日':              data.serviceDate || '',
    '売上(USD)':           Number(data.revenue || 0),
    'コミッション率':      rate,
    'コミッション額(USD)': commission,
    '支払ステータス':      '未払い',
    '支払日':              '',
    '支払方法':            '',
    '備考':                data.memo || ''
  });
  Logger.log('✅ 紹介履歴記録: ' + id + ' partner=' + data.partnerId + ' commission=' + commission);
  return id;
}

function generateReferralId_() {
  const dateStr = Utilities.formatDate(new Date(), OPS_TZ, 'yyMMdd');
  const headPrefix = 'REF-' + dateStr + '-';
  const rows = getAllRows(SHEET_NAMES.REFERRAL_HISTORY);
  let maxSeq = 0;
  rows.forEach(function(r) {
    const id = String(r['紹介ID'] || '');
    if (id.indexOf(headPrefix) === 0) {
      const seq = parseInt(id.substring(headPrefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
  });
  return headPrefix + ('00' + (maxSeq + 1)).slice(-3);
}

// ============================================================
//  デバッグ
// ============================================================

/**
 * デバッグ用: 直近のパートナー申請を強制通知（承認ボタン付き）
 */
function debugResendLatestPartnerApproval() {
  const rows = getAllRows(SHEET_NAMES.PARTNERS);
  const pending = rows.filter(function(r) { return String(r['ステータス']) === '承認待ち'; });
  if (pending.length === 0) {
    Logger.log('ℹ️ 承認待ちのパートナー申請はありません');
    return;
  }
  const latest = pending[pending.length - 1];
  notifyPartnerApplicationForApproval_(String(latest['パートナーID']));
  Logger.log('✅ 再通知: ' + latest['パートナーID']);
}

/**
 * デバッグ用: フォーム投稿を手動で模擬する（本番 Form を叩かずにテスト）
 */
function debugMockPartnerFormSubmit() {
  const namedValues = {};
  namedValues[PARTNER_FORM_FIELDS_.NAME]            = ['山田 太郎'];
  namedValues[PARTNER_FORM_FIELDS_.DISPLAY_NAME]    = ['ヤマダ'];
  namedValues[PARTNER_FORM_FIELDS_.NATIONALITY]     = ['日本'];
  namedValues[PARTNER_FORM_FIELDS_.COMPANY]         = ['Test Corp'];
  namedValues[PARTNER_FORM_FIELDS_.TITLE]           = ['CEO'];
  namedValues[PARTNER_FORM_FIELDS_.COMMUNITY]       = ['日本人会'];
  namedValues[PARTNER_FORM_FIELDS_.PHONE]           = ['+855 12 345 678'];
  namedValues[PARTNER_FORM_FIELDS_.TELEGRAM]        = ['@yamada'];
  namedValues[PARTNER_FORM_FIELDS_.EMAIL]           = ['test@example.com'];
  namedValues[PARTNER_FORM_FIELDS_.ABA_ACCOUNT]     = ['123456789'];
  namedValues[PARTNER_FORM_FIELDS_.ABA_NAME]        = ['YAMADA TARO'];
  namedValues[PARTNER_FORM_FIELDS_.CODE_HINT]       = ['YAMADA'];
  namedValues[PARTNER_FORM_FIELDS_.REFERRER_SOURCE] = ['飯泉さんから'];
  namedValues[PARTNER_FORM_FIELDS_.TERMS_AGREE]     = ['同意します'];
  namedValues[PARTNER_FORM_FIELDS_.NOTES]           = ['テスト申請です'];
  handlePartnerFormSubmit({ namedValues: namedValues });
}
