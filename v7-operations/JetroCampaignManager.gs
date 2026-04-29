/**
 * JetroCampaignManager.gs — Samurai Motors 開業記念 × 雨季前
 *                           窓ガラス撥水加工 無料体験キャンペーン
 *
 * 【責務】
 *   - 日系駐在員向け予約 Google Form の生成
 *   - フォーム送信時の処理:
 *     - 予約をシート記録(JETROキャンペーン予約 シート)
 *     - Admin グループへ Telegram 通知(業務 Bot 経由)
 *     - 現地スタッフ(ロン君)個人へ Telegram 通知(業務 Bot 経由)
 *
 * 【お客様はBotを触らない・メールも送らない】
 *   - Google Form のみで完結
 *   - 送信完了画面には弊社現地スタッフの Telegram 連絡先と場所のみ表示
 *   - 駐在員は自身の言葉でドライバーに伝える(クメール語テンプレなし)
 *   - ドライバーは現地スタッフに Telegram で直接連絡し、時刻を調整する
 *
 * 【表記の方針】
 *   - 顧客向けの表示は「弊社現地スタッフ」「Samurai Motors」(レターと統一)
 *   - 内部識別子(関数名・定数名・ファイル名・流入経路タグ)は JETRO のまま
 *     (キャンペーンの起点が JETRO 経由のため)
 *
 * 【シート】
 *   SHEET_NAMES.JETRO_BOOKINGS = 'JETROキャンペーン予約'
 *
 * 【1度だけ実行する関数】
 *   setupJetroCampaign() — Form 自動生成 + onFormSubmit トリガー設定
 *   出力: 回答用URL(レター掲載用ディープリンク) + 編集用URL
 *
 * 【既存フォームの文言更新(URLを変えずに反映)】
 *   updateJetroFormText() — タイトル/説明/送信完了メッセージなどを書き換え
 *
 * 【手動テスト】
 *   debugNotifyJetroTest()     — Admin/現地スタッフ 通知確認
 */

// ============================================================
//  定数
// ============================================================

const JETRO_FORM_TITLE = 'Samurai Motors 開業記念 × 雨季前 窓ガラス撥水加工 無料体験キャンペーン';
const JETRO_FORM_DESCRIPTION =
  'プノンペン日系コミュニティの皆様へ、Samurai Motors 開業記念のご案内です。\n' +
  '雨季の安全運転にお役立ていただける「窓ガラス撥水加工」を、無料でご体験ください。\n\n' +
  '【施工内容】無料 窓ガラス撥水加工(フロントガラス + 左右サイドガラス + サイドミラー / 計4面)\n' +
  '【場所】Samurai Motors 事務所(プノンペン市トゥールコーク)\n' +
  '【対象】日系駐在員の皆様、先着30台限定\n' +
  '【期間】2026年5月1日(木) 〜 5月30日(土) ※日曜日を除く\n' +
  '【費用】無料(材料・作業すべて含む)\n\n' +
  '※ 具体的な時刻は、ご予約後にドライバー様と弊社現地スタッフが Telegram にて直接調整いたします。';

const JETRO_PLAN_LABEL = '無料 窓ガラス撥水加工(フロントガラス + 左右サイドガラス + サイドミラー / 計4面)';
const JETRO_OFFICE_NAME = 'Samurai Motors 事務所';
const JETRO_OFFICE_MAP_URL = 'https://maps.app.goo.gl/U2ktnZMmbzJVhXep7';
const JETRO_RON_PHONE = '096 713 8456';
const JETRO_DEFAULT_SOURCE = 'jetro2026';

const JETRO_BOOKING_HEADERS_ = [
  '予約ID',
  '申込日時',
  '希望日',
  '流入経路',
  '氏名',
  '会社名',
  '役職',
  '駐在員 Telegram',
  'ドライバー Telegram',
  'ステータス',
  '確定時刻',
  '車両情報',
  '施工: 窓フロント3面',
  '施工: ミラー',
  'ロン君メモ'
];

// ============================================================
//  シート準備
// ============================================================

/**
 * JETROキャンペーン予約シートが無ければ作成する
 */
