# 🚗 Samurai Motors システム v7 正式仕様書（統合版）

**プロジェクト名**: Samurai Motors 予約・業務管理・顧客対応システム（顧客向けシステム）
**バージョン**: **v7.4 統合版**
**初版作成**: 2026-04-15
**最終更新**: 2026-05-03
**ステータス**: ✅ **全フェーズ完了・本番運用中**
**適用対象**: 顧客対応系（予約／洗車管理／決済／顧客チャット）

> 本書は **v7.2 凍結版**（1,297行）と **v7.3 差分版**（経営ダッシュボード・Delivery fee 動的化等）を統合し、さらに **v7.4 改修**（clasp 自動デプロイ・QR 耐障害性向上）を加えた現行版です。

---

## 📋 目次

1. 関係者向けサマリー（経営・現場共有用）
2. プロジェクトゴール
3. ターゲットユーザー
4. 重要な制約
5. システム全体構成図
6. Bot 構成
7. 業務フロー全体像
8. 予約管理機能
9. 作業管理機能
10. 決済管理機能
11. 顧客チャット機能（フォーラムトピック）
12. **経営ダッシュボード（v7.3 新規）**
13. スプレッドシート設計
14. 設定値（CONFIG）
15. GAS ファイル構成
16. ストレージ使い分けルール
17. 非同期キュー方式の実装仕様
18. セットアップ関数仕様
19. doGet API エンドポイント仕様
20. **clasp 自動デプロイ運用（v7.4 新規）**
21. **QR 配信耐障害性（v7.4 新規）**
22. 構築フェーズと進捗
23. 運用ルール
24. 既存資産の評価
25. バージョン履歴

---

## 1. 📢 関係者向けサマリー（経営・現場共有用）

### 現在の状況（2026-05-03 時点）

- ✅ **設計から構築・運用まで全フェーズ完了**
- ✅ v6（旧システム）は **2026-04-18 に完全廃止**（コード削除、Git 履歴に保管）
- ✅ v7 単独稼働中、運用フィードバックで v7.3 → v7.4 へ改修済み
- ⚙️ デプロイは **clasp 自動化**（2026-04-23〜）。手動 `.gs`/`.txt` コピーは廃止

### なぜ見直しが必要だったか（v6 → v7 の経緯）

機能追加を重ねた結果、Google Apps Script のコードが **6,000 行を超過**し、以下の問題が顕在化しました：

- ⏱️ 通知の遅延（最大数分）
- 🔁 重複通知の発生
- ⚠️ 動作の不安定化

このまま機能追加を続けると状況が悪化するため、**システム構成を根本から整理**することを決定しました。

### 見直しの方向性

**顧客対応系** と **社内業務系** を完全に分離し、独立したシステムとして再構築：

| 系統 | 対象機能 | 本仕様書での扱い |
|---|---|---|
| 🙋 顧客対応系 | 予約 / 洗車管理 / 決済 / 顧客チャット | ✅ **本仕様書の対象（v7）** |
| 🏢 社内業務系 | 日報 / 勤怠 / 経費 / 在庫管理 | ❌ 別システム（v7-operations） |

**効果**：動作が軽量化され、片方に問題が起きてももう片方は影響を受けない構成。

### 予約の仕組み

- 📘 **集客**：Meta（Facebook）
- 💬 **受付窓口**：Telegram（Facebook から誘導）
- 📱 **予約方式**：Telegram ミニアプリ上のボタン操作（テキスト入力不要）

**判断根拠**：前回のカンボジア出張で検証した結果、音声自動予約は精度不足のため見送り。現地はテキスト入力文化が薄いため、ボタン中心の UI がベストと判断。

---

## 2. 🎯 プロジェクトゴール

予約受付 → スタッフ通知 → 作業開始 → Before 写真4枚（顧客にも送信）→ 作業完了 → After 写真4枚（顧客にも送信）→ QR 決済 → 入金確認 → 顧客個別チャット までの全フローを、**3,000〜3,500 行の GAS** で完結させる。

**実績（2026-05-03 時点）**：本番稼働中・全フローが想定どおり動作。経営ダッシュボード（v7.3）と QR 耐障害性（v7.4）を追加。

---

## 3. 👥 ターゲットユーザー

| ユーザー種別 | 特徴 | UI 言語 |
|---|---|---|
| 🇰🇭 カンボジア人顧客 | Facebook で内容理解後、Telegram で予約 | クメール語 |
| 🌏 在カンボジア外国人顧客 | 英語話者 | 英語 |
| 👷 現場スタッフ（カンボジア人） | ミニアプリで業務操作 | クメール語（メイン）＋日本語（補足） |
| 👨‍💼 日本側管理者 | Admin グループで運用管理 | 日本語 |

---

## 4. ⚠️ 重要な制約

- 🆕 顧客対応系は **新構成で再構築**（v6 の 6,100 行コードは廃止）
- 💰 バックエンド：**Google Apps Script（GAS）のみ**・サーバレス・無料
- 🕐 タイムゾーン：`Asia/Phnom_Penh`
- 📏 目標行数：**3,000〜3,500 行**（経営ダッシュボードを除く）
- 🔒 トークン・ID 等は全て `PropertiesService` に保存、ハードコード禁止
- ⚡ `doPost` は必ず即座に `ok` を返す非同期キュー方式（Telegram リトライ防止）
- 🔒 `update_id` の重複排除を必ず実装
- 🚫 **社内業務管理（日報・勤怠・TODO・経費・在庫）は含めない**（別システム）

---

## 5. 🏗️ システム全体構成図

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    👤 顧客の世界
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  📘 Facebook（サービス理解・集客）
        ↓
  🤖 予約Bot ← 顧客が触るのはこれだけ
        │
        ├── 📱 ミニアプリで予約
        ├── 💬 質問・メッセージ送信
        ├── 📷 駐車場写真の送信
        ├── 📩 作業開始通知を受信
        ├── 📷 Before写真 4枚を受信
        ├── 📩 作業完了通知を受信
        ├── 📷 After写真 4枚を受信
        ├── 💳 QR決済コードを受信
        └── 🧾 決済スクショを送信

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    ⚙️ サーバー側
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ⚙️ GAS v7（本プロジェクト）
        │
        ├── 📅 Googleカレンダー（空き枠管理）
        ├── 📊 Googleスプレッドシート（予約・顧客・ジョブDB）
        ├── 📁 Googleドライブ（写真保存）
        └── 📈 経営ダッシュボード（v7.3 新規）

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    👷 現場スタッフの世界
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🤖 業務Bot ← スタッフが使う
        │
        └── 📱 ミニアプリ（既存資産を流用）
              ├── 📋 今日の予約一覧
              ├── ▶️ 作業開始
              ├── 📷 Before写真 4枚アップロード
              ├── ✅ 作業完了
              └── 📷 After写真 4枚アップロード

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                    👨‍💼 管理者の世界
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  💬 管理グループ（フォーラムトピック付き）
        │
        ├── 🚗 BK-0042 Hisanori / Camry ← 顧客別トピック
        │     ├── 📅 予約情報
        │     ├── 💬 顧客とのやりとり
        │     ├── ▶️ 作業開始通知
        │     ├── 📷 Before写真 4枚
        │     ├── ✅ 作業完了通知
        │     ├── 📷 After写真 4枚
        │     └── 💳 決済ステータス
        │
        ├── 🚗 BK-0043 Kosal / RAV4
        └── 🚗 BK-0044 Sokha / Prius
```

---

## 6. 🤖 Bot 構成

### 呼称統一

| 統一呼称 | 旧呼称 | 役割 |
|---|---|---|
| **予約Bot** | Bot C, booking bot | 顧客用（唯一の接点） |
| **業務Bot** | Bot B, field bot | 現場スタッフ用 |
| **管理グループ** | Admin Group | 日本側管理者向けフォーラム |
| ~~管理Bot~~ | ~~admin bot~~ | **廃止**（Webhook を外す） |

### 予約Bot（顧客向け）

**役割**：顧客が唯一やりとりする窓口

| 機能 | 説明 |
|---|---|
| 📱 予約 | ミニアプリで車種→メニュー→日時→確定 |
| 💬 チャット | 質問・写真・位置情報を自由に送信 |
| 📩 通知受信 | 作業開始/完了、Before/After 写真、QR コード |
| 🧾 決済 | 決済スクショの送信 |

### 業務Bot（現場スタッフ向け）

**役割**：カンボジア人スタッフが施工情報を登録

- 📱 **左下「業務管理」ボタン → ミニアプリ起動** が基本操作
- 🇰🇭 クメール語（メイン）＋🇯🇵 日本語（補足）併記
- 既存の `job-manager.html` の UX をそのまま継承

### 管理グループ（日本側管理者向け）

**役割**：顧客ごとにトピックが分かれたコミュニケーションハブ

| 機能 | 説明 |
|---|---|
| 🧵 自動トピック作成 | 新規予約で顧客別トピック生成 |
| 💬 顧客チャット | トピック内で顧客と個別やりとり |
| 📷 写真確認 | Before/After 写真がトピックに届く |
| 💳 決済管理 | 決済スクショの確認・承認 |
| 📊 ステータス把握 | 全顧客の状況がトピック一覧で見える |
| 🚨 失敗アラート | QR 配信失敗を即座に通知（v7.4 新規） |

---

## 7. 🔄 業務フロー全体像

```
👤 顧客が予約
    ↓
