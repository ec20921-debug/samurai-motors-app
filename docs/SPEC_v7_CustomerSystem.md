# 🚗 Samurai Motors システム v7 仕様書

**プロジェクト名**: Samurai Motors 予約・業務管理・顧客対応システム（顧客向けシステム）
**バージョン**: v7.2
**作成日**: 2026-04-15
**ステータス**: 設計完了・構築フェーズ開始

---

## 📢 関係者向けサマリー（経営・現場共有用）

### 現在の状況

これまでの3つのBot（日本管理用・現場スタッフ用・顧客予約用）の大幅見直しについて、**設計がほぼ固まり、新しい構成での構築フェーズに入りました**。

### なぜ見直しが必要だったか

機能追加を重ねた結果、Google Apps Script（GAS）のコードが **6,000行を超過**し、以下の問題が顕在化しました：

- ⏱️ 通知の遅延（最大数分）
- 🔁 重複通知の発生
- ⚠️ 動作の不安定化

このまま機能追加を続けると状況が悪化するため、**システム構成を根本から整理**することを決定しました。

### 見直しの方向性

**顧客対応系** と **社内業務系** を完全に分離し、独立したシステムとして再構築します。

| 系統 | 対象機能 | 本仕様書での扱い |
|---|---|---|
| 🙋 顧客対応系 | 予約 / 洗車管理 / 決済 / 顧客チャット | ✅ **本仕様書の対象** |
| 🏢 社内業務系 | 日報 / 勤怠 / 経費 / 在庫管理 | ❌ 別システム（別仕様書） |

**効果**：動作が軽量化され、片方に問題が起きてももう片方は影響を受けない構成になります。

### 予約の仕組み

- 📘 **集客**：Meta（Facebook）
- 💬 **受付窓口**：Telegram（Facebookから誘導）
- 📱 **予約方式**：Telegramミニアプリ上のボタン操作（テキスト入力不要）

**判断根拠**：前回のカンボジア出張で検証した結果、音声自動予約は精度不足のため見送り。現地はテキスト入力文化が薄いため、ボタン中心のUIがベストと判断。

### 進捗まとめ

- ✅ 設計完了、構築フェーズ開始
- ♻️ 既存コードの **約70%を再利用**、構成のみ整理し直す
- 🔄 既存システムは **新システム完成まで並行稼働**、サービス停止なし

---

## 🎯 プロジェクトゴール

予約受付 → スタッフ通知 → 作業開始 → Before写真4枚（顧客にも送信）→ 作業完了 → After写真4枚（顧客にも送信）→ QR決済 → 入金確認 → 顧客個別チャット までの全フローを、**3,000〜3,500行のGAS** で完結させる。

---

## 👥 ターゲットユーザー

| ユーザー種別 | 特徴 | UI言語 |
|---|---|---|
| 🇰🇭 カンボジア人顧客 | Facebookで内容理解後、Telegramで予約 | クメール語 |
| 🌏 在カンボジア外国人顧客 | 英語話者 | 英語 |
| 👷 現場スタッフ（カンボジア人） | ミニアプリで業務操作 | クメール語（メイン）＋日本語（補足） |
| 👨‍💼 日本側管理者 | Adminグループで運用管理 | 日本語 |

---

## ⚠️ 重要な制約

- 🆕 顧客対応系は **新構成で再構築**（既存の6,100行コードは顧客対応部分は廃止）
- 💰 バックエンド：**Google Apps Script（GAS）のみ**・サーバレス・無料
- 🕐 タイムゾーン：`Asia/Phnom_Penh`
- 📏 目標行数：**3,000〜3,500行**
- 🔒 トークン・ID等は全て `PropertiesService` に保存、ハードコード禁止
- ⚡ `doPost` は必ず即座に `ok` を返す非同期キュー方式（Telegramリトライ防止）
- 🔒 `update_id` の重複排除を必ず実装
- 🚫 **社内業務管理（日報・勤怠・TODO・経費・在庫）は含めない**（別システム）

---

## 🏗️ システム全体構成図

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
        └── 📁 Googleドライブ（写真保存）

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

## 🤖 Bot構成

### 呼称統一

| 統一呼称 | 旧呼称 | 役割 |
|---|---|---|
| **予約Bot** | Bot C, booking bot | 顧客用（唯一の接点） |
| **業務Bot** | Bot B, field bot | 現場スタッフ用 |
| **管理グループ** | Admin Group | 日本側管理者向けフォーラム |
| ~~管理Bot~~ | ~~admin bot~~ | **廃止**（Webhookを外す） |

### 予約Bot（顧客向け）

**役割**：顧客が唯一やりとりする窓口

| 機能 | 説明 |
|---|---|
| 📱 予約 | ミニアプリで車種→メニュー→日時→確定 |
| 💬 チャット | 質問・写真・位置情報を自由に送信 |
| 📩 通知受信 | 作業開始/完了、Before/After写真、QRコード |
| 🧾 決済 | 決済スクショの送信 |

### 業務Bot（現場スタッフ向け）

**役割**：カンボジア人スタッフが施工情報を登録

- 📱 **左下「業務管理」ボタン → ミニアプリ起動** が基本操作
- 🇰🇭 クメール語（メイン）＋🇯🇵 日本語（補足）併記
- 既存の `job-manager.html` のUXをそのまま継承

### 管理グループ（日本側管理者向け）

