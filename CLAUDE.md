# CLAUDE.md — Samurai Motors v7 プロジェクト

このファイルは、本プロジェクトに初めて触れる Claude Code セッションが、**コードベースの構造・設計方針・やってはいけないこと・現在のフェーズを即座に把握する**ためのガイドです。作業を始める前に必ず一読してください。

---

## 🚗 プロジェクト概要

**Samurai Motors** はカンボジア・プノンペンで運営する**出張洗車サービス**です。本プロジェクトはそのサービスを支える **Telegram + Google Apps Script（GAS）** ベースのシステム。

### v7 の目的

前バージョン v6 は単一 GAS ファイルが **6,000行超**に肥大化し、通知遅延・重複送信・動作不安定が発生。v7 では **顧客対応系** と **社内業務系（日報・勤怠・経費・在庫）** を完全に分離し、顧客対応系のみを **3,000〜3,500行** でゼロから再構築します。

### 本リポジトリのスコープ

本プロジェクトは **顧客対応系のみ** を対象とします：

- ✅ 予約 / 洗車管理 / 決済 / 顧客チャット
- ❌ 日報 / 勤怠 / 経費 / 在庫管理（完全に別システム）

### システム構成

```
👤 顧客 → 📘 Facebook集客 → 🤖 予約Bot（Telegramミニアプリ）
                                     ↓
                          ⚙️ GAS v7 ← 📊 Googleスプレッドシート
                                     ↓          📅 Googleカレンダー
                          🤖 業務Bot ← 📁 Googleドライブ
                                     ↓
                          💬 管理グループ（フォーラムトピック）
```

### 3つのTelegram要素

| 呼称（統一） | 役割 | 旧呼称 |
|---|---|---|
| **予約Bot** | 顧客用（唯一の接点） | Bot C, booking bot |
| **業務Bot** | 現場スタッフ用（ミニアプリ主体） | Bot B, field bot |
| **管理グループ** | 日本側管理者（フォーラムトピック付き） | Admin Group |

※ 旧「管理Bot」は廃止。

---

## 🌐 言語ルール（最重要 — 必ず毎回確認）

誰が見るかで言語が決まる。迷ったらこの表を見ること。

| 画面・機能 | 使う人 | メイン言語 | 補足言語 |
|---|---|---|---|
| 予約Bot（チャット） | 🇰🇭 カンボジア人顧客 | クメール語 | 英語 |
| booking.html（ミニアプリ） | 🇰🇭🌏 顧客全般 | 英語 | クメール語 |
| 業務Bot（チャット） | 🇰🇭 現場スタッフ | クメール語 | 日本語（括弧） |
| job-manager.html（ミニアプリ） | 🇰🇭 現場スタッフ | クメール語 | 日本語（括弧） |
| 管理グループ通知 | 🇯🇵 日本人管理者 | 日本語 | — |
| スプレッドシート | 🇯🇵 日本人管理者（主）、🇰🇭 スタッフ（副） | 日本語 | 英語（列ヘッダー） |
| GASコード・コメント | 開発者 | 英語 | — |

### 書き方の例

- 顧客向け: `សូមជ្រើសរើស / Please select`
- スタッフ向け: `ចាប់ផ្តើមការងារ（作業開始）`
- 管理者向け: `▶️ 作業開始 - BK-0042 Hisanori / Camry`
- シートヘッダー: `予約番号(booking_id)`

### 絶対にやってはいけないこと

- ❌ 顧客に日本語を見せる
- ❌ スタッフ向けUIを英語だけにする
- ❌ 管理グループの通知をクメール語にする

---

## 📁 GASファイル構成と各ファイルの責務

v7 は **12ファイル体制**（合計 3,000〜3,500行想定）で構成します。**1ファイル 500行を超えたら責務分割を検討**してください。

```
📂 Samurai Motors v7（GASプロジェクト）
│
├── ⚙️ Config.gs            — 設定値定数、PropertiesService参照       100行
├── 🔀 Router.gs            — doPost/doGet のルーティング              150行
├── 📬 QueueManager.gs      — 非同期キュー管理（ScriptProperties）     150行
├── 📡 TelegramAPI.gs       — sendMessage / sendPhoto 等のラッパー    150行
├── 📊 SheetHelpers.gs      — スプレッドシート読み書きユーティリティ  250行
├── 📅 BookingBot.gs        — 予約Botの会話フロー                      400行
├── 📅 BookingLogic.gs      — カレンダー空き検索、料金計算             400行
├── 👷 FieldBot.gs          — 業務Bot処理                              300行
├── 🔧 JobManager.gs        — 作業ステータス、写真3方向配信            400行
├── 💬 CustomerChat.gs      — 顧客メッセージ転送、管理者返信           400行
├── 🧵 ForumTopicManager.gs — トピック作成、thread_id管理              200行
└── 💳 PaymentManager.gs    — QR送信、スクショ受付、自動催促           350行
```

