/**
 * Campaign.gs — 顧客向けキャンペーン一斉送信 + 個別連絡（統合版）
 *
 * 【責務】
 *   スプレッドシートのメニューから、登録済み顧客へ予約Bot経由で
 *   - 一斉送信（テキスト / 画像 / ボイス、言語別出し分け）
 *   - 個別送信（選択行の1名へ）
 *   を行い、結果を記録する。
 *
 * 【Option A 統合 (2026-05-29)】
 *   旧 BroadcastTool.gs（📩 顧客連絡 個別送信）を本ファイルに吸収・廃止。
 *   キャンペーン系メニューを「📢 キャンペーン」1本に集約（メニュー乱立防止）。
 *
 * 【使い方】
 *   1. `setupCampaign()` を1回だけ実行
 *      → 「キャンペーン下書き」「キャンペーン配信履歴」シート生成
 *      → 「顧客」シートに「配信対象」「最終配信日時」列を追加
 *      → onOpen トリガー登録（旧📩メニューの孤立トリガーも掃除）
 *   2. スプレッドシートを開き直す
 *   3. 「キャンペーン下書き」シートに本文（＋任意で画像/ボイスのDriveリンク）を記入
 *   4. メニュー「📢 キャンペーン」→「① プレビュー」で送信先と内容を確認
 *   5. 「② 送信実行」で配信開始（最終確認ダイアログあり）
 *   6. 結果は「キャンペーン配信履歴」シートに自動記録
 *
 * 【設計方針】
 *   - 顧客接点は予約Bot1本に統一（BOT_TYPE.BOOKING を使う）
 *   - 顧客「言語」列に応じてクメール語/英語を出し分け
 *   - 「配信対象」チェックボックス=FALSE の顧客は一斉送信から除外（苦情客/ブロック客）
 *   - 50ms 間隔 = 20msg/秒 で送信（Telegram レート制限 30msg/秒 の安全圏）
 *   - 429（Too Many Requests）は retry_after に従って1回リトライ
 *   - 403（bot blocked）は履歴に「blocked」と記録して継続
 *   - 画像は既存 sendQRImage() を流用（Driveリンク/外部URL両対応）
 *   - ボイスは sendVoiceFromUrl()（sendVoice→sendAudio フォールバック）
 *   - 6分実行制限に備え、CAMPAIGN_MAX_RECIPIENTS で上限ガード
 *
 * 【2価格分離の原則（SPEC_CampaignBroadcast.md）】
 *   テレグラム限定特価（例:5ドル）は本文に手書きするのみ。
 *   料金設定/メニューシートには絶対に入れない（公開客に漏れるため）。
 */

// === シート名 ===
const CAMPAIGN_DRAFT_SHEET = 'キャンペーン下書き';
const CAMPAIGN_LOG_SHEET   = 'キャンペーン配信履歴';

// === 設定 ===
const CAMPAIGN_SEND_INTERVAL_MS = 50;   // 送信間ウェイト（20msg/秒）
const CAMPAIGN_MAX_RECIPIENTS   = 2000; // 1回の上限（6分制限の安全マージン）

// === 「送信対象」セル（B4）の選択肢 ===
const CAMPAIGN_AUDIENCE_OPTIONS = ['全員', 'クメール語のみ', '英語のみ'];

// === 下書きシートのセル位置（レイアウト変更時はここを直す） ===
const CAMPAIGN_CELL = {
  AUDIENCE:  'B4',
  TEXT_KM:   'B6',
  TEXT_EN:   'B7',
  IMAGE_URL: 'B8',
  VOICE_URL: 'B9',
  RESULT_AT:    'B13',
  RESULT_STATS: 'B14',
  RESULT_ID:    'B15'
};

// =====================================================
//  セットアップ
// =====================================================

/**
 * キャンペーン機能の初期セットアップ（1回だけ実行）
 *   - 下書き／履歴シートを作成（既存なら維持）
 *   - 顧客シートに「配信対象」「最終配信日時」列を追加（冪等）
 *   - onOpen トリガーを登録（旧 BroadcastTool の孤立トリガーも掃除）
 */