**役割**：顧客ごとにトピックが分かれたコミュニケーションハブ

| 機能 | 説明 |
|---|---|
| 🧵 自動トピック作成 | 新規予約で顧客別トピック生成 |
| 💬 顧客チャット | トピック内で顧客と個別やりとり |
| 📷 写真確認 | Before/After写真がトピックに届く |
| 💳 決済管理 | 決済スクショの確認・承認 |
| 📊 ステータス把握 | 全顧客の状況がトピック一覧で見える |

---

## 🔄 業務フロー全体像

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
🤖 QR決済コードを顧客に自動送信
    ↓
👤 顧客が決済スクショを予約Botに送信
    ↓
👨‍💼 Admin該当トピックに転送 → 確認 → ステータス更新
    ↓
👤 顧客に「🙏 ありがとうございました」自動送信
```

---

## 📅 予約管理機能

### プラン・料金体系（スプレッドシート連動）

**プラン名**：KIYOME（清）/ KAGAMI（鏡）/ TAKUMI（匠）/ SHOGUN（将軍）

| プラン | 内容 | セダン | SUV |
|---|---|---|---|
| 🅰️ 清 KIYOME | 無水洗車＋タイヤワックス＋エアチェック | 12 USD / 30分 | 15 USD / 45分 |
| 🅱️ 鏡 KAGAMI | A + 前3面ガラス撥水（簡易） | 17 USD / 40分 | 20 USD / 55分 |
| 🅲️ 匠 TAKUMI | A + 全面ガラス撥水（簡易） | 20 USD / 50分 | 23 USD / 65分 |
| 🅳️ 将軍 SHOGUN | A + 全面油膜落とし + 全面ガラス撥水 | 32 USD / 80分 | 35 USD / 95分 |

- 💰 **出張料**：2 USD（全プラン共通、キャンペーン時変動可）
- ⏱️ **移動バッファ**：30分
- 🕘 **営業時間**：9:00〜18:00

### 料金・営業時間の動的管理

**仕様**：
- 📊 Googleスプレッドシートの **`Plan_Prices` シート** が唯一のソース
- ⚡ `CacheService` で 60秒キャッシュ
- 🔄 シート更新 → 最大60秒で全機能に反映
- 🧹 「キャッシュクリア」ボタンで即時反映

**反映先**（全て連動）：
- 📱 予約ミニアプリ（料金表示・所要時間計算）
- 📅 カレンダー空き枠検索（営業時間・バッファ反映）
- 💳 QR決済金額（自動計算）
- 📊 BOOKINGS シート記録

### 予約フロー（予約Bot ミニアプリ）

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
📅 Step 4：カレンダーで空き日時を選択
    ↓
📍 Step 5：場所の入力（Googleマップのピン留め）
    ├── 🗺️ 地図上でピンを置いて場所指定
    ├── 📝 住所が自動で取得される
    └── ✏️ 補足情報（建物名・部屋番号等）も入力可
    ↓
✅ Step 6：確認画面（内容・料金・日時・場所）
    ↓
📩 予約確定
    ├── 👤 顧客に確定通知（場所情報込み）
    ├── 👨‍💼 Adminトピック自動作成 + 予約情報投稿（場所リンク付き）
    ├── 👷 スタッフに通知（場所リンク付き - タップでGoogleマップ起動）
    ├── 📅 Googleカレンダーにイベント作成（場所欄に住所記入）
    └── 📊 BOOKINGSシートに記録（緯度経度・住所・リンク）
```

**場所入力仕様**：
- 🗺️ 既存の `booking.html` の Googleマップピン機能を**そのまま継承**
- 📍 緯度経度（lat/lng）と住所文字列を両方保存
- 🔗 `https://www.google.com/maps?q={lat},{lng}` 形式のリンクを生成
- 📱 スタッフ通知の場所リンクをタップ → Googleマップアプリが起動してナビ可能

### カレンダー連携仕様

| 項目 | 設定値 |
|---|---|
| 📅 カレンダーID | `samuraimotors.japan@gmail.com` |
| ⏰ 営業時間 | 設定シートから動的取得 |
| 🚗 移動バッファ | 設定シートから動的取得 |
| 🔒 重複防止 | カレンダーイベントで時間枠をブロック |

---

## 👷 作業管理機能

### 施工フロー（業務Bot → GAS → 3方向配信）

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

### 各アクションの3方向配信仕様

#### ▶️ 作業開始

| 方向 | 内容 |
|---|---|
| 👤 顧客 | 「▶️ រថយន្តរបស់អ្នកកំពុងលាងសម្អាត!<br>Your car wash has started!」 |
| 👨‍💼 Adminトピック | 「▶️ 作業開始 - BK-0042 Hisanori / Camry<br>スタッフ：{名} 開始：{時刻}」 |
| 📊 JOBSシート | `status = started`, `started_at = {時刻}` |

#### 📷 Before写真4枚

| 方向 | 内容 |
|---|---|
| 📁 Drive | `BK-0042_before_front.jpg` 等で保存 |
| 👤 顧客 | `sendMediaGroup` で4枚まとめて送信<br>「📷 រូបថតមុនលាង / Before photos」 |
| 👨‍💼 Adminトピック | `sendMediaGroup` で4枚転送<br>「📷 Before - BK-0042 Hisanori / Camry」 |
| 📊 JOBSシート | `before_photos = Drive URL（4枚カンマ区切り）` |

