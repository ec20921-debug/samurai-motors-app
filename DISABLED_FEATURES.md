# 一時無効化機能メモ (Phase 1: 2026-04-14)

Samurai Motors アプリのコア機能（予約・ジョブ管理・顧客問い合わせ返信）を安定稼働させるため、以下の機能を一時的に無効化した。各機能は `SamuraiMotors_AppsScript_v6.js` 内で `// [DISABLED:<feature>]` コメントで囲まれている。

## なぜ無効化したか

GAS処理が重すぎてTelegramが60秒タイムアウトで再送 → 通知が30回スパムされる問題が発生。根本原因は処理時間の長さ。まずコア機能だけにして処理を軽くし、安定稼働を優先する。

## 復元時の一般手順

1. このファイルの該当セクションを読む
2. `// [DISABLED:<feature>]` ブロックを探してコメントアウトを外す
3. 関連する switch case を有効化
4. 関連トリガーがあれば setupV6Triggers() に復活させる
5. テスト（最低でも1件ずつ動作確認）

---

## 1. タスク管理（Tasks）

### 概要
Adminが現場スタッフにタスクを割り振り、スタッフが完了/未完了を報告できる機能。インラインボタンで操作。

### シート
- **Tasks シート**（自動作成）
- 列: Task ID, 作成日時, 担当者, 担当者ChatID, 期限, やるべきこと, ステータス, 完了日時, 未完了理由, 繰返しルール, 親タスクID, 関連経費ID

### 無効化した箇所
- `doPost` switch case: `task_create`, `task_update`, `task_edit`
- Adminグループコマンド: `/task`, `/tasklist`
- フィールドスタッフコマンド: `/tasks`
- 会話ステート: `task_create`, `pending_reason`
- callback_query: `task_done:`, `task_notdone:`

### 主要関数（残存、呼び出し停止のみ）
- `handleAdminTaskCommand()` 1444行付近
- `handleTaskCreateFlow()` (会話フロー)
- `showAllTasks()` 1545行付近
- `showMyTasks()` 1575行付近
- `handleTaskCreateFromApp()` 2791行付近
- `handleTaskUpdateFromApp()`, `handleTaskEditFromApp()`
- `handlePendingReasonFlow()` (未完了理由入力)
- `getTasksSheet()`, `createTask()`, `updateTaskStatus()`

### 復元手順
1. `doPost` の `case 'task_create'`〜`task_edit'` のコメントアウトを解除
2. `handleTelegramWebhook` 内の `/task`, `/tasklist`, `/tasks` コマンドを有効化
3. `handleConversationState` の `task_create`, `pending_reason` ケースを有効化
4. `handleCallbackQuery` の `task_done:`, `task_notdone:` ブロックを有効化

---

## 2. 経費 OCR（Receipt）+ 経費登録

### 概要
フィールドスタッフが `/receipt` コマンドで起動し、レシート写真を送ると自動OCRで金額・店名・日付を読み取って Expenses シートに登録する機能。ミニアプリ（expense-entry.html）からの手動入力経路も別途あり。

### シート
- **Expenses シート**（自動作成）
- 列: Expense ID, 日付, カテゴリ, 金額(USD/KHR), 詳細, 支払い方法, 担当者, レシート写真URL, メモ

### 無効化した箇所
- `doPost` switch case: `expense_create`, `expense_edit`
- フィールドスタッフコマンド: `/receipt`
- 会話ステート: `receipt_pending`

### 主要関数（残存）
- `handleReceiptFlow()` 2104行付近 — レシートOCRフロー
- `handleExpenseCreateFromApp()` 3226行付近
- `handleExpenseEditFromApp()`
- OCR関連: 画像をClaudeまたはVision APIで解析する処理が含まれる可能性

### 復元手順
1. `doPost` の `case 'expense_create'`, `case 'expense_edit'` を有効化
2. `/receipt` コマンド処理を有効化
3. `receipt_pending` 会話ステートを `handleConversationState` で有効化
4. **expense-entry.html のミニアプリは別動作**（予約ミニアプリと分離）なので、こちらはURLさえ使えば今でも動く

---

## 3. 日報（Daily Report）

### 概要
フィールドスタッフが1日の終わりにミニアプリから日報を提出する機能。

### シート
- **DailyReports シート**

### 無効化した箇所
- `doPost` switch case: `daily_report`

### 主要関数
- `handleDailyReportFromApp()` 3127行付近

### 復元手順
1. `doPost` の `case 'daily_report'` を有効化

---

## 4. 勤怠管理（Attendance）

### 概要
フィールドスタッフの出勤・退勤打刻。ミニアプリから送信。

### シート
- **Attendance シート**

### 無効化した箇所
- `doPost` switch case: `attendance`

### 主要関数
- `handleAttendanceFromApp()` 2948行付近

### 復元手順
1. `doPost` の `case 'attendance'` を有効化

---

## 5. 在庫管理（Inventory）

### 概要
既に以前のフェーズで一時停止済み。`memory/project_inventory_architecture.md` に詳細あり。

### 状態
既に無効化されているので今回は変更なし。

---

## 6. Admin ⇄ Field 間の一般メッセージ転送

### 概要
Adminグループに送信されたテキスト/写真/音声等を全フィールドスタッフに転送する機能。問い合わせ返信フロー（inquiry_reply）とは別。

### 無効化した箇所
- `handleTelegramWebhook` 内の Admin グループ一般転送ブロック（358-400行付近、`/task`, `/tasklist`, `/reply` 以外）
- フィールドスタッフ → Admin 一般メッセージ転送（420-430行付近）

### 理由
これらは顧客対応に必須ではなく、処理時間増加の一因。内部連絡はTelegramで直接できるため不要。

### 復元手順
1. `handleTelegramWebhook` のコメントアウトを解除

---

## 7. 24時間未払い催促トリガー（checkUnpaidBookings）

### 状態
**残す**。これは予約フローの一部で重要。ただし1時間毎実行なので負荷監視は必要。

---

## Phase 1 で保持する機能（コア）

- ✅ Booking Bot（顧客向け予約）
- ✅ booking.html（予約ミニアプリ）
- ✅ job-manager.html（ジョブ管理ミニアプリ）
- ✅ `doPost` のアクション: `job`, `job_start`, `job_end`, `booking_*`, `chat_*`, `inquiry_reply`
- ✅ 駐車情報フロー（写真+フロア）
- ✅ 支払いQR送信フロー
- ✅ 問い合わせ返信ボタン（Field Bot経由）
- ✅ ChatLog記録
- ✅ 24h未払い催促

## Phase 1 で追加される「非同期キュー方式」

Telegram Webhookは即座に `ok` を返し、実処理は1分毎のトリガー（`processTelegramQueue`）で行う。これによりTelegramのリトライが止まり、重複通知スパムが解消される。

- キュー保存: `PropertiesService.getScriptProperties()` に `queue_<timestamp>_<update_id>` キーで保存
- 処理トリガー: `processTelegramQueue()` を1分毎に実行
- 同じ update_id は1回だけ処理（重複排除）
- 処理後は即座にキーを削除
- 5分超のループ回避でタイムアウト防止

## 復元時の注意

- GAS コード行数は今の倍以上に戻るので、再度ファイル分割（clasp導入等）を検討すること
- 復元時は1機能ずつ有効化して動作確認する（一気に戻すとまた重くなる）
- 復元後はGASの実行ログで平均処理時間をチェック（目標: 1秒以下）

---

## 関連ドキュメント

- `memory/project_inventory_architecture.md` — 在庫管理（既に無効化済み）
- `CLAUDE.md` — 作業ルール全般