### 各ファイルの責務

| ファイル | 責務 | 主要関数 |
|---|---|---|
| **Config.gs** | PropertiesService から設定値を取得し、定数としてexport | `CONFIG`, `getConfig()` |
| **Router.gs** | Telegram Webhook（doPost）とミニアプリAPI（doGet）のルーティング | `doPost`, `doGet` |
| **QueueManager.gs** | update_id 重複排除、キュー投入、1分トリガーでの取り出し処理 | `enqueueTelegramUpdate`, `processTelegramQueue`, `cleanupOldProcessedIds` |
| **TelegramAPI.gs** | Telegram Bot API のラッパー、sendMediaGroup、createForumTopic 等 | `sendMessage`, `sendPhoto`, `sendMediaGroup`, `createForumTopic`, `forwardMessage` |
| **SheetHelpers.gs** | 各シートの CRUD ユーティリティ、設定シート読み込み、キャッシュ | `getSheet`, `appendRow`, `findRow`, `getBookingConfig`（60秒キャッシュ） |
| **BookingBot.gs** | 予約Bot のコマンド・会話処理、ミニアプリ起動ボタン | `handleBookingBotUpdate`, `sendBookingMiniApp` |
| **BookingLogic.gs** | `findAvailableSlots`、`calculatePrice`、カレンダーイベント作成 | `findAvailableSlots`, `calculatePrice`, `createBooking` |
| **FieldBot.gs** | 業務Bot のコマンド・ミニアプリ起動 | `handleFieldBotUpdate`, `sendFieldMiniApp` |
| **JobManager.gs** | 作業開始・完了・写真アップロードの **3方向配信**（顧客/Admin/シート） | `startJob`, `endJob`, `uploadBeforePhotos`, `uploadAfterPhotos` |
| **CustomerChat.gs** | 顧客メッセージを Admin トピックへ転送、管理者返信フロー | `forwardToAdminTopic`, `handleAdminReply` |
| **ForumTopicManager.gs** | 1顧客=1トピックの排他制御、thread_id 管理 | `getOrCreateTopic`, `updateTopicName` |
| **PaymentManager.gs** | QR自動送信、スクショ受信処理、24h間隔催促 | `sendPaymentQR`, `handlePaymentScreenshot`, `checkUnpaidReminders` |

### ミニアプリ（別リポジトリ/GitHub Pagesでホスト）

- `booking.html` — 予約ミニアプリ（既存資産を流用、URL差し替えのみ）
- `job-manager.html` — 現場ミニアプリ（既存資産を流用、URL差し替えのみ）

---

## 🔒 doPost は即OK返却の非同期キュー方式

### 絶対に守るルール

Telegram Webhook（`doPost`）は **必ず1秒以内に `ContentService.createTextOutput('ok')` を return** してください。処理が遅いと Telegram がリトライを仕掛けて**重複通知スパム**が発生します。v6 はこれが原因で崩壊しました。

### 実装パターン

```javascript
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const updateId = data.update_id;

    // ① 重複排除チェック
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('processed_' + updateId)) {
      return ContentService.createTextOutput('ok'); // 既に処理済み
    }

    // ② キューに投入（これだけ。重い処理は絶対にしない）
    enqueueTelegramUpdate(data, botType);

    // ③ 即return（1秒以内）
    return ContentService.createTextOutput('ok');
  } catch (err) {
    Logger.log('doPost error: ' + err);
    return ContentService.createTextOutput('ok'); // エラーでも ok を返す（リトライ防止）
  }
}
```

### 実処理は1分間隔トリガーで

キューに溜めた更新は `processTelegramQueue()` が1分間隔で取り出して処理します。メッセージ送信・シート書き込み・画像保存等は全てこちら側で実行。

### トリガー構成