function ensureJetroBookingSheet() {
  const cfg = getConfig();
  const ss = SpreadsheetApp.openById(cfg.operationsSpreadsheetId);
  let sheet = ss.getSheetByName(SHEET_NAMES.JETRO_BOOKINGS);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.JETRO_BOOKINGS);
    sheet.getRange(1, 1, 1, JETRO_BOOKING_HEADERS_.length).setValues([JETRO_BOOKING_HEADERS_]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, JETRO_BOOKING_HEADERS_.length)
      .setFontWeight('bold')
      .setBackground('#1f3a1f')
      .setFontColor('#e8f0e8');
    sheet.setColumnWidth(1, 160);   // 予約ID
    sheet.setColumnWidth(2, 160);   // 申込日時
    sheet.setColumnWidth(3, 130);   // 希望日
    sheet.setColumnWidth(5, 140);   // 氏名
    sheet.setColumnWidth(6, 200);   // 会社名
    sheet.setColumnWidth(7, 160);   // 役職
    sheet.setColumnWidth(11, 130);  // 確定時刻
    sheet.setColumnWidth(12, 200);  // 車両情報
    sheet.setColumnWidth(15, 240);  // メモ
    Logger.log('✅ JETROキャンペーン予約シート 作成');
  } else {
    const lastCol = sheet.getLastColumn() || 1;
    const existing = sheet.getRange(1, 1, 1, Math.max(lastCol, JETRO_BOOKING_HEADERS_.length)).getValues()[0];
    let needs = false;
    JETRO_BOOKING_HEADERS_.forEach(function(h, i) { if (existing[i] !== h) needs = true; });
    if (needs) {
      sheet.getRange(1, 1, 1, JETRO_BOOKING_HEADERS_.length).setValues([JETRO_BOOKING_HEADERS_]);
      Logger.log('♻️ JETROキャンペーン予約シート ヘッダー整備');
    } else {
      Logger.log('ℹ️ JETROキャンペーン予約シート 変更なし');
    }
  }
}

// ============================================================
//  キャンペーン初期セットアップ(1 度だけ実行)
// ============================================================

/**
 * Google Form を自動生成し、onFormSubmit トリガーを設定する
 * 完了後、ログに以下を出力:
 *   - フォーム回答用URL(レター掲載用)
 *   - フォーム編集用URL
 *   - プレフィル付きURL(jetro2026 タグ自動付与)
 *
 * @return {{publishedUrl:string, editUrl:string, prefilledUrl:string}}
 */
function setupJetroCampaign() {
  ensureJetroBookingSheet();

  const form = FormApp.create(JETRO_FORM_TITLE);
  form.setDescription(JETRO_FORM_DESCRIPTION);
  form.setCollectEmail(false);
  form.setLimitOneResponsePerUser(false);      // 認証なしで誰でも回答可
  form.setShowLinkToRespondAgain(false);

  // ===== 送信完了メッセージ =====
  // レターの STEP 2 と同じ言い回しで、駐在員はそのままドライバーへ伝達できる。
  form.setConfirmationMessage(buildJetroConfirmationMessage_());

  // ===== 設問 =====

  // Q1: 希望日
  form.addDateItem()
    .setTitle('ご希望日')
    .setHelpText('施工をご希望の日付をお選びください。具体的な時刻は、ご予約後にドライバー様と弊社現地スタッフが Telegram で直接調整いたします。')
    .setRequired(true);

  // Q2: 氏名
  form.addTextItem()
    .setTitle('お名前')
    .setHelpText('例: 鈴木 太郎')
    .setRequired(true);

  // Q3: 会社名
  form.addTextItem()
    .setTitle('会社名')
    .setHelpText('所属されている企業名をご記入ください。')
    .setRequired(true);

  // Q4: 役職
  form.addTextItem()
    .setTitle('役職')
    .setHelpText('例: 代表 / 事業部長 / 駐在員')
    .setRequired(true);

  // Q5: 駐在員 Telegram
  form.addTextItem()
    .setTitle('お客様の Telegram')
    .setHelpText('@your_username またはリンク https://t.me/your_username の形式でご入力ください。Telegram のプロフィール画面で確認いただけます。')
    .setRequired(true);

  // Q6: ドライバー Telegram
  form.addTextItem()
    .setTitle('ドライバー様の Telegram')
    .setHelpText('ドライバー様の @username またはリンクをご入力ください。')
    .setRequired(true);

  // 施工内容・場所・マップはフォーム冒頭の説明文に集約。
  // 流入経路は廃止し、すべての申込を JETRO_DEFAULT_SOURCE 固定で記録する。

  // ===== Form ID を Script Properties に保存 =====
  const formId = form.getId();
  const publishedUrl = form.getPublishedUrl();
  const editUrl = form.getEditUrl();

  PropertiesService.getScriptProperties().setProperties({
    [CONFIG_KEYS.JETRO_FORM_ID]:  formId,
    [CONFIG_KEYS.JETRO_FORM_URL]: publishedUrl
  });

  // ===== onFormSubmit トリガー =====
  // 既存の同名トリガーは削除してから作成(冪等)
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'handleJetroFormSubmit') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('handleJetroFormSubmit')
    .forForm(form)
    .onFormSubmit()
    .create();

  Logger.log('================================');
  Logger.log('キャンペーン セットアップ完了');
  Logger.log('================================');
  Logger.log('【フォーム回答用URL(レター掲載用)】');
  Logger.log(publishedUrl);
  Logger.log('  → このURLからの申込は流入経路 = ' + JETRO_DEFAULT_SOURCE + ' として自動記録');
  Logger.log('');
  Logger.log('【編集用URL(設問の微修正用)】');
  Logger.log(editUrl);
  Logger.log('================================');

  return { publishedUrl: publishedUrl, editUrl: editUrl };
}

