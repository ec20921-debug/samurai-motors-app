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
 *      → 「キャンペーン下書き」「キャンペーン台帳」「キャンペーン送信エラー」シート生成
 *      → 「顧客」シートに「配信対象」「最終配信日時」列を追加
 *      → onOpen トリガー登録（旧📩メニューの孤立トリガーも掃除）
 *   2. スプレッドシートを開き直す
 *   3. 「キャンペーン下書き」シートに本文（＋任意で画像/ボイスのDriveリンク）を記入
 *   4. メニュー「📢 キャンペーン」→「① プレビュー」で送信先と内容を確認
 *   5. 「② 送信実行」で配信開始（最終確認ダイアログあり）
 *   6. 内容は「キャンペーン台帳」、届かなかった人は「キャンペーン送信エラー」に記録
 *
 * 【設計方針】
 *   - 顧客接点は予約Bot1本に統一（BOT_TYPE.BOOKING を使う）
 *   - 全員に同じ内容を送る。何語で送るかは下書きB4の「言語」設定で決まる:
 *       クメール語＋英語（デフォルト/推奨）= 1通に両方をまとめて送信
 *       クメール語のみ / 英語のみ = その言語だけ
 *     （顧客の「言語」列での絞り込みはしない。2026-05-30 Daisuke 指示）
 *   - 「配信対象」チェックボックス=FALSE の顧客は一斉送信から除外（苦情客/ブロック客）
 *   - 50ms 間隔 = 20msg/秒 で送信（Telegram レート制限 30msg/秒 の安全圏）
 *   - 429（Too Many Requests）は retry_after に従って1回リトライ
 *   - 403（bot blocked）は履歴に「blocked」と記録して継続
 *   - 画像は既存 sendQRImage() を流用（Driveリンク/外部URL両対応）
 *   - ボイスは sendVoiceFromUrl()（sendVoice→sendAudio フォールバック）
 *   - 動画は sendVideoFromUrl()。初回アップロードの file_id を再利用して
 *     再アップロードを避ける（50名×動画でも6分制限内に収める）。50MB上限。
 *   - メイン送信の優先順位: 動画 > 画像 > テキスト（本文=キャプション）
 *   - 6分実行制限に備え、CAMPAIGN_MAX_RECIPIENTS で上限ガード
 *
 * 【2価格分離の原則（SPEC_CampaignBroadcast.md）】
 *   テレグラム限定特価（例:5ドル）は本文に手書きするのみ。
 *   料金設定/メニューシートには絶対に入れない（公開客に漏れるため）。
 */

// 定数（シート名 / 送信設定 / 言語選択肢 / セル位置）と シート構築系は
// CampaignSheets.gs に分離。GAS 同一スコープのためそのまま参照できる。

/** 下書きシートを開く（メニュー①） */
function openCampaignDraftSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_DRAFT_SHEET);
  if (!sh) { ss.toast('下書きシートがありません。🔧シート再生成を実行してください。'); return; }
  ss.setActiveSheet(sh);
}

/** 顧客シートを開いて配信対象選択へ誘導（メニュー②） */
function openCustomerSheetForTargeting() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAMES.CUSTOMERS);
  if (!sh) { ss.toast('顧客シートが見つかりません。'); return; }
  ss.setActiveSheet(sh);
  ss.toast('「配信対象」列(L)で送る人に☑。メニュー「☑配信対象 一括操作」で一括ON/OFFも可。', '配信対象を選ぶ', 8);
}

// =====================================================
//  下書きシート構築
// =====================================================

function openCampaignLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_LOG_SHEET);
  if (!sh) {
    SpreadsheetApp.getUi().alert('「キャンペーン送信エラー」シートが存在しません。「🔧 シート再生成」を実行してください。');
    return;
  }
  ss.setActiveSheet(sh);
}

function openCampaignLedgerSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CAMPAIGN_LEDGER_SHEET);
  if (!sh) {
    SpreadsheetApp.getUi().alert('台帳シートが存在しません。「🔧 シート再生成」を実行してください。');
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
    const recipients = buildRecipientList_();
    const total = recipients.length;

    if (total === 0) {
      ui.alert('⚠️ 送信先が0名です',
        '「配信対象=☑」の顧客がいません。', ui.ButtonSet.OK);
      return;
    }
    if (!draft.textKm && !draft.textEn) {
      ui.alert('⚠️ 本文が空です',
        'クメール語または英語のいずれかに本文を入力してください。', ui.ButtonSet.OK);
      return;
    }

    const msg = buildDraftPreviewText_(draft, total) +
      '\n\n※ これはプレビューです。送信は「④ 一斉送信を実行」から。';
    ui.alert('📢 キャンペーン プレビュー（下書き）', msg, ui.ButtonSet.OK);
  } catch (err) {
    ui.alert('❌ プレビュー失敗', String(err && err.message || err), ui.ButtonSet.OK);
  }
}

/**
 * draft オブジェクトからプレビュー本文を組み立てる（下書き・予約行で共通利用）
 *
 * @param {Object} draft - {audience,textKm,textEn,imageUrl,voiceUrl,videoUrl}
 * @param {number} total - 送信先人数（配信対象=☑ の数）
 * @return {string}
 */
function buildDraftPreviewText_(draft, total) {
  let langDesc;
  if (draft.audience === CAMPAIGN_LANG_KM_ONLY)      langDesc = 'クメール語のみ';
  else if (draft.audience === CAMPAIGN_LANG_EN_ONLY) langDesc = '英語のみ';
  else langDesc = 'クメール語＋英語（1通にまとめて）';

  const previewKm = draft.textKm ? draft.textKm.substring(0, 300) : '(空)';
  const previewEn = draft.textEn ? draft.textEn.substring(0, 300) : '(空)';

  // 素材名がリンクに解決できたか（名前のまま残っている＝フォルダ未更新/ファイル名違い）
  let assetWarn = '';
  if (typeof isAssetUrl_ === 'function') {
    const bad = [];
    if (draft.imageUrl && !isAssetUrl_(draft.imageUrl)) bad.push('画像「' + draft.imageUrl + '」');
    if (draft.voiceUrl && !isAssetUrl_(draft.voiceUrl)) bad.push('ボイス「' + draft.voiceUrl + '」');
    if (draft.videoUrl && !isAssetUrl_(draft.videoUrl)) bad.push('動画「' + draft.videoUrl + '」');
    if (bad.length) {
      assetWarn = '⚠️ 素材が見つかりません: ' + bad.join(', ') + '\n' +
        '　「📂 素材一覧を更新」してから正しいファイル名を選んでください\n\n';
    }
  }

  return assetWarn +
    (draft.noteJp ? '📝 内容(日本語): ' + draft.noteJp + '\n\n' : '') +
    '🎯 送信先\n' +
    '  合計: ' + total + '名（配信対象=☑ の全員）\n' +
    '  送信言語: ' + langDesc + '\n' +
    '\n' +
    '📎 添付\n' +
    '  動画: ' + (draft.videoUrl ? 'あり ✅（画像より優先）' : 'なし') + '\n' +
    '  画像: ' + (draft.imageUrl ? 'あり ✅' : 'なし') + '\n' +
    '  ボイス: ' + (draft.voiceUrl ? 'あり ✅' : 'なし') + '\n' +
    '\n' +
    '📝 本文（クメール語）\n' +
    '────────────────\n' +
    previewKm + '\n' +
    '\n' +
    '📝 本文（英語）\n' +
    '────────────────\n' +
    previewEn;
}

// =====================================================
//  送信実行
// =====================================================