function setupCampaign() {
  ensureCampaignDraftSheet_();
  ensureCampaignLogSheet_();
  ensureCustomerBroadcastColumns_();
  setupCampaignMenu_();
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ キャンペーン機能 セットアップ完了');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('  - 「' + CAMPAIGN_DRAFT_SHEET + '」シート 準備OK');
  Logger.log('  - 「' + CAMPAIGN_LOG_SHEET + '」シート 準備OK');
  Logger.log('  - 「顧客」シートに 配信対象 / 最終配信日時 列 準備OK');
  Logger.log('  - onOpen メニュー登録済み → シートを開き直してください');
}

function setupCampaignMenu_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // 自分のトリガー + 旧 BroadcastTool の孤立トリガーを削除
  ScriptApp.getProjectTriggers().forEach(function(t) {
    const fn = t.getHandlerFunction();
    if (fn === 'campaignOnOpen_' || fn === 'broadcastMenuOnOpen_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('campaignOnOpen_')
    .forSpreadsheet(ss).onOpen().create();
  try { campaignOnOpen_(); } catch (e) { Logger.log('⚠️ onOpen 即時実行: ' + e); }
}

function campaignOnOpen_() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('📢 キャンペーン')
    .addItem('① プレビュー（送信先と内容を確認）', 'previewCampaign')
    .addItem('② 一斉送信を実行', 'sendCampaign')
    .addSeparator()
    .addItem('📤 選択した顧客に1通だけ送信', 'sendMessageToSelectedCustomer')
    .addSeparator()
    .addItem('📋 配信履歴シートを開く', 'openCampaignLogSheet')
    .addItem('❓ 使い方', 'showCampaignHelp_')
    .addItem('🔧 シート再生成（壊した時の復旧）', 'setupCampaign')
    .addToUi();
}

// =====================================================
//  下書きシート構築
// =====================================================

function ensureCampaignDraftSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (sh) return sh; // 既存なら内容を壊さない

  sh = ss.insertSheet(CAMPAIGN_DRAFT_SHEET);

  // タイトル
  sh.getRange('A1:B1').merge()
    .setValue('📢 キャンペーン下書き')
    .setBackground('#1a1a1a').setFontColor('#c9a84c')
    .setFontSize(16).setFontWeight('bold')
    .setHorizontalAlignment('center');
  sh.setRowHeight(1, 36);

  sh.getRange('A2:B2').merge()
    .setValue('本文を編集 →  メニュー「📢 キャンペーン」→「① プレビュー」→「② 一斉送信を実行」')
    .setFontColor('#666').setFontSize(10)
    .setHorizontalAlignment('center');

  // 送信対象
  sh.getRange('A4').setValue('送信対象').setFontWeight('bold').setBackground('#f0e8d0');
  const audience = sh.getRange('B4');
  audience.setValue('全員');
  audience.setDataValidation(
    SpreadsheetApp.newDataValidation()
      .requireValueInList(CAMPAIGN_AUDIENCE_OPTIONS, true)
      .setAllowInvalid(false).build()
  );

  // 本文（クメール語）
  sh.getRange('A6').setValue('本文（クメール語）').setFontWeight('bold').setBackground('#f0e8d0').setVerticalAlignment('top');
  sh.getRange('B6').setValue(
    '🎉 ការផ្តល់ជូនពិសេសសប្តាហ៍នេះ!\n\n' +
    'សម្រាប់អតិថិជនដែលបានចុះឈ្មោះតាម Telegram\n' +
    '👉 តម្លៃពិសេស! (ផ្ញើសារមកយើងដើម្បីកក់)\n\n' +
    '📞 ផ្ញើ សារ ឬ សារសំឡេង មកកាន់យើងបាន!\n' +
    'បុគ្គលិកខ្មែររបស់យើងនឹងទាក់ទងទៅអ្នកវិញ 🚗✨'
  ).setWrap(true).setVerticalAlignment('top').setFontSize(11);
  sh.setRowHeight(6, 150);

  // 本文（英語）
  sh.getRange('A7').setValue('本文（英語）任意').setFontWeight('bold').setBackground('#f0e8d0').setVerticalAlignment('top');
  sh.getRange('B7').setValue(
    '🎉 SPECIAL OFFER THIS WEEK!\n\n' +
    'For customers registered via Telegram:\n' +
    '👉 Special price! (Message us to book)\n\n' +
    '📞 Send us a text OR voice message — anything works!\n' +
    'Our Cambodian staff will get back to you 🚗✨'
  ).setWrap(true).setVerticalAlignment('top').setFontSize(11);
  sh.setRowHeight(7, 150);

  // 画像 Drive リンク（任意）
  sh.getRange('A8').setValue('画像 Driveリンク（任意）').setFontWeight('bold').setBackground('#e8f0e0').setVerticalAlignment('top');
  sh.getRange('B8').setValue('').setWrap(true).setFontSize(10);
  sh.getRange('C8').setValue('← チラシ等。空なら画像なし。本文がキャプションになる')
    .setFontColor('#888').setFontSize(9).setFontStyle('italic');

  // ボイス Drive リンク（任意）
  sh.getRange('A9').setValue('ボイス Driveリンク（任意）').setFontWeight('bold').setBackground('#e8f0e0').setVerticalAlignment('top');
  sh.getRange('B9').setValue('').setWrap(true).setFontSize(10);
  sh.getRange('C9').setValue('← クメール語ボイス。OGG推奨（MP3/M4Aも自動対応）')
    .setFontColor('#888').setFontSize(9).setFontStyle('italic');

  // 注釈
  sh.getRange('A11:B11').merge()
    .setValue('💡 顧客の「言語」列で自動振り分け。英語版が空ならクメール語版を全員に送信。' +
              '「顧客」シートの「配信対象」=☑ の人だけに届きます。')
    .setFontColor('#888').setFontSize(9).setFontStyle('italic')
    .setHorizontalAlignment('center');
  sh.setRowHeight(11, 30);

  // 最終結果
  sh.getRange('A12:B12').merge()
    .setValue('━━━ 最終配信結果（自動更新） ━━━')
    .setBackground('#1a1a1a').setFontColor('#c9a84c')
    .setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange('A13').setValue('送信日時');
  sh.getRange('A14').setValue('成功 / 失敗 / ブロック');
  sh.getRange('A15').setValue('キャンペーンID');
  ['A13', 'A14', 'A15'].forEach(function(a) {
    sh.getRange(a).setFontWeight('bold').setBackground('#f8f4e8');
  });

  // 列幅・凍結
  sh.setColumnWidth(1, 180);
  sh.setColumnWidth(2, 600);
  sh.setColumnWidth(3, 360);
  sh.setFrozenRows(2);

  return sh;
}

function ensureCampaignLogSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(CAMPAIGN_LOG_SHEET);
  if (sh) return sh;

  sh = ss.insertSheet(CAMPAIGN_LOG_SHEET);
  const headers = [
    'キャンペーンID', '送信日時', '顧客ID', 'チャットID', '氏名',
    '言語', '添付', '結果', 'エラー詳細', '本文プレビュー'
  ];
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
  sh.setFrozenRows(1);

  const widths = [180, 160, 100, 130, 140, 90, 100, 80, 220, 400];
  widths.forEach(function(w, i) { sh.setColumnWidth(i + 1, w); });

  return sh;
}

/**
 * 「顧客」シートに「配信対象」「最終配信日時」列を追加（冪等）
 *   - 配信対象: チェックボックス。既存顧客はデフォルト ☑（送る）
 *   - 最終配信日時: 直近配信日時の記録用
 */
function ensureCustomerBroadcastColumns_() {
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const lastRow = sheet.getLastRow();
  let headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);

  // 配信対象
  if (!headers['配信対象']) {
    const col = sheet.getLastColumn() + 1;
    sheet.getRange(1, col).setValue('配信対象')
      .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
    sheet.setColumnWidth(col, 80);
    if (lastRow >= 2) {
      const rng = sheet.getRange(2, col, lastRow - 1, 1);
      rng.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
      const vals = [];
      for (let i = 0; i < lastRow - 1; i++) vals.push([true]); // 既存顧客はデフォルト送る
      rng.setValues(vals);
    }
    Logger.log('  ➕ 顧客シートに「配信対象」列を追加');
    headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  }

  // 最終配信日時
  if (!headers['最終配信日時']) {
    const col = sheet.getLastColumn() + 1;
    sheet.getRange(1, col).setValue('最終配信日時')
      .setFontWeight('bold').setBackground('#1a1a1a').setFontColor('#ffffff');
    sheet.setColumnWidth(col, 160);
    Logger.log('  ➕ 顧客シートに「最終配信日時」列を追加');
  }
}

function openCampaignLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_LOG_SHEET);
  if (!sh) {
    SpreadsheetApp.getUi().alert('履歴シートが存在しません。「🔧 シート再生成」を実行してください。');
    return;
  }
  ss.setActiveSheet(sh);
}

// =====================================================
//  プレビュー
// =====================================================

function previewCampaign() {
  const ui = SpreadsheetApp.getUi();
  try {
    const draft = readCampaignDraft_();
    const recipients = buildRecipientList_(draft.audience);
    const total = recipients.length;
    const enCount = recipients.filter(function(r) { return r.language === '英語'; }).length;
    const kmCount = total - enCount;

    if (total === 0) {
      ui.alert('⚠️ 送信先が0名です',
        '「' + draft.audience + '」かつ「配信対象=☑」に該当する顧客がいません。', ui.ButtonSet.OK);
      return;
    }
    if (!draft.textKm && !draft.textEn) {
      ui.alert('⚠️ 本文が空です',
        'クメール語または英語のいずれかに本文を入力してください。', ui.ButtonSet.OK);
      return;
    }

    const previewKm = draft.textKm ? draft.textKm.substring(0, 300) : '(空 → 英語版を流用)';
    const previewEn = draft.textEn ? draft.textEn.substring(0, 300) : '(空 → クメール語版を流用)';

    const msg =
      '🎯 送信先\n' +
      '  合計: ' + total + '名（配信対象=☑ のみ）\n' +
      '  クメール語向け: ' + kmCount + '名\n' +
      '  英語向け: ' + enCount + '名\n' +
      '\n' +
      '📎 添付\n' +
      '  画像: ' + (draft.imageUrl ? 'あり ✅' : 'なし') + '\n' +
      '  ボイス: ' + (draft.voiceUrl ? 'あり ✅' : 'なし') + '\n' +
      '\n' +
      '📝 本文（クメール語）\n' +
      '────────────────\n' +
      previewKm + '\n' +
      '\n' +
      '📝 本文（英語）\n' +
      '────────────────\n' +
      previewEn + '\n' +
      '\n' +
      '※ これはプレビューです。送信は「② 一斉送信を実行」から。';

    ui.alert('📢 キャンペーン プレビュー', msg, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('❌ プレビュー失敗', String(err && err.message || err), ui.ButtonSet.OK);
  }
}

// =====================================================
//  送信実行
// =====================================================

function sendCampaign() {
  const ui = SpreadsheetApp.getUi();

  let draft, recipients;
  try {
    draft = readCampaignDraft_();
    recipients = buildRecipientList_(draft.audience);
  } catch (err) {
    ui.alert('❌ 設定読込失敗', String(err && err.message || err), ui.ButtonSet.OK);
    return;
  }

  if (recipients.length === 0) {
    ui.alert('⚠️ 送信先が0名です',
      '「' + draft.audience + '」かつ「配信対象=☑」に該当する顧客がいません。', ui.ButtonSet.OK);
    return;
  }
  if (!draft.textKm && !draft.textEn) {
    ui.alert('⚠️ 本文が空です', '本文を入力してください。', ui.ButtonSet.OK);
    return;
  }
  if (recipients.length > CAMPAIGN_MAX_RECIPIENTS) {
    ui.alert('⚠️ 送信先が多すぎます',
      '送信先 ' + recipients.length + '名 が上限 ' + CAMPAIGN_MAX_RECIPIENTS + ' を超えています。',
      ui.ButtonSet.OK);
    return;
  }

  // 最終確認
  const attachNote =
    (draft.imageUrl ? '\n📷 画像添付あり' : '') +
    (draft.voiceUrl ? '\n🎤 ボイス添付あり' : '');
  const confirm = ui.alert(
    '⚠️ 最終確認：本当に送信しますか？',
    recipients.length + ' 名 にメッセージを送信します。' + attachNote + '\n\n' +
    'この操作は取り消せません。よろしいですか？',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) {
    ui.alert('🚫 キャンセルしました');
    return;
  }

  // 配信実行
  const result = executeBroadcast_(draft, recipients);

  // 下書きシートに最終結果を書き戻す
  writeCampaignSummary_(result);

  ui.alert('📢 配信完了',
    '✅ 成功: ' + result.success + ' 件\n' +
    '❌ 失敗: ' + result.failed + ' 件\n' +
    '🚫 ブロック済み: ' + result.blocked + ' 件\n' +
    '\n' +
    'キャンペーンID: ' + result.campaignId + '\n' +
    '詳細は「' + CAMPAIGN_LOG_SHEET + '」シートをご確認ください。',
    ui.ButtonSet.OK
  );
}

// =====================================================
//  内部処理
// =====================================================

function readCampaignDraft_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (!sh) {
    throw new Error('「' + CAMPAIGN_DRAFT_SHEET +
      '」シートが見つかりません。メニューの「🔧 シート再生成」を実行してください。');
  }
  return {
    audience: String(sh.getRange(CAMPAIGN_CELL.AUDIENCE).getValue() || '全員').trim(),
    textKm:   String(sh.getRange(CAMPAIGN_CELL.TEXT_KM).getValue() || '').trim(),
    textEn:   String(sh.getRange(CAMPAIGN_CELL.TEXT_EN).getValue() || '').trim(),
    imageUrl: String(sh.getRange(CAMPAIGN_CELL.IMAGE_URL).getValue() || '').trim(),
    voiceUrl: String(sh.getRange(CAMPAIGN_CELL.VOICE_URL).getValue() || '').trim()
  };
}

