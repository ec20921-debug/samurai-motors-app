/**
 * DotsSetup.gs — ドッちゃんのメール転送（DotsDigestBridge.gs）のセットアップ・手動実行（GAS エディタから）
 *
 * 手順の正本: docs/DOTS_SECRETARY_SETUP.md
 *   ① Script Properties に DOTS_SENDER_ALLOWLIST を入れる
 *   ② setupDotsBridgeTrigger を1回実行（Gmail の権限確認・合言葉の発行・「日報明細」タブの作成・5分トリガー）
 *   ③ DOTS_BRIDGE_ENABLED を 'true' にする
 */

/**
 * 5分トリガーを登録する（1回だけ実行）。Gmail の権限確認もここで出る。
 * 合言葉がまだ無ければ作ってログに出す（issueDotsSharedToken）。「日報明細」タブが無ければ作る。
 * 動き出すのは DOTS_BRIDGE_ENABLED を 'true' にしてから。
 */
function setupDotsBridgeTrigger() {
  issueDotsSharedToken();
  ensureDotsItemsSheet_();
  removeDotsBridgeTrigger();
  GmailApp.getUserLabelByName(DOTS_LABEL_DONE); // Gmail の権限確認を出すための呼び出し
  ScriptApp.newTrigger(DOTS_TRIGGER_FN).timeBased().everyMinutes(5).create();
  Logger.log('✅ dots 転送トリガー設定（5分ごと）');
  debugDotsBridgeConfig();
}

function removeDotsBridgeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === DOTS_TRIGGER_FN) ScriptApp.deleteTrigger(t);
  });
}

/**
 * 合言葉を作って Script Properties に入れる（まだ無い時だけ）。
 * 作った合言葉はこの実行ログに1回だけ出るので、ドッちゃんへの指示文の <KEY> に貼る（GitHub・Vault・チャットには書かない）。
 * 作り直す時は DOTS_SHARED_TOKEN を消してから再実行し、ドッちゃんにも新しい合言葉を伝える。
 */
function issueDotsSharedToken() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty(DOTS_PROP.TOKEN)) {
    Logger.log('ℹ️ 合言葉は設定済みです（作り直す時は DOTS_SHARED_TOKEN を消してから再実行）');
    return;
  }
  const token = 'SM' + Utilities.getUuid().replace(/-/g, '').substring(0, 22);
  p.setProperty(DOTS_PROP.TOKEN, token);
  Logger.log('✅ 合言葉を作りました。ドッちゃんへの指示文の <KEY> にこれを貼ってください: ' + token);
}

/** 設定の確認（合言葉・アドレスそのものはログに出さない） */
function debugDotsBridgeConfig() {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty(DOTS_PROP.TOKEN) || '';
  const allow = parseDotsAllowlist_(p.getProperty(DOTS_PROP.ALLOWLIST));
  const triggers = ScriptApp.getProjectTriggers().filter(function(t) { return t.getHandlerFunction() === DOTS_TRIGGER_FN; });
  let staff = null;
  try { staff = resolveDotsStaff_(); } catch (e) { Logger.log('⚠️ スタッフ解決失敗: ' + e); }
  Logger.log('停止スイッチ   ' + DOTS_PROP.ENABLED + ' : ' + (p.getProperty(DOTS_PROP.ENABLED) || '(未設定=停止)'));
  Logger.log('合言葉         ' + DOTS_PROP.TOKEN + ' : ' + (token ? token.length + '文字' + (token.length < 20 ? ' ⚠️ 20文字以上にしてください' : '') : '未設定'));
  Logger.log('許可リスト     ' + DOTS_PROP.ALLOWLIST + ' : ' + allow.length + '件');
  Logger.log('投稿先トピック ' + DOTS_PROP.THREAD_ID + ' : ' + (p.getProperty(DOTS_PROP.THREAD_ID) || '(未設定=日報トピック)'));
  Logger.log('日報の作成者名 : ' + (staff ? staff.nameJp + '（スタッフマスター）' : '⚠️ 解決できず（RON_CHAT_ID を確認）'));
  Logger.log('トリガー       : ' + triggers.length + '本');
  Logger.log('当日の状態     : ' + (p.getProperty(DOTS_STATE_PROP.DAY_STATE) || '{}'));
}

/** 5分待たずに今すぐ1回動かす（停止スイッチは尊重する） */
function debugRunDotsBridgeNow() {
  runDotsBridge();
}
