/**
 * InternalBotDispatcher.gs — 勤務Bot の update 入口（ここ1か所だけ）
 *
 * 【経緯】2026-10-20
 *   2026-04-18 に AttendanceManager.gs（/start → ミニアプリ起動ボタン）と
 *   TaskManager.gs（インラインボタン押下の処理）が、同じ名前 handleInternalBotUpdate を別々に定義していた。
 *   GAS は全ファイルが1つのグローバル空間で、同名の関数は後に読まれた方が勝つ。
 *   clasp はファイル名のアルファベット順に送るため TaskManager 側だけが動き、
 *   /start・/menu への返信は黙って止まっていた。入口をここに集めて各機能へ振り分ける。
 *
 * 【振り分け】
 *   - callback_query（インラインボタン） → handleTaskCallback_（TaskManager.gs。パートナー承認・撥水モニターもここから派遣）
 *   - /start・/menu                      → handleInternalMenuCommand_（AttendanceManager.gs）
 *   - その他のテキスト（/ping 等）       → handleTextCommand_（TaskManager.gs）
 *
 * QueueManager.processInternalQueue から呼ばれる。
 * 例外はここで受け止めてログに残す（投げ返すとキューが消えず、毎分再試行され続けるため）。
 */
function handleInternalBotUpdate(update) {
  try {
    if (update.callback_query) {
      handleTaskCallback_(update.callback_query);
      return;
    }
    const msg = update.message;
    if (!msg || !msg.text) return;
    if (handleInternalMenuCommand_(msg)) return;
    handleTextCommand_(msg);
  } catch (err) {
    Logger.log('❌ handleInternalBotUpdate update_id=' + (update && update.update_id) + ' err=' + err +
      (err && err.stack ? '\n' + err.stack : ''));
  }
}
