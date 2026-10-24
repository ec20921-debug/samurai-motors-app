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

## 2.5 すでに専用QRを配った店をグループ連携する（2026-10-20 追加）

営業で先に専用QR（`start=shop_<店マスターの既存shop_id>`）を配った店は、**フォームを使わない**（フォームは新しい shop_id を採番するので、配った QR と食い違う）。

1. 店マスターの「QRリンク(BookingBot)」に、その店の予約Botリンク（`https://t.me/SAMURAI_MOTORS_BOOKING_BOT?start=shop_<shop_id>`）が入っていることを確認する
2. v7-operations の GAS エディタで `issueShopLinkCodesForQrShops()` を実行
   → Bot連携シートに「待機中」の行（既存の shop_id のまま・6桁コード）ができ、管理グループのパートナートピックに **店名とコードの一覧** が届く。何度実行しても二重には作らない（発行済みの店は同じコードを再掲、連携済みの店は ✅ 表示）。【サンプル】行は対象外
   - 店を指定して出すときは `issueShopLinkCodes(['SHOP-…', 'SHOP-…'])`
3. 店ごとに、お店の人と Telegram グループを作り予約Botを招待 → `/register <コード>` を送る → ✅ で完了
   - **あいさつ文は Bot が自動で送る（2026-10-24〜）**: 「✅ Connected!」の直後に、営業ボードと同じあいさつ文（クメール語＋英語）を予約Botが1回だけ送る。手で貼らない（二重になる）。送れなかった時は毎時の安全網が、連携から7日以内の店に限って送り直す（v7/ShopGroupGreeting.gs・送信済みの印は Script Properties `shop_greeting_sent_<shop_id>`）。文言を直すときは v7/ShopGroupGreeting.gs と v7-operations/ScoutBoardShopLinks.gs の両方を直す

**一覧はここ（2026-10-22〜）**: 営業ボード「SAMURAI SCOUT 営業ボード」の **「🔗 提携店QR・グループ連携」タブ**（1時間ごとに自動更新・見るだけ）。店ごとに 連携の状態・作るグループ名・グループで送る文（/register）・あいさつ文（クメール語＋英語・Panha 校閲 provisional）・予約QRのURL・流入（QRを読んだ人→予約画面→予約→施工→売上・取り分）・実際のグループ名。作り方の手順もタブの上にある（v7-operations/ScoutBoardShopLinks.gs）

**現場でQRシールを作る流れ（2026-10-22〜・正本）**: Daisuke「営業ボードから顧客のQR URLをスマホでコピーして、アプリにコピペで現場ではQRシールを印刷する。流れと記録の最適化を」
1. お店がOK → 営業アプリ（SAMURAI SCOUT）のお店の画面「🔗 QRシール・お店のグループ」→「このお店のQRを出す」。店マスター「QRリンク(BookingBot)」に書かれ、Bot連携に6桁コードが出る（管理グループのパートナートピックに通知）。その場で使える（ボードの1時間更新を待たない）
2. 「📋 URLをコピー」→ ラベル印刷アプリに貼り付けてシールを印刷 → 自分のスマホで1回読んで確認（カードの「QRを読んだ人」が増える）
3. 「🏷 QRシールを渡した」で枚数を記録 → v7 Database「QRシール記録」タブに1行（記録者・日時）、店マスター「QRシール枚数／QRシール最終日／QRシール記録者」に累計（v7-operations/ShopQrSticker.gs）
4. 「📋 グループ名をコピー」「📋 送る文をコピー」でグループを作り /register → ✅
- 記録の大元は v7 Database（店マスター・Bot連携・QRシール記録）。営業ボードは見るだけ（列順は 店名 → QRのURL → 連携 → 送る文 → シール枚数）
- 旧ファイル「SamuraiMotors_提携店専用QR_URL一覧_2026-10-20」（Drive）は使わない（中身は営業ボードと同じ・流入分析タブは未接続のまま）
- QRリンク欄に別の店のリンクが入っている店は、アプリで発行できない（「別のお店のもの」と出る）→ 店マスターを手で確認する

**決済QRについて（2026-10-20 修正）**: 店QR経由のお客様には、**店舗グループが未連携でも** 当社の決済QR・支払いのご案内を送らない（お客様は店に定価を払うため）。管理グループの作業終了通知に「🏪 提携店経由」と出る。
- 店扱いになる条件: 店QRのリンクの shop_id が **店マスターにあり**、Bot連携で **停止になっていない** こと。店マスターに無い・停止中の店のリンクから来た人は通常のお客様として案内し、管理グループに「⚠️ 店として扱わなかった」と出る
- **最後に読んだQRが優先**: 店QRを読むとレジデンス等の流入元（src_ref）は外れ、有効な流入元QR（Picasso 等）を読むと店の紐付け（shop_ref）は外れる
- 予約なしの手動ジョブの「支払いのご案内」: 現場アプリの支払区分が 現金・ABA なら送る（現場の明示が優先）／提携店払い・無料なら送らない／未選択・後払いなら店QR経由のお客様には送らない
- 店マスターが一時的に読めない時は店扱い（当社QRを送らない側）に倒す
- **写真共有の告知（2026-10-21 Daisuke 決定）**: 店QRから来たお客様への歓迎メッセージで「作業前後の写真はこのお店にも共有されます」とクメール語＋英語で一言伝える（BookingBot.gs sendWelcomeMessage の referralLine）。現場が口頭で伝える必要はない
- 店を通さず当社で集金する例外だけ `retryPaymentQR("<予約ID>", true)` で送れる（第2引数なしだと何も変えずに止まる）
- 関連ファイル: v7/ShopRouting.gs（getValidShopRef_ / lookupShopMaster_）・v7/PaymentManager.gs・v7/ManualCustomerLink.gs・v7-operations/ShopLinkCodes.gs

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
- `v7/ShopRouting.gs` — /register・ディープリンク・店舗グループ通知・店集金の判定（getValidShopRef_）
- `v7-operations/ShopLinkCodes.gs` — 既存 shop_id のまま連携コードを出す（issueShopLinkCodesForQrShops）
- `v7/BookingBot.gs` — フック2箇所（グループ /register・/start shop_）
- `docs/SHOP_PROVISIONING_MANUAL_LOCAL.md` — 現地スタッフ用（小学生レベル）