/**
 * 顧客シートから配信対象リストを構築
 *   - チャットID が空の顧客は除外（Bot から送信不可能）
 *   - 「配信対象」=FALSE の顧客は除外（空欄/未設定は送る扱い=後方互換）
 *   - 言語フィルタを適用
 *   - rowIndex を保持（送信後に「最終配信日時」を書き戻すため）
 */
function buildRecipientList_(audience) {
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  const idCol     = headers['顧客ID'];
  const chatCol   = headers['チャットID'];
  const nameCol   = headers['氏名'];
  const langCol   = headers['言語'];
  const targetCol = headers['配信対象'];   // 無い場合もある（後方互換）
  if (!chatCol) throw new Error('「顧客」シートに「チャットID」列が見つかりません');

  const data = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const list = [];
  data.forEach(function(row, idx) {
    const chatId = String(row[chatCol - 1] || '').trim();
    if (!chatId) return;

    // 配信対象フィルタ: 明示的 FALSE のみ除外。空欄/未設定/TRUE は送る。
    if (targetCol) {
      const t = row[targetCol - 1];
      if (t === false || String(t).toUpperCase() === 'FALSE') return;
    }

    const language = String((langCol ? row[langCol - 1] : '') || 'クメール語').trim();
    if (audience === 'クメール語のみ' && language === '英語') return;
    if (audience === '英語のみ'      && language !== '英語') return;

    list.push({
      customerId: idCol  ? String(row[idCol  - 1] || '') : '',
      chatId:     chatId,
      name:       nameCol ? String(row[nameCol - 1] || '') : '',
      language:   language,
      rowIndex:   idx + 2   // データは2行目開始
    });
  });
  return list;
}