| トリガー関数 | 間隔 | 役割 |
|---|---|---|
| `processTelegramQueue` | 1分 | キュー処理（Bot メッセージ処理の本体） |
| `checkUnpaidReminders` | 1時間 | 24h経過未払い検知 → 自動催促送信 |
| `cleanupOldProcessedIds` | 1時間 | 24h経過した `processed_*` マーカー削除 |

---

## 🗄️ PropertiesService と CacheService の使い分けルール

**状態管理は2つのストレージを使い分けます。迷ったら下表を参照してください。**

### ScriptProperties を使う（永続・重要データ）

| データ | キー形式 | 理由 |
|---|---|---|
| Telegramキュー | `queue_{timestamp}_{update_id}` | GAS再起動でも失ってはいけない |
| update_id重複排除マーカー | `processed_{update_id}` | 24h保持が必要（Cacheの6h制限では短いケース対策） |
| Botトークン・設定値 | `BOT_TOKEN_BOOKING` 等 | 永続必須 |

### CacheService を使う（短期・揮発データ）

| データ | キー形式 | TTL | 理由 |
|---|---|---|---|
| 管理者返信状態 | `admin_reply_{admin_chat_id}` | 300秒 | 返信操作中だけ有効、放置されれば自動失効すべき |
| 料金表キャッシュ | `plan_prices_cache` | 60秒 | 高速化目的、失っても再取得可能 |
| 空き枠キャッシュ | `available_slots_{date}` | 60秒 | 高速化目的、失っても再取得可能 |

### 判断フローチャート

```
このデータは失われると業務影響が出る？
├── YES → ScriptProperties（永続）
└── NO  → CacheService（揮発）

GAS再起動・6時間経過後も保持が必要？
├── YES → ScriptProperties
└── NO  → CacheService
```

### v6 からの教訓

- **キュー系は絶対に ScriptProperties**。CacheServiceをキューに使うと6時間TTL・サイズ制限でデータ損失が発生。
- **返信状態のような短期データは CacheService**。ScriptPropertiesに置くと掃除漏れで永遠に残る。

---

## 📊 重要な設計方針

### 1. 状態管理の責務分離

BOOKINGSシートの `status` と `payment_status` は **完全に独立**：

| 列 | 管理する状態 | 値 |
|---|---|---|
| `status` | **作業進行状態のみ** | `confirmed` → `in_progress` → `completed` / `cancelled` |
| `payment_status` | **決済状態のみ** | `未清算` / `QR送信済み` / `清算済み` / `要確認` |

- ❌ `status = paid` という値は使わない
- ✅ 「全フロー完了」判定：`status = completed` **かつ** `payment_status = 清算済み`
- 🚫 コード内で両列を同時更新する箇所は避ける

### 2. 設定はスプレッドシート連動

料金・営業時間・移動バッファは **Plan_Pricesシートから動的取得**（60秒キャッシュ）。
コード内にハードコードしない。シート更新 → 最大60秒で全機能に反映。

### 3. 1顧客 = 1トピック（排他制御）

顧客のメッセージは、必ず同じフォーラムトピックに転送される。
- `CUSTOMERS.thread_id` で管理
- 存在すればそのトピックへ、なければ `createForumTopic` で新規作成
- 同じ顧客のトピックが複数できることは**絶対に防ぐ**

### 4. 3方向配信

作業開始・完了・写真アップロード時は必ず **顧客 / Admin / シート** の3方向へ同時配信。

### 5. QRコードは1予約1回のみ

- 作業完了イベントで `完了通知 → After写真4枚 → QR画像` を連続送信
- 24h催促メッセージには **QRを再添付しない**（テキストのみ）
- QR画像は `QR_CODES` シートの `active=TRUE` 行から動的取得

---

## 🚦 現在の開発フェーズ

**現在：Phase 0（準備・基盤整備）進行中**

### フェーズ全体

| フェーズ | 内容 | 状態 |
|---|---|---|
| **Phase 0** | 準備作業（スプレッドシート・GAS・Telegram・Webhook） | 🟡 **進行中** |
| Phase 1 | 基盤コード構築（Config / Router / Queue / TelegramAPI / SheetHelpers） | ⬜ 未着手 |
| Phase 2 | 顧客チャット + フォーラムトピック基盤 | ⬜ 未着手 |
| Phase 3 | 予約機能（BookingBot / BookingLogic、booking.html流用） | ⬜ 未着手 |
| Phase 4 | 業務管理機能（FieldBot / JobManager、job-manager.html流用） | ⬜ 未着手 |
| Phase 5 | 決済管理（QR送信・スクショ受付・24h催促） | ⬜ 未着手 |
| 統合テスト | 全フロー通し動作確認 | ⬜ 未着手 |