function sendCampaign() {
  const ui = SpreadsheetApp.getUi();

  let draft, recipients;
  try {
    draft = readCampaignDraft_();
    recipients = buildRecipientList_();
  } catch (err) {
    ui.alert('❌ 設定読込失敗', String(err && err.message || err), ui.ButtonSet.OK);
    return;
  }

  if (recipients.length === 0) {
    ui.alert('⚠️ 送信先が0名です',
      '「配信対象=☑」の顧客がいません。', ui.ButtonSet.OK);
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

  // 動画サイズ事前チェック（Telegram Bot のアップロード上限は 50MB）
  if (draft.videoUrl) {
    const mb = driveSizeMB_(draft.videoUrl);
    if (mb > 50) {
      ui.alert('⚠️ 動画が大きすぎます',
        '動画サイズ ' + mb.toFixed(1) + 'MB は Telegram の上限 50MB を超えています。\n' +
        '50MB以内（推奨20MB以下）に圧縮してから再実行してください。',
        ui.ButtonSet.OK);
      return;
    }
  }

  // 最終確認
  const attachNote =
    (draft.videoUrl ? '\n🎬 動画添付あり（画像より優先）' : '') +
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
    'キャンペーンID: ' + result.campaignId + '\n\n' +
    '📒 内容と件数 →「' + CAMPAIGN_LEDGER_SHEET + '」（1配信=1行・本文全文）\n' +
    '📋 失敗/ブロックした人 →「' + CAMPAIGN_LOG_SHEET + '」（例外のみ。空＝全員成功）',
    ui.ButtonSet.OK
  );
}

// =====================================================
//  テスト送信（自分のチャットIDだけに実物を送る）
// =====================================================

/**
 * 下書きの実物（テキスト＋画像/ボイス/動画）を、指定した1つのチャットIDだけに送る。
 * 配信履歴・最終配信日時には記録しない（本番配信と混ざらない）。
 * 50名のチェックを触らず安全に「見え方」を確認するためのもの。
 */
function testSendCampaign() {
  const ui = SpreadsheetApp.getUi();
  let draft;
  try { draft = readCampaignDraft_(); }
  catch (err) { ui.alert('❌ 設定読込失敗', String(err && err.message || err), ui.ButtonSet.OK); return; }

  if (!draft.textKm && !draft.textEn && !draft.imageUrl && !draft.voiceUrl && !draft.videoUrl) {
    ui.alert('⚠️ 本文も添付もありません', '下書きを入力してから実行してください。', ui.ButtonSet.OK);
    return;
  }
  if (draft.videoUrl) {
    const mb = driveSizeMB_(draft.videoUrl);
    if (mb > 50) {
      ui.alert('⚠️ 動画が大きすぎます',
        mb.toFixed(1) + 'MB は上限50MBを超えています。圧縮してください。', ui.ButtonSet.OK);
      return;
    }
  }

  const props = PropertiesService.getScriptProperties();
  const saved = props.getProperty('CAMPAIGN_TEST_CHAT_ID') || '';
  const resp = ui.prompt('🧪 テスト送信',
    'テスト送信先の Telegram チャットID を入力してください。\n' +
    '（自分のチャットID。予約Botを /start 済みであること）' +
    (saved ? '\n\n空欄のままOKで前回のID（' + saved + '）を使います。' : ''),
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  let chatId = String(resp.getResponseText() || '').trim();
  if (!chatId) chatId = saved;
  if (!chatId) { ui.alert('⚠️ チャットIDが空です'); return; }
  props.setProperty('CAMPAIGN_TEST_CHAT_ID', chatId);

  const text = draft.textKm || draft.textEn; // クメール語優先（多数派の見え方）
  const cache = { id: '' };
  let res;
  if (draft.videoUrl)      res = sendCampaignVideo_(chatId, draft.videoUrl, text, cache);
  else if (draft.imageUrl) res = sendCampaignPhoto_(chatId, draft.imageUrl, text);
  else                     res = sendCampaignText_(chatId, text);

  let voiceNote = '';
  if (draft.voiceUrl) {
    const vr = sendVoiceFromUrl(BOT_TYPE.BOOKING, chatId, draft.voiceUrl, {});
    voiceNote = '\nボイス: ' + (vr && vr.ok ? '✅ 送信' : '❌ 失敗');
  }

  const cls = classifyTgResult_(res);
  if (cls.ok) {
    ui.alert('🧪 テスト送信 完了',
      'チャットID ' + chatId + ' に送信しました。\nTelegram を確認してください。' + voiceNote + '\n\n' +
      '※ テスト送信は配信履歴・最終配信日時には記録しません。',
      ui.ButtonSet.OK);
  } else {
    ui.alert('❌ テスト送信 失敗',
      '原因: ' + (cls.error || '不明') + voiceNote + '\n\n' +
      'チャットIDが正しいか、相手が予約Botを開始(/start)済みか確認してください。',
      ui.ButtonSet.OK);
  }
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
  // 画像/ボイス/動画は「ファイル名」でも「リンク直貼り」でもOK。
  // resolveAssetValue_(CampaignAssets.gs) が ファイル名→リンク へ自動解決する。
  const resolve = (typeof resolveAssetValue_ === 'function')
    ? resolveAssetValue_
    : function(x) { return String(x || '').trim(); };
  return {
    audience: String(sh.getRange(CAMPAIGN_CELL.AUDIENCE).getValue() || CAMPAIGN_LANG_BOTH).trim(),
    noteJp:   String(sh.getRange(CAMPAIGN_CELL.NOTE_JP).getValue() || '').trim(),
    textKm:   String(sh.getRange(CAMPAIGN_CELL.TEXT_KM).getValue() || '').trim(),
    textEn:   String(sh.getRange(CAMPAIGN_CELL.TEXT_EN).getValue() || '').trim(),
    imageUrl: resolve(sh.getRange(CAMPAIGN_CELL.IMAGE_URL).getValue()),
    voiceUrl: resolve(sh.getRange(CAMPAIGN_CELL.VOICE_URL).getValue()),
    videoUrl: resolve(sh.getRange(CAMPAIGN_CELL.VIDEO_URL).getValue())
  };
}

/**
 * 顧客シートから配信対象リストを構築
 *   - チャットID が空の顧客は除外（Bot から送信不可能）
 *   - 「配信対象」=FALSE の顧客は除外（空欄/未設定は送る扱い=後方互換）
 *   - rowIndex を保持（送信後に「最終配信日時」を書き戻すため）
 *
 * 2026-05-30: 顧客の「言語」列での絞り込みは廃止。送る相手は常に
 * 「配信対象=☑ の全員」。何語で送るかは下書きの「言語」設定(B4)で決まり、
 * 全員に同じ内容（クメール語＋英語 など）が届く。
 */
function buildRecipientList_() {
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  const idCol     = headers['顧客ID'];
  const chatCol   = headers['チャットID'];
  const nameCol   = headers['氏名'];
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

    list.push({
      customerId: idCol  ? String(row[idCol  - 1] || '') : '',
      chatId:     chatId,
      name:       nameCol ? String(row[nameCol - 1] || '') : '',
      rowIndex:   idx + 2   // データは2行目開始
    });
  });
  return list;
}

