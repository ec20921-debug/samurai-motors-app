# jp-expense — 日本側経費の入力アプリ（2026-11-10〜）

鈴木・飯泉・五木田さんなど、日本側メンバーが自分で払った経費を、スマホから
**スクショ（証憑）とコメントつき**で入れるウェブアプリ。送るとすぐ、経費 GSS の「経費マスター」に1行入る。

- 独立した GAS プロジェクト（本番の v7 / v7-operations とは別。業務Bot には影響しない）
  - scriptId: `1EzngxztzlGzkgtTaQphOIU1Q-Zt9nydgMdKynZ8KcO4-xPFjBd4H_fHj`
  - 本番の deploymentId: `AKfycbxAZuGD3MVOKBoGII1wsxl9kE_QIt8GpMYfvpwrvIu3L5BR8B3KwLPBayANrHMSX58`
- 通知は送らない（Daisuke 2026-11-10「Telegram への通知はいらない」）

## 使い方

1. 経費 GSS のタブ「日本側メンバー」の D 列にある**本人用リンク**を、その人にだけ送る
2. 本人はリンクを開いて、日付・何に使ったか・金額・分類・支払い方法・スクショ・コメントを入れて「登録する」
3. 経費マスターに次の形で入る

| 列 | 入る値 |
|---|---|
| F 負担先 / J 入力者 | 本人の名前（名簿の A 列） |
| G 支払方法 | 「クレカ（五木田）」のように 方法＋本人 |
| H レシート | 証憑のリンク（1枚＝ファイル、2枚以上＝その件のフォルダ） |
| I 備考 | 「日本側経費アプリから入力 / コメント」 |
| N 出典 / O 元ID | `日本側経費アプリ` / `JP-yyyyMMdd-HHmmss-xxx` |

- 証憑の保存先: Drive「SamuraiMotors_日本側経費_証憑/yyyy-MM/」（ec20921 のマイドライブ。共有はしない）
- Run Kosal の前払い残金（前払い管理 F2）には関係しない

## メンバーを足す・止める

- 足す: 「日本側メンバー」に行を足す（A 名前・B 合言葉＝推測できない長い文字列・C 有効にチェック）。D 列のリンクは式で出る
- 止める: C 列のチェックを外す（リンクを知られた時は B 列の合言葉を変える＝古いリンクは使えなくなる）
- A 列の名前は経費マスターの負担先にそのまま入る。既存の書き方（鈴木・飯泉・五木田）にそろえる

## 初回だけ（Daisuke）

GAS エディタで `setupJpExpense` を1回実行して、権限を許可する（スプレッドシートと Drive）。

## 変更・デプロイ

```bash
cd jp-expense
"C:/nodejs-global/clasp.cmd" push --force
"C:/nodejs-global/clasp.cmd" deploy --deploymentId AKfycbxAZuGD3MVOKBoGII1wsxl9kE_QIt8GpMYfvpwrvIu3L5BR8B3KwLPBayANrHMSX58 --description "<変更内容>"
```

push だけでは本番の URL に反映されない。必ず同じ deploymentId で deploy する（URL を変えないため）。