📅 カレンダーに登録 + 📊 スプレッドシートに記録
    ↓
👨‍💼 Adminトピック自動作成 + 👷 スタッフに通知
    ↓
👷 スタッフが「▶️ 作業開始」（ミニアプリ）
    ↓ 同時に3方向へ通知
    ├── 👤 顧客 ← 「▶️ 洗車を開始しました」
    ├── 👨‍💼 Admin ← 該当トピックに通知
    └── 📊 シート ← ステータス更新
    ↓
👷 スタッフがBefore写真4枚送信（ミニアプリ）
    ↓ 同時に3方向へ配信
    ├── 👤 顧客 ← 📷 Before写真 4枚
    ├── 👨‍💼 Admin ← 📷 該当トピックに4枚
    └── 📁 Drive ← 写真保存
    ↓
👷 スタッフが「✅ 作業完了」（ミニアプリ）
    ↓ 同時に3方向へ通知
    ├── 👤 顧客 ← 「✅ 洗車が完了しました」
    ├── 👨‍💼 Admin ← 該当トピックに通知
    └── 📊 シート ← ステータス更新
    ↓
👷 スタッフがAfter写真4枚送信（ミニアプリ）
    ↓ 同時に3方向へ配信
    ├── 👤 顧客 ← ✨ After写真 4枚
    ├── 👨‍💼 Admin ← 📷 該当トピックに4枚
    └── 📁 Drive ← 写真保存
    ↓
🤖 QR決済コードを顧客に自動送信（apiJobEnd / apiJobFinal 両系統で保証 — v7.4）
    ↓ 失敗時：🚨 Admin に即アラート（v7.4）
👤 顧客が決済スクショを予約Botに送信
    ↓ 進行状態=作業完了 + 48h以内のみ判定（v7.3）
👨‍💼 Admin該当トピックに転送 → 確認 → ステータス更新
    ↓
👤 顧客に「🙏 ありがとうございました」自動送信
```

---

## 8. 📅 予約管理機能

### 8.1 プラン・料金体系（スプレッドシート連動）

**プラン名**：KIYOME（清）/ KAGAMI（鏡）/ TAKUMI（匠）/ SHOGUN（将軍）

| プラン | 内容 | セダン | SUV |
|---|---|---|---|
| 🅰️ 清 KIYOME | 無水洗車＋タイヤワックス＋エアチェック | 12 USD / 30分 | 15 USD / 45分 |
| 🅱️ 鏡 KAGAMI | A + 前3面ガラス撥水（簡易） | 17 USD / 40分 | 23 USD / 65分 |
| 🅲️ 匠 TAKUMI | A + 全面ガラス撥水（簡易） | 20 USD / 50分 | 25 USD / 65分 |
| 🅳️ 将軍 SHOGUN | A + 全面油膜落とし + 全面ガラス撥水 | 32 USD / 80分 | 38 USD / 100分 |

- 💰 **出張料（Delivery fee）**：2 USD（全プラン共通、v7.3 で動的加算化）
- ⏱️ **移動バッファ**：30 分
- 🕘 **営業時間**：9:00〜18:00（日曜・祝日休業 / v7.3）

### 8.2 料金・営業時間の動的管理

**仕様**：
- 📊 Google スプレッドシートの **`Plan_Prices` シート** が唯一のソース
- ⚡ `CacheService` で 60 秒キャッシュ
- 🔄 シート更新 → 最大 60 秒で全機能に反映
- 🧹 「キャッシュクリア」ボタンで即時反映

**反映先**（全て連動）：
- 📱 予約ミニアプリ（料金表示・所要時間計算）
- 📅 カレンダー空き枠検索（営業時間・バッファ反映）
- 💳 QR 決済金額（自動計算）
- 📊 BOOKINGS シート記録

### 8.3 🆕 Delivery fee（出張料）の動的加算 — v7.3 新規

**設計原則：料金設定シート「出張料」行を唯一の真実とする（$2 をコードにハードコードしない）**

- `getDispatchFee()` が料金設定シート「出張料」行（セダン/SUV列）を参照
- `getBasePriceFor()`：基本料金のみ
- `getDispatchFeeFor()`：出張料のみ
- `getPriceFor()` = 基本料金 + 出張料 **（合計を返す）**

#### 表示フロー

| 箇所 | 表示 |
|---|---|
| ミニアプリ プランカード | `$12` の下に小さく `+ $2 Delivery fee / + $2 ថ្លៃដឹកជញ្ជូន` |
| ミニアプリ 確認画面 | `Plan price / Delivery fee / Total` の3行内訳 |
| 顧客 Telegram 通知 | 💰 Plan / 🚚 Delivery fee / 💵 Total の3行内訳 |
| 管理グループ通知 | `料金: $12 + 出張料 $2 = 合計 $14` |
| Google カレンダー説明 | `料金: $12 + 出張料 $2 = 合計 $14` |
| 予約シート `料金(USD)` 列 | **合計金額を保存**（QR/請求/ダッシュボードが自動で正しくなる） |

#### 🔮 将来の料金改定
料金設定シートの「出張料」行の値を変えるだけ（60 秒キャッシュ後に全体反映）。コード変更不要。

### 8.4 🆕 定休日・祝日 — v7.3 新規

| 区分 | 扱い |
|---|---|
| 日曜日 | **定休日**（`CLOSED_WEEKDAYS = [0]`） |
| カンボジア公式祝日 | **定休日**（`CAMBODIA_HOLIDAYS` 配列に 2026 年・2027 年固定祝日登録） |
| booking.html 側 | `CLOSED_DAYS` / `CAMBODIA_HOLIDAYS` を同期。日付セルに `Closed` / `Holiday` 英語バッジ表示、opacity 0.4 |

### 8.5 🆕 空き枠診断情報 — v7.3 新規

`findAvailableSlots()` の返値に `debug` フィールド追加：

```
events=3 past=0 conflict=4 overflow=0 blockedBy=[飯泉渡航 04/20 00:00-23:59]
```

管理者がカレンダーの全日イベント等で空き枠が消えた原因を即判別できるようにした。

### 8.6 予約フロー（予約Bot ミニアプリ）

```
👤 顧客が予約Botを開く
    ↓
📱 ミニアプリで予約画面を表示
    ↓
🚗 Step 1：車種選択（セダン以下 / SUV以上）
    ↓
📋 Step 2：プラン選択（KIYOME / KAGAMI / TAKUMI / SHOGUN）
    ↓
🔧 Step 3：オプション選択（任意・複数選択可）
    ↓
📅 Step 4：カレンダーで空き日時を選択（日曜・祝日は Closed/Holiday バッジ）
    ↓
📍 Step 5：場所の入力（Googleマップのピン留め）
    ├── 🗺️ 地図上でピンを置いて場所指定
    ├── 📝 住所が自動で取得される
    └── ✏️ 補足情報（建物名・部屋番号等）も入力可
    ↓
✅ Step 6：確認画面（内容・Plan price / Delivery fee / Total・日時・場所）
    ↓
📩 予約確定
    ├── 👤 顧客に確定通知（場所情報・料金内訳込み）
    ├── 👨‍💼 Adminトピック自動作成 + 予約情報投稿（場所リンク付き）
    ├── 👷 スタッフに通知（場所リンク付き - タップでGoogleマップ起動）
    ├── 📅 Googleカレンダーにイベント作成（場所欄に住所記入）
    └── 📊 BOOKINGSシートに記録（緯度経度・住所・リンク・合計金額）
```

**場所入力仕様**：
- 🗺️ 既存の `booking.html` の Google マップピン機能を**そのまま継承**
- 📍 緯度経度（lat/lng）と住所文字列を両方保存
- 🔗 `https://www.google.com/maps?q={lat},{lng}` 形式のリンクを生成
- 📱 スタッフ通知の場所リンクをタップ → Google マップアプリが起動してナビ可能

