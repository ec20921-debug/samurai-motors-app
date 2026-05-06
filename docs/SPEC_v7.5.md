# 🚗 SPEC v7.5 — Menu v2 + Campaign + Premium UX(差分仕様)

**プロジェクト**: Samurai Motors 顧客対応システム
**バージョン**: v7.5(v7.4 への差分)
**日付**: 2026-05-06
**ステータス**: ✅ 本番稼働中
**前提**: [`SPEC_v7.4.md`](./SPEC_v7.4.md) を読んだうえで本書を読むこと

> 本書は v7.4 統合版に対する **追加・変更のみ** を記録する差分仕様。
> 統合版は将来 v7.6 等で再統合する。

---

## 📑 v7.5 で追加・変更されたもの

| # | 領域 | 概要 |
|---|---|---|
| 1 | メニュー構造 | 旧 4 プラン(KIYOME/KAGAMI/TAKUMI/SHOGUN) → **WASH 必須 + GLASS 任意 add-on の 2 層構造** |
| 2 | キャンペーン機能 | **GRAND OPENING -30% OFF**(サービス料金のみ・出張料は通常)を Plan_Prices シート 4 行で制御 |
| 3 | 新シート | `OPTIONS`(GLASS add-on)/ `FUNNEL_LOG`(計測) |
| 4 | BOOKINGS 列追加 | `割引前金額(USD)` / `割引額(USD)` / `キャンペーン名` |
| 5 | UX/UI 全面刷新 | booking.html を Cinzel セリフ + 黒×シャンパンゴールドの premium へ |
| 6 | 待機演出 | 起動 splash(ロゴ + pulse)/ スロット待ち(SAMURAI MOTORS 波 + 刀閃)/ 提出中 ceremonial overlay |
| 7 | 完了 seal | Reserved 画面に「侍ロゴ」ゴールド円章 + 周囲リング回転 |
| 8 | 言語フリップ(部分) | booking.html / 予約確定通知 / Bot welcome を **英語メイン × クメール語サブ** に |
| 9 | 祝日扱い | 祝日も予約可能、日曜のみ定休日 |

---

## 1. 🌟 メニュー構造(Menu v2)

### サービス

| Service | Sedan | SUV | 所要時間(Sedan/SUV) |
|---|---|---|---|
| **SAMURAI WASH**(必須) | $12 | $15 | 30 / 45 min |
| **+ SAMURAI GLASS — 3 Windows + Mirrors**(任意) | +$15 | +$20 | +30 / +50 min |
| **+ SAMURAI GLASS — All Windows + Mirrors**(任意) | +$30 | +$40 | +60 / +100 min |
| 出張料 | $2 | $2 | — |

### 制約

- ⚠️ GLASS は単体注文不可、**WASH を選択した場合のみ追加可**
- ✨ ドアミラー(両サイド)への coating は GLASS 標準装備(追加料金なし)
- 🚫 室内ルームミラーは対象外
- 旧 4 プラン(A/B/C/D)は廃止、新規予約には使用しない(レガシー履歴のみ表示用に保持)

### バンドル早見

| Bundle | Sedan | SUV |
|---|---|---|
| WASH only | $14 | $17 |
| WASH + 3 Windows GLASS ⭐ | $29 | $37 |
| WASH + All Windows GLASS | $44 | $57 |

⭐ 想定主力商品

---

## 2. 🎌 キャンペーン機能

### 設計原則

**Plan_Prices シートの設定行で完全制御**。コード変更不要で ON/OFF・割引率・名称を切替可能。

### Plan_Prices に追加された 4 行

| プラン名 | セダン列(B) | 用途 |
|---|---|---|
| 【設定】キャンペーン有効 | TRUE | TRUE/FALSE で全体 ON/OFF |
| 【設定】キャンペーン割引(%) | 30 | 整数(0-99) |
| 【設定】キャンペーン名(英) | GRAND OPENING | 顧客表示用 |
| 【設定】キャンペーン名(クメール) | ការបើកដំបូង | 顧客表示用(任意) |

### 適用ロジック(案 a 採用)

- **割引対象**: WASH + GLASS の合計(`serviceSubtotal`)のみ
- **出張料**: 通常価格(透明性)
- 計算: `discount = round(serviceSubtotal × percent) / 100`、`amount = subtotal − discount`

### 全層への伝播

