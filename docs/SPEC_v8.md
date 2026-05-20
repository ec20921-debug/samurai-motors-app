# 🏪🚗 SPEC v8 — In-store オプション + Menu v3 統合 + UX 改善（差分仕様）

**プロジェクト**: Samurai Motors 顧客対応システム
**バージョン**: v8（v7.5 への差分）
**日付**: 2026-05-20
**ステータス**: ✅ 本番稼働中
**前提**: [`SPEC_v7.5.md`](./SPEC_v7.5.md) を読んだうえで本書を読むこと

> 本書は v7.5 統合版に対する **追加・変更のみ** を記録する差分仕様。
> 統合版は将来 v8.x で再統合する。

---

## 📑 v8 で追加・変更されたもの

| # | 領域 | 概要 |
|---|---|---|
| 1 | **サービス受領場所** | **店舗作業 / 出張作業の選択肢を追加**。店舗作業は出張料$0で予約可能 |
| 2 | **ミニアプリ UI（場所選択）** | 「🚗 Delivery / 🏪 In-store」タブ切替UI追加 |
| 3 | **ミニアプリ UX** | 出張モード: GPS で現在地を自動取得しピン自動設置 |
| 4 | **ミニアプリ UI（店舗モード）** | Leaflet で店舗座標を固定埋め込みマップ表示（外部リンク撤廃） |
| 5 | **BOOKINGS 列追加** | `サービスタイプ`（"店舗" or "出張"）— 33列目 |
| 6 | **通知メッセージ** | 顧客/管理者へのメッセージで店舗/出張を区別、店舗向けには来店案内を追加 |
| 7 | **駐車場ヒアリング** | 店舗予約時は省略（出張時のみ送信） |
| 8 | **Menu v3 統合シート** | 旧「料金設定」「オプション」を「メニュー」シート1枚に統合（dual-read で後方互換） |

---

## 1. 🏪 サービス受領場所オプション（v8 の中核）

### 1-1. 背景

現地スタッフからのフィードバック：

> 「事務所に来てもらってサービス受けてもらう導線が必要。来店なら出張費 $2 はかからない。
> アプリの場所選択で『店舗で受ける』ボタンを出すべき。」

→ 「リアル → デジタル」段階的導線設計（Day 2 / 2026-05-20 議事録参照）。

### 1-2. ユーザー体験フロー

```
[プラン選択] → [日時選択] → [場所選択画面]
                                  ↓
                  ┌─────────────┴──────────────┐
              [🚗 Delivery]              [🏪 In-store]
              地図 + ピン留め             店舗住所カード
                  ↓                            ↓
              現在地自動GPS              固定埋め込みマップ
                  ↓                            ↓
              出張料 $2 加算             出張料 $0
                  ↓                            ↓
              [確認画面] → [予約確定] ← [駐車場ヒアリング (出張のみ)]
                          ↓
                  [来店案内 (店舗のみ)]
```

### 1-3. データモデル

#### BOOKINGS シート — 1 列追加

| 列 | 列名 | 値 | 用途 |
|---|---|---|---|
| **AG (33)** | **サービスタイプ** | `店舗` or `出張` | 場所オプションの記録 |

→ マイグレーション関数: `addServiceTypeColumn()` in `v7/Migration_ServiceType.gs`
→ 実行記録: 2026-05-20 12:25 ec20921@gmail.com の GAS エディタから実行 ✅

#### 互換性

- **既存予約**（v8 前の予約）: `サービスタイプ` 列が空 → 暗黙的に「出張」扱い
- 互換性のため、`createBooking` のデフォルトは `serviceType = '出張'`

### 1-4. 料金計算ロジック

```javascript
// v7/BookingLogic.gs createBooking() 内
const serviceType = (params.serviceType === '店舗') ? '店舗' : '出張';
const dispatchFeeAmount = (serviceType === '店舗') ? 0 : getDispatchFeeFor(vehicleType);
```

→ 店舗作業時のみ `dispatchFeeAmount = 0`、その他は既存通り（料金設定シートの「出張料」を加算）。

