# Samurai Motors アプリ（GAS / clasp）

## デプロイ・同期ルール（clasp 自動デプロイ、2026-04-23〜）
- push コマンド：`"C:/nodejs-global/clasp.cmd" push --force`（v7 / v7-operations 各ディレクトリで実行）
- `.txt` ペアファイルは廃止
- 旧 OneDrive フォルダ（`OneDrive/Desktop/samurai-motors-app`）は保険として残置（**編集禁止**）
- コード変更後は必ず `git add` → `git commit` → `git push`（GitHub: ec20921-debug/samurai-motors-app）

## Google アカウント
- GSS・GAS・Drive 操作は **`ec20921@gmail.com`**（workspace-mcp / Sheets API の `user_google_email` に必ず指定）
- `drym.project2021@gmail.com` は Claude 用アカウント（Samurai Motors 資産はない）

## メインスプシ『📒Samurai Motors 経費・勤務関連』
- **スプシ ID**: `1-5rMJW21t4PnpXnDAYdrNXzz672kL2cd4mOSti3Yfc0`
- **URL**: `https://docs.google.com/spreadsheets/d/1-5rMJW21t4PnpXnDAYdrNXzz672kL2cd4mOSti3Yfc0/edit`
- 主要タブ:
  - 経費（Bot入力先・既存）
  - 経費マスター（経費の集約 SoT、Bot入力時に GAS が自動転記）
  - 前払い管理（飯泉→ロン君 ABA送金履歴）
  - ルーティン経費（月次定期経費）
  - 経費ダッシュボード（KPI・カテゴリ別・月別・負担先別）
  - 設定（為替・残金アラート閾値）
  - その他既存（スタッフマスター・タスク・日報・勤怠記録 等）

## リポジトリ構成
- `v7/` — 顧客対応系 GAS（予約・決済・チャット管理）
- `v7-operations/` — 勤務系 GAS（勤怠・タスク・経費・日報）

## 担当エージェント
- 日次記帳・残金突合: **加藤 (choba)**
- 月次決算・P&L・$50超承認: **金子 (kaneko)**