### 8.7 カレンダー連携仕様

| 項目 | 設定値 |
|---|---|
| 📅 カレンダー ID | `samuraimotors.japan@gmail.com` |
| ⏰ 営業時間 | 設定シートから動的取得 |
| 🚗 移動バッファ | 設定シートから動的取得 |
| 🔒 重複防止 | カレンダーイベントで時間枠をブロック |
| 📅 定休日 | 日曜・カンボジア祝日を自動除外（v7.3） |

---

## 9. 👷 作業管理機能

### 9.1 施工フロー（業務Bot → GAS → 3方向配信）

スタッフは **既存の `job-manager.html` ミニアプリ** で全操作を完結：

```
👷 スタッフが業務Botを開く
    ↓
[🔧 業務管理] ボタン（左下・永続表示）
    ↓
📱 ミニアプリ起動
    ├── 📋 今日の予約一覧（顧客カード）
    ├── 🚗 カードタップ → 予約詳細
    ├── ▶️ 作業開始ボタン
    ├── 📷 Before写真 4枚アップロード（前・後・左・右）
    ├── ✅ 作業完了ボタン
    └── 📷 After写真 4枚アップロード（前・後・左・右）
```

### 9.2 各アクションの3方向配信仕様

#### ▶️ 作業開始

| 方向 | 内容 |
|---|---|
| 👤 顧客 | 「▶️ រថយន្តរបស់អ្នកកំពុងលាងសម្អាត!<br>Your car wash has started!」 |
| 👨‍💼 Admin トピック | 「▶️ 作業開始 - BK-0042 Hisanori / Camry<br>スタッフ：{名} 開始：{時刻}」 |
| 📊 JOBS シート | `status = started`, `started_at = {時刻}` |

#### 📷 Before 写真4枚

| 方向 | 内容 |
|---|---|
| 📁 Drive | `BK-0042_before_front.jpg` 等で保存 |
| 👤 顧客 | `sendMediaGroup` で4枚まとめて送信<br>「📷 រូបថតមុនលាង / Before photos」 |
| 👨‍💼 Admin トピック | `sendMediaGroup` で4枚転送<br>「📷 Before - BK-0042 Hisanori / Camry」 |
| 📊 JOBS シート | `before_photos = Drive URL（4枚カンマ区切り）` |

#### ✅ 作業完了

| 方向 | 内容 |
|---|---|
| 👤 顧客 | 「✅ រថយន្តរបស់អ្នកលាងសម្អាតរួចហើយ!<br>Your car wash is complete!」 |
| 👨‍💼 Admin トピック | 「✅ 作業完了 - BK-0042 Hisanori / Camry<br>スタッフ：{名} 完了：{時刻} 所要：{分}分」 |
| 📊 JOBS シート | `status = completed`, `completed_at = {時刻}` |

#### 📷 After 写真4枚

| 方向 | 内容 |
|---|---|
| 📁 Drive | `BK-0042_after_front.jpg` 等で保存 |
| 👤 顧客 | `sendMediaGroup` で4枚まとめて送信<br>「✨ រូបថតបន្ទាប់ពីលាង / After photos<br>Please check the result!」 |
| 👨‍💼 Admin トピック | `sendMediaGroup` で4枚転送「✨ After - BK-0042 Hisanori / Camry」 |
| 📊 JOBS シート | `after_photos = Drive URL（4枚カンマ区切り）` |

### 9.3 スタッフ管理

- 👥 **最大5人**まで対応
- 📊 **STAFF シート**で動的管理（追加・削除がシート操作のみで完結）
- 🆔 `staff_id`（Telegram chat_id）で識別

---

## 10. 💳 決済管理機能

### 10.1 QR コード管理（Drive フォルダ + 履歴シート方式）

**運用方針**：QR コードの内容は将来変更される可能性があるため、柔軟に切り替えられる仕組みで管理。

#### QR コード保管場所

- 📁 **Google ドライブ**：`SamuraiMotors_QRCodes/` フォルダに画像を保存
- 📊 **QR_CODES シート**：履歴・有効フラグ管理（後述のシート設計参照）
- 🔄 QR 変更時は**シート操作のみ**で切り替え完結（コード変更不要）

#### QR 切り替え手順（管理者）

1. 新 QR 画像を `SamuraiMotors_QRCodes/` にアップロード
2. QR_CODES シートに新しい行を追加（`qr_id`, `image_url`, `description`）
3. 新 QR の `active` を `TRUE` に、旧 QR の `active` を `FALSE` に変更
4. 次回送信から自動的に新 QR が適用される

### 10.2 決済フロー

**QR 送信タイミング**：作業完了ボタン押下時、顧客への「完了通知」「After 写真4枚」「QR 画像」を**連続して自動送信**（1予約につき1回のみ）。

```
✅ 作業完了ボタン押下
    ↓
👤 顧客へ連続送信（同一イベント）：
    ① ✅ 「洗車が完了しました」メッセージ
    ② 📷 After写真 4枚（sendMediaGroup）
    ③ 💳 QR決済コードを顧客に自動送信（QR_CODESシートの active=TRUE を取得）
    ├── 👤 顧客 ← QRコード画像 + 金額
    │   「💳 សូមបង់ប្រាក់ / Please make payment
    │     Amount: ${金額} USD」
    └── 👨‍💼 Adminトピック ← 「💳 QR送信済み - ${金額} USD」
    ↓
👤 顧客が決済スクショを予約Botに送信
    │ ┌─ v7.3: 進行状態=作業完了 + QR送信から48時間以内のみ判定 ─┐
    │
    ├── 📁 Driveフォルダ `SamuraiMotors_PaymentScreenshots/` に保存
    │     ファイル名：BK-0042_payment_{timestamp}.jpg
    │
    ├── 📊 BOOKINGSシート
    │     ├── payment_screenshot_url = Drive URL（自動リンク）
    │     ├── payment_status = 清算済み（自動セット）
    │     └── payment_received_at = {日時}
    │
    └── 👨‍💼 Adminトピック ← スクショ転送
          「🧾 決済スクショ受信 - BK-0042 Hisanori
            💰 請求額：25 USD
            ✅ ステータス：自動で【清算済み】に変更しました
            ⚠️ 金額不一致の場合はシートで【要確認】に変更してください」
    ↓
👨‍💼 管理者がシートで金額照合
    │
    ├── ✅ 金額一致 → そのまま【清算済み】
    │     └── 📤 顧客に自動お礼メッセージ
    │         「🙏 អរគុណ! Thank you!
    │           Payment confirmed. See you next time!」
    │
    └── ⚠️ 金額違い・行き違い等 → シートで【要確認】に変更
          └── 📞 管理者が個別に電話・メッセージで確認（アナログ対応）
```

### 10.3 🆕 支払スクショ判定の厳格化 — v7.3 新規

v7.2 では「駐車場所の写真」が支払スクショ誤認定される不具合があった。v7.3 で `findLatestUnpaidBooking()` に以下の条件を追加：

```javascript
// 進行状態 は「作業完了」のみ対象
if (jStatus !== '作業完了') continue;
// QR送信から48時間以内のみ対象
var WINDOW_MS = 48 * 60 * 60 * 1000;
if (!ts || (now - ts) > WINDOW_MS) continue;
```

### 10.4 🆕 非支払写真への軽い受領返信 — v7.3 新規

駐車場所写真など「支払スクショではない写真」への返信：

```
📸 សូមអរគុណសម្រាប់រូបថត! / Thanks for the photo!
ក្រុមការងាររបស់យើងបានទទួលហើយ។
Our team has received it.
```

支払い確認の自動返信は誤解を招くため出さない。

### 10.5 決済ステータス（BOOKINGS シート）

| ステータス | 意味 | セット方法 |
|---|---|---|
| 未清算 (unpaid) | QR 未送信または入金待ち | 初期値 |
| QR 送信済み (qr_sent) | QR 画像送信完了 | システム自動 |
| 清算済み (paid) | スクショ受信 → 自動で clearance 完了 | スクショ受信時に自動 |
| 要確認 (needs_review) | 金額違い・行き違い等で要確認 | 管理者が手動 |

- 📋 シートにプルダウンリスト（データ検証）を設定
- 🎨 ステータス別に色分け（未清算=赤 / 清算済み=緑 / 要確認=黄）
- 📧 自動お礼メッセージは **清算済み** 状態時のみ送信

