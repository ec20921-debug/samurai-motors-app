/**
 * Migration_P6_LegacyReimburse.gs — 既存「立替」レコードの新セマンティクス移行
 *
 * 【目的】
 *   P2 で立替の意味を再定義（ロン→プール消費 / 飯泉等→個人立替）したため、
 *   既存の「立替 + ステータス=未精算」レコードと自動生成済み精算タスクを整理する。
 *
 * 【一度だけ実行する関数】
 *   migrateP6LegacyReimburse() を GAS エディタで 1 回実行 → ログ確認 → 完了
 *
 * 【処理内容】
 *   経費シートで `立替区分=立替` の行を全件スキャン：
 *     - 登録者=ロン  かつ ステータス=未精算 → ステータスを 'プール消費' に変更
 *                                            関連 精算タスク（未着手）を 'キャンセル' に変更
 *     - 登録者≠ロン かつ ステータス=未精算 → ステータスを '個人立替' に変更
 *                                            関連 精算タスクは触らない（γ＝記録のみだが
 *                                            既存タスクは運用判断で残す）
 *
 * 【冪等性】
 *   既に 'プール消費' / '個人立替' になっている行は無視。
 *
 * 【削除推奨】
 *   このファイルは本番反映後・1 回実行・動作確認できたら GAS から削除して OK。
 *   Git 履歴には残るのでいつでも復元可能。
 */

function migrateP6LegacyReimburse() {
  const sheet = getSheet(SHEET_NAMES.EXPENSES);
  const rows = getAllRows(SHEET_NAMES.EXPENSES);
  const headers = getHeaders(SHEET_NAMES.EXPENSES);

  const statusIdx = headers.indexOf('ステータス');
  if (statusIdx < 0) throw new Error('経費シートに ステータス 列がありません');

  let toPool = 0, toPersonal = 0, taskCancelled = 0, skipped = 0;
  const cancelledTaskIds = [];

  rows.forEach(function(r, i) {
    if (String(r['立替区分']) !== '立替') return;
    const status = String(r['ステータス']);
    if (status !== '未精算') {
      skipped++;
      return;
    }
    const rowNum = i + 2; // ヘッダー行ぶん +1, 0-indexed → 1-indexed
    const registrant = String(r['登録者']);
    const linkedTaskId = String(r['関連タスクID'] || '').trim();

    if (registrant === 'ロン') {
      sheet.getRange(rowNum, statusIdx + 1).setValue('プール消費');
      toPool++;
      // 関連 精算タスクをキャンセル（未着手のもののみ）
      if (linkedTaskId) {
        try {
          const taskRow = findRow(SHEET_NAMES.TASKS, 'タスクID', linkedTaskId);
          if (taskRow && String(taskRow.data['ステータス']) === '未着手') {
            updateRow(SHEET_NAMES.TASKS, taskRow.row, {
              'ステータス':   '完了',
              '完了日時':     new Date(),
              '未完了理由':   'P6 移行: ロンのプール消費に再分類、精算タスク不要として自動クローズ'
            });
            cancelledTaskIds.push(linkedTaskId);
            taskCancelled++;
          }
        } catch (err) {
          Logger.log('⚠️ タスククローズ失敗 ' + linkedTaskId + ': ' + err);
        }
      }
    } else {
      sheet.getRange(rowNum, statusIdx + 1).setValue('個人立替');
      toPersonal++;
      // 個人立替の既存タスクはそのまま残す（運用で精算するか判断）
    }
  });

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('✅ migrateP6LegacyReimburse 完了');
  Logger.log('  ロン → プール消費:       ' + toPool + '件');
  Logger.log('  ロン以外 → 個人立替:     ' + toPersonal + '件');
  Logger.log('  関連タスク 自動クローズ: ' + taskCancelled + '件');
  Logger.log('  スキップ（変更不要）:    ' + skipped + '件');
  if (cancelledTaskIds.length > 0) {
    Logger.log('  クローズしたタスクID: ' + cancelledTaskIds.join(', '));
  }
  Logger.log('━━━━━━━━━━━━━━━━━━━━');

  return {
    ok: true,
    toPool: toPool,
    toPersonal: toPersonal,
    taskCancelled: taskCancelled,
    skipped: skipped,
    cancelledTaskIds: cancelledTaskIds
  };
}

/**
 * dry-run: 何が起きるかだけログに出して実際の変更はしない
 */
function migrateP6LegacyReimburseDryRun() {
  const rows = getAllRows(SHEET_NAMES.EXPENSES);
  let toPool = 0, toPersonal = 0, skipped = 0;
  const samples = [];

  rows.forEach(function(r) {
    if (String(r['立替区分']) !== '立替') return;
    const status = String(r['ステータス']);
    if (status !== '未精算') { skipped++; return; }
    const registrant = String(r['登録者']);
    if (registrant === 'ロン') {
      toPool++;
      if (samples.length < 5) {
        samples.push('ロン: ' + r['経費ID'] + ' / ' + r['品目・摘要'] + ' → プール消費');
      }
    } else {
      toPersonal++;
      if (samples.length < 5) {
        samples.push(registrant + ': ' + r['経費ID'] + ' → 個人立替');
      }
    }
  });

  Logger.log('━━━ DRY RUN (変更なし) ━━━');
  Logger.log('  ロン → プール消費 予定:   ' + toPool + '件');
  Logger.log('  ロン以外 → 個人立替 予定: ' + toPersonal + '件');
  Logger.log('  スキップ予定:            ' + skipped + '件');
  Logger.log('  サンプル:');
  samples.forEach(function(s) { Logger.log('    ' + s); });
  return { dryRun: true, toPool: toPool, toPersonal: toPersonal, skipped: skipped, samples: samples };
}
