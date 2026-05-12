/**
 * Migration_BulkImport_20260512.gs
 *
 * 2026-05-12 にロンが立替えた経費を一括で「経費」シートに登録するための
 * 一回限りの移行スクリプト。
 *
 * 【実行方法】
 *   1. clasp push でこのファイルを GAS にアップロード
 *   2. GAS エディタで migrateBulkImport20260512 を選択して実行
 *   3. 実行ログで結果確認
 *   4. このファイルを削除（コード肥大化防止）して再度 clasp push
 *
 * 【データソース】
 *   2026-05-12 飯泉さんが SAMURAI 業務連絡で送ったロンの経費リスト：
 *     チラシをコピー ×3 @ $12.5 / バイクはこぶ $5 / iBC $3.5 (※重複のため除外) /
 *     会社のけいたいのWifi $4 / バイクの鍵コピー $3 / バイクのガス $7 /
 *     会社の鍵を買う $6 / バイクの駐車場 $0.5
 *   合計（除外後）: $63 / 重複の iBC $3.5 は既登録の EXP-20260512-002 と同一とみなす
 *
 * 【区分】
 *   全件「会社直払い」とする。理由：
 *     ロンは飯泉さんから渡されていた前渡し金（$57）から支払っており、
 *     立替/精算ではなく実質「会社のお金で会社の費用を払った」状態。
 *     前渡し金トラッキング機能（SPEC_expense_cash_float.md）が未実装のため、
 *     当面はこの扱いで統一。
 *
 * 【注意】
 *   - notifyExpenseCreatedIfField_ を経由しないので Admin 通知は飛ばない（意図通り）
 *   - レシート写真は無し
 *   - 重複登録防止のため、実行前に経費シートで EXP-20260512-* の登録済み範囲を確認
 */

// 登録対象データ（必要に応じて編集してから実行）
const BULK_IMPORT_20260512_ = [
  { desc: 'チラシのコピー (1)',         amount: 12.5, vendor: '',    category: '広告宣伝費' },
  { desc: 'チラシのコピー (2)',         amount: 12.5, vendor: '',    category: '広告宣伝費' },
  { desc: 'チラシのコピー (3)',         amount: 12.5, vendor: '',    category: '広告宣伝費' },
  { desc: 'バイクの運搬',               amount: 5,    vendor: '',    category: '車両費'     },
  { desc: '会社の携帯Wifi',             amount: 4,    vendor: '',    category: '通信費'     },
  { desc: 'バイクの鍵コピー',           amount: 3,    vendor: '',    category: '車両費'     },
  { desc: 'バイクのガス代',             amount: 7,    vendor: '',    category: '車両費'     },
  { desc: '会社の鍵を購入',             amount: 6,    vendor: '',    category: '消耗品費'   },
  { desc: 'バイクの駐車場代',           amount: 0.5,  vendor: '',    category: '車両費'     }
  // iBC $3.5 は EXP-20260512-002 と重複のため除外
];

const BULK_IMPORT_20260512_TX_DATE_ = '2026-05-12';
const BULK_IMPORT_20260512_MEMO_    = '2026-05-12 飯泉さんからの前渡し金($57)から支払い。$20 ABA仮払い済み(残$10.5)';

function migrateBulkImport20260512() {
  const ron = findStaffByNameJp('ロン');
  if (!ron) {
    Logger.log('❌ スタッフ「ロン」が見つかりません。スタッフマスターを確認してください。');
    return;
  }

  ensureExpensesSheet(); // ヘッダー整備

  let okCount = 0;
  let totalUsd = 0;
  const results = [];

  BULK_IMPORT_20260512_.forEach(function(item, i) {
    try {
      const expenseId = generateDateSeqId('EXP', SHEET_NAMES.EXPENSES, '経費ID');
      appendRow(SHEET_NAMES.EXPENSES, {
        '経費ID':         expenseId,
        '登録日時':       new Date(),
        '取引日':         BULK_IMPORT_20260512_TX_DATE_,
        '品目・摘要':     item.desc,
        '金額':           item.amount,
        '通貨':           'USD',
        '取引先':         item.vendor,
        '勘定科目':       item.category,
        '登録者':         ron.nameJp,
        '登録者 Chat ID': ron.chatId || '',
        'レシート写真':   '',
        'OCR原文':        '',
        'ステータス':     '会社負担',
        'メモ':           BULK_IMPORT_20260512_MEMO_,
        '立替区分':       '会社直払い',
        '精算先':         '',
        '精算期限':       '',
        '精算日':         '',
        '精算方法':       '',
        '関連タスクID':   ''
      });
      okCount++;
      totalUsd += Number(item.amount);
      results.push('✅ ' + expenseId + ' ' + item.desc + ' / USD ' + item.amount);
    } catch (err) {
      results.push('❌ #' + (i + 1) + ' ' + item.desc + ' / ' + err);
    }
  });

  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('📊 Bulk Import 2026-05-12 結果');
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  results.forEach(function(r) { Logger.log(r); });
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('登録: ' + okCount + '/' + BULK_IMPORT_20260512_.length + ' 件');
  Logger.log('合計: USD ' + totalUsd.toFixed(2));
  Logger.log('━━━━━━━━━━━━━━━━━━━━');
  Logger.log('※ 実行完了後、このファイルを削除して clasp push してください');
}