### 各フェーズ完了時のルール

1. ✅ デプロイ → 実環境で動作確認
2. ✅ GitHubへプッシュ（バックアップ）
3. ✅ 次フェーズに進む前にユーザーへ報告
4. ✅ 問題があれば即修正、次に持ち越さない

### 並行運用戦略（※ v6 は 2026-04-18 に廃止済み）

- ~~v6（既存）は Webhook 生かしたまま稼働継続~~
- ~~v7 完成＋統合テスト合格まで v6 は生きたまま~~
- v7 が単独稼働中。v2〜v6 のコード／HTML／Render.com 構成はリポジトリから削除済み（Git 履歴には残る）。

---

## 🪶 コード肥大化防止ルール（最重要）

v6 が 6,000行超に肥大化した最大の原因は、**「一時的にしか使わないコード」を本番コードに混ぜ続けたこと**。v7 では以下を厳守する。

### 原則：「本番で毎日動くコード」と「一度きりのコード」を分離する

| コード種別 | 置き場所 | 本番デプロイに含める？ |
|---|---|---|
| 🟢 **本番コード** | Config.gs / Router.gs / BookingBot.gs 等の12ファイル | ✅ 含める |
| 🟡 **セットアップ・移行コード** | 別ファイル（例：`Setup.gs`, `Migration_XXX.gs`） | ⚠️ 初回実行後は**削除 or コメントアウト** |
| 🔴 **デバッグ・テスト用コード** | `Debug.gs` 等に隔離、本番マージ前に削除 | ❌ 含めない |

### セットアップコードの扱い

- `Setup.gs`（シート作成、初期データ投入、Drive フォルダ作成など）は **初回1回だけ** 実行するもの。
- **実行完了したら、本番GASから削除してよい**（`v7/Setup.gs` としてローカル＆GitHubには残す）。
- 万一再セットアップが必要なら、ローカルから再度貼り付ける運用にする。
- **3,000〜3,500行の行数目標には Setup.gs を含めない**（毎日動くコードだけカウント）。
- ⚠️ **`Setup.gs` が空の場合、それは正常。セットアップ済みを意味する。復元しないこと。**

### 移行コード（migrateXXX）の扱い

- 特定の1回のデータ移行のためのコード（例：`migratePlanPrices`）は、実行後に削除する。
- GitHub 履歴には残るので、必要ならいつでも復元できる。

### 実装時の自問ルール

新しい関数を書くときは必ず自問してください：

1. **この関数は毎日/毎週動く？** → YES なら本番コード、NO なら分離検討
2. **同じようなコードが他にある？** → 共通化できるかチェック
3. **今後も使う可能性が高い？** → 低いなら削除候補にマーク
4. **コメントやログが過剰でない？** → 必要最小限に

### 行数のレッドライン

| ファイル | 想定上限 | 超えたら |
|---|---|---|
| 1ファイル | 500行 | 責務分割を検討 |
| 本番全体 | 3,500行 | 機能追加を止め、リファクタ |

**ルール：本番全体が 4,000行を超えそうになったら、機能追加を止めて整理する**。v6 の失敗を二度と繰り返さない。

### v6 から学んだこと

- 「あとで消そう」は絶対に消されない → **書くときに分離する**
- 「念のため残しておこう」は積もる → **使わないものは即削除**
- テスト関数 `testXXX()` は本番にコミットしない → 別ブランチ or Debug.gs へ

---

## 🚫 絶対にやってはいけないこと

以下は **即座に致命的障害** を引き起こすため、何があっても守ってください。

### 1. トークン・機密情報のハードコード

```javascript
// ❌ 絶対ダメ
const BOT_TOKEN = "1234567890:ABCdef...";

// ✅ 正しい
const BOT_TOKEN = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN_BOOKING');
```

対象：Botトークン、スプレッドシートID、管理者chat_id、ADMIN_GROUP_ID など。
すべて **PropertiesService** から取得。コミット前に必ずチェック。

### 2. CacheService でキューを管理する