### 10.6 自動催促機能（24 時間間隔・継続）

**運用ルール**：

1. ⏰ **初回催促**：作業完了から **24 時間経過** + `payment_status = qr_sent or unpaid` の場合
2. 🔄 **継続催促**：以後 **24 時間ごと** に自動送信（清算済み/要確認になるまで）
3. 📊 **催促回数記録**：BOOKINGS シートの `reminder_count` 列にカウントアップ
4. 🎯 **手動対応の判断材料**：シートを見て催促回数が 2〜3 回以上 → 管理者が個別連絡（電話・メッセージ）

**重要ルール**：催促メッセージは **テキストのみ**。QR 画像は再送しない（QR は1予約につき1回のみ送信）。

#### 催促メッセージ文面（英語＋クメール語）

```
🇰🇭 សូមគោរព!
យើងមិនទាន់បានទទួលការបង់ប្រាក់ពីអ្នកទេ សូមបង់ប្រាក់នៅពេលងាយស្រួល។
ប្រសិនបើអ្នកបានបង់ប្រាក់រួចហើយ សូមអភ័យទោស!

🇬🇧 Hello!
We haven't received your payment yet. Please make your payment at your convenience.
If you have already paid, please disregard this message — apologies for the inconvenience!

💳 Amount: ${金額} USD
📋 Booking: BK-0042

Thank you! / អរគុណ!
```

#### 催促時の Admin 通知

```
⚠️ 未払い催促送信 - BK-0042 Hisanori
💰 請求額：25 USD
🔁 催促回数：3回目
⏰ 作業完了から：72時間経過
```

→ 催促 3 回以上は Admin トピックに **🚨 赤色アラート** で強調表示し、管理者が気づきやすくする。

---

## 11. 💬 顧客チャット機能（フォーラムトピック）

### 11.1 1顧客 = 1トピック ルール

- 📌 顧客の `chat_id` で CUSTOMERS シートの `thread_id` を検索
- ✅ `thread_id` が存在 → そのトピックに転送
- 🆕 存在しない → `createForumTopic` で新規作成 → `thread_id` を保存
- 🚫 同じ顧客のトピックが複数できることは絶対に防ぐ

### 11.2 🆕 スタレッドトピック自動復旧 — v7.3 新規

**背景**：管理グループのチャットログを削除するとトピックも消え、`thread_id` がスタレ化して `sendMessage` が `message thread not found` エラーで失敗する。v7.2 では予約通知が Admin に届かない障害が実際に発生した。

**対策**：`sendToCustomerTopicWithRecovery()` を新設。

```
1回目 → 既存の thread_id で送信
  ↓ 失敗
2回目 → description が "thread not found" or "TOPIC_*_INVALID" なら
         CUSTOMERS.thread_id をクリア → createForumTopic 再作成 → リトライ
  ↓ それでも失敗
最終フォールバック → General（thread 指定なし）へ `⚠️ トピック送信失敗` 付きで投稿
```

通知消失ゼロを保証。

### 11.3 全顧客トピックリセット関数

`resetAllCustomerTopicIds()` — 管理グループのチャットログを完全削除した際のリセット用。次回の顧客メッセージ／予約で自動的に新しいトピックが作成される。

### 11.4 トピック自動作成ルール

| 条件 | トピック名 | タイミング |
|---|---|---|
| 🆕 新規予約 | `🚗 BK-{番号} {顧客名} / {車種}` | 予約確定時 |
| 🆕 予約前の問い合わせ | `🆕 新規 {Telegram ユーザー名}` | 初回メッセージ受信時 |
| 🔄 予約紐づけ後 | トピック名を予約情報付きに更新 | 予約確定時 |

### 11.5 メッセージ転送（顧客 → 管理者）

- 顧客の予約フロー外メッセージを該当トピックに転送
- 📝 テキスト、📷 写真、🎥 動画、📍 位置情報、📎 ドキュメントに対応
- 🏷️ ヘッダー：`📩 {顧客名} ({予約番号} / {車種})`
- 🔘 「💬 返信」インラインボタン付き

### 11.6 管理者の返信（管理者 → 顧客）

```
👨‍💼 トピック内で「💬 返信」ボタンを押す
    ↓
🤖 「返信メッセージを入力してください」と表示
    ↓
👨‍💼 メッセージを入力（テキスト/写真/動画）
    ↓
🤖 予約Bot経由で顧客に送信
    ↓
📊 CHAT_LOGシートに記録
```

- 🧠 返信状態は `CacheService` で管理
  - キー：`admin_reply_{admin_chat_id}`
  - 値：`{customer_chat_id}`
  - TTL：300 秒（5 分間操作がなければ自動失効）
  - 🎯 **CacheService 採用理由**：5 分で消えて問題ないため揮発ストレージで十分

---

## 12. 📈 経営ダッシュボード（v7.3 新規）

### 12.1 目的

日本側管理者が「数字による経営管理」を**毎朝5秒で完了**できること。

### 12.2 配置

**顧客対応系スプレッドシート** に `経営ダッシュボード` タブを自動生成。
カスタムメニュー「📊 ダッシュボード」から手動更新可能。

### 12.3 構成（11 セクション）

| # | セクション | 内容 |
|---|---|---|
| ① | バナー | Samurai Motors 経営ダッシュボード（Dark×Gold テーマ） |
| ② | 期間セレクター | 今月 / 先月 / 今年 / 昨年 / 過去 12 ヶ月 |
| ③ | KPI カード（6 枚） | 売上合計 / 予約件数 / 平均単価 / 新規顧客数 / リピート率 / 未回収金額 |
| ④ | 月次推移グラフ | 売上 + 予約件数の複合チャート |
| ⑤ | プラン別円グラフ | A/B/C/D の構成比 |
| ⑥ | 決済状態別円グラフ | 清算済み / QR 送信済み / 未清算 / 要確認 |
| ⑦ | 新規 vs リピート円グラフ | 新規顧客 vs リピート顧客 |
| ⑧ | 日別棒グラフ | 当月の日別売上 |
| ⑨ | プラン別売上ランキング | プラン別の売上額・件数順 |
| ⑩ | LTV Top10 | 顧客別 累計売上 上位 10 名 |
| ⑪ | アラートエリア | 未入金 48h 超 / 前日比 ±20% 異常 等 |

### 12.4 データ算出ロジック

- `_経営キャッシュ` 隠しシートに中間集計を保存
- `COUNTIFS` / `SUMIFS` / `QUERY` を駆使しスプレッドシート関数で完結（GAS の重いループを避ける）
- Chart API で円グラフ／棒グラフ／複合チャートを生成

### 12.5 自動更新

- JST 7:30 の時間トリガーで毎朝自動更新
- onOpen で手動更新メニュー表示

### 12.6 関連関数

| 関数 | 役割 |
|---|---|
| `setupBookingDashboardMenu()` | スプレッドシート onOpen トリガー設置 |
| `setupBookingDashboardDailyTrigger()` | JST 7:30 自動更新トリガー |
| `ensureBookingDashboard()` | ダッシュボード生成 |
| `refreshBookingDashboard()` | ダッシュボード更新 |

---

## 13. 📊 スプレッドシート設計

### 13.1 📋 CUSTOMERS シート

| 列 | 内容 |
|---|---|
| A: customer_id | 🔖 顧客 ID（自動採番 C-0001〜） |
| B: chat_id | 👤 Telegram chat_id |
| C: username | 👤 Telegram ユーザー名 |
| D: name | 📛 顧客名 |
| E: phone | 📱 電話番号 |
| F: language | 🌐 言語（km / en） |
| G: thread_id | 🧵 フォーラムトピック ID |
| H: created_at | 📅 登録日時 |
| I: last_contact_at | 🕐 最終連絡日時 |

### 13.2 📅 BOOKINGS シート

