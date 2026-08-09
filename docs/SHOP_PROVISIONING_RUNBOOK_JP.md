# 🇯🇵 提携店プロビジョニング 日本側ランブック

> 対象: Daisuke / 日本側管理者。現地スタッフ用は `SHOP_PROVISIONING_MANUAL_LOCAL.md`。
> 設計正典: Vault/04_Projects/Samurai/04_Businesses/Motors/2026-08-09-partner-bot-provisioning-design.md

---

## 0. 仕組みの全体像（1分で理解）

- **ボットは増やさない**。既存の予約Bot 1本を全店で共用し、店ごとの区別は
  ディープリンク `t.me/<予約Bot>?start=shop_<shop_id>` で行う → **トークン新規発行ゼロが標準**
- 店舗の実体は既存の **店マスター**（v7 Database・shop_id体系）
- 店⇄グループの紐付けは v7 Database の **「Bot連携」シート**（自動作成）
- 精算集計は既存の **コミッション台帳**（勤務用GSS）から shop_id 別に自動集計

### 💰 精算ルール（2026-08-09 Daisuke 決定）
1. お客様は **店に全額支払い**（受付の信頼できる人がお金を扱うのがカンボジアの自然な形）
2. 店は **30%を自分の取り分**としてその場で確保
3. 当社の**70%は施工完了時にその場回収**（現金 or ABA）。出張施工でスタッフが現場にいるので売掛を残さない
4. 回収したら **コミッション台帳の支払ステータスを「支払済み」に更新**（集金者=「店」の行）
5. 未回収分は月次レポートに「⏳ Not yet settled」として双方に表示 → 督促の代わり

---

## 1. 初期セットアップ（一度だけ・約10分）

すべて **v7-operations** の GASエディタ（ec20921）で実行:

1. `setupShopProvisioning()` を実行
   → フォームが自動作成され、ログに **入力URL** が出る → 管理グループにピン留め
2. Script Properties に予約Botトークンを登録（月次レポート送信用）:
   - キー: `BOT_TOKEN_BOOKING` ／ 値: 予約Botのトークン（v7側と同じもの）
   - ⚠️ トークンはチャット・シート・コードに書かない。Script Properties 直接入力のみ
3. （Bot名が既定と違う場合）Script Properties `SHOP_BOOKING_BOT_USERNAME` を設定
4. `installShopMonthlyReportTrigger()` を実行（毎月1日10時にレポート送信）

**v7側のデプロイ**（ShopRouting.gs / BookingBot.gs 変更の反映）:
```
cd C:\Users\drymp\dev\samurai-motors-app\v7
clasp push --force
```
※ doPost/Router には触れていないため Web アプリ再デプロイは不要（ポーリングは push だけで反映）。
v7-operations 側も同様に `clasp push --force`。

## 2. 日常運用（日本側は原則ノータッチ）

- 現地がフォーム入力 → 自動で shop_id・QR・ワンタイムコードが管理グループに届く
- 現地がグループ作成→Bot招待→`/register <コード>` → 完了通知が届く
- 毎月1日: 店別レポートが各店グループ＋管理グループに自動送信
- **日本側がやること**: 月次サマリーで未回収の多い店がないか眺めるだけ

## 3. ブランドBot希望の店が出たら（+10分）

フォームの「ブランドBot希望=はい」通知が来た場合のみ:

1. BotFather で新Bot作成（命名例: `<shop>_samurai_bot`）
2. トークンを **v7 の Script Properties** に `BOT_TOKEN_SHOP_<shop_id>` で登録
   - ⚠️ **絶対にコード・リポジトリ・GSS・チャットに貼らない**（2026-07-03 トークン露出インシデントの教訓）
3. マルチテナントのポーリング組み込みは未実装（需要が出た時点で BotPoller 拡張を実装）。
   それまでは標準方式（共用Bot＋専用グループ）で提供し、Bot名義だけ待ってもらう
4. 露出事故時: BotFather で即 revoke → 新トークンを再登録

## 4. トラブルシューティング

| 症状 | 対処 |
|---|---|
| /register にBotが無反応 | Botがグループに入っているか確認。ポーリングは1分間隔なので少し待つ |
| 「Code not found」 | コード転記ミス or 既に使用済み。フォーム再送信で新しい行とコードを発行 |
| QRリンクが開けない | Driveの共有設定（リンクを知っている全員）を確認 |
| 月次レポートが店に届かない | v7-operations の Script Properties `BOT_TOKEN_BOOKING` 未登録が典型。手順1-2を実施 |
| フォーム項目を変更したい | `SHOP_PROV_FIELDS` のラベルとフォームのタイトルは**1文字も違わず一致**が必須。両方直す |

## 5. 関連ファイル

- `v7-operations/ShopProvisioningManager.gs` — フォーム・採番・QR・通知・月次レポート
- `v7/ShopRouting.gs` — /register・ディープリンク・店舗グループ通知
- `v7/BookingBot.gs` — フック2箇所（グループ /register・/start shop_）
- `docs/SHOP_PROVISIONING_MANUAL_LOCAL.md` — 現地スタッフ用（小学生レベル）