| 層 | 反映 |
|---|---|
| Plan_Prices シート | 4 設定行で源 |
| `getBookingConfig()` (SheetHelpers.gs) | `config.campaign = {active, percent, nameEn, nameKm}` |
| `apiBookingInit` (Router.gs) | レスポンスに `campaign` を含めミニアプリへ |
| booking.html ミニアプリ | キャンペーンバナー(赤+ゴールド sweep)+ 価格 strikethrough + 確認画面で内訳 |
| `createBooking` (BookingLogic.gs) | 割引適用後の `amount` を BOOKINGS に書き込み + 3 列にメタデータ |
| `notifyBookingCreated` | 顧客 Telegram + Admin グループに内訳付き通知 |
| QR 送信 / 24h 催促 / 全通知 | `BOOKINGS.請求額(USD)` を読むため自動で割引後 |

### 運用感

| やりたいこと | やり方 |
|---|---|
| キャンペーン終了 | Plan_Prices の「キャンペーン有効」セルを `FALSE` |
| 割引率変更 | 「キャンペーン割引(%)」セルを 25 等に変更 |
| 名称変更 | 「キャンペーン名(英)」セルを書換 |
| 60 秒キャッシュ | 自動。即時反映なら GAS で `clearBookingConfigCache()` を実行 |

---

## 3. 📊 新シート

### 3.1 OPTIONS シート

GLASS add-on 等の追加オプションを管理。`getActiveOptions()` で読み込み。

| コード | 名称(英) | 名称(クメール) | 名称(日) | セダン価格 | SUV 価格 | セダン所要(分) | SUV 所要(分) | 必須プラン | 有効 | 備考 |
|---|---|---|---|---|---|---|---|---|---|---|
| GLASS_3 | 3 Windows + Mirrors | កញ្ចក់ ៣ + កញ្ចក់ឆ្លុះ ២ | 3面+ドアミラー | 15 | 20 | 30 | 50 | W | TRUE | 前 3 面 + ドアミラー coating |
| GLASS_ALL | All Windows + Mirrors | កញ្ចក់ ទាំងអស់ + កញ្ចក់ឆ្លុះ ២ | 全面+ドアミラー | 30 | 40 | 60 | 100 | W | TRUE | 全面 + ドアミラー coating |

### 3.2 FUNNEL_LOG シート

`Bot 来訪 → ミニアプリ起動 → 予約完了` の 3 段ファネルを記録。

| 列 | 内容 |
|---|---|
| A: タイムスタンプ | イベント発生時刻 |
| B: チャットID | 顧客の Telegram chat_id |
| C: イベント | `bot_start` / `miniapp_opened` / `booking_completed` 等 |
| D: ソース | `telegram` / `booking.html` / `system` |
| E: 予約 ID | (該当時のみ) BK-... |
| F: メタデータ(JSON) | プラン / GLASS 選択 / 金額 等 |

書き込み: `logFunnelEvent(chatId, event, source, bookingId, metadata)` 関数経由(失敗しても業務影響なし)。

---

## 4. 📋 BOOKINGS シート列追加(分析用)

末尾に 3 列追加(`ensureBookingCampaignColumnsV2_()` で冪等に作成):

| 列 | 内容 | 用途 |
|---|---|---|
| AB: 割引前金額(USD) | 27.00 | キャンペーン適用前の合計(WASH+GLASS+Delivery) |
| AC: 割引額(USD) | 8.10 | 引かれた額(0 = キャンペーン無し) |
| AD: キャンペーン名 | GRAND OPENING | 適用したキャンペーン識別 |

→ これにより「キャンペーン適用率」「平均割引額」「累計割引額」が後付で集計可能に。

---

## 5. 🎨 UX/UI 監修パス(プロデザイナー視点)

booking.html を 6 領域で昇華(全て CSS only、追加アセットなし):