/**
 * 顧客1件あたりの本文を決定（全員に同じ内容を送る）
 *
 * 2026-05-30 Daisuke 指示で「言語」設定ベースに変更:
 *   - クメール語＋英語（デフォルト）: 両方を区切り線でつないで1通に
 *   - クメール語のみ / 英語のみ: その言語だけ
 * いずれも顧客の「言語」列は見ない（全員に同じものを送る）。
 * 片方の本文が空なら、もう片方だけを送る（フォールバック）。
 */
function pickCampaignText_(draft, recipient) {
  const km = draft.textKm || '';
  const en = draft.textEn || '';
  if (draft.audience === CAMPAIGN_LANG_KM_ONLY) return km || en;
  if (draft.audience === CAMPAIGN_LANG_EN_ONLY) return en || km;
  // デフォルト = クメール語＋英語を1通にまとめる
  if (km && en) return km + '\n\n━━━━━━━━━━\n\n' + en;
  return km || en;
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
  const attachParts = [];
  if (draft.videoUrl) attachParts.push('動画');
  if (draft.imageUrl) attachParts.push('画像');
  if (draft.voiceUrl) attachParts.push('ボイス');
  const attachLabel = attachParts.length ? attachParts.join('+') : '—';
  // 配信履歴の「言語」列に入れるラベル（全員に同じ内容を送るため配信単位で1つ）
  let langLabel;
  if (draft.audience === CAMPAIGN_LANG_KM_ONLY)      langLabel = 'クメール語';
  else if (draft.audience === CAMPAIGN_LANG_EN_ONLY) langLabel = '英語';
  else langLabel = 'クメール語＋英語';

  let success = 0, failed = 0, blocked = 0;
  const logRows = [];
  const sentRowIndexes = [];
  // 動画は初回アップロードで得た file_id を再利用（再アップロード回避→6分制限のタイムアウト防止）
  const videoCache = { id: '' };

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const text = pickCampaignText_(draft, r);
    const preview = text ? (text.length > 80 ? text.substring(0, 80) + '…' : text) : '';

    // 配信履歴は「失敗・ブロックのみ」記録（成功はカウントのみ＝台帳で件数を見る）。
    // 重複を避け、対応が必要な例外だけが履歴に残るようにする。
    if (!text && !draft.imageUrl && !draft.voiceUrl && !draft.videoUrl) {
      failed += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, 'failed', '本文・添付すべて空']);
      continue;
    }

    // メイン送信の優先順位: 動画 > 画像 > テキスト（本文=キャプション）
    let mainRes;
    if (draft.videoUrl) {
      mainRes = sendCampaignVideo_(r.chatId, draft.videoUrl, text, videoCache);
    } else if (draft.imageUrl) {
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
      // 成功は履歴に書かない（件数は台帳へ）
    } else if (cls.blocked) {
      blocked += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, 'blocked', cls.error || 'bot blocked']);
    } else {
      failed += 1;
      logRows.push([campaignId, sentAt, r.customerId, r.chatId, r.name, 'failed', cls.error || 'unknown']);
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

  const result = {
    campaignId: campaignId,
    sentAt:     sentAt,
    total:      recipients.length,
    success:    success,
    failed:     failed,
    blocked:    blocked,
    langLabel:  langLabel
  };

  // 台帳に1行追記（いつ・何を・何語で・送信数/成否を全文保存）
  appendCampaignLedger_(draft, result, langLabel);

  return result;
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
 * 動画1件送信（本文をキャプションに）。429リトライ込み。
 *
 * 初回は Drive からアップロードして file_id を取得し cache に保存、
 * 2回目以降は file_id で送信（再アップロード回避＝6分制限のタイムアウト防止）。
 * 50名に30MB動画を毎回アップすると6分制限を超えるため、この最適化は必須。
 *
 * @param {Object} cache - { id: string } 配信ループ内で file_id を共有する
 */
function sendCampaignVideo_(chatId, videoUrl, caption, cache) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    if (cache && cache.id) {
      // 2回目以降: file_id を再利用（高速・再アップロードなし）
      const p = { chat_id: String(chatId), video: cache.id, supports_streaming: true };
      if (caption) p.caption = caption;
      res = callTelegramApi(BOT_TYPE.BOOKING, 'sendVideo', p);
    } else {
      // 初回: Drive からアップロードし file_id を確保
      res = sendVideoFromUrl(BOT_TYPE.BOOKING, chatId, videoUrl, { caption: caption });
      if (res && res.ok && res.result && res.result.video && cache) {
        cache.id = res.result.video.file_id;
      }
    }
    const cls = classifyTgResult_(res);
    if (cls.ok) return res;
    if (cls.retryAfter > 0) { Utilities.sleep((cls.retryAfter + 1) * 1000); continue; }
    return res;
  }
  return { ok: false, description: '429 リトライ後も失敗' };
}