#### ✅ 作業完了

| 方向 | 内容 |
|---|---|
| 👤 顧客 | 「✅ រថយន្តរបស់អ្នកលាងសម្អាតរួចហើយ!<br>Your car wash is complete!」 |
| 👨‍💼 Adminトピック | 「✅ 作業完了 - BK-0042 Hisanori / Camry<br>スタッフ：{名} 完了：{時刻} 所要：{分}分」 |
| 📊 JOBSシート | `status = completed`, `completed_at = {時刻}` |

#### 📷 After写真4枚

| 方向 | 内容 |
|---|---|
| 📁 Drive | `BK-0042_after_front.jpg` 等で保存 |
| 👤 顧客 | `sendMediaGroup` で4枚まとめて送信<br>「✨ រូបថតបន្ទាប់ពីលាង / After photos<br>Please check the result!」 |
| 👨‍💼 Adminトピック | `sendMediaGroup` で4枚転送「✨ After - BK-0042 Hisanori / Camry」 |
| 📊 JOBSシート | `after_photos = Drive URL（4枚カンマ区切り）` |

### スタッフ管理

- 👥 **最大5人**まで対応
- 📊 **STAFFシート**で動的管理（追加・削除がシート操作のみで完結）
- 🆔 `staff_id`（Telegram chat_id）で識別

---

## 💳 決済管理機能

### QRコード管理（Driveフォルダ + 履歴シート方式）

**運用方針**：QRコードの内容は将来変更される可能性があるため、柔軟に切り替えられる仕組みで管理。

#### QRコード保管場所

- 📁 **Googleドライブ**：`SamuraiMotors_QRCodes/` フォルダに画像を保存
- 📊 **QR_CODESシート**：履歴・有効フラグ管理（後述のシート設計参照）
- 🔄 QR変更時は**シート操作のみ**で切り替え完結（コード変更不要）

#### QR切り替え手順（管理者）

1. 新QR画像を `SamuraiMotors_QRCodes/` にアップロード
2. QR_CODESシートに新しい行を追加（`qr_id`, `image_url`, `description`）
3. 新QRの `active` を `TRUE` に、旧QRの `active` を `FALSE` に変更
4. 次回送信から自動的に新QRが適用される

---

### 決済フロー

**QR送信タイミング**：作業完了ボタン押下時、顧客への「完了通知」「After写真4枚」「QR画像」を**連続して自動送信**（1予約につき1回のみ）。

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

### 決済ステータス（BOOKINGS シート）

| ステータス | 意味 | セット方法 |
|---|---|---|
| 未清算 (unpaid) | QR未送信または入金待ち | 初期値 |
| QR送信済み (qr_sent) | QR画像送信完了 | システム自動 |
| 清算済み (paid) | スクショ受信 → 自動で clearance 完了 | スクショ受信時に自動 |
| 要確認 (needs_review) | 金額違い・行き違い等で要確認 | 管理者が手動 |

- 📋 シートにプルダウンリスト（データ検証）を設定
- 🎨 ステータス別に色分け（未清算=赤 / 清算済み=緑 / 要確認=黄）
- 📧 自動お礼メッセージは **清算済み** 状態時のみ送信

---

### 自動催促機能（24時間間隔・継続）

**運用ルール**：

1. ⏰ **初回催促**：作業完了から **24時間経過** + `payment_status = qr_sent or unpaid` の場合
2. 🔄 **継続催促**：以後 **24時間ごと** に自動送信（清算済み/要確認になるまで）
3. 📊 **催促回数記録**：BOOKINGSシートの `reminder_count` 列にカウントアップ
4. 🎯 **手動対応の判断材料**：シートを見て催促回数が2〜3回以上 → 管理者が個別連絡（電話・メッセージ）

**重要ルール**：催促メッセージは **テキストのみ**。QR画像は再送しない（QRは1予約につき1回のみ送信）。

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

#### 催促時のAdmin通知

```
⚠️ 未払い催促送信 - BK-0042 Hisanori
💰 請求額：25 USD
🔁 催促回数：3回目
⏰ 作業完了から：72時間経過
```

→ 催促3回以上はAdminトピックに **🚨 赤色アラート** で強調表示し、管理者が気づきやすくする。

---

## 💬 顧客チャット機能（フォーラムトピック）

### 1顧客 = 1トピック ルール

- 📌 顧客の `chat_id` で CUSTOMERSシートの `thread_id` を検索
- ✅ `thread_id` が存在 → そのトピックに転送
- 🆕 存在しない → `createForumTopic` で新規作成 → `thread_id` を保存
- 🚫 同じ顧客のトピックが複数できることは絶対に防ぐ

### トピック自動作成ルール

| 条件 | トピック名 | タイミング |
|---|---|---|
| 🆕 新規予約 | `🚗 BK-{番号} {顧客名} / {車種}` | 予約確定時 |
| 🆕 予約前の問い合わせ | `🆕 新規 {Telegramユーザー名}` | 初回メッセージ受信時 |
| 🔄 予約紐づけ後 | トピック名を予約情報付きに更新 | 予約確定時 |

### メッセージ転送（顧客 → 管理者）