/**
 * 顧客1件あたりの本文を決定
 *   - 英語顧客は英語版、なければクメール語版
 *   - クメール語顧客はクメール語版、なければ英語版
 */
function pickCampaignText_(draft, recipient) {
  if (recipient.language === '英語') {
    return draft.textEn || draft.textKm;
  }
  return draft.textKm || draft.textEn;
}

/**
 * Telegram レスポンスを成否分類する
 * @return {{ok:boolean, blocked:boolean, error:string, retryAfter:number}}
 */
function classifyTgResult_(res) {
  if (res && res.ok) return { ok: true, blocked: false, error: '', retryAfter: 0 };
  const desc = (res && res.description) ? String(res.description) : (res && res.error) ? String(res.error) : '';
  const errCode = (res && res.error_code) ? Number(res.error_code) : 0;
  if (errCode === 429 && res.parameters && res.parameters.retry_after) {
    return { ok: false, blocked: false, error: desc, retryAfter: Number(res.parameters.retry_after) };
  }
  if (errCode === 403 || /blocked|deactivated|user is deactivated|kicked|chat not found/i.test(desc)) {
    return { ok: false, blocked: true, error: desc || ('error_code=' + errCode), retryAfter: 0 };
  }
  return { ok: false, blocked: false, error: desc || ('error_code=' + errCode), retryAfter: 0 };
}

/**
 * ブロードキャスト本体
 */
function executeBroadcast_(draft, recipients) {
  const campaignId = 'CAMP-' + Utilities.formatDate(
    new Date(), 'Asia/Phnom_Penh', 'yyyyMMdd-HHmmss'
  );
  const sentAt = new Date();
  const attachLabel =
    (draft.imageUrl ? '画像' : '') +
    (draft.imageUrl && draft.voiceUrl ? '+' : '') +
    (draft.voiceUrl ? 'ボイス' : '') || '—';

  let success = 0, failed = 0, blocked = 0;
  const logRows = [];
  const sentRowIndexes = [];

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const text = pickCampaignText_(draft, r);
    const preview = text ? (text.length > 80 ? text.substring(0, 80) + '…' : text) : '';

    if (!text && !draft.imageUrl && !draft.voiceUrl) {
      failed += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, r.language,
                    attachLabel, 'failed', '本文・添付すべて空', '']);
      continue;
    }

    // メイン送信: 画像があれば写真(本文=キャプション)、なければテキスト
    let mainRes;
    if (draft.imageUrl) {
      mainRes = sendCampaignPhoto_(r.chatId, draft.imageUrl, text);
    } else {
      mainRes = sendCampaignText_(r.chatId, text);
    }
    const cls = classifyTgResult_(mainRes);

    // ボイスは best-effort（メイン結果は変えない）
    if (draft.voiceUrl && (cls.ok || !cls.blocked)) {
      try { sendVoiceFromUrl(BOT_TYPE.BOOKING, r.chatId, draft.voiceUrl, {}); }
      catch (e) { Logger.log('⚠️ voice 送信失敗 chatId=' + r.chatId + ': ' + e); }
    }

    if (cls.ok) {
      success += 1;
      sentRowIndexes.push(r.rowIndex);
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, r.language,
                    attachLabel, 'success', '', preview]);
    } else if (cls.blocked) {
      blocked += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, r.language,
                    attachLabel, 'blocked', cls.error || 'bot blocked', preview]);
    } else {
      failed += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, r.language,
                    attachLabel, 'failed', cls.error || 'unknown', preview]);
    }

    if (i < recipients.length - 1) {
      Utilities.sleep(CAMPAIGN_SEND_INTERVAL_MS);
    }
  }

  // 履歴シートに一括書き込み
  if (logRows.length > 0) {
    const logSh = ensureCampaignLogSheet_();
    logSh.getRange(logSh.getLastRow() + 1, 1, logRows.length, logRows[0].length)
      .setValues(logRows);
  }

  // 顧客シートの「最終配信日時」を成功分だけ更新
  updateCustomerLastBroadcast_(sentRowIndexes, sentAt);

  return {
    campaignId: campaignId,
    sentAt:     sentAt,
    total:      recipients.length,
    success:    success,
    failed:     failed,
    blocked:    blocked
  };
}