| 列 | 内容 |
|---|---|
| A: booking_id | 🔖 予約番号（BK-0001〜） |
| B: customer_id | 👤 顧客 ID |
| C: chat_id | 👤 Telegram chat_id |
| D: vehicle_type | 🚗 sedan / suv |
| E: vehicle_name | 🚗 車種名 |
| F: plan | 📋 A / B / C / D |
| G: options | 🔧 オプション（カンマ区切り） |
| H: date | 📅 予約日 |
| I: time | ⏰ 予約時間 |
| J: duration | ⏱️ 所要時間（分） |
| K: price | 💰 料金（USD・**Delivery fee 込み合計**） |
| L: status | 📌 **作業進行状態のみ**：confirmed / in_progress / completed / cancelled |
| M: location_lat | 📍 緯度 |
| N: location_lng | 📍 経度 |
| O: location_address | 🏠 住所文字列 |
| P: location_note | 📝 補足（建物名・部屋番号等） |
| Q: location_map_url | 🔗 Google マップリンク |
| R: calendar_event_id | 📅 カレンダーイベント ID |
| S: created_at | 📅 作成日時 |
| T: payment_status | 💳 未清算 / QR 送信済み / 清算済み / 要確認 |
| U: payment_amount | 💰 請求額（USD） |
| V: payment_screenshot_url | 🧾 決済スクショ URL（Drive） |
| W: payment_received_at | 📅 スクショ受信日時 |
| X: qr_sent_at | 💳 QR 送信日時 |
| Y: reminder_count | 🔁 催促回数 |
| Z: last_reminder_at | ⏰ 最終催促日時 |
| AA: admin_note | 📝 管理者メモ（要確認時の記録等） |

#### 🔑 status と payment_status の責務分離ルール

**状態管理を 2 箇所に分散させないため、以下のルールを厳守**：

| 列 | 管理する状態 | 値 |
|---|---|---|
| **L: status** | **作業進行状態のみ** | `confirmed` → `in_progress` → `completed` / `cancelled` |
| **T: payment_status** | **決済状態のみ** | `未清算` / `QR 送信済み` / `清算済み` / `要確認` |

- ❌ `status = paid` という値は **使わない**（決済状態は `payment_status` に一元化）
- ✅ 「全フロー完了」の判定条件：`status = completed` **かつ** `payment_status = 清算済み`
- ✅ 各列は互いに独立して遷移する（例：`status = completed` でも `payment_status = 未清算` はあり得る）
- 🚫 コード内で両列を同時更新する箇所は避け、それぞれ単独で更新する

### 13.3 🚗 VEHICLES シート

| 列 | 内容 |
|---|---|
| A: customer_id | 👤 顧客 ID |
| B: vehicle_type | 🚗 sedan / suv |
| C: vehicle_name | 🚗 車種名 |
| D: plate_number | 🔢 ナンバー |
| E: photo_url | 📷 車両写真 URL |

### 13.4 🔧 JOBS シート

| 列 | 内容 |
|---|---|
| A: job_id | 🔖 ジョブ ID（J-0001〜） |
| B: booking_id | 📅 予約番号 |
| C: staff_id | 👷 スタッフ chat_id |
| D: staff_name | 👷 スタッフ名 |
| E: status | 📌 assigned / started / completed |
| F: started_at | ▶️ 作業開始時刻 |
| G: completed_at | ✅ 作業完了時刻 |
| H: before_photos | 📷 Before 写真 URL（4 枚、カンマ区切り） |
| I: after_photos | 📷 After 写真 URL（4 枚、カンマ区切り） |

**※ 決済関連は BOOKINGS シートに集約**（BK 単位で管理するため、JOBS には置かない）

### 13.5 👥 STAFF シート

| 列 | 内容 |
|---|---|
| A: staff_id | 👷 Telegram chat_id |
| B: name_km | 🇰🇭 クメール語名 |
| C: name_jp | 🇯🇵 日本語名 |
| D: active | ✅ 有効フラグ（TRUE/FALSE） |

### 13.6 💬 CHAT_LOG シート

| 列 | 内容 |
|---|---|
| A: timestamp | 🕐 日時 |
| B: direction | ↔️ customer_to_admin / admin_to_customer |
| C: chat_id | 👤 顧客 chat_id |
| D: thread_id | 🧵 トピック ID |
| E: message_type | 📝 text / photo / video / location / document |
| F: content | 💬 内容（テキストまたはファイル ID） |
| G: admin_id | 👨‍💼 返信管理者 ID |

### 13.7 💳 QR_CODES シート（QR 履歴管理）

| 列 | 内容 |
|---|---|
| A: qr_id | 🔖 QR 識別子（QR-001〜） |
| B: image_url | 🖼️ Drive 画像 URL |
| C: description | 📝 説明（「ABA Bank メイン」等） |
| D: bank_name | 🏦 銀行名（ABA / Wing / ACLEDA 等） |
| E: active | ✅ 現在有効（TRUE / FALSE）- 1 つだけ TRUE |
| F: created_at | 📅 登録日 |
| G: deactivated_at | 📅 無効化日（切り替え時） |

**運用ルール**：
- 🎯 `active = TRUE` は常に **1 行だけ**（排他制御）
- 🔄 切り替え時：旧行を FALSE + `deactivated_at` 記録 → 新行を TRUE
- 📁 画像ファイルは `SamuraiMotors_QRCodes/` Drive フォルダに保存

### 13.8 ⚙️ Plan_Prices シート（動的設定）

| 列 | 内容 |
|---|---|
| A: プラン名 | 清 KIYOME (A) / 鏡 KAGAMI (B) / 匠 TAKUMI (C) / 将軍 SHOGUN (D) |
| B: セダン価格(USD) | 12 / 17 / 20 / 32 |
| C: SUV 価格(USD) | 15 / 23 / 25 / 38 |
| D: セダン所要時間(分) | 30 / 40 / 50 / 80 |
| E: SUV 所要時間(分) | 45 / 65 / 65 / 100 |
| F: 備考 | プラン内容説明 |

**特殊行**：
- `出張料`（v7.3 でセダン/SUV 列から動的読み込み）
- `【設定】移動バッファ(分)` / `【設定】営業開始時刻` / `【設定】営業終了時刻`

---

## 14. ⚙️ 設定値（CONFIG）

```javascript
const CONFIG = {
  // 🤖 Botトークン（全てPropertiesServiceから取得）
  BOT_TOKEN_BOOKING: PropertiesService.getScriptProperties().getProperty('BOT_TOKEN_BOOKING'),
  BOT_TOKEN_FIELD: PropertiesService.getScriptProperties().getProperty('BOT_TOKEN_FIELD'),

  // 💬 管理グループ（フォーラムトピック付き）
  ADMIN_GROUP_ID: PropertiesService.getScriptProperties().getProperty('ADMIN_GROUP_ID'),

  // 📅 Googleカレンダー
  BOOKING_CALENDAR_ID: 'samuraimotors.japan@gmail.com',

  // 📊 スプレッドシートID
  SPREADSHEET_ID: PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'),

  // 📁 Googleドライブ
  PHOTO_FOLDER_NAME: 'SamuraiMotors_Photos',

  // 🕐 タイムゾーン
  TIMEZONE: 'Asia/Phnom_Penh',

  // 👨‍💼 管理者chat_idリスト
  ADMIN_IDS: PropertiesService.getScriptProperties().getProperty('ADMIN_IDS').split(','),

  // ⏰ 未払いリマインダー
  PAYMENT_REMINDER_HOURS: 24,

  // 📱 ミニアプリURL
  BOOKING_MINIAPP_URL: 'https://ec20921-debug.github.io/samurai-motors-app/booking.html',
  FIELD_MINIAPP_URL: 'https://ec20921-debug.github.io/samurai-motors-app/job-manager.html',
};

// v7.3: 定休日設定
const CLOSED_WEEKDAYS = [0]; // 0=日曜
const CAMBODIA_HOLIDAYS = [
  '2026-01-01', '2026-04-14', '2026-04-15', '2026-04-16', // ...
];
```

**注意**：料金・出張料・営業時間・バッファは `CONFIG` には持たず、Plan_Prices シートから動的取得。

---

## 15. 📁 GAS ファイル構成

```
📂 GAS v7 プロジェクト（推定 3,000〜3,500行 + ダッシュボード約600行）
│
├── ⚙️ Config.gs            設定値・PropertiesService参照        100行
├── 🔀 Router.gs            doPost → Bot振り分け                 150行
├── 📬 QueueManager.gs      非同期キュー管理                      150行
├── 📡 TelegramAPI.gs       sendMessage・sendPhoto等ラッパー     150行
├── 📊 SheetHelpers.gs      シート読み書きユーティリティ          250行
├── 📅 BookingBot.gs        予約Bot会話フロー                     400行
├── 📅 BookingLogic.gs      カレンダー空き検索・料金計算          400行
├── 👷 FieldBot.gs          業務Bot処理                           300行
├── 🔧 JobManager.gs        作業ステータス・写真3方向配信         710行(現状)
├── 💬 CustomerChat.gs      顧客メッセージ転送・管理者返信        400行
├── 🧵 ForumTopicManager.gs トピック作成・thread_id管理 + 自動復旧(v7.3) 250行
├── 💳 PaymentManager.gs    QR送信・スクショ受付・自動催促        736行(v7.4)
└── 📈 BookingDashboard.gs  経営ダッシュボード（v7.3 新規）        600行
```

