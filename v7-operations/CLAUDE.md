# CLAUDE.md — Samurai Motors v7-operations

本プロジェクトは、Samurai Motors の**内務系（現場スタッフの勤怠・日報・経費・タスク管理）** を担う Google Apps Script プロジェクトです。v7（顧客対応系）とは完全に別の GAS プロジェクト・別の Telegram Bot で稼働します。

---

## 🎯 スコープ

| ✅ 対象 | ❌ 対象外 |
|---|---|
| 勤怠打刻（GPS付き） | 予約・顧客チャット |
| タスク管理（配布・完了報告） | 決済・QRコード |
| 日報入力 | 顧客マスター・車両管理 |
| 経費入力（レシートOCR） | 料金設定 |
| 管理コンソール（ダッシュボード） | 業務Bot との通信 |

v7 (顧客系) との分離は厳格に。互いに参照・呼び出ししない。

---

## 🏗 構成

```
v7-operations/ （本ディレクトリ）
├── Config.gs            — 設定定数、PropertiesService 参照
├── Router.gs            — doGet/doPost ルーティング
├── TelegramAPI.gs       — 内務Bot API ラッパー
├── SheetHelpers.gs      — シート CRUD + スタッフマスターキャッシュ
├── QueueManager.gs      — 非同期キュー
├── BotPoller.gs         — 内務Bot の getUpdates ポーリング
├── Setup.gs             — 初回シート作成（スタッフマスター・勤怠記録 等）
├── AttendanceManager.gs — 勤怠（Phase 1b で追加）
├── TaskManager.gs       — タスク管理（Phase 2 で追加）
└── ...（日報/経費/管理コンソールは後続 Phase）
```

---

## 🤖 内務Bot の責務

- ポーリングで update 取得
- ミニアプリ（`home-internal.html`）からの API リクエスト受付（doGet/doPost）
- Admin トピックへの通知（打刻・タスク配布・日報リマインダー等）

---

## 📊 スプレッドシート

v7 の顧客用スプレッドシートとは**別ファイル**（内務専用）を使う。
- PropertiesService キー: `OPERATIONS_SPREADSHEET_ID`
- 既存の v5/v6 時代のスプレッドシートを流用（Tasks, Expenses, DailyReports, Attendance 等が入っているもの）
- 新設シート: `スタッフマスター`

---

## 🔗 管理グループの共有

Admin グループ（フォーラム）は v7 と v7-ops で共通利用する。
- `ADMIN_GROUP_ID` は v7 と同値
- ただし topic は用途別に使い分ける（顧客トピック ≠ 勤怠通知トピック）
- topic ID 管理は各プロジェクトが独立して行う

---

## 🚫 禁止事項（v7 と共通）

- Botトークン等のハードコード
- CacheService でキュー管理
- doPost 内で重い処理
- `rm -rf` 無確認実行

---

## 🪶 コード肥大化防止

- 1ファイル 500行 超えたら責務分割
- 全体 2,500 行を目標（v7-ops は機能少なめ）
- セットアップ・移行コードは初回実行後削除

---

## 📋 現在の Phase

**Phase 1a**: 基盤整備（本ドキュメント時点） ⬅️ 現在位置
**Phase 1b**: 勤怠打刻（GPS付き）
**Phase 1c**: Admin通知 + 履歴API
**Phase 1d**: ミニアプリ hub 分離（業務Bot から内務項目削除、home-internal.html 新設）
**Phase 2**: タスク管理
**Phase 3**: 日報
**Phase 4**: 経費
**Phase 5**: 管理コンソール
