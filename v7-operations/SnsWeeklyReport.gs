/**
 * SnsWeeklyReport.gs — SNS 週次レビュー（Facebook）を管理グループの日報トピックへ送る（2026-11-09 Daisuke 指示）
 *
 * 【責務】
 *   本文は Day1 の tools/motors_pdca.py --post-weekly が毎週月曜に作り、
 *   FB動画量産管理 GSS のタブ「12_SNS週次」に1行入れる（A 週 / B 本文〈Telegram HTML〉/ C 作成日時 / D 送信状態 / E 送信日時）。
 *   ここでは D が「未送信」の行を、日報のあと（20:32〜20:59 JST）に日報トピックへ送り、D を「送信済」にする。
 *
 * 【なぜ GAS から送るか】
 *   日報と同じ Bot・同じトピックに届けるため。Bot のトークンは Script Properties にだけあり、PC 側には置かない。
 *
 * 【止め方】
 *   D 列を「未送信」以外（例: 停止）にすれば送らない。
 */

const SNS_WEEKLY_SPREADSHEET_ID_ = '1O9b6y9hFqTzPVygqu81M80dB2Zng1WWWde3daep07fo'; // FB動画量産管理 GSS（秘密ではない）
const SNS_WEEKLY_TAB_ = '12_SNS週次';

/** 1分トリガー（pollInternalBot）から毎分呼ばれる。時刻窓の外は即 return */
function maybeSendSnsWeekly_() {
  const hm = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm');
  if (hm < '20:32' || hm > '20:59') return;
  sendPendingSnsWeekly_();
}

function sendPendingSnsWeekly_() {
  const cfg = getConfig();
  if (!cfg.adminDailyReportThreadId) return;
  const sh = SpreadsheetApp.openById(SNS_WEEKLY_SPREADSHEET_ID_).getSheetByName(SNS_WEEKLY_TAB_);
  if (!sh) return;
  const last = sh.getLastRow();
  if (last < 2) return;
  const rows = sh.getRange(2, 1, last - 1, 5).getValues();
  rows.forEach(function (r, i) {
    if (String(r[3]).trim() !== '未送信' || !String(r[1]).trim()) return;
    const rowNo = i + 2;
    sh.getRange(rowNo, 4).setValue('送信中'); // 送る前に印（多重送信の防止を優先）
    SpreadsheetApp.flush();
    const res = sendMessage(BOT_TYPE.INTERNAL, cfg.adminGroupId, String(r[1]), {
      parse_mode: 'HTML',
      message_thread_id: Number(cfg.adminDailyReportThreadId),
      disable_web_page_preview: true
    });
    const ok = res && res.ok;
    sh.getRange(rowNo, 4, 1, 2).setValues([[ok ? '送信済' : '送信失敗', Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')]]);
    Logger.log((ok ? '📤 SNS 週次レビュー送信 ' : '❌ SNS 週次レビュー送信失敗 ') + r[0] + (ok ? '' : ' res=' + JSON.stringify(res)));
  });
}

/** 手動確認用: 時刻窓を無視して「未送信」の行を今すぐ送る */
function debugSendSnsWeeklyNow() {
  sendPendingSnsWeekly_();
}