**v7.3 で追加されたファイル**：`BookingDashboard.gs`（毎日動くコードではなくメニュー＋朝7:30トリガーのみ動作）

**v7.4 での増加**：`PaymentManager.gs` に診断・救済関数を追加（481→736行）

---

## 16. 🗄️ ストレージ使い分けルール（CacheService vs ScriptProperties）

状態管理を 2 つのストレージに使い分ける理由と基準：

| ストレージ | 特徴 | 用途 |
|---|---|---|
| **ScriptProperties** | 永続・サイズ制限緩い・順序管理可・**GAS 再起動に耐える** | 🔐 **重要・永続データ** |
| **CacheService** | 高速・TTL 必須・最大 6 時間で消失・サイズ制限厳しい | ⚡ **短期・揮発データ** |

### ScriptProperties を使う（永続が必要なもの）

| データ | キー形式 | 理由 |
|---|---|---|
| 🔀 Telegram キュー | `queue_{timestamp}_{update_id}` | GAS 再起動でも失ってはいけない |
| 🔁 update_id 重複排除 | `processed_{update_id}` | 24h 保持が必要、Cache 6h で不足 |
| 🔐 Bot トークン・設定値 | `BOT_TOKEN_BOOKING` 等 | 設定情報は永続必須 |

### CacheService を使う（短期で消えてよいもの）

| データ | キー形式 | TTL | 理由 |
|---|---|---|---|
| 💬 管理者返信状態 | `admin_reply_{admin_chat_id}` | 300 秒 | 返信操作中だけ有効、放置されれば自動失効すべき |
| 💰 料金表キャッシュ | `plan_prices_cache` | 60 秒 | 高速化目的、失っても再計算可能 |
| 📅 空き枠キャッシュ | `available_slots_{date}` | 60 秒 | 高速化目的、失っても再取得可能 |

### 判断基準（迷ったとき）

```
このデータは失われると業務影響が出る？
├── YES → ScriptProperties（永続）
└── NO  → CacheService（揮発）

GAS再起動・6時間経過後も保持が必要？
├── YES → ScriptProperties
└── NO  → CacheService
```

**重要**：v6 実装の教訓として「**キュー系は絶対に ScriptProperties**」。CacheService をキューに使うと 6 時間 TTL・サイズ制限でデータ損失が発生する。

---

## 17. 🔒 非同期キュー方式の実装仕様

```
📩 Telegram Webhook → doPost()
    │
    ├── 1️⃣ update_id を ScriptProperties でチェック
    │     └── 処理済み（processed_{update_id}が存在） → 即return
    │
    ├── 2️⃣ リクエスト本体を ScriptProperties にキュー追加
    │     └── キー：queue_{timestamp}_{update_id}
    │
    └── 3️⃣ 即座に ContentService.createTextOutput('ok') を return
           （ここまで1秒以内）

⏱️ 1分間隔トリガー → processTelegramQueue()
    │
    ├── ScriptProperties からキューを取得（時系列順）
    ├── 1件ずつ処理
    │     ├── 予約Bot のメッセージ → BookingBot or CustomerChat
    │     └── 業務Bot のメッセージ → FieldBot
    ├── 処理完了後、processed_{update_id} を24hマーカーとして保存
    └── 処理済みキューを削除

🧹 1時間間隔トリガー → cleanupOldProcessedIds()
    └── 24h経過した processed_* マーカーを削除
```

**重要**：v6 で実装済みの知見をそのまま継承。CacheService は使わない（6 時間 TTL・サイズ制限のため不向き）。

---

## 18. 🛠️ セットアップ関数仕様（setupV7）

GAS エディタから手動実行する初期化関数群。プロジェクト立ち上げ時・メンテナンス時に使用。

### 18.1 `setupV7()` — プロジェクト全体の初期化

**役割**：新規環境構築時に **1 回だけ** 実行し、システム全体を初期状態に整える。

```
setupV7() の処理順序：
1. 🗑️ 既存トリガーを全削除（重複実行防止）
2. ⏱️ トリガー再作成
   ├── processTelegramQueue        → 1分間隔
   ├── checkUnpaidReminders        → 1時間間隔
   └── cleanupOldProcessedIds      → 1時間間隔
3. 📊 スプレッドシート各シートのヘッダー自動設定
   ├── CUSTOMERS / BOOKINGS / VEHICLES / JOBS
   ├── STAFF / CHAT_LOG / QR_CODES / Plan_Prices
   └── 各シートの列幅・データ検証（プルダウン）も設定
4. 📁 Driveフォルダ作成（なければ）
   ├── SamuraiMotors_Photos/
   ├── SamuraiMotors_QRCodes/
   └── SamuraiMotors_PaymentScreenshots/
5. 🌐 Webhook 自動設定（予約Bot / 業務Bot）
6. ✅ 完了ログをLogger出力
```

### 18.2 個別セットアップ関数

| 関数名 | 役割 | 単独実行可否 |
|---|---|---|
| `setupV7Triggers()` | トリガーのみ再作成 | ✅ 可 |
| `setupV7Sheets()` | シートヘッダー・プルダウンのみ設定 | ✅ 可 |
| `setupV7Folders()` | Drive フォルダのみ作成 | ✅ 可 |
| `setupV7Webhooks()` | Webhook のみ再設定 | ✅ 可 |
| `resetV7()` | 全トリガー削除（緊急停止用） | ✅ 可 |

### 18.3 v7.3 追加：ダッシュボード関連

| 関数名 | 役割 |
|---|---|
| `setupBookingDashboardMenu()` | スプレッドシート onOpen トリガー設置 |
| `setupBookingDashboardDailyTrigger()` | JST 7:30 自動更新トリガー |
| `ensureBookingDashboard()` | ダッシュボード生成 |
| `refreshBookingDashboard()` | ダッシュボード更新 |

### 18.4 v7.4 追加：QR 診断・救済関数

| 関数名 | 役割 |
|---|---|
| `diagnoseQRSystem()` | QR 配信システム健全性チェック（Drive・Bot トークン・シート整合性） |
| `dispatchAllPendingQRs(days)` | 「作業完了 + QR 未送信」を一括救済送信 |
| `retryPaymentQR(bookingId)` | 単一予約の QR 再送（QR 送信日時クリア → 再送） |
| `notifyAdminQRFailure_(...)` | 失敗理由を Admin グループに 🚨 アラート |

### 18.5 メンテナンス関数

| 関数名 | 役割 |
|---|---|
| `clearTelegramQueue()` | キュー全消去（緊急時） |
| `clearProcessedIds()` | 処理済み ID マーカー全消去 |
| `clearAllCaches()` | CacheService 全消去（料金表・空き枠等） |
| `emergencyStopWebhooks()` | 全 Bot の Webhook を緊急解除（spam 対策） |
| `resetAllCustomerTopicIds()` | 全顧客の thread_id クリア（v7.3） |

### 18.6 トリガー一覧

| トリガー関数 | 間隔 | 役割 |
|---|---|---|
| `processTelegramQueue` | 1 分 | キュー処理（Bot メッセージ処理の本体） |
| `checkUnpaidReminders` | 1 時間 | 24h 経過未払い検知 → 自動催促送信 |
| `cleanupOldProcessedIds` | 1 時間 | 24h 経過した `processed_*` マーカー削除 |
| `refreshBookingDashboard` | JST 7:30 毎日 | ダッシュボード自動更新（v7.3） |

---

## 19. 🌐 doGet API エンドポイント仕様（ミニアプリ連携）

### 19.1 エンドポイント一覧

| action | メソッド | 用途 | 呼び出し元 |
|---|---|---|---|
| `booking_init` | GET | 予約画面の初期データ取得（プラン一覧・料金・所要時間） | booking.html |
| `booking_slots` | GET | 指定日の空き時間スロット取得 + デバッグ情報（v7.3） | booking.html |
| `booking_create` | POST | 予約確定（カレンダー登録＋シート記録＋通知配信） | booking.html |
| `field_jobs_today` | GET | 今日の予約一覧（スタッフ別） | job-manager.html |
| `field_job_detail` | GET | 予約詳細取得 | job-manager.html |
| `job_start` | POST | 作業開始（3方向配信） | job-manager.html |
| `job_upload_before` | POST | Before 写真4枚アップロード（3方向配信） | job-manager.html |
| `job_end` | POST | 作業完了（3方向配信＋QR 自動送信） | job-manager.html |
| `job_upload_after` | POST | After 写真4枚アップロード（3方向配信） | job-manager.html |
| `plan_prices` | GET | 料金表取得（Plan_Prices シート動的読み込み） | 両ミニアプリ |
| `status` | GET | サーバー生存確認 | ヘルスチェック |

