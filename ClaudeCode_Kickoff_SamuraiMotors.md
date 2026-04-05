# Samurai Motors - 業務管理Mini App 開発キックオフ
# Claude Code 引き継ぎ指示書
# 作成日: 2026-04-05

---

## ■ プロジェクト概要

Samurai Motors Cambodia（サムライモーターズ）の現場オペレーション用
Telegram Mini App を構築する。

- **目的**: ロン（現場洗車スタッフ）がTelegram上でジョブ管理と在庫管理を行う
- **利用Bot**: @quickwash_kh_bot（既存の未使用Bot。Mini App設定済み）
- **担当**: 鈴木が全て構築（木戸さんは関与しない）
- **ホスティング**: Render（Starter $7/月、既存サーバーあり）
- **バックエンド**: Google Apps Script → Google Sheets + Google Drive
- **ローンチ日**: 2026年4月20日

---

## ■ 完成済みの資産（このプロジェクトに組み込むファイル）

### 1. SamuraiMotors_JobManager.html
- 5ステップのジョブ管理フォーム（完成済み・動作確認済み）
- 全画面クメール語（日本語括弧付き）
- GPS現在地取得、写真撮影・圧縮、タイマー機能搭載
- Google Apps Script への fetch POST で送信
- **このHTMLをTelegram Mini App化する**

### 2. SamuraiMotors_AppsScript_v2.js
- Google Sheetsへのデータ記録（23列）
- Google Driveへの写真保存（SamuraiMotors_Photosフォルダに自動整理）
- **デプロイ済みURL**: https://script.google.com/macros/s/AKfycbxJfqfid10yT_gRxzUb01qoN_RUVr6AcMuKzVpE7w3_cZoDKNewnBjKO4DO96LPA1hh/exec
- ※ 現在v1がデプロイ中。v2への更新が必要（写真対応追加のため）

### 3. Google Spreadsheet
- **顧客・ジョブ管理用**: https://docs.google.com/spreadsheets/d/1-5rMJW21t4PnpXnDAYdrNXzz672kL2cd4mOSti3Yfc0/edit
- **事業計画書（在庫情報含む可能性）**: https://docs.google.com/spreadsheets/d/1zhXFgpPY90xjDcxuXgLw8Ac42fr-ZNZ8/edit?gid=1275454032#gid=1275454032

---

## ■ システム構成

```
ロンのスマホ (Telegram)
  └→ @quickwash_kh_bot のメニューボタン「📋 業務管理」タップ
       └→ Telegram Mini App (HTML/CSS/JS)
            │   ホスティング: Render (HTTPS必須)
            │   URL例: https://samurai-motors-bot.onrender.com/job-manager.html
            │
            ├→ ジョブ管理タブ
            │    └→ fetch POST → Google Apps Script
            │         ├→ Google Sheets（ジョブデータ23列）
            │         └→ Google Drive（写真保存）
            │
            └→ 在庫管理タブ
                 └→ fetch POST → Google Apps Script（別エンドポイントまたは同一）
                      └→ Google Sheets（在庫シート）
                           └→ 閾値アラート → Telegram通知（将来）

管理者（鈴木・飯泉）
  └→ Google Sheetsで全ジョブ履歴・在庫状況を閲覧
  └→ Google Driveでビフォー/アフター写真を確認
```

---

## ■ 開発タスク

### Phase 1: Telegram Mini App化（優先・今週中）

#### Task 1-1: プロジェクト構造の作成
```
samurai-motors-app/
├── public/
│   ├── index.html          ← メインページ（タブ切り替え: ジョブ管理 / 在庫管理）
│   ├── job-manager.html    ← 既存のJobManager.htmlを改修
│   └── inventory.html      ← 在庫管理画面（新規作成）
├── server.js               ← Express静的ファイル配信（最小構成）
├── package.json
├── render.yaml             ← Renderデプロイ設定
└── README.md
```

#### Task 1-2: HTMLにTelegram Web App SDKを追加
```html
<!-- <head>内に追加 -->
<script src="https://telegram.org/js/telegram-web-app.js"></script>
```
追加後に利用可能になるもの:
- `Telegram.WebApp.themeParams` → Telegramのテーマカラー自動適用
- `Telegram.WebApp.initDataUnsafe.user` → ユーザー情報（ロンの識別に使える）
- `Telegram.WebApp.MainButton` → 画面下部のメインボタン
- `Telegram.WebApp.close()` → Mini Appを閉じる