- 顧客の予約フロー外メッセージを該当トピックに転送
- 📝 テキスト、📷 写真、🎥 動画、📍 位置情報、📎 ドキュメントに対応
- 🏷️ ヘッダー：`📩 {顧客名} ({予約番号} / {車種})`
- 🔘 「💬 返信」インラインボタン付き

### 管理者の返信（管理者 → 顧客）

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
  - TTL：300秒（5分間操作がなければ自動失効）
  - 🎯 **CacheService採用理由**：5分で消えて問題ないため揮発ストレージで十分（詳細は「🗄️ ストレージ使い分けルール」参照）

---

## 📊 スプレッドシート設計

### 📋 CUSTOMERS シート

| 列 | 内容 |
|---|---|
| A: customer_id | 🔖 顧客ID（自動採番 C-0001〜） |
| B: chat_id | 👤 Telegram chat_id |
| C: username | 👤 Telegramユーザー名 |
| D: name | 📛 顧客名 |
| E: phone | 📱 電話番号 |
| F: language | 🌐 言語（km / en） |
| G: thread_id | 🧵 フォーラムトピックID |
| H: created_at | 📅 登録日時 |
| I: last_contact_at | 🕐 最終連絡日時 |

### 📅 BOOKINGS シート

| 列 | 内容 |
|---|---|
| A: booking_id | 🔖 予約番号（BK-0001〜） |
| B: customer_id | 👤 顧客ID |
| C: chat_id | 👤 Telegram chat_id |
| D: vehicle_type | 🚗 sedan / suv |
| E: vehicle_name | 🚗 車種名 |
| F: plan | 📋 A / B / C / D |
| G: options | 🔧 オプション（カンマ区切り） |
| H: date | 📅 予約日 |
| I: time | ⏰ 予約時間 |
| J: duration | ⏱️ 所要時間（分） |
| K: price | 💰 料金（USD） |
| L: status | 📌 **作業進行状態のみ** ： confirmed / in_progress / completed / cancelled |
| M: location_lat | 📍 緯度 |
| N: location_lng | 📍 経度 |
| O: location_address | 🏠 住所文字列 |
| P: location_note | 📝 補足（建物名・部屋番号等） |
| Q: location_map_url | 🔗 Googleマップリンク |
| R: calendar_event_id | 📅 カレンダーイベントID |
| S: created_at | 📅 作成日時 |
| T: payment_status | 💳 未清算 / QR送信済み / 清算済み / 要確認 |
| U: payment_amount | 💰 請求額（USD） |
| V: payment_screenshot_url | 🧾 決済スクショURL（Drive） |
| W: payment_received_at | 📅 スクショ受信日時 |
| X: qr_sent_at | 💳 QR送信日時 |
| Y: reminder_count | 🔁 催促回数 |
| Z: last_reminder_at | ⏰ 最終催促日時 |
| AA: admin_note | 📝 管理者メモ（要確認時の記録等） |

#### 🔑 status と payment_status の責務分離ルール

**状態管理を2箇所に分散させないため、以下のルールを厳守**：

| 列 | 管理する状態 | 値 |
|---|---|---|
| **L: status** | **作業進行状態のみ** | `confirmed` → `in_progress` → `completed` / `cancelled` |
| **T: payment_status** | **決済状態のみ** | `未清算` / `QR送信済み` / `清算済み` / `要確認` |

- ❌ `status = paid` という値は **使わない**（決済状態は `payment_status` に一元化）
- ✅ 「全フロー完了」の判定条件：`status = completed` **かつ** `payment_status = 清算済み`
- ✅ 各列は互いに独立して遷移する（例：`status = completed` でも `payment_status = 未清算` はあり得る）
- 🚫 コード内で両列を同時更新する箇所は避け、それぞれ単独で更新する

### 🚗 VEHICLES シート

| 列 | 内容 |
|---|---|
| A: customer_id | 👤 顧客ID |
| B: vehicle_type | 🚗 sedan / suv |
| C: vehicle_name | 🚗 車種名 |
| D: plate_number | 🔢 ナンバー |
| E: photo_url | 📷 車両写真URL |

### 🔧 JOBS シート

| 列 | 内容 |
|---|---|
| A: job_id | 🔖 ジョブID（J-0001〜） |
| B: booking_id | 📅 予約番号 |
| C: staff_id | 👷 スタッフchat_id |
| D: staff_name | 👷 スタッフ名 |
| E: status | 📌 assigned / started / completed |
| F: started_at | ▶️ 作業開始時刻 |
| G: completed_at | ✅ 作業完了時刻 |
| H: before_photos | 📷 Before写真URL（4枚、カンマ区切り） |
| I: after_photos | 📷 After写真URL（4枚、カンマ区切り） |

**※ 決済関連は BOOKINGS シートに集約**（BK単位で管理するため、JOBSには置かない）

### 👥 STAFF シート

| 列 | 内容 |
|---|---|
| A: staff_id | 👷 Telegram chat_id |
| B: name_km | 🇰🇭 クメール語名 |
| C: name_jp | 🇯🇵 日本語名 |
| D: active | ✅ 有効フラグ（TRUE/FALSE） |

### 💬 CHAT_LOG シート

| 列 | 内容 |
|---|---|
| A: timestamp | 🕐 日時 |
| B: direction | ↔️ customer_to_admin / admin_to_customer |
| C: chat_id | 👤 顧客chat_id |
| D: thread_id | 🧵 トピックID |
| E: message_type | 📝 text / photo / video / location / document |
| F: content | 💬 内容（テキストまたはファイルID） |
| G: admin_id | 👨‍💼 返信管理者ID |

