# CLAUDE.md — Samurai Motors（本番稼働中）

カンボジア・プノンペンの**出張洗車サービス**を支える Telegram + GAS システム。
本リポジトリは2つの GAS プロジェクトを含む：

- `v7/` — **顧客対応系**（予約・洗車管理・決済・顧客チャット・キャンペーン）
- `v7-operations/` — **社内業務系**（日報・勤怠・経費・タスク。別 GAS プロジェクト）

### 3つの Telegram 要素（呼称統一）

| 呼称 | 役割 | Script Property |
|---|---|---|
| **予約Bot** | 顧客用（唯一の接点） | `BOT_TOKEN_BOOKING` |
| **業務Bot** | 現場スタッフ用（ミニアプリ主体） | `BOT_TOKEN_FIELD` |
| **管理グループ** | 日本側管理者（フォーラムトピック付き） | `BOT_TOKEN_INTERNAL` |

---

## 🌐 言語ルール（最重要 — 毎回確認）

| 画面・機能 | 使う人 | メイン言語 | 補足言語 |
|---|---|---|---|
| 予約Bot（チャット） | 🇰🇭 顧客 | クメール語 | 英語 |
| booking.html（ミニアプリ） | 🇰🇭🌏 顧客全般 | 英語 | クメール語 |
| 業務Bot / job-manager.html | 🇰🇭 現場スタッフ | クメール語 | 日本語（括弧） |
| 管理グループ通知 | 🇯🇵 日本人管理者 | 日本語 | — |
| スプレッドシート | 🇯🇵 管理者（主） | 日本語 | 英語（列ヘッダー） |
| GASコード・コメント | 開発者 | 英語 | — |

- 例: 顧客向け `សូមជ្រើសរើស / Please select`、スタッフ向け `ចាប់ផ្តើមការងារ（作業開始）`、ヘッダー `予約番号(booking_id)`
- ❌ 顧客に日本語を見せない / スタッフUIを英語だけにしない / 管理通知をクメール語にしない

---

## 📁 v7 実ファイル構成（2026-07-03 実測: 29ファイル・11,055行 / 本番push対象 10,374行）

| グループ | ファイル | 役割 |
|---|---|---|
| 基盤 | Config / Router / QueueManager / TelegramAPI / SheetHelpers / Holidays / BotPoller | 設定・ルーティング・キュー・API・シートIO・祝日・ポーリング |
| 予約 | BookingBot / BookingLogic / BookingDashboard | 会話フロー・空き検索/料金・予約ダッシュボード |
| 作業管理 | JobManager | 作業開始/完了・写真3方向配信・リピーター判定 |
| 顧客コミュ | CustomerChat / CustomerContact / CustomerNotifier / ForumTopicManager | 転送・連絡先・通知・1顧客1トピック |
| 決済 | PaymentManager | QR送信・スクショ受付・24h催促 |
| キャンペーン | Campaign / CampaignAssets / CampaignBooking / CampaignScheduler / CampaignSheets | 配信・素材・予約連動・スケジュール・シート |
| セットアップ系（本番外） | Setup / SetupProperties / GetGroupId / WebhookSetup | .claspignore で push 除外 |
| ⚠️ 整理候補 | Setup_CampaignBooking / Setup_MenuV2 / Setup_MenuV3 / Migration_ServiceType | **claspignore 漏れで push 対象に残存**（docs/DEPLOY.md 参照） |

- ミニアプリ: `booking.html` / `job-manager.html`（GitHub Pages ホスト）

---

## 🔒 GAS 実装の絶対ルール（コード例と背景: docs/GAS_PATTERNS.md）