#### Task 1-3: Expressサーバー（最小構成）
```javascript
const express = require('express');
const app = express();
app.use(express.static('public'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
```

#### Task 1-4: Renderにデプロイ
- 既存のRenderアカウントに新しいStatic Site or Web Serviceとして追加
- HTTPS自動付与（Telegram Mini Appの必須要件）

#### Task 1-5: BotFatherでMini App URL設定
- @BotFather → `/setmenubutton`
  - Bot: @quickwash_kh_bot
  - ボタンテキスト: `📋 業務管理`
  - URL: Render上のURL

---

### Phase 2: 在庫管理機能の追加

#### Task 2-1: 在庫管理シートの設計
事業計画書スプレッドシートの既存データを確認し、在庫管理用のシートを設計する。

想定カラム:
| 列 | 項目 | 説明 |
|----|------|------|
| A | Item ID | 自動採番 |
| B | ឈ្មោះផលិតផល（品名） | 洗車液、コーティング剤等 |
| C | ប្រភេទ（カテゴリ） | 液体/布/道具 |
| D | ចំនួនបច្ចុប្បន្ន（現在庫数） | |
| E | ឯកតា（単位） | 本/枚/個 |
| F | កម្រិតព្រមាន（発注閾値） | この数を下回ったら通知 |
| G | កាលបរិច្ឆេទធ្វើបច្ចុប្បន្នភាព（最終更新） | |

#### Task 2-2: 在庫管理UI
- 現在庫一覧表示
- 使用記録ボタン（「洗車液 -1」のようなワンタップ操作）
- ジョブ完了時に「使用した資材」を選択 → 自動在庫減算
- 在庫追加（入荷時）

#### Task 2-3: ジョブ管理との連携
- ジョブ完了時に使用資材を記録 → 在庫シートを自動更新
- 在庫が閾値を下回った場合の通知（将来：Telegram Bot APIで通知送信）

---

### Phase 3: 改善・最適化（ローンチ後）

- ロンからのフィードバック反映
- 在庫閾値アラートのTelegram通知実装
- ジョブ履歴の検索・フィルタ機能
- 日次レポート自動生成

---

## ■ Google Sheets データ仕様（ジョブ管理・23列）

| # | 列名 | 型 | 説明 |
|---|------|-----|------|
| 1 | Job ID | text | SM-YYYYMMDD-001 形式の自動採番 |
| 2 | ថ្ងៃចុះបញ្ជី（登録日時） | datetime | カンボジア時間 UTC+7 |
| 3 | ឈ្មោះ（顧客名） | text | 必須 |
| 4 | ទូរស័ព្ទ（電話番号） | text | 必須 |
| 5 | អគារ（建物） | select | TS3, Diamond Island, ICON, Bolero, De Castle Royal, その他 |
| 6 | បន្ទប់（部屋番号） | text | 任意 |
| 7 | រថយន្ត（車種） | text | 任意 |
| 8 | ស្លាកលេខ（ナンバー） | text | 任意 |
| 9 | គម្រោង（プラン） | select | 清KIYOME/鏡KAGAMI/匠TAKUMI/将軍SHOGUN |
| 10 | Google Maps | url | GPS取得 or 手動入力 |
| 11 | កំណត់សម្គាល់（備考） | text | 任意 |
| 12 | កាលវិភាគ（予約日時） | datetime | 五木田さんが問い合わせ時に記録 |
| 13 | ចាប់ផ្តើម（開始時刻） | datetime | ロンが「スタート」タップ |
| 14 | បញ្ចប់（終了時刻） | datetime | ロンが「作業終了」タップ |
| 15 | រយៈពេល（所要分） | number | 開始〜終了の差分（分） |
| 16-19 | មុន 1-4（ビフォー） | url | Google Driveの共有リンク |
| 20-23 | ក្រោយ 1-4（アフター） | url | Google Driveの共有リンク |

---

## ■ サービスプラン情報