### 💳 QR_CODES シート（QR履歴管理）

| 列 | 内容 |
|---|---|
| A: qr_id | 🔖 QR識別子（QR-001〜） |
| B: image_url | 🖼️ Drive画像URL |
| C: description | 📝 説明（「ABA Bank メイン」等） |
| D: bank_name | 🏦 銀行名（ABA / Wing / ACLEDA等） |
| E: active | ✅ 現在有効（TRUE / FALSE） - 1つだけTRUE |
| F: created_at | 📅 登録日 |
| G: deactivated_at | 📅 無効化日（切り替え時） |

**運用ルール**：
- 🎯 `active = TRUE` は常に **1行だけ**（排他制御）
- 🔄 切り替え時：旧行を FALSE + `deactivated_at` 記録 → 新行を TRUE
- 📁 画像ファイルは `SamuraiMotors_QRCodes/` Driveフォルダに保存

---

### ⚙️ Plan_Prices シート（動的設定）

| 列 | 内容 |
|---|---|
| A: プラン名 | 清 KIYOME (A) / 鏡 KAGAMI (B) / 匠 TAKUMI (C) / 将軍 SHOGUN (D) |
| B: セダン価格(USD) | 12 / 17 / 20 / 32 |
| C: SUV価格(USD) | 15 / 20 / 23 / 35 |
| D: セダン所要時間(分) | 30 / 40 / 50 / 80 |
| E: SUV所要時間(分) | 45 / 55 / 65 / 95 |
| F: 備考 | プラン内容説明 |

**特殊行**：
- `出張料` / `【設定】移動バッファ(分)` / `【設定】営業開始時刻` / `【設定】営業終了時刻`

---

## ⚙️ 設定値（CONFIG）

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
```

**注意**：料金・営業時間・バッファは `CONFIG` には持たず、Plan_Pricesシートから動的取得。

---

## 📁 GASファイル構成

```
📂 GAS v7 プロジェクト（推定 3,000〜3,500行）
│
├── ⚙️ Config.gs            設定値・PropertiesService参照        100行
├── 🔀 Router.gs            doPost → Bot振り分け                 150行
├── 📬 QueueManager.gs      非同期キュー管理                      150行
├── 📡 TelegramAPI.gs       sendMessage・sendPhoto等ラッパー     150行
├── 📊 SheetHelpers.gs      シート読み書きユーティリティ          250行
├── 📅 BookingBot.gs        予約Bot会話フロー                     400行
├── 📅 BookingLogic.gs      カレンダー空き検索・料金計算          400行
├── 👷 FieldBot.gs          業務Bot処理                           300行
├── 🔧 JobManager.gs        作業ステータス・写真3方向配信         400行
├── 💬 CustomerChat.gs      顧客メッセージ転送・管理者返信        400行
├── 🧵 ForumTopicManager.gs トピック作成・thread_id管理           200行
└── 💳 PaymentManager.gs    QR送信・スクショ受付・自動催促        350行
```

---

## 🗄️ ストレージ使い分けルール（CacheService vs ScriptProperties）

状態管理を2つのストレージに使い分ける理由と基準：

| ストレージ | 特徴 | 用途 |
|---|---|---|
| **ScriptProperties** | 永続・サイズ制限緩い・順序管理可・**GAS再起動に耐える** | 🔐 **重要・永続データ** |
| **CacheService** | 高速・TTL必須・最大6時間で消失・サイズ制限厳しい | ⚡ **短期・揮発データ** |

### ScriptProperties を使う（永続が必要なもの）

| データ | キー形式 | 理由 |
|---|---|---|
| 🔀 Telegramキュー | `queue_{timestamp}_{update_id}` | GAS再起動でも失ってはいけない |
| 🔁 update_id重複排除 | `processed_{update_id}` | 24h保持が必要、Cache 6hで不足 |
| 🔐 Botトークン・設定値 | `BOT_TOKEN_BOOKING` 等 | 設定情報は永続必須 |

### CacheService を使う（短期で消えてよいもの）

| データ | キー形式 | TTL | 理由 |
|---|---|---|---|
| 💬 管理者返信状態 | `admin_reply_{admin_chat_id}` | 300秒 | 返信操作中だけ有効、放置されれば自動失効すべき |
| 💰 料金表キャッシュ | `plan_prices_cache` | 60秒 | 高速化目的、失っても再計算可能 |
| 📅 空き枠キャッシュ | `available_slots_{date}` | 60秒 | 高速化目的、失っても再取得可能 |

### 判断基準（迷ったとき）

```
このデータは失われると業務影響が出る？
├── YES → ScriptProperties（永続）
└── NO  → CacheService（揮発）