/**
 * Drive リンクの動画サイズ(MB)を返す。Drive でない/取得失敗時は -1。
 * 送信前の 50MB 上限チェックに使う。
 */
function driveSizeMB_(url) {
  const m = url.match(/[?&]id=([a-zA-Z0-9_-]+)|\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return -1; // 外部URL等はサイズ不明
  const fileId = m[1] || m[2];
  try {
    return DriveApp.getFileById(fileId).getSize() / (1024 * 1024);
  } catch (e) {
    Logger.log('⚠️ driveSizeMB_ 取得失敗: ' + e);
    return -1;
  }
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
//  配信対象 一括操作（顧客シートの「配信対象」チェックボックス）
// =====================================================

function setAllBroadcastOn()       { bulkSetBroadcastTarget_(true,  false); }

function setAllBroadcastOff()      { bulkSetBroadcastTarget_(false, false); }

function setSelectedBroadcastOn()  { bulkSetBroadcastTarget_(true,  true); }

function setSelectedBroadcastOff() { bulkSetBroadcastTarget_(false, true); }

/**
 * 「顧客」シートの「配信対象」チェックを一括 ON/OFF する
 *
 * @param {boolean} value        - true=☑ON / false=☐OFF
 * @param {boolean} selectedOnly - true=選択した行だけ / false=全顧客
 */
function bulkSetBroadcastTarget_(value, selectedOnly) {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = getSheet(SHEET_NAMES.CUSTOMERS);
  const headers = getHeaderMap(SHEET_NAMES.CUSTOMERS);
  const col = headers['配信対象'];
  if (!col) {
    ui.alert('「配信対象」列がありません',
      'メニュー「🔧 シート再生成」または setupCampaign を先に実行してください。', ui.ButtonSet.OK);
    return;
  }
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { ui.alert('顧客がいません。'); return; }

  let startRow = 2, numRows = lastRow - 1;
  if (selectedOnly) {
    const active = ss.getActiveSheet();
    if (active.getName() !== SHEET_NAMES.CUSTOMERS) {
      ui.alert('⚠️ 「顧客」シートで対象の行を選択してから実行してください。',
        '現在のシート: ' + active.getName(), ui.ButtonSet.OK);
      return;
    }
    const sel = active.getActiveRange();
    startRow = Math.max(2, sel.getRow());
    const selEnd = sel.getRow() + sel.getNumRows() - 1;
    numRows = Math.min(selEnd, lastRow) - startRow + 1;
    if (numRows < 1) {
      ui.alert('対象行がありません（2行目以降を選択してください）。');
      return;
    }
  }

  // チェックボックス検証を付与してから一括代入（未設定セルでも確実に☑/☐になる）
  const rng = sheet.getRange(startRow, col, numRows, 1);
  rng.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
  const vals = [];
  for (let i = 0; i < numRows; i++) vals.push([value]);
  rng.setValues(vals);

  ss.toast('配信対象を ' + numRows + ' 件 ' + (value ? 'ON ☑' : 'OFF ☐') + ' にしました', '一括操作', 5);
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
    '【基本の流れ（メニュー①→④の順）】\n' +
    '① 下書きを準備：「キャンペーン下書き」で本文を編集\n' +
    '   画像/動画/ボイスを付ける場合:\n' +
    '   ・B11「📁 素材フォルダ」にファイルを入れる\n' +
    '   ・メニュー「📂 素材一覧を更新」\n' +
    '   ・B8/B9/B10 のドロップダウンで選ぶ\n' +
    '   ※ 動画は50MB以内。動画があれば画像より優先\n' +
    '② 配信対象を選ぶ：「顧客」シートの「配信対象」列で☑\n' +
    '   （メニュー「☑ 配信対象 一括操作」で全員ON/OFFも可）\n' +
    '③ プレビュー：送信先の人数と内容を確認\n' +
    '④ 一斉送信を実行：最終確認 → 配信\n\n' +
    '★ ②③④はどのタブにいても実行OK。④が下書きの本文＋画像を\n' +
    '　 配信対象=☑ の全員に送ります。\n\n' +
    '【テスト送信（本番前におすすめ）】\n' +
    '「🧪 テスト送信」で自分のチャットIDだけに実物を確認できます。\n\n' +
    '【結果の見方】\n' +
    '📒「キャンペーン台帳」= いつ・何を送ったか（本文全文＋件数）\n' +
    '📋「キャンペーン送信エラー」= 失敗・ブロックした人だけ（空＝全員成功）\n\n' +
    '【1人だけに送りたい時】\n' +
    'メニュー「⚙️ その他・メンテ → 📤 1人だけに手入力で送る」\n' +
    '※ これは下書きを使わずテキストのみ。画像は送れません。\n\n' +
    '【重要】テレグラム限定特価（5ドル等）は本文に手書きするだけ。\n' +
    '料金設定/メニューシートには絶対に入れないでください（公開客に漏れます）。',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}