```javascript
// ❌ 絶対ダメ（6時間TTL・サイズ制限でデータ損失）
CacheService.getScriptCache().put('queue_' + ts, payload);

// ✅ 正しい（永続）
PropertiesService.getScriptProperties().setProperty('queue_' + ts, payload);
```

v6 で実際にこれをやって通知が消失した。**キュー系は絶対に ScriptProperties**。

### 3. doPost 内で重い処理を実行する

```javascript
// ❌ 絶対ダメ（Telegram がリトライ→重複スパム）
function doPost(e) {
  sendMessage(...);        // API呼び出し
  saveToSheet(...);        // シート書き込み
  uploadToDrive(...);      // 画像保存
  return ContentService.createTextOutput('ok');
}

// ✅ 正しい（キューに入れて即return）
function doPost(e) {
  enqueueTelegramUpdate(data);
  return ContentService.createTextOutput('ok');
}
```

**doPost は1秒以内に ok を返す**。重い処理は全て `processTelegramQueue` 側で。

### 4. 同じ顧客のトピックを複数作成する

必ず `CUSTOMERS.thread_id` を先に検索し、存在すればそれを使う。`createForumTopic` は存在しない時のみ呼ぶ。

### 5. status 列に `paid` を入れる

決済状態は `payment_status` 列に一元化。`status` 列は作業進行のみ。

### 6. 無許可のファイル削除・本番データ変更

- v6 のシートデータは**絶対に削除しない**（3ヶ月バックアップ保持）。コード本体は 2026-04-18 に削除済み（Git 履歴で復元可）
- 本番データ変更前に必ずユーザー確認
- `rm -rf` 系コマンドは必ず確認を取る

### 7. force push を main ブランチに

`git push --force` は原則禁止。必要な場合は必ず事前確認。

---

## 💬 コミュニケーションルール

- 作業完了後は必ず**日本語**で結果サマリーを報告
- 不明点・曖昧な点は作業前に確認
- エラーは原因と解決策を日本語で説明
- コードのコメントは日本語
- コード変更後は必ず `git add` → `git commit` → `git push`

---

## 🚀 GAS デプロイ運用（clasp）

2026-04-23 から **clasp（Google 公式 CLI）** で v7 / v7-operations の双方を自動デプロイする運用に移行。**手動コピペは廃止**。

### 作業ディレクトリ

- 本リポジトリの**唯一の作業場所**：`C:\Users\drymp\dev\samurai-motors-app\`
- `C:\Users\drymp\OneDrive\Desktop\samurai-motors-app\` は**旧スナップショット**（戻る必要が出たときの保険、編集しない）

### 必要ツール

- `clasp` v3.3.0 が `C:\nodejs-global\clasp.cmd` にインストール済み
- ログイン済みアカウント：`ec20921@gmail.com`（GAS 開発系の所有者）
- Google Apps Script API は本人アカウントで有効化済み

### push コマンド

```bash
# v7（顧客系）を反映
cd "C:/Users/drymp/dev/samurai-motors-app/v7"
"C:/nodejs-global/clasp.cmd" push --force

# v7-operations（勤務系）を反映
cd "C:/Users/drymp/dev/samurai-motors-app/v7-operations"
"C:/nodejs-global/clasp.cmd" push --force
```

`--force` は manifest 変更がある場合のプロンプトをスキップする用。通常運用ではあった方が摩擦が少ない。

### 設計上の重要ポイント

- v7 の `Setup.gs` / `SetupProperties.gs` / `GetGroupId.gs` / `WebhookSetup.gs` は **`.claspignore` で除外**。リモート GAS には残さない（コード肥大化防止）
- v7-operations の `Setup.gs` は本番ファイル扱い（毎回 push される）
- `.txt` ペアファイルは廃止（`.claspignore` でも除外、ローカルにも置かない）

### 万一壊れた場合の戻し方

1. `C:\Users\drymp\OneDrive\Desktop\samurai-motors-app\` に旧スナップショットあり
2. `git log` で commit 履歴から復元可能
3. `clasp clone <scriptId>` でリモート GAS から再取得も可能

---

## 📎 関連ドキュメント

- `docs/SPEC_v7_CustomerSystem.md` — 本プロジェクトの完全仕様書（必読）
- `docs/manual_admin_jp.md` — 管理者向けマニュアル
- `docs/manual_staff_km.md` — スタッフ向けマニュアル（クメール語）

---

あなたの出力が終わったら、Codexがレビューします。品質を意識してください。