| 領域 | 内容 |
|---|---|
| Typography | Cinzel セリフ書体導入。タイトル 28px serif、large letter-spacing |
| Color | 深黒 #050505 + シャンパンゴールド #c9a85c + ハイライト #e3c878 |
| Cards | グラデーション背景 + 多層 box-shadow + inner glow で素材感 |
| Step 番号 | ソリッドゴールド → ゴールドリング(Roman feel) |
| 日付ピッカー | Cinzel 大判数字 + 今日 = ゴールドドット(旧:赤縁) |
| 時間スロット | Cinzel 数字 + 選択時 text-shadow + ホバー gold-muted |
| 確認画面 | Editorial layout: 上端ゴールドの hairline + Total 26px serif + textShadow |
| 完了 seal | 侍ロゴ画像円章 + bounce 入場 + dashed リング 18s 回転 |
| 起動 splash | ロゴ + ゴールド pulse animation |
| スロット待ち | SAMURAI MOTORS 14 文字波 + ゴールド刀閃 sweep |
| 提出中 overlay | 全画面 backdrop-blur + ceremonial loader |
| **場所選択マップ** | **height: clamp(420px, 68vh, 620px) ビューポート適応(旧 280px 固定の 2 倍超)、box-shadow 追加** |
| **車種アイコン** | 🚗 / 🚙 emoji → **ゴールド線画 SVG**(セダン: 短低車高、SUV: 短ボンネット+長キャビン+ルーフレール+大径ホイール) |
| **キャンペーンバナー** | 赤+ゴールドの sweep アニメ、`getBookingConfig().campaign` 連動で動的表示/非表示 |

---

## 6. 🌐 言語フリップ(部分実施)

「英語メイン × クメール語サブ」の方針で以下を入替:

- ✅ booking.html(全面)
- ✅ 予約確定通知(顧客 Telegram)
- ✅ 予約Bot /start ウェルカム
- 🟡 未対応(P4 で全面実施予定): 作業開始/完了通知 / Before/After 写真キャプション / QR 送信 / 24h 催促 / 受領自動応答

---

## 7. 📅 営業日扱い

| 日 | 旧(v7.4) | 新(v7.5) |
|---|---|---|
| 日曜 | 定休日 | 定休日(変更なし) |
| カンボジア祝日 | 全営業停止 | **通常営業**、Holiday バッジ表示のみ |

→ ロジック: `findAvailableSlots` の祝日ブロックを削除、UI 側もクリック可能に。

---

## 8. 🚮 廃止された仕様

| 廃止項目 | 廃止理由 |
|---|---|
| 旧 4 プラン(KIYOME/KAGAMI/TAKUMI/SHOGUN) | Menu v2 で WASH+GLASS に集約 |
| 祝日 = 営業停止 | 売上機会損失、Daisuke 判断で営業可へ |
| クメール語先頭順の通知文(部分) | 英語メイン化 |
| spinner + "Loading..." の汎用待機 UI | premium 演出に置換 |
| 提出時 "Sending..." テキスト | ceremonial overlay に置換 |

---

## 9. 📦 v7.5 で更新されたファイル

### GAS

| ファイル | 主な変更 |
|---|---|
| `Config.gs` | SHEET_NAMES に OPTIONS / FUNNEL_LOG 追加 |
| `Setup_MenuV2.gs`(新規) | `migrateMenuV2()` 一括マイグレーション(Plan_Prices/OPTIONS/FUNNEL_LOG/BOOKINGS 列追加) |
| `SheetHelpers.gs` | `getBookingConfig()` で campaign パース |
| `BookingLogic.gs` | `parsePlanRow` 両形式対応 / `getActiveOptions` 新設 / `createBooking` で GLASS+割引適用+3 列書込 / `notifyBookingCreated` で内訳表示 |
| `Router.gs` | `apiBookingInit` で options/campaign を返却、`miniapp_opened` 計測フック |
| `BookingDashboard.gs` | プラン一覧を動的化 / Menu v2 分析セクション(キャンペーン/GLASS/ファネル) |
| `BookingBot.gs` | /start ウェルカムを英語メイン化 + キャンペーン自動表示 |

### フロントエンド

| ファイル | 主な変更 |
|---|---|
| `booking.html` | Menu v2 構造 + premium UI 全面刷新 |
| `job-manager.html` | 旧 4 プラン UI を WASH + GLASS 構造に変更 |
| `logo.png` | 既存活用(splash + 完了 seal で使用) |

---

## 10. 🛠️ 運用手順(マイグレーション)

新環境 or 大型改修後に 1 回実行:

1. clasp push で GAS 反映
2. Web App を redeploy(`clasp redeploy <deploymentId>`)
3. GAS エディタで `migrateMenuV2()` を ▶ 実行
4. ログで以下を確認:
   - Plan_Prices: 9 行(WASH + 出張料 + 設定 5 + キャンペーン 4)
   - OPTIONS: 2 行(GLASS_3 / GLASS_ALL)
   - FUNNEL_LOG: ヘッダー
   - BOOKINGS: 末尾に 3 列追加(`割引前金額(USD)` / `割引額(USD)` / `キャンペーン名`)