GAS再起動・6時間経過後も保持が必要？
├── YES → ScriptProperties
└── NO  → CacheService
```

**重要**：v6 実装の教訓として「**キュー系は絶対に ScriptProperties**」。CacheServiceをキューに使うと6時間TTL・サイズ制限でデータ損失が発生する。

---

## 🔒 非同期キュー方式の実装仕様

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

**重要**：v6 で実装済みの知見をそのまま継承。CacheServiceは使わない（6時間TTL・サイズ制限のため不向き）。

---

## 🛠️ セットアップ関数仕様（setupV7）

GAS エディタから手動実行する初期化関数群。プロジェクト立ち上げ時・メンテナンス時に使用。

### `setupV7()` — プロジェクト全体の初期化

**役割**：新規環境構築時に **1回だけ** 実行し、システム全体を初期状態に整える。

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

### 個別セットアップ関数

| 関数名 | 役割 | 単独実行可否 |
|---|---|---|
| `setupV7Triggers()` | トリガーのみ再作成 | ✅ 可 |
| `setupV7Sheets()` | シートヘッダー・プルダウンのみ設定 | ✅ 可 |
| `setupV7Folders()` | Driveフォルダのみ作成 | ✅ 可 |
| `setupV7Webhooks()` | Webhookのみ再設定 | ✅ 可 |
| `resetV7()` | 全トリガー削除（緊急停止用） | ✅ 可 |

### メンテナンス関数

| 関数名 | 役割 |
|---|---|
| `clearTelegramQueue()` | キュー全消去（緊急時） |
| `clearProcessedIds()` | 処理済みIDマーカー全消去 |
| `clearAllCaches()` | CacheService全消去（料金表・空き枠等） |
| `emergencyStopWebhooks()` | 全Botの Webhook を緊急解除（spam対策） |

### トリガー一覧

| トリガー関数 | 間隔 | 役割 |
|---|---|---|
| `processTelegramQueue` | 1分 | キュー処理（Bot メッセージ処理の本体） |
| `checkUnpaidReminders` | 1時間 | 24h経過未払い検知 → 自動催促送信 |
| `cleanupOldProcessedIds` | 1時間 | 24h経過した `processed_*` マーカー削除 |

---

## 🌐 doGet API エンドポイント仕様（ミニアプリ連携）

ミニアプリ（booking.html / job-manager.html）は `doGet` と `doPost` 経由で GAS と通信。各エンドポイントの仕様を定義。

### 📋 エンドポイント一覧

| action | メソッド | 用途 | 呼び出し元 |
|---|---|---|---|
| `booking_init` | GET | 予約画面の初期データ取得（プラン一覧・料金・所要時間） | booking.html |
| `booking_slots` | GET | 指定日の空き時間スロット取得 | booking.html |
| `booking_create` | POST | 予約確定（カレンダー登録＋シート記録＋通知配信） | booking.html |
| `field_jobs_today` | GET | 今日の予約一覧（スタッフ別） | job-manager.html |
| `field_job_detail` | GET | 予約詳細取得 | job-manager.html |
| `job_start` | POST | 作業開始（3方向配信） | job-manager.html |
| `job_upload_before` | POST | Before写真4枚アップロード（3方向配信） | job-manager.html |
| `job_end` | POST | 作業完了（3方向配信＋QR自動送信トリガー） | job-manager.html |
| `job_upload_after` | POST | After写真4枚アップロード（3方向配信） | job-manager.html |
| `plan_prices` | GET | 料金表取得（Plan_Pricesシート動的読み込み） | 両ミニアプリ |
| `status` | GET | サーバー生存確認 | ヘルスチェック |

### 🔸 `booking_init` — 予約画面初期化

**リクエスト**：
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
     "description_km": "...", "description_en": "..."},
    ... (B, C, D)
  ],
  "options": [
    {"code": "opt1", "name_km": "...", "name_jp": "...", "price": 5, "duration": 10}
  ],
  "business_hours": {"start": 9, "end": 18},
  "buffer_minutes": 30,
  "dispatch_fee": 2,
  "customer": {"name": "Hisanori", "language": "km", "saved_vehicles": [...]}
}
```

### 🔸 `booking_slots` — 空き時間取得

**リクエスト**：
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
    {"time": "09:30", "available": false, "reason": "予約済み"},
    {"time": "10:00", "available": true}
  ]
}
```

### 🔸 `booking_create` — 予約確定

**リクエスト**：
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
  "price": 20,
  "duration": 55,
  "calendar_event_id": "...",
  "thread_id": 12345
}
```

**副作用**：
- BOOKINGSシートに記録
- Googleカレンダーにイベント作成
- Adminトピック自動作成（ForumTopicManager経由）
- 顧客に確定通知（クメール語/英語）
- スタッフに通知（場所リンク付き）

### 🔸 `field_jobs_today` — 今日の予約一覧

**リクエスト**：
```
GET /exec?action=field_jobs_today&staff_id=123456789
```

**レスポンス**：
```json
{
  "ok": true,
  "date": "2026-04-15",
  "jobs": [
    {
      "booking_id": "BK-0042",
      "time": "10:00",
      "customer_name": "Hisanori",
      "vehicle": "Toyota Camry (sedan)",
      "plan": "B",
      "options": ["opt1"],
      "price": 20,
      "duration": 55,
      "location_map_url": "https://www.google.com/maps?q=...",
      "status": "confirmed",
      "job_status": "assigned"
    }
  ]
}
```

### 🔸 `job_start` / `job_end` — 作業開始・完了

**リクエスト**（共通フォーマット）：
```json
POST /exec?action=job_start
{
  "booking_id": "BK-0042",
  "staff_id": 123456789,
  "timestamp": "2026-04-15T10:05:00+07:00"
}
```

**レスポンス**：
```json
{
  "ok": true,
  "job_id": "J-0042",
  "status": "started"  // or "completed"
}
```