/**
 * フォーム送信完了画面に表示するメッセージ。
 * レターの STEP 2 と同じ言い回しで揃える。
 */
function buildJetroConfirmationMessage_() {
  return [
    'ご予約承りました。',
    '',
    '【ドライバー様にお伝えください】',
    '弊社現地スタッフ(Telegram: ' + JETRO_RON_PHONE + ')までご連絡のうえ、',
    '「Samurai Motors と時間を調整してほしい」とご指示ください。',
    '',
    '以降、ドライバー様と弊社現地スタッフがクメール語で直接やり取りし、',
    'ご都合に合わせて施工時刻を確定いたします。',
    '',
    '場所: ' + JETRO_OFFICE_NAME,
    'マップ: ' + JETRO_OFFICE_MAP_URL
  ].join('\n');
}

/**
 * 既存フォームの文言を一括更新する(URLは変わらない)。
 *  - タイトル / 説明 / 送信完了メッセージ
 *  - 希望日設問のヘルプテキスト
 *  - 施工内容セクションヘッダーのヘルプテキスト
 *
 * 想定: setupJetroCampaign 実行後、文面だけ調整したい時に使う。
 */
function updateJetroFormText() {
  const cfg = getConfig();
  if (!cfg.jetroFormId) {
    Logger.log('⚠️ JETRO_FORM_ID 未登録。先に setupJetroCampaign を実行してください。');
    return;
  }
  const form = FormApp.openById(cfg.jetroFormId);

  // タイトル / 説明 / 送信完了メッセージ
  form.setTitle(JETRO_FORM_TITLE);
  form.setDescription(JETRO_FORM_DESCRIPTION);
  form.setConfirmationMessage(buildJetroConfirmationMessage_());

  // ヘルプ更新 + 不要フィールド(施工内容セクションヘッダー / 流入経路)の削除
  // 削除中に getItems() のインデックスがズレるので、削除対象を集めてから処理
  const items = form.getItems();
  const itemsToDelete = [];
  let removedSourceField = false;
  let removedPlanSection = false;

  items.forEach(function(item) {
    const type = item.getType();
    const title = item.getTitle();

    // 希望日のヘルプテキスト更新
    if (type === FormApp.ItemType.DATE && title === 'ご希望日') {
      item.asDateItem().setHelpText(
        '施工をご希望の日付をお選びください。具体的な時刻は、ご予約後にドライバー様と弊社現地スタッフが Telegram で直接調整いたします。'
      );
    }

    // 施工内容セクションヘッダー → 削除(冒頭説明文と重複)
    if (type === FormApp.ItemType.SECTION_HEADER && title === '施工内容(固定)') {
      itemsToDelete.push(item);
      removedPlanSection = true;
    }

    // 流入経路フィールド → 削除(駐在員には不要)
    if (type === FormApp.ItemType.TEXT && title === '流入経路(自動入力)') {
      itemsToDelete.push(item);
      removedSourceField = true;
    }
  });

  itemsToDelete.forEach(function(item) { form.deleteItem(item); });

  // 流入経路フィールド削除に伴い、関連 Script Property も掃除
  if (removedSourceField) {
    PropertiesService.getScriptProperties().deleteProperty(CONFIG_KEYS.JETRO_FORM_SOURCE_ENTRY);
  }

  Logger.log('================================');
  Logger.log('フォーム文言を更新しました');
  Logger.log('================================');
  Logger.log('タイトル: ' + JETRO_FORM_TITLE);
  Logger.log('場所: ' + JETRO_OFFICE_NAME);
  if (removedPlanSection) Logger.log('🗑 施工内容セクションヘッダーを削除しました');
  if (removedSourceField) Logger.log('🗑 流入経路フィールドを削除しました');
  Logger.log('================================');
  Logger.log('※ URL は変わりません。');
}