/**
 * テキスト1件送信（429リトライ込み）
 */
function sendCampaignText_(chatId, text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = sendMessage(BOT_TYPE.BOOKING, chatId, text, { disable_web_page_preview: true });
    const cls = classifyTgResult_(res);
    if (cls.ok) return res;
    if (cls.retryAfter > 0) { Utilities.sleep((cls.retryAfter + 1) * 1000); continue; }
    return res;
  }
  return { ok: false, description: '429 リトライ後も失敗' };
}

/**
 * 写真1件送信（本文をキャプションに）。429リトライ込み。
 * 既存 sendQRImage()（Driveリンク/外部URL両対応）を流用。
 */
function sendCampaignPhoto_(chatId, imageUrl, caption) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = sendQRImage(chatId, imageUrl, caption);
    const cls = classifyTgResult_(res);
    if (cls.ok) return res;
    if (cls.retryAfter > 0) { Utilities.sleep((cls.retryAfter + 1) * 1000); continue; }
    return res;
  }
  return { ok: false, description: '429 リトライ後も失敗' };
}

/**
 * 成功した顧客行の「最終配信日時」を更新（バッチ）
 */
function updateCustomerLastBroadcast_(rowIndexes, when) {
  if (!rowIndexes || rowIndexes.length === 0) return;
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  const col = headers['最終配信日時'];
  if (!col) return; // 列が無ければスキップ
  rowIndexes.forEach(function(rowIndex) {
    sheet.getRange(rowIndex, col).setValue(when);
  });
}

/**
 * 下書きシートに最終結果を書き戻す
 */
function writeCampaignSummary_(result) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (!sh) return;

  const tz = ss.getSpreadsheetTimeZone() || 'Asia/Phnom_Penh';
  sh.getRange(CAMPAIGN_CELL.RESULT_AT).setValue(Utilities.formatDate(result.sentAt, tz, 'yyyy-MM-dd HH:mm:ss'));
  sh.getRange(CAMPAIGN_CELL.RESULT_STATS).setValue(
    '✅ ' + result.success + ' / ❌ ' + result.failed + ' / 🚫 ' + result.blocked +
    '   （合計 ' + result.total + '）'
  );
  sh.getRange(CAMPAIGN_CELL.RESULT_ID).setValue(result.campaignId);
}

// =====================================================
//  ヘルプ
//  ※ 個別送信（sendMessageToSelectedCustomer 等）は CustomerContact.gs に分離
// =====================================================

/**
 * 使い方ヘルプ
 */
function showCampaignHelp_() {
  SpreadsheetApp.getUi().alert(
    '📢 キャンペーン — 使い方',
    '【一斉送信】\n' +
    '1. 「キャンペーン下書き」シートで本文を編集\n' +
    '   （任意で 画像/ボイス の Driveリンクも貼れます）\n' +
    '2. メニュー「① プレビュー」で送信先と内容を確認\n' +
    '3. 「② 一斉送信を実行」→ 最終確認 → 配信\n' +
    '4. 結果は「キャンペーン配信履歴」シートに記録\n\n' +
    '【個別送信】\n' +
    '1. 「顧客」シートで対象の行をクリック\n' +
    '2. メニュー「📤 選択した顧客に1通だけ送信」\n' +
    '3. 本文を入力して送信\n\n' +
    '【配信対象の除外】\n' +
    '「顧客」シートの「配信対象」チェックを外すと\n' +
    'その人は一斉送信から除外されます（苦情客/ブロック客）。\n\n' +
    '【重要】テレグラム限定特価（5ドル等）は本文に手書きするだけ。\n' +
    '料金設定/メニューシートには絶対に入れないでください（公開客に漏れます）。',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}