---

## 2. 🎨 ミニアプリ UI 改修（booking.html）

### 2-1. 場所選択画面 — タブ切替UI

```html
[ 🚗 Delivery / ដឹកជញ្ជូន ]  [ 🏪 In-store / នៅហាង ]
```

- デフォルト選択: **「🚗 Delivery」**（既存動作との互換性）
- タブクリックで `selectServiceType('出張' or '店舗')` 発火
- `state.serviceType` ('出張' or '店舗') が更新される
- 確認画面・予約送信時にこの値が反映される

### 2-2. 出張モード — GPS 自動取得（新機能）

```javascript
// 場所選択画面表示時、Leaflet 初期化後に自動実行
navigator.geolocation.getCurrentPosition(
  function(pos) {
    if (!savedCoords) {
      setMapPin(pos.coords.latitude, pos.coords.longitude);  // 現在地にピン自動設置
    }
  },
  function(err) { /* タップ操作にフォールバック */ },
  { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
);
```

**効果**: ユーザーは微調整するだけで済む（タップでピン設置の手間削減）。

### 2-3. 店舗モード — 固定埋め込みマップ

```javascript
var STORE_COORDS = { lat: 11.5848188, lng: 104.8993556 };

function initStoreMap() {
  storeMap = L.map(el, {
    zoomControl: false, scrollWheelZoom: false,
    dragging: false, doubleClickZoom: false,
    touchZoom: false, keyboard: false, tap: false
  }).setView([STORE_COORDS.lat, STORE_COORDS.lng], 17);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { ... }).addTo(storeMap);
  L.marker([STORE_COORDS.lat, STORE_COORDS.lng]).addTo(storeMap);
}
```

**設計判断**:
- 当初の「Open in Google Maps」リンクは **予約フロー離脱を招く** ため削除
- 代わりに Leaflet で店舗座標を **操作不可（パン・ズーム禁止）の固定マップ** として埋め込み
- 店舗住所/マップリンクは予約完了後の Telegram で送信（フロー完結優先）

### 2-4. タブ切替時の挙動

| 操作 | 動作 |
|---|---|
| 「Delivery」→「In-store」 | 地図 div を非表示 + 店舗カード div を表示 + 店舗マップ初期化（初回のみ） |
| 「In-store」→「Delivery」 | 店舗カード非表示 + 地図 div 表示 + `leafletMap.invalidateSize()`（display 切替時のサイズ問題対策） |

---

## 3. 💬 通知メッセージ改修

### 3-1. 顧客 Telegram メッセージ

| 場面 | 出張作業 | 店舗作業 |
|---|---|---|
| 料金行 | `🚚 Delivery fee / ថ្លៃដឹកជញ្ជូន: $2` | `🏪 In-store service / សេវានៅហាង: $0.00` |
| 来店案内 | （なし） | `🏪 Please come to our office` + `📍 Samurai Motors Office (https://maps.app.goo.gl/wEHuqw2fry4QJQ5y6)` + `⏰ Please arrive at HH:MM` |
| What happens next | 出張フロー | 「🏪 On arrival: We greet you at the office」追加 |
| 駐車場ヒアリング（写真+階数） | 送信 | **送信しない** |

### 3-2. 管理者通知（Admin グループ・顧客トピック）

```
🆕 新規予約 [🏪 店舗作業]      ← 店舗の場合
🆕 新規予約 [🚗 出張作業]      ← 出張の場合
```

料金行も serviceType で分岐:

| | 表示 |
|---|---|
| 出張 | `料金: WASH $X + 出張料 $2 = 合計 $Y` |
| 店舗 | `料金: WASH $X + 店舗作業(出張料なし) = 合計 $Y` |

場所表示:

| | 表示 |
|---|---|
| 出張 | `場所: https://www.google.com/maps?q=LAT,LNG` |
| 店舗 | `場所: 🏪 店舗 (Samurai Motors 事務所)` |

---

## 4. 📊 Menu v3 統合シート（v7.5 以降の変更、v8 で前提化）