### 19.2 主要エンドポイントの仕様

#### `booking_init` — 予約画面初期化

```
GET /exec?action=booking_init&chat_id=123456789
```

**レスポンス**：
```json
{
  "ok": true,
  "plans": [
    {"code": "A", "name_km": "清 KIYOME", "name_jp": "清 KIYOME",
     "price_sedan": 12, "price_suv": 15, "duration_sedan": 30, "duration_suv": 45,
     "description_km": "...", "description_en": "..."}
  ],
  "options": [...],
  "business_hours": {"start": 9, "end": 18},
  "buffer_minutes": 30,
  "dispatch_fee": 2,
  "closed_weekdays": [0],
  "holidays": ["2026-04-14", "2026-04-15"],
  "customer": {"name": "Hisanori", "language": "km", "saved_vehicles": [...]}
}
```

#### `booking_slots` — 空き時間取得（v7.3 で debug 追加）

```
GET /exec?action=booking_slots&date=2026-04-20&duration=45
```

**レスポンス**：
```json
{
  "ok": true,
  "date": "2026-04-20",
  "slots": [
    {"time": "09:00", "available": true},
    {"time": "09:30", "available": false, "reason": "予約済み"}
  ],
  "debug": "events=3 past=0 conflict=4 overflow=0 blockedBy=[飯泉渡航 04/20]"
}
```

#### `booking_create` — 予約確定

```json
POST /exec?action=booking_create
{
  "chat_id": 123456789,
  "customer_name": "Hisanori",
  "phone": "+855...",
  "vehicle_type": "sedan",
  "vehicle_name": "Toyota Camry",
  "plate_number": "2AB-1234",
  "plan": "B",
  "options": ["opt1", "opt3"],
  "date": "2026-04-20",
  "time": "10:00",
  "location": {
    "lat": 11.5564,
    "lng": 104.9282,
    "address": "Street 271, Phnom Penh",
    "note": "Building A, Room 301"
  }
}
```

**レスポンス**：
```json
{
  "ok": true,
  "booking_id": "BK-0042",
  "price": 19,
  "base_price": 17,
  "delivery_fee": 2,
  "duration": 40,
  "calendar_event_id": "...",
  "thread_id": 12345
}
```

#### `job_start` / `job_end` — 作業開始・完了

```json
POST /exec?action=job_end
{
  "booking_id": "BK-0042",
  "staff_id": 123456789,
  "timestamp": "2026-04-15T11:00:00+07:00"
}
```

**副作用（job_end）**：
- 👤 顧客に完了通知
- 👨‍💼 Admin トピックに完了通知
- 📊 JOBS シート更新
- 💳 **QR 自動送信**（apiJobEnd / apiJobFinal の二重保証 — v7.4）
- 🚨 失敗時は Admin に即アラート（v7.4）

### 19.3 共通エラーレスポンス

```json
{
  "ok": false,
  "error": "エラーコード",
  "message": "人間向けエラーメッセージ（日本語）"
}
```

### 19.4 doGet / doPost の責務分離

| メソッド | 用途 |
|---|---|
| **doPost** | Telegram Webhook 専用（キューに入れて即 `ok` return） |
| **doGet** | ミニアプリからの API 呼び出し専用 |

---

## 20. 🚀 clasp 自動デプロイ運用（v7.4 新規）

### 20.1 背景

v7.0〜v7.3 までは「`.gs` 編集 → `.txt` 同期 → GAS エディタへ手動コピペ」運用だった。これは：

- ❌ ファイル数増加で手作業が膨大
- ❌ コピペ漏れで本番とローカルが乖離するリスク
- ❌ デプロイに 5〜10 分かかる

v7.4 で **Google 公式 CLI `clasp`** を導入し、ローカル → リモート GAS 自動同期を実現。

### 20.2 構成