**副作用**（3方向配信）：
- 👤 顧客に通知
- 👨‍💼 Adminトピックに通知
- 📊 JOBSシート更新
- 💳 `job_end` の場合：QR自動送信をキックオフ

### 🔸 `job_upload_before` / `job_upload_after` — 写真アップロード

**リクエスト**：
```json
POST /exec?action=job_upload_before
{
  "booking_id": "BK-0042",
  "staff_id": 123456789,
  "photos": [
    {"position": "front", "data": "<base64>"},
    {"position": "back", "data": "<base64>"},
    {"position": "left", "data": "<base64>"},
    {"position": "right", "data": "<base64>"}
  ]
}
```

**レスポンス**：
```json
{
  "ok": true,
  "photo_urls": [
    "https://drive.google.com/...front.jpg",
    "https://drive.google.com/...back.jpg",
    "https://drive.google.com/...left.jpg",
    "https://drive.google.com/...right.jpg"
  ]
}
```

**副作用**：
- 📁 Driveに4枚保存
- 👤 顧客に `sendMediaGroup` で4枚配信
- 👨‍💼 Adminトピックに `sendMediaGroup` で4枚配信
- 📊 JOBSシート更新（before_photos / after_photos列）

### 🔸 `plan_prices` — 料金表取得

**リクエスト**：
```
GET /exec?action=plan_prices
```

**レスポンス**：Plan_Pricesシートから動的取得し、60秒キャッシュ。`booking_init` と同じ構造の `plans` 配列を返す。

### 🔸 共通エラーレスポンス

```json
{
  "ok": false,
  "error": "エラーコード",
  "message": "人間向けエラーメッセージ（日本語）"
}
```

### 🔒 doGet / doPost の責務分離

| メソッド | 用途 |
|---|---|
| **doPost** | Telegram Webhook専用（キューに入れて即 `ok` return） |
| **doGet** | ミニアプリからのAPI呼び出し専用 |

※ ミニアプリのPOST送信も実装上は `doGet` 経由の action パラメータ＋body に統一（GAS の Web App の制約）。または `doPost` のルーティングで action パラメータを見て分岐。詳細は Router.gs で実装。

---

## 🚦 構築フェーズ計画

### Phase 0: 準備・基盤整備（手動作業）

- 🗂️ 新Googleスプレッドシート作成（Samurai Motors v7）
- 📅 Plan_Prices シート初期化
- 📅 Calendar API / Drive API v2 有効化
- 💬 新Telegramグループ作成 + フォーラム有効化
- 🤖 予約Bot / 業務Bot をグループに追加
- 🗂️ 新GASプロジェクト作成
- 🔐 PropertiesService キー登録

**所要時間**：30〜45分

### Phase 1: 基盤コード構築

| ファイル | 行数 | 移植元 |
|---|---|---|
| Config.gs | 100 | v6 定数 |
| TelegramAPI.gs | 150 | v6 sendMessage等 |
| SheetHelpers.gs | 250 | v6 getSheet系 |
| Router.gs | 150 | v6 doPost |
| QueueManager.gs | 150 | v6 非同期キュー |

**完了条件**：Webhook設定 → doPost が1秒以内に `ok` を返す

### Phase 2: 顧客チャット + フォーラムトピック基盤

| ファイル | 行数 | 新規割合 |
|---|---|---|
| CustomerChat.gs | 400 | 70% |
| ForumTopicManager.gs | 200 | 100% |

**完了条件**：初回メッセージで新規トピック作成、管理者返信が顧客に届く

### Phase 3: 予約機能

| ファイル | 行数 | 備考 |
|---|---|---|
| BookingBot.gs | 400 | v6 handleBookingBotWebhook から移植 |
| BookingLogic.gs | 400 | v6 findAvailableSlots / getPlanPrice から移植 |
| booking.html | 1,101 | **既存をそのまま使用**（API URL差し替え） |

**完了条件**：予約確定 → Admin トピック自動作成 + カレンダー登録

### Phase 4: 業務管理機能

| ファイル | 行数 | 備考 |
|---|---|---|
| FieldBot.gs | 300 | v6 handleFieldBotWebhook から移植 |
| JobManager.gs | 400 | 3方向配信ロジック新規追加 |
| job-manager.html | 2,012 | **既存をそのまま使用**（API URL差し替え） |

**完了条件**：ミニアプリ操作 → 顧客/Admin/シート 同時配信成功

### Phase 5: 決済管理

| ファイル | 行数 | 新規割合 |
|---|---|---|
| PaymentManager.gs | 350 | 100% |

**主要機能**：
- QR_CODESシートからactive=TRUEのQRを動的取得して送信
- 顧客スクショ受信 → Drive保存 → BOOKINGS自動【清算済み】化
- シートの【要確認】ステータス検知（お礼メッセージ送信抑止）
- 24時間ごとの自動催促（英語+クメール語）
- 催促回数カウント＋Adminトピック通知（3回以上は赤アラート）

**完了条件**：
- ✅ QR送信 → スクショ受付 → 自動【清算済み】 → お礼メッセージ全フロー動作
- ✅ 【要確認】ステータス時はお礼送信されない
- ✅ 24h未払い → 催促メッセージ送信 + `reminder_count` インクリメント
- ✅ QR_CODES シート切り替えで送信QRが変わる

### 統合テスト