| プラン | 名称 | セダン | SUV/Premium |
|--------|------|--------|-------------|
| A | 清/KIYOME | $12 | $15 |
| B | 鏡/KAGAMI | $17 | $20 |
| C | 匠/TAKUMI | $20 | $23 |
| VIP | 将軍/SHOGUN | $35 | $38 |

- 全プラン共通で $2 の出張費が別途かかる
- 鏡/KAGAMI がアンカープラン（松竹梅の中間効果）
- 初回顧客は全プランで撥水サービス込み

---

## ■ ロンのUX設計原則

- **テキスト入力は最小限**: ドロップダウン選択、ボタンタップを優先
- **言語**: 全画面クメール語メイン + 日本語括弧付き
- **ロンはクメール語を画面で読み、音声で返答するスタイル**（テキスト入力苦手）
- **GPS位置取得エラーでUIがフリーズしないこと**（修正済み）
  - type="url" → type="text" に変更
  - alert() → トースト通知に変更
  - viewport の user-scalable=no を削除
- **写真はカメラから直接撮影**（capture="environment"属性）
- **オフライン対応**: ネット不通時はlocalStorageに一時保存

---

## ■ 技術的な注意事項

### Apps Script v2 のデプロイ更新手順
現在v1がデプロイされている。v2コード（写真対応）への更新が必要:
1. Apps Scriptエディタで既存コードを全削除
2. v2コードを貼り付け → 保存
3. 「デプロイ」→「デプロイを管理」→ 鉛筆アイコン → バージョン「新しいバージョン」→「デプロイ」
4. Drive権限の承認（初回のみ）
※ URLは変わらない

### Telegram Mini App の要件
- HTTPS必須（Renderなら自動）
- telegram-web-app.js を読み込むこと
- `Telegram.WebApp.ready()` を初期化時に呼ぶ
- `Telegram.WebApp.expand()` でフルスクリーン展開推奨

### 写真の処理フロー
1. ロンがカメラで撮影（capture="environment"）
2. JavaScriptでリサイズ（max 1200px幅）+ JPEG品質70%に圧縮
3. Base64エンコード → JSONに含めてApps Scriptに送信
4. Apps ScriptがBase64デコード → Google Driveに.jpgとして保存
5. ファイルを「リンクを知っている全員」に共有設定
6. Drive URLをGoogle Sheetsに記録

### 写真のサイズ制限
- Apps Scriptの制限: リクエストbody最大50MB
- 写真4枚×2（ビフォー/アフター）= 最大8枚
- 1枚あたり圧縮後 ~200-400KB → 合計 ~3MB程度で問題なし

---

## ■ 既存のTelegramボット一覧

| Bot | 用途 | 状態 |
|-----|------|------|
| @SamuraiMotorsAI_bot | CS顧客対応（Claude API） | 本番稼働中 |
| @SamuraiMotorsKH_bot | フォームベース顧客対応 | 稼働中 |
| @quickwash_kh_bot | **→ 業務管理に転用** | Mini App設定済み・未使用 |

---

## ■ チーム構成（関連メンバー）

- **鈴木（だい）**: オーナー。本アプリの開発・運用を担当
- **ロン（Run Kosal）**: 現場スタッフ。本アプリのメインユーザー
- **飯泉さん**: 管理担当。Google Sheetsで実績を確認
- **五木田さん**: 問い合わせ受付。予約日時を記録する役割
- **木戸さん**: 技術担当だが、本プロジェクトには関与しない

---

## ■ 最初にやること（Claude Codeへの指示）

1. 上記のプロジェクト構造を作成
2. SamuraiMotors_JobManager.html を `public/job-manager.html` に配置
3. Telegram Web App SDK を追加
4. 在庫管理画面のプロトタイプを作成
5. タブ切り替え式のメインページ（index.html）を作成
6. Express サーバー（server.js）を作成
7. 事業計画書のスプレッドシートを確認し、在庫管理の品目リストを設計
8. Renderへのデプロイ設定

---

## ■ 参考ファイル

本指示書と一緒に以下のファイルをClaude Codeのプロジェクトに配置すること:
- `SamuraiMotors_JobManager.html` — ジョブ管理UI完成版
- `SamuraiMotors_AppsScript_v2.js` — バックエンドコード
- `20260405_SamuraiMotors_JobSystem_Report.docx` — 詳細レポート