5. 経営ダッシュボードを再生成: `ensureBookingDashboard()`
6. ミニアプリで予約テスト → 通知 / シート / カレンダー / ダッシュボード反映を確認

---

## 11. 🤖 Customer Onboarding Flow(/start ウェルカム動線)

### 11.1 設計原則: チラシは evergreen、キャンペーンは動的

**チラシに「30%OFF」を印字しない**。代わりに **Bot welcome で動的にキャンペーン情報を配信**することで、キャンペーン切替時にチラシ刷新が不要(Plan_Prices シート 1 セルだけで運用切替)。

### 11.2 動作フロー(/start 押下時)

```
1. 顧客が QR スキャン → @SAMURAI_MOTORS_BOOKING_BOT 起動
2. 顧客が「Start」または「/start」を送信
   ↓
3. BookingBot.gs `sendWelcomeMessage(msg)` 実行
   ┌─ ① sendPhoto(FLYER_URL, caption: "🚗 SAMURAI MOTORS — Premium Japanese-style mobile car wash")
   ├─ ② getBookingConfig().campaign を読み、有効ならバナー文挿入
   ├─ ③ sendMessage(welcome テキスト + 動的バナー + ミニアプリ誘導)
   ├─ ④ setChatMenuButton(顧客個別、type: web_app)
   └─ ⑤ sendMessage(管理グループ, "/start 受信" 通知)
4. 並行: ensureCustomerTopic で管理グループに顧客トピック作成
```

### 11.3 配信先と表示内容

| 配信先 | 内容 |
|---|---|
| 顧客 DM(予約Bot) | チラシ画像 + welcome 文(英語メイン+クメール語サブ)+ キャンペーン文 |
| 管理マスターグループ | "/start 受信: {名前} (chat_id={数字})" 通知のみ(チラシは送らない) |

### 11.4 チラシのホスト

`flyer.png`(814 KB)を**リポジトリ直下に配置**:
- ローカル: `C:\Users\drymp\dev\samurai-motors-app\flyer.png`
- 配信 URL: `https://ec20921-debug.github.io/samurai-motors-app/flyer.png`(GitHub Pages 自動配信)
- Drive 経由でも可能だが、GitHub Pages の方が高速かつ簡素

→ **チラシ刷新時**: 同名で `flyer.png` を上書き → `git push` だけで顧客の welcome 画像が更新される。

### 11.5 動的キャンペーンバナー文

`getBookingConfig().campaign.active === true && percent > 0` の場合:

```
━━━━━━━━━━━━━━━━
🎌 GRAND OPENING — 30% OFF
   (limited time, services only)
━━━━━━━━━━━━━━━━
```

→ Plan_Prices シートの「キャンペーン有効」を FALSE にすると、welcome から自動的にバナー行が消える。

### 11.6 流入元計測(将来拡張)

QR コードに `?start=flyer_v1` 等の start parameter を付与すれば、チラシ・FB・店頭等の流入元を `FUNNEL_LOG` に記録可能(現状未実装、必要時に拡張)。

---

## 12. 🛡️ 運用ノート(2026-05-06 学習事項)

### 12.1 Telegram フォーラムトピック消失インシデント

#### 何が起きたか
2026-05-06 の test 中、管理マスターグループから **35 顧客分のトピックが一斉に削除**された(操作系トピック「経費/勤怠/タスク/日報」は無傷)。

#### 原因(推定)
Daisuke の test 用アカウント(管理者権限保持)が、Bot の chat を「Delete」する際に出現した「**All Delete**」型の確認ダイアログを承諾 → Telegram 側で管理者権限により **顧客トピック群が一斉削除された**可能性が高い。

→ **コード起因ではない**。Telegram の管理者権限と UI の組み合わせによる事故。

#### 復旧
- ✅ CUSTOMERS シートの thread_id 列は無傷(全 35 顧客分)
- ✅ 顧客 DM・予約・決済・写真などの**業務データはすべて残存**
- 🔴 削除された Telegram 内チャット履歴は **復元不可**(Telegram-side deletion is permanent)
- ✅ v7.3 の `sendToCustomerTopicWithRecovery` が、各顧客の次回メッセージで **新トピック自動作成** → 業務継続に支障なし