1. 📅 自分で予約（顧客役）- 場所をGoogleマップで指定
2. 📍 スタッフ通知の場所リンクをタップ → Googleマップが起動するか確認
3. 🧵 Adminグループにトピックが作成されるか確認
4. 💬 予約Botにメッセージ送信 → トピックに転送されるか確認
5. 💬 トピックから返信 → 予約Botに届くか確認
6. ▶️ 作業開始 → Before写真4枚 → 顧客に届くか確認
7. ✅ 作業完了 → After写真4枚 → 顧客に届くか確認
8. 💳 QR自動送信（QR_CODESシートの有効QR） → 顧客に届くか確認
9. 🧾 スクショ送信 → BOOKINGSが自動【清算済み】→ お礼送信確認
10. ⚠️ 【要確認】にシート変更 → お礼送信されないこと確認
11. ⏰ 24時間後の自動催促送信確認 + `reminder_count` カウントアップ
12. 🔄 QR_CODESシートで別QRに切り替え → 次の顧客に新QRが届く
13. 🔒 同じ操作を3回連続で実行し、重複通知が来ないか確認

---

## 📅 スケジュール見積もり

| フェーズ | 作業時間 | 累計行数 |
|---|---|---|
| Phase 0: 準備 | 30〜45分 | 0 |
| Phase 1: 基盤 | 2〜3時間 | 〜800行 |
| Phase 2: チャット | 3〜4時間 | 〜1,400行 |
| Phase 3: 予約 | 3〜4時間 | 〜2,200行 |
| Phase 4: 業務 | 3〜4時間 | 〜2,900行 |
| Phase 5: 決済 | 2〜3時間 | 〜3,150行 |
| 統合テスト | 2時間 | - |
| **合計** | **15〜20時間** | **約3,150行** |

---

## 🔄 並行運用戦略

### サービス停止ゼロの切り替え

1. **v6（既存）はWebhook生かしたまま稼働継続**
2. **v7（新）を別GASプロジェクトで構築**
3. Phase 5 完了 + 統合テスト合格まで v6 は生きたまま
4. 切り替え当日：
   - ① v7 の Webhook を設定
   - ② v6 の Webhook を外す
   - ③ 問題発生時は即座に v6 Webhook 復旧（ロールバック）

### v6 の最終状態

- ❌ Webhook は外す
- ✅ アカウント・スプレッドシート・コードは **削除せず保管**
- 📦 緊急時のバックアップとして3ヶ月間保持

---

## 🎯 各フェーズ完了時のルール

**各フェーズ完了時に必ず行うこと**：
1. ✅ デプロイ → 実環境で動作確認
2. ✅ GitHub へプッシュ（バックアップ）
3. ✅ 次フェーズに進む前にユーザーに報告
4. ✅ 問題があれば即修正、次に持ち越さない

---

## 📊 既存資産の評価

| 資産 | 状態 | 扱い |
|---|---|---|
| 🔧 非同期キュー実装 | ✅ 完成 | **そのまま移植** |
| 📅 findAvailableSlots | ✅ 完成 | **そのまま移植** |
| 💰 料金計算（Plan_Prices連動） | ✅ 完成 | **そのまま移植** |
| ⚙️ getBookingConfig（60秒キャッシュ） | ✅ 完成 | **そのまま移植** |
| 📱 booking.html（予約ミニアプリ） | ✅ 完成 | **そのまま流用**（URL差し替え） |
| 🔧 job-manager.html（現場ミニアプリ） | ✅ 完成 | **そのまま流用**（URL差し替え） |
| 📸 写真アップロード（Base64→Drive） | ✅ 完成 | **そのまま移植** |
| 💬 customer-chat.html | ⚠️ 未完成 | **破棄・新規作成** |
| 🧵 フォーラムトピック管理 | ❌ 未実装 | **新規作成** |
| 💳 QR決済フロー | ❌ 未実装 | **新規作成** |

**総合**：**約70%の資産が移植可能**

---

## 🔐 セキュリティ・運用ルール

- 🔒 Botトークン等の機密情報は必ず PropertiesService に保存
- 🚫 ハードコード絶対禁止
- 📝 コミット前に機密情報混入チェック
- 🔄 全変更はGitHubにプッシュ（バックアップ）
- 📋 `.js` ファイル更新時は `.txt` コピーも同期

---

## 📎 関連ドキュメント

- `DISABLED_FEATURES.md` - Phase 1 で無効化した機能の復元手順
- `docs/manual_admin_jp.md` - 管理者向けマニュアル
- `docs/manual_staff_km.md` - スタッフ向けマニュアル（クメール語）
- `docs/manual_field_staff.md` - 現場スタッフ向けマニュアル

---

## ✅ 次のアクション

**Phase 0（準備作業）** の詳細手順に進む準備ができています。

---

**改訂履歴**

| 日付 | バージョン | 変更内容 |
|---|---|---|
| 2026-04-15 | v7.0 | 初版作成・設計完了 |
| 2026-04-15 | v7.1 | 場所入力Step追加 / QR_CODESシート新設 / 決済フロー刷新（自動【清算済み】化・【要確認】ステータス・24h継続催促・催促回数カウント） |
| 2026-04-15 | v7.2 | status/payment_status 責務分離明記 / CacheService vs ScriptProperties 使い分けルール追加 / setupV7()関数仕様追加 / doGet API エンドポイント仕様追加 |
