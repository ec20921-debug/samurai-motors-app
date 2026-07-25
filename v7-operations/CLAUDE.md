# CLAUDE.md — Samurai Motors v7-operations（本番稼働中）

Samurai Motors の**社内業務系**（勤怠・日報・経費・タスク・管理コンソール）を担う GAS プロジェクト。
v7（顧客対応系）とは**完全に別の GAS・別の Bot**。互いに参照・呼び出ししない。

## 🎯 スコープ

| ✅ 対象 | ❌ 対象外（→ v7） |
|---|---|
| 勤怠打刻（GPS付き）/ タスク管理 / 日報 | 予約・顧客チャット |
| 経費入力（レシートOCR）・経費同期・ルーティン経費 | 決済・QRコード |
| 管理コンソール・経営ダッシュボード・ExecChat | 顧客マスター・料金設定 |
| キャンペーン管理（JETRO・撥水）・パートナー管理 | 業務Bot との通信 |

## 🏗 実ファイル構成（2026-07-03 実測: 20ファイル・9,811行）

| グループ | ファイル |
|---|---|
| 基盤 | Config / Router / TelegramAPI / SheetHelpers / QueueManager / BotPoller |
| 勤怠・日報・タスク | AttendanceManager / DailyReport / TaskManager |
| 経費 | ExpenseManager / ExpenseSync / RoutineExpense |
| 経営・レポート | Dashboard / ExecDashboard / ExecChat / ReportManager |
| 渉外・キャンペーン | PartnerManager / JetroCampaignManager / WaterRepellentManager / SalesLogManager（車屋提携 営業ログ・書込先は v7 Database「営業ログ」タブ） |
| セットアップ | Setup（本番ファイル扱い、push される） |

- ミニアプリ: `home-internal.html` 系（勤務Bot からの入口）
- **スタンドアロン GAS**（スプレッドシート非紐付け）— container-bound とは API 挙動が違う点に注意（→ docs/OPS_LESSONS.md #5）

## 📊 スプレッドシート・管理グループ

- 勤務専用スプレッドシート（v7 顧客用とは別ファイル）: PropertiesService キー `OPERATIONS_SPREADSHEET_ID`
- Admin グループ（フォーラム）は v7 と共通（`ADMIN_GROUP_ID` 同値）。**topic は用途別に使い分け**、topic ID 管理は各プロジェクト独立

## 🚫 禁止事項・実装ルール

- v7 と共通の絶対ルール（トークンハードコード禁止 / CacheService キュー禁止 / doPost 重処理禁止 等）→ **ルート CLAUDE.md と docs/GAS_PATTERNS.md 参照**
- `rm -rf` 無確認実行の禁止

## 🪶 肥大化ルール（2026-07-03 改定 — 実測基準）

- **基準線 = 9,811行（2026-07-03 実測）**。当初目標2,500行は撤廃。**約11,300行（基準線+15%）を超える前に整理タイム**
- 1ファイル 500行超で責務分割検討。新機能は新モジュールで

## ⚠️ 過去のハマりどころ索引（全文・コード例: docs/OPS_LESSONS.md — ミニアプリ/GAS連携を書く前に必読）

1. ミニアプリ→GAS の fetch は **v7 booking.html と同一書式**（iOS Safari 405 対策。`Content-Type: text/plain` 明示）
2. URL 分解 regex は**先に `?` でクエリを落としてから**（Telegram WebView 404）
3. Mini App の `initDataUnsafe.user` は**初回URLのみ**。遷移先へは chatId を URL クエリで渡す
4. 動作確認は**本番と同じ URL 形式**（クエリ付き）で行う
5. スタンドアロン GAS で `getActiveSpreadsheet()` は **null**。`openById` + TZ 統一（日付1日ズレの元凶）
6. フォーラムトピックの thread_id は URL の**真ん中**の数字（`t.me/c/<group>/<topic>/<msg>`）
7. 原因説明を繰り返さない。**修正→commit→push を1ターンで完結**

## 🚦 現況（2026-07-03 更新 — 旧 Phase 表は廃止）

- 勤怠・タスク・日報・経費・管理コンソールまで**本番稼働中**。開発は機能単位（完了時: デプロイ→実機確認→push→報告）
- 経費まわりの担当エージェント: 日次記帳=**加藤 (choba)**、月次P&L=**金子 (kaneko)**
