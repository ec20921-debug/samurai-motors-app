# 引き継ぎ — 営業ミニアプリの訪問支援（地図の現在地・近い順・前回メモ・商談計算）2026-10-20

## 何が変わるか（現場スタッフの画面 saleslog-internal.html）

| 追加 | 中身 |
|---|---|
| 店の検索 | 一覧の上に検索欄（店名・電話・オーナー名） |
| 🧭 近い順 | 現在地を取ってから、一覧を近い順に並べ替え。各店に距離（例 160m）を表示 |
| 📍 現在地 | 地図に自分の位置（青い点）。地図を開くと自分の周り（ズーム16）から表示 |
| ピン | 丸い点 → 反応の文字入りピン（A/B/C/D・提携済は ★）。色は従来どおり |
| 前回メモ | 一覧のカードとピンの吹き出しに、直近の訪問メモ（2行まで） |
| 🧮 商談計算 | 店詳細・ピンの吹き出しから開く。整備工場モード（1日の台数×営業日÷N×平均単価）と中古車屋モード（在庫の黄ばみ・ガラス → 提携価格30%オフ、来店客からの紹介料）。紹介料率は店マスターの「紹介料率(%)」（空欄=30%） |
| 商談計算の履歴 | 店詳細に、その店の計算の記録（日時・記録者・入力した数字・紹介料・メモ） |

## バックエンド（v7-operations）

- 新ファイル `SalesHearingManager.gs`
  - v7 Database に **「商談ヒアリング」タブを自動作成**（初回保存時）。1回=1行。列は `HEARING_HEADERS` を参照
  - 料金は v7 Database の **「メニュー」タブ**（HEADLIGHT / HEADLIGHT_MAGIC / GLASS_3 / GLASS_ALL のセダン・SUV価格）。コードに料金は書いていない
  - 保存時はサーバー側で計算し直す（画面の数字をそのまま書かない）。画面の `hearingCalc_` と同じ式（クラウドで5パターン照合済み・金額は全一致）
- `SalesLogManager.gs`: `saleslog_shops` が各店の `lastMemo`・`lastVisitAt` と料金 `prices` を返す。`saleslog_shop_detail` が `hearings` を返す
- `Router.gs`: 新しいアクション `saleslog_hearing_create`

## PC でのデプロイ手順（新アクションがあるので clasp deploy まで必要）

1. このブランチを取り込む: `git fetch origin claude/picasso-campaign-response-9jlthu && git checkout claude/picasso-campaign-response-9jlthu`
2. GAS（v7-operations）:
   ```bash
   cd v7-operations
   clasp push --force
   clasp deploy --deploymentId <本番のデプロイID>   # これを忘れると /exec が旧版のまま（UNKNOWN_ACTION）
   ```
3. GAS エディタで `debugSalesHearingPrices` を1回実行 → ログに5件（HEADLIGHT 15 / HEADLIGHT_MAGIC 30 / GLASS_3 15・20 / GLASS_ALL 30・40 / WASH 12・15）が出ること
4. ミニアプリ配信: docs/DEPLOY.md の「ミニアプリ同期」を実行（`saleslog-internal.html` は既に同期リストに入っている）
5. 実機確認（ロン君の Telegram で）:
   - 一覧で「🧭 近い順」→ 位置情報の許可 → 距離が出る
   - 地図で青い点・文字入りピン・吹き出しの「前回」が出る
   - 店を開いて「🧮」→ 数字を動かす → 保存 → GSS「商談ヒアリング」に1行入り、店詳細の履歴に出る

## 注意

- クメール語の新しい文言は Panha 校閲済み（provisional）。Ron に確認してほしい点: 「ជិតបំផុត（近い順）」が並べ替えと伝わるか／「ផ្ទាំង（タブ）」が自然か／社内ボタンに「ចំណូលបន្ថែម（追加収入）」で良いか
- 地図タイルは従来どおり OpenStreetMap（変更なし）
- 位置の取得は Telegram LocationManager が許可済みならそれを、だめならブラウザの位置情報を使う。訪問フォームの GPS 表示には影響しない
- v7-operations の行数は追加前から肥大化ルールの目安（約11,300行）を超えている（今回 +約270行で 13,168行）。整理タイムの要否は Daisuke 判断