旧「料金設定」シートと「オプション」シートを **「メニュー」シート 1 枚に統合**。

### スキーマ

| 列 | 項目 |
|---|---|
| A | コード（例: `WASH`, `GLASS_3`） |
| B | 種別（`WASH` / `GLASS`） |
| C | 名称（英） |
| D | 名称（クメール） |
| E | 名称（日） |
| F | セダン価格 |
| G | SUV 価格 |
| H | セダン所要（分） |
| I | SUV 所要（分） |
| J | 有効（TRUE/FALSE） |
| K | 備考 |

### Dual-read 方式（後方互換）

- `getActivePlans()`: 「メニュー」シート優先、なければ「料金設定」シートにフォールバック
- `getActiveOptions()`: 「メニュー」シート優先、なければ「オプション」シートにフォールバック

→ booking.html / Router.gs は変更不要、既存運用に影響なし。

---

## 5. 🛠️ 実装ファイル変更箇所

### `v7/BookingLogic.gs`

- `createBooking()`: `params.serviceType` を受け取り、`serviceType === '店舗'` なら `dispatchFeeAmount = 0`
- `appendRow` に `'サービスタイプ': serviceType` 追加
- `notifyBookingCreated()`: `info.serviceType` を判定し、顧客/管理者メッセージで分岐
  - 店舗予約時は「Please come to our office」+ 来店案内ブロックを追加
  - 駐車場ヒアリング `parkingInfoText` は店舗予約時はスキップ
- Menu v3 関連: `readPlansFromMenuSheet_()` / `readGlassFromMenuSheet_()` 等の dual-read 関数

### `booking.html`

- `state.serviceType = '出張'` 追加（デフォルト）
- `STORE_INFO` / `STORE_COORDS` 定数追加
- 場所選択画面 (`#view-location`) の HTML 構造変更:
  - タブ UI（`.service-type-tabs`）追加
  - `#locationDelivery`（地図 + ピン留め）と `#locationInStore`（店舗カード + 固定マップ）の 2 モード
- CSS追加: `.svc-tab`, `.svc-tab.active`, `.store-card`, `.store-card-title`, `.store-card-note`
- JS 追加:
  - `selectServiceType(type)`: タブ切替 + display 切替
  - `initStoreMap()`: 店舗マップ初期化（操作不可）
  - `initLocationMapAfterLoad_()`: GPS 自動取得を追加
- `handleNext()` 内 `case 'view-location'`: 店舗時はバリデーションスキップ
- `submitBooking()` payload: `serviceType: state.serviceType` 追加
- `renderSummary()`: serviceType で fee 計算分岐 + 表示分岐

### `v7/Migration_ServiceType.gs`（新規、一時ファイル）

- `addServiceTypeColumn()`: BOOKINGS シート最終列に「サービスタイプ」列を追加
- ✅ 2026-05-20 12:25 に実行済み、列追加完了（33列目）
- 役目終了、出張後に削除予定

---

## 6. 🧪 テスト確認項目

### 出張作業フロー

- [ ] 場所選択画面で「🚗 Delivery」タブがデフォルト選択中
- [ ] GPS 取得 → 現在地に自動ピン設置（GPS 拒否時はプノンペン中心 + タップでフォールバック）
- [ ] 確認画面: `🚚 Delivery fee: $2.00`
- [ ] 顧客通知: `🚚 Delivery fee` 表示 + 駐車場ヒアリング送信
- [ ] 管理通知: `[🚗 出張作業]` + マップURL
- [ ] BOOKINGS 33列目: `出張`

### 店舗作業フロー