#### 顧客側からの脅威評価
**ゼロ**。一般顧客は管理マスターグループの**メンバーではないため、トピック削除の権限がない**。
顧客が予約Bot を Delete / Block しても、それは顧客自身の Telegram 側だけの操作で、管理グループには**一切影響しない**。

### 12.2 再発防止策

| 施策 | 内容 |
|---|---|
| ① 管理者権限の最小化 | 管理マスターグループの管理者を Daisuke + 飯泉 + 必要最小限に。テスト用アカウントは管理者から外す |
| ② Bot の権限最小化 | Bot に必要なのは「メッセージ送信」「Manage Topics」のみ。「Delete Messages of Others」などの広い権限は不要 |
| ③ テスト環境の分離 | テスト用アカウントは管理マスターから除外し、別の test グループでテスト |
| ④ Pin 警告 | 管理マスター General の Pin に「⚠️ Don't delete topics」を貼って視覚的に防衛 |

### 12.3 v7.3 の `sendToCustomerTopicWithRecovery` の効果

本インシデントで **v7.3 の自動復旧コードが本番で実証された**:
- 1 回目の送信で「thread not found」エラー検知
- CUSTOMERS の stale thread_id を自動クリア
- `createForumTopic` で新トピック作成
- 新 thread_id を保存 + リトライ送信

→ **ゼロダウンタイム** で復旧可能、過去履歴は失うが業務継続性は完全保証。

---

## 13. 🤔 残タスク・将来予定

| # | 領域 | 内容 |
|---|---|---|
| P4 | 言語フリップ完了 | 全 Bot 通知の英語メイン化 |
| P5 | デザイナー発注 | チラシ v2(指示書 Vault 配備済) |
| 計測 | A/B テスト基盤 | FUNNEL_LOG にバージョン番号 |
| 顧客 | リピート促進 | 90 日来てない顧客への自動メッセージ |
| エラー監視 | 観測性向上 | 予約失敗・シート書込エラーの Admin 通知 |

---

## バージョン履歴

| バージョン | 日付 | 内容 |
|---|---|---|
| v7.4 | 2026-05-03 | clasp 自動デプロイ + QR 配信耐障害性 |
| **v7.5** | **2026-05-06** | **Menu v2(WASH+GLASS) + GRAND OPENING -30% キャンペーン + UX/UI 監修パス + 祝日営業 + Bot welcome 英語メイン化 + チラシ画像配信 + Map 大型化 + 運用ノート(Telegram トピック消失インシデント) + 車種 SVG アイコン化** |

### v7.5 内の主要 commit(参考)

| commit | 内容 |
|---|---|
| `0820ad4` | Menu v2 GAS 改修(Plan_Prices/OPTIONS/Router) |
| `675ecad` | booking.html Menu v2 + Armor Tokyo 風 UI |
| `c7cacca` | GLASS opt-in トグル化 |
| `f711cab` | premium upgrade(Cinzel + シャンパンゴールド) |
| `1cf2808` | Leaflet 遅延 + premium splash |
| `c63ce6f` | ロゴ splash + 車種 SVG アイコン |
| `7779525` | UX/UI 監修パス 5 領域 |
| `bcc8c42` | Reserved 完了 seal をロゴ画像化 |
| `5631a38` | 祝日営業可(日曜のみ定休) |
| `60db3d5` | GRAND OPENING -30% キャンペーン全層統合 + SUV 再デザイン |
| `8d77442` | Layer 2 + BOOKINGS 分析列 + ダッシュボード新セクション + SPEC v7.5 |
| `89ad8e9` | Bot welcome に evergreen チラシ + 動的キャンペーン配信 |
| `a292ad6` / `db0e23b` | Map 大型化 (280px 固定 → clamp(420px, 68vh, 620px)) |

---

**関連ドキュメント**:
- [`SPEC_v7.4.md`](./SPEC_v7.4.md) — 統合版前提仕様
- [`G:\マイドライブ\SuzukiEmpire\Vault\04_Projects\Samurai\04_Businesses\Motors\Menu_v2.md`](file://G:\マイドライブ\SuzukiEmpire\Vault\04_Projects\Samurai\04_Businesses\Motors\Menu_v2.md) — メニュー詳細
- [`Flyer_v2_Designer_Brief.md`](file://G:\マイドライブ\SuzukiEmpire\Vault\04_Projects\Samurai\04_Businesses\Motors\Flyer_v2_Designer_Brief.md) — チラシ発注指示書