| ディレクトリ | scriptId | 役割 |
|---|---|---|
| `C:\Users\drymp\dev\samurai-motors-app\v7\` | `18gQRz...NieRkF` | 顧客系（本仕様書の対象） |
| `C:\Users\drymp\dev\samurai-motors-app\v7-operations\` | `1dW1fvq...3WpAr` | 勤務系（別仕様） |

各ディレクトリに `.clasp.json`（scriptId）と `.claspignore`（除外ファイル）を配置。

### 20.3 デプロイコマンド

```bash
cd "C:/Users/drymp/dev/samurai-motors-app/v7"
"C:/nodejs-global/clasp.cmd" push --force
```

**所要時間**：5 秒程度（13 ファイル）

### 20.4 .claspignore（v7）

```
*.txt              # .txt ペアは廃止
Setup.gs           # 初回のみ必要、本番には残さない
SetupProperties.gs
GetGroupId.gs
WebhookSetup.gs
*.md
.git/**
node_modules/**
```

セットアップ系コードは**ローカルだけに保持**し、リモート（本番 GAS）には残さない設計。**コード肥大化防止ルール**を機械的に強制。

### 20.5 旧 OneDrive フォルダの扱い

`C:\Users\drymp\OneDrive\Desktop\samurai-motors-app\` は **保険として残置**（編集禁止）。

### 20.6 Apps Script API の有効化（初回のみ）

各 Google アカウントで一度だけ：
https://script.google.com/home/usersettings → API を ON

---

## 21. 💪 QR 配信耐障害性（v7.4 新規）

### 21.1 背景

2026-05-03、本番運用中に **「作業完了したのに QR が顧客に届かない」障害** が発生。原因：

- `apiJobEnd`（正常系）でのみ `sendPaymentQR` を呼んでいた
- 例外時のフォールバック `apiJobFinal` には QR 送信がなかった
- 失敗しても誰にも通知されず、顧客が放置されていることが見えなかった

### 21.2 v7.4 で潰した穴

#### ① apiJobFinal にも QR 送信を追加

```javascript
// JobManager.gs apiJobFinal()
if (bookingId && typeof sendPaymentQR === 'function') {
  try {
    var qrRes = sendPaymentQR(bookingId);
    if (!qrRes || !qrRes.ok) {
      Logger.log('ℹ️ apiJobFinal sendPaymentQR 結果: ' + JSON.stringify(qrRes));
    }
  } catch (e) {
    Logger.log('⚠️ apiJobFinal sendPaymentQR 呼び出しエラー: ' + e);
  }
}
```

`sendPaymentQR` は `ALREADY_SENT` ガード付きなので、apiJobEnd で送信済みなら自動的にスキップ。二重送信の心配なし。

#### ② 失敗時の Admin 即アラート

`sendPaymentQR` の全失敗ブランチで `notifyAdminQRFailure_()` を呼ぶ。

| 失敗理由 | アラート内容 |
|---|---|
| `BOOKING_NOT_FOUND` | 予約 ID が見つからない |
| `NO_CHAT_ID` | 顧客の chat_id が未登録 |
| `NO_ACTIVE_QR` | QR_CODES に有効行がない |
| `SEND_FAILED` | Telegram API エラー |

`ALREADY_SENT` は正常動作なので通知しない。

メッセージ例：
```
🚨 QR配信失敗 - BK-0042 Hisanori
理由: NO_CHAT_ID
詳細: chat_id列が空欄です
復旧: 予約シートでchat_idを補完後、retryPaymentQR('BK-0042')
```

#### ③ 救済コマンド3点セット

| 関数 | 用途 |
|---|---|
| `retryPaymentQR(bookingId)` | 単一予約の `QR 送信日時` クリア → 再送 |
| `dispatchAllPendingQRs(days)` | 過去 N 日の「作業完了 + QR 未送信」を一括送信 |
| `diagnoseQRSystem()` | システム健全性チェック（Drive・Bot トークン・シート整合性） |

### 21.3 診断レポートの構造

`diagnoseQRSystem()` の出力（Logger ＆ Admin グループへ自動投稿）：

```
━━━━━━━━━━━━━━━━━━━━
🔍 QRシステム診断
━━━━━━━━━━━━━━━━━━━━
✅ QR_CODES: 有効行あり
   qrId=QR-001 / bank=ABA
   imageUrl=https://drive.google.com/...
   ✅ Drive取得OK: S__103211011.jpg (170099 bytes)
   共有: access=ANYONE_WITH_LINK / permission=VIEW
✅ 予約Bot: @samurai_motors_booking_bot (ID=8613749365)
✅ 予約シート: 必須列すべて存在
━━━━━━━━━━━━━━━━━━━━
```

### 21.4 残るリスクと対処

| リスク | 発生確率 | 対処 |
|---|---|---|
| 予約の chat_id 空欄 | ごく稀 | NO_CHAT_ID アラートで即検知 |
| QR 画像が Drive から消える | 運用事故 | 次回送信時アラート、QR_CODES シートで切り替え |
| Telegram API 一時障害 | たまにある | SEND_FAILED アラート、`retryPaymentQR` で再送 |
| Bot トークン再発行忘れ | 運用事故 | 即アラート |

### 21.5 将来の追加（未実装）

- 時間トリガーで「作業完了から 10 分経っても QR 未送信の予約を自動救済」
- `clasp logs` セットアップで実行ログを手元で tail 可能に

---

## 22. 🚦 構築フェーズと進捗

### 22.1 全フェーズ完了状況（2026-05-03 時点）

| フェーズ | 内容 | ステータス |
|---|---|---|
| Phase 0 | 準備作業（スプレッドシート・GAS・Telegram・Webhook） | ✅ 完了 |
| Phase 1 | 基盤コード構築（Config / Router / Queue / TelegramAPI / SheetHelpers） | ✅ 完了 |
| Phase 2 | 顧客チャット + フォーラムトピック基盤 | ✅ 完了 |
| Phase 3 | 予約機能（BookingBot / BookingLogic / booking.html） | ✅ 完了 |
| Phase 4 | 業務管理機能（FieldBot / JobManager / job-manager.html） | ✅ 完了 |
| Phase 5 | 決済管理（QR 送信・スクショ受付・24h 催促） | ✅ 完了 |
| **Phase 6** | **経営ダッシュボード・Delivery fee 動的化・定休日 / 祝日・トピック自動復旧（v7.3）** | ✅ 完了 |
| **Phase 7** | **clasp 自動デプロイ・QR 耐障害性向上（v7.4）** | ✅ 完了 |

### 22.2 v6 廃止

2026-04-18 に v6 は完全廃止。コード本体は削除済み（Git 履歴で復元可）。シートデータは 3 ヶ月バックアップ保持。

### 22.3 各フェーズ完了時のルール

1. ✅ デプロイ（clasp push）→ 実環境で動作確認
2. ✅ GitHub へプッシュ（バックアップ）
3. ✅ ユーザーに報告
4. ✅ 問題があれば即修正、次に持ち越さない

---

## 23. 🔐 運用ルール

### 23.1 絶対にやってはいけないこと

1. ❌ **トークン・機密情報のハードコード** → 必ず PropertiesService
2. ❌ **CacheService でキュー管理** → 6 時間 TTL でデータ損失。ScriptProperties 一択
3. ❌ **doPost 内での重い処理** → リトライスパムの原因。キュー投入のみ
4. ❌ **同じ顧客のトピック重複作成** → 必ず thread_id を先に検索
5. ❌ **status 列に `paid` を入れる** → 決済状態は payment_status に一元化
6. ❌ **料金・出張料のコードハードコード**（v7.3 から）→ Plan_Prices シートから取得
7. ❌ 無許可のファイル削除／本番データ変更
8. ❌ main への force push

### 23.2 デプロイ・同期ルール（v7.4）

- コード変更したら **必ず GitHub にプッシュ**（`git add` → `git commit` → `git push`）
- GAS への反映は **clasp push --force**（v7 / v7-operations 各ディレクトリで実行）
- `.txt` ペアファイルは廃止
- 旧 OneDrive フォルダは保険として残置（編集禁止）

### 23.3 ラベル統一ルール（v7.3）

- 「dispatch fee」ではなく **「Delivery fee / ថ្លៃដឹកជញ្ជូន」** で統一
- 「休業」ではなく **「Closed / Holiday」** で統一

### 23.4 コード肥大化防止ルール

- 1 ファイル **500 行**を超えたら責務分割を検討
- 本番全体 **3,500 行**を超えそうになったら機能追加を止め、リファクタ
- セットアップ系コードは `.claspignore` で本番から除外
- テスト関数 `testXXX()` は本番にコミットしない

---

## 24. 📊 既存資産の評価（v7.0 時点）

| 資産 | 状態 | 扱い |
|---|---|---|
| 🔧 非同期キュー実装 | ✅ 完成 | **そのまま移植** |
| 📅 findAvailableSlots | ✅ 完成 | **そのまま移植** |
| 💰 料金計算（Plan_Prices 連動） | ✅ 完成 | **そのまま移植** |
| ⚙️ getBookingConfig（60 秒キャッシュ） | ✅ 完成 | **そのまま移植** |
| 📱 booking.html（予約ミニアプリ） | ✅ 完成 | **そのまま流用**（URL 差し替え） |
| 🔧 job-manager.html（現場ミニアプリ） | ✅ 完成 | **そのまま流用**（URL 差し替え） |
| 📸 写真アップロード（Base64→Drive） | ✅ 完成 | **そのまま移植** |
| 💬 customer-chat.html | ⚠️ 未完成 | **破棄・新規作成** |
| 🧵 フォーラムトピック管理 | ❌ 未実装 | **新規作成（v7 / 自動復旧 v7.3）** |
| 💳 QR 決済フロー | ❌ 未実装 | **新規作成（v7 / 耐障害性 v7.4）** |
| 📈 経営ダッシュボード | ❌ 未実装 | **新規作成（v7.3）** |

**総合**：v7.0 時点で約 70% の既存資産が移植可能。現在は v7.4 まで全て完成。

---

## 25. 📅 バージョン履歴

| バージョン | 日付 | 変更内容 |
|---|---|---|
| v7.0 | 2026-04-15 | 初版作成・設計完了 |
| v7.1 | 2026-04-15 | 場所入力 Step 追加 / QR_CODES シート新設 / 決済フロー刷新（自動【清算済み】化・【要確認】ステータス・24h 継続催促・催促回数カウント） |
| v7.2 | 2026-04-15 | status / payment_status 責務分離明記 / CacheService vs ScriptProperties 使い分けルール追加 / setupV7() 関数仕様追加 / doGet API エンドポイント仕様追加 |
| v7.3 | 2026-04-19 | 経営ダッシュボード新設 / Delivery fee 動的加算 / 日曜定休日 + カンボジア祝日 / スタレッドトピック自動復旧 / 支払スクショ誤認定修正 / 非支払写真への軽い受領返信 / 空き枠診断情報 / Closed・Holiday 英語ラベル統一 |
| **v7.4** | **2026-05-03** | **clasp 自動デプロイ運用 / QR 配信耐障害性向上（apiJobFinal 救済 / Admin 失敗通知 / diagnoseQRSystem / dispatchAllPendingQRs / retryPaymentQR）/ コード肥大化防止ルール強化** |

---

## 📑 v7.4 統合版の変更点サマリー（一枚要約）

| 領域 | v7.2 | v7.3 | v7.4 |
|---|---|---|---|
| Delivery fee | コード固定 | **シート動的・内訳表示** | 継承 |
| 定休日 | なし | **日曜+祝日** | 継承 |
| 経営ダッシュボード | なし | **9 セクション Dark×Gold** | 継承 |
| トピック耐障害性 | スタレで通知消失 | **自動再作成 → リトライ** | 継承 |
| 支払スクショ判定 | 全候補 | **作業完了 + 48h 以内** | 継承 |
| QR 配信保証 | apiJobEnd のみ | 同左 | **apiJobEnd + apiJobFinal 二重保証** |
| QR 失敗通知 | なし（顧客放置） | 同左 | **Admin に 🚨 即アラート** |
| QR 救済手段 | コード書き換え | 同左 | **3 つの専用関数** |
| デプロイ運用 | `.gs`/`.txt` 手動 | 同左 | **clasp 自動 push** |
| セットアップ分離 | コメント運用 | 同左 | **`.claspignore` で機械的に除外** |

---

## 📎 関連ドキュメント

- `docs/SPEC_v7_CustomerSystem.md` — v7.2 凍結版（参考用、本書の元）
- `docs/SPEC_v7.3.md` — v7.3 差分版（参考用、本書の元）
- `docs/manual_admin_jp.md` — 管理者向けマニュアル
- `docs/manual_staff_km.md` — スタッフ向けマニュアル（クメール語）
- `DISABLED_FEATURES.md` — Phase 1 で無効化した機能の復元手順

---

**Samurai Motors / System Specification v7.4（統合版）**
**© 2026 Samurai Motors. All rights reserved.**