- [ ] 「🏪 In-store」タブをタップ → 地図非表示 + 店舗カード表示
- [ ] 店舗カード内に Leaflet 固定マップ（操作不可）が表示される
- [ ] 「Open in Google Maps」リンクは存在しない（フロー離脱防止）
- [ ] 確認画面: `🏪 In-store: $0.00 (saved $2.00)`
- [ ] 顧客通知: `🏪 In-store service` 表示 + 「Please come to our office」+ 店舗住所/Google Mapsリンク + 来店時刻
- [ ] 駐車場ヒアリングは送信されない
- [ ] 管理通知: `[🏪 店舗作業]` + 場所「🏪 店舗 (Samurai Motors 事務所)」
- [ ] BOOKINGS 33列目: `店舗`、料金合計に出張料が含まれない

### タブ切替

- [ ] 「Delivery」→「In-store」→「Delivery」と戻った時、地図が正しく表示される（`invalidateSize` 効果確認）

---

## 7. 🔧 デプロイ・運用メモ

### 2026-05-20 デプロイ手順（記録）

1. `clasp push --force` で `v7/` 配下 18 ファイル GAS 反映
2. GAS エディタ「デプロイを管理」→ 既存 Web app デプロイを編集 → バージョン 40 へ更新
   - URL 変更なし（`AKfycbwV8eVN6KJvfMnQLkNmbOqYsjpvQSJTCqk40kfyMFzRjxFItJ8-4VxOV4U9MojLH4U/exec`）
   - Telegram Webhook / booking.html GAS_URL の更新不要
3. `addServiceTypeColumn()` を GAS エディタから実行 → BOOKINGS 33 列目に「サービスタイプ」追加

### 注意事項

- **新しいデプロイを作らない**こと（URL が変わって運用に支障）
- 必ず「デプロイを管理」から **既存デプロイのバージョンを上げる**運用
- API executable デプロイは未設定（必要なら別途 GAS エディタからデプロイ）

---

## 8. 📝 関連メモ

### 設計判断の記録

| 判断 | 内容 | 理由 |
|---|---|---|
| デフォルトを「出張」に | 店舗ではなく出張をデフォルトタブに | 既存の予約パターン（自宅出張）の方が主流。来店は新規導線として追加 |
| 店舗マップを操作不可に | パン・ズーム・ドラッグ全て無効 | 「場所を確認するだけ」なので操作の必要なし。誤操作で予約フローから離脱を防ぐ |
| 駐車場ヒアリング省略（店舗時） | parkingInfoText を送信しない | 顧客が車を運転して店舗に来るので、階数等の情報は不要 |
| 出張料を別管理（既存維持） | Plan_Prices シート「出張料」行 | ハードコード禁止、シート編集のみで料金改定可能（既存設計を尊重） |

### 将来の拡張余地

- **集計ダッシュボード**: BOOKINGS の「サービスタイプ」で店舗 vs 出張の比率・売上を可視化
- **店舗運用シフト**: 店舗予約が集中する曜日/時間帯の特定 → スタッフ配置最適化
- **キャンペーン**: 「店舗予約限定 -10%」のような場所別キャンペーンも Plan_Prices で追加可能
- **複数店舗対応**: STORE_INFO を配列化、`selectStore(storeId)` で複数店舗から選択可能に拡張

---

## 9. 🔗 関連リンク

- 前バージョン仕様書: [`SPEC_v7.5.md`](./SPEC_v7.5.md)
- 統合版（顧客系全体仕様）: [`SPEC_v7_CustomerSystem.md`](./SPEC_v7_CustomerSystem.md)
- 現地スタッフPC運用手順: [`cambodia-pc-setup.md`](./cambodia-pc-setup.md)
- 2026-05 プノンペン出張 事前準備サマリー: [`../reports/2026-05-phnom-penh/preparation_summary.md`](../reports/2026-05-phnom-penh/preparation_summary.md)
- Day 2 議事録（店舗オプション議論）: [`../reports/2026-05-phnom-penh/daily/day2_2026-05-20.md`](../reports/2026-05-phnom-penh/daily/day2_2026-05-20.md)

---

## 10. 改訂履歴

| 日付 | 改訂者 | 内容 |
|---|---|---|
| 2026-05-20 | 鈴木（Claude Code 支援） | 初版作成。v7.5 への差分として、In-store オプション + Menu v3 統合 + UX 改善を仕様化 |