// ============================================================
//  フォーム送信ハンドラ(トリガー)
// ============================================================

/**
 * Google Form 送信時に呼ばれる
 * 1. 予約IDを採番してシート記録
 * 2. Admin グループに通知(業務Bot)
 * 3. ロン君に個別通知(業務Bot)
 * 4. 駐在員にメール送信(確認 + ドライバー転送用クメール語テンプレ)
 */
function handleJetroFormSubmit(e) {
  try {
    const responses = e.response.getItemResponses();
    const submittedAt = e.response.getTimestamp();

    // 設問順に取得(SectionHeader はレスポンスに含まれないので、有効レスポンスは 6 件)
    //   [0] 希望日(Date)
    //   [1] 氏名
    //   [2] 会社名
    //   [3] 役職
    //   [4] 駐在員 Telegram
    //   [5] ドライバー Telegram
    // DateItem.getResponse() は 'yyyy-MM-dd' 形式の文字列を返す
    // 流入経路フィールドは廃止し、固定値 JETRO_DEFAULT_SOURCE で記録する
    const desiredDate  = String(responses[0] ? responses[0].getResponse() : '').trim();
    const fullName     = String(responses[1] ? responses[1].getResponse() : '').trim();
    const companyName  = String(responses[2] ? responses[2].getResponse() : '').trim();
    const jobTitle     = String(responses[3] ? responses[3].getResponse() : '').trim();
    const expatTg      = String(responses[4] ? responses[4].getResponse() : '').trim();
    const driverTg     = String(responses[5] ? responses[5].getResponse() : '').trim();
    const source       = JETRO_DEFAULT_SOURCE;

    const bookingId = generateDateSeqId('JET', SHEET_NAMES.JETRO_BOOKINGS, '予約ID');

    // ===== シート記録 =====
    appendRow(SHEET_NAMES.JETRO_BOOKINGS, {
      '予約ID':              bookingId,
      '申込日時':            submittedAt,
      '希望日':              desiredDate,
      '流入経路':            source,
      '氏名':                fullName,
      '会社名':              companyName,
      '役職':                jobTitle,
      '駐在員 Telegram':     expatTg,
      'ドライバー Telegram': driverTg,
      'ステータス':          '未対応',
      '確定時刻':            '',
      '車両情報':            '',
      '施工: 窓フロント3面': '',
      '施工: ミラー':        '',
      'ロン君メモ':          ''
    });

    const data = {
      bookingId:   bookingId,
      submittedAt: submittedAt,
      desiredDate: desiredDate,
      fullName:    fullName,
      companyName: companyName,
      jobTitle:    jobTitle,
      expatTg:     expatTg,
      driverTg:    driverTg,
      source:      source
    };

    // ===== Telegram 通知配信(失敗しても他は止めない) =====
    try { notifyJetroAdminGroup_(data); } catch (err) { Logger.log('⚠️ JETRO admin 通知失敗: ' + err); }
    try { notifyJetroRon_(data); }       catch (err) { Logger.log('⚠️ JETRO ロン君通知失敗: ' + err); }

  } catch (err) {
    Logger.log('❌ handleJetroFormSubmit: ' + err + ' stack=' + (err.stack || ''));
  }
}

// ============================================================
//  通知(Admin グループ)
// ============================================================