1. **doPost は1秒以内に `ok` を return**。実処理はキュー投入→ `processTelegramQueue`（1分トリガー）側で。v6 崩壊の直接原因
2. **キュー・重複排除マーカー・トークンは ScriptProperties（永続）**。返信状態・キャッシュ類は CacheService（揮発）。判断基準:「失うと業務影響が出るか」
3. **トークン・ID類のハードコード禁止**。すべて PropertiesService から取得。コミット前チェック必須
4. **1顧客 = 1トピック**。`CUSTOMERS.thread_id` を先に検索、`createForumTopic` は存在しない時のみ
5. **`status`（作業進行）と `payment_status`（決済）は完全独立**。`status=paid` は使わない。全フロー完了 = `completed` かつ `清算済み`
6. **3方向配信**: 作業開始・完了・写真は必ず 顧客 / Admin / シート へ同時配信
7. **QR は1予約1回のみ**。24h催促にQR再添付しない。QRは `QR_CODES` シートの `active=TRUE` 行から
8. **設定はシート連動**（Plan_Prices、60秒キャッシュ）。料金・営業時間をコードにハードコードしない

### 常設トリガー

| 関数 | 間隔 | 役割 |
|---|---|---|
| `processTelegramQueue` | 1分 | キュー処理（Bot処理の本体） |
| `checkUnpaidReminders` | 1時間 | 24h未払い検知→催促 |
| `cleanupOldProcessedIds` | 1時間 | 古い処理済みマーカー削除 |

---

## 🚦 現況（2026-07-03 更新 — 旧 Phase 表は廃止）

- **v7 は本番稼働中**（2026-04〜）。当初の「12ファイル・3,500行」計画は卒業し、キャンペーン系・顧客通知系が加わって現在の実測規模に成長
- 開発は**機能単位**で進める。完了時ルール: ①デプロイ→実機確認 ②GitHub push ③ユーザー報告 ④問題は持ち越さない
- v2〜v6 は 2026-04-18 削除済み（Git 履歴に残存）。v6 シートデータは削除禁止（バックアップ保持）

## 🪶 肥大化ルール（2026-07-03 改定 — 実測基準）

- **基準線 = 本番 push 対象 10,374行（2026-07-03 実測）**。**約12,000行（基準線+15%）を超える前に機能追加を止めて整理**
- 1ファイル 500行超で責務分割を検討。**新機能は既存ファイルへの追記でなく新モジュールで**
- セットアップ・移行・デバッグコードは本番に混ぜない（.claspignore 運用。詳細: docs/GAS_PATTERNS.md §4-5）

---

## 🚫 絶対にやってはいけないこと

1. トークン・機密のハードコード（→ PropertiesService。docs/GAS_PATTERNS.md §3）
2. CacheService でキュー管理（v6 で通知消失の実績あり）
3. doPost 内での重い処理（重複スパム発生）
4. 同一顧客のトピック複数作成
5. `status` 列に `paid` を入れる
6. 無許可のファイル削除・本番データ変更（v6 シートデータは削除禁止・`rm -rf` 系は確認必須）
7. main への force push（原則禁止・必要時は事前確認）

---

## 🚀 デプロイ（正式手順: docs/DEPLOY.md）

- `clasp push --force` を `v7/` と `v7-operations/` の各ディレクトリで実行（アカウント: `ec20921@gmail.com`）
- コード変更後は必ず git add → commit → push
- 旧 OneDrive フォルダ（`OneDrive/Desktop/samurai-motors-app`）は保険スナップショット。**編集禁止**

## 📊 メインスプシ『📒Samurai Motors 経費・勤務関連』

- ID: `1-5rMJW21t4PnpXnDAYdrNXzz672kL2cd4mOSti3Yfc0`（操作は ec20921@gmail.com、`user_google_email` に必ず指定）
- 主要タブ: 経費（Bot入力先）/ 経費マスター（SoT・GAS自動転記）/ 前払い管理 / ルーティン経費 / 経費ダッシュボード / 設定
- 担当エージェント: 日次記帳=**加藤 (choba)**、月次P&L・$50超承認=**金子 (kaneko)**

## 📎 関連ドキュメント

- `docs/DEPLOY.md` — clasp デプロイ正式手順・戻し方・claspignore ポリシー
- `docs/GAS_PATTERNS.md` — doPost/Properties/Cache のコード例・v6 教訓・自問ルール
- `docs/SPEC_v7_CustomerSystem.md` — 完全仕様書 / `docs/SPEC_v7.5.md` 等 — 増分仕様
- `docs/manual_admin_jp.md` / `docs/manual_staff_km.md` — 運用マニュアル

---

あなたの出力が終わったら、Codexがレビューします。品質を意識してください。