function notifyJetroAdminGroup_(data) {
  const cfg = getConfig();
  const thread = cfg.adminJetroThreadId
              || cfg.adminWaterRepellentThreadId
              || cfg.adminDailyReportThreadId;
  if (!thread) {
    Logger.log('⚠️ JETRO 通知先トピック未設定、admin 通知スキップ');
    return;
  }

  const lines = [
    '🌟 <b>日系駐在員予約 (撥水キャンペーン)</b>',
    '━━━━━━━━━━━━━━━━━━',
    '🆔 ' + escapeHtml_(data.bookingId),
    '📅 希望日: <b>' + escapeHtml_(data.desiredDate) + '</b>',
    '',
    '👤 <b>' + escapeHtml_(data.fullName) + '</b> 様',
    '🏢 ' + escapeHtml_(data.companyName) + ' / ' + escapeHtml_(data.jobTitle),
    '💬 駐在員 Telegram: ' + escapeHtml_(data.expatTg),
    '🚖 ドライバー Telegram: ' + escapeHtml_(data.driverTg),
    '🏷 流入: ' + escapeHtml_(data.source),
    '',
    '施工内容: ' + escapeHtml_(JETRO_PLAN_LABEL),
    '受け入れ場所: ' + JETRO_OFFICE_NAME,
    '',
    '※ 具体的な時刻は、ロン君がドライバーと Telegram で直接調整します'
  ];

  sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, lines.join('\n'), {
    parse_mode: 'HTML',
    message_thread_id: Number(thread),
    disable_web_page_preview: true
  });
  Logger.log('📤 JETRO admin 通知送信: ' + data.bookingId);
}

// ============================================================
//  通知(ロン君個別)
// ============================================================

function notifyJetroRon_(data) {
  const cfg = getConfig();
  let chatId = cfg.ronChatId;
  if (!chatId) {
    // スタッフマスターから "ロン" さんを解決(role=field を優先)
    try {
      const allStaff = (typeof getActiveStaff === 'function') ? getActiveStaff() : [];
      const ron = allStaff.find(function(s) {
        return s && s.nameJp && s.nameJp.indexOf('ロン') >= 0;
      });
      if (ron && ron.chatId) chatId = ron.chatId;
    } catch (err) {
      Logger.log('⚠️ スタッフマスターから ロン君 解決失敗: ' + err);
    }
  }
  if (!chatId) {
    Logger.log('⚠️ ロン君 chatId 未解決、個別通知スキップ');
    return;
  }

  const lines = [
    '🛻 <b>撥水キャンペーン 予約が入りました</b>',
    '━━━━━━━━━━━━━━━━━━',
    '🆔 ' + escapeHtml_(data.bookingId),
    '📅 希望日: ' + escapeHtml_(data.desiredDate),
    '👤 ' + escapeHtml_(data.fullName) + ' 様 (' + escapeHtml_(data.companyName) + ')',
    '🚖 ドライバー: ' + escapeHtml_(data.driverTg),
    '',
    '施工: ' + escapeHtml_(JETRO_PLAN_LABEL),
    '',
    'ドライバーから直接連絡が来ます。',
    '時刻調整後、シートとカレンダーに記入してください。'
  ];

  sendMessage(BOT_TYPE.INTERNAL, chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  Logger.log('📤 JETRO ロン君通知送信: ' + data.bookingId);
}

// ============================================================
//  デバッグ(手動実行)
// ============================================================

/**
 * テスト用ダミーデータで Admin/ロン君通知を試す
 */
function debugNotifyJetroTest() {
  const data = {
    bookingId:   'JET-TEST-001',
    submittedAt: new Date(),
    desiredDate: '2026-05-01',
    fullName:    'テスト 太郎',
    companyName: 'テスト商事株式会社',
    jobTitle:    '代表',
    expatTg:     '@test_expat',
    driverTg:    '@test_driver',
    email:       'test@example.com',
    source:      JETRO_DEFAULT_SOURCE
  };
  notifyJetroAdminGroup_(data);
  notifyJetroRon_(data);
}

/**
 * 既に作成済みフォームの URL を表示(setupJetroCampaign 後の確認用)
 */
function debugShowJetroFormUrls() {
  const cfg = getConfig();
  if (!cfg.jetroFormId) {
    Logger.log('⚠️ JETRO_FORM_ID 未登録。先に setupJetroCampaign を実行してください。');
    return;
  }
  const form = FormApp.openById(cfg.jetroFormId);
  const publishedUrl = form.getPublishedUrl();
  const editUrl = form.getEditUrl();

  Logger.log('================================');
  Logger.log('キャンペーン フォーム URL');
  Logger.log('================================');
  Logger.log('回答用(レター掲載用): ' + publishedUrl);
  Logger.log('編集用: ' + editUrl);
  Logger.log('================================');
}
