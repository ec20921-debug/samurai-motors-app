# jp-expense — 日本側経費の入力アプリ（2026-11-10〜）

鈴木・飯泉・五木田さんなど、日本側メンバーが自分で払った経費を、スマホから
**スクショ（証憑）とコメントつき**で入れるウェブアプリ。送るとすぐ、経費 GSS の「経費マスター」に1行入る。

- 独立した GAS プロジェクト（本番の v7 / v7-operations とは別。業務Bot には影響しない）
  - scriptId: `1EzngxztzlGzkgtTaQphOIU1Q-Zt9nydgMdKynZ8KcO4-xPFjBd4H_fHj`
  - 本番の deploymentId: `AKfycbxAZuGD3MVOKBoGII1wsxl9kE_QIt8GpMYfvpwrvIu3L5BR8B3KwLPBayANrHMSX58`
- 通知は送らない（Daisuke 2026-11-10「Telegram への通知はいらない」）

## 使い方

1. 下のリンク（1本だけ・全員共通）を日本側メンバーに送る。合言葉はない（2026-11-10 Daisuke「個別リンクも合言葉もいらない。開いたらすぐ入れられるように」）
   **`https://ec20921-debug.github.io/samurai-motors-miniapp/jp-expense/`**（GitHub Pages 版・こちらを配る）
   - GAS の `/exec` を直接開く版は、スマホで Google アカウントに複数ログインしていると「現在、ファイルを開くことができません」になる（2026-11-10 Daisuke の iPhone で発生）。Pages 版は画面を Pages に置き、GAS の `doPost` へ fetch するので、ログイン状態に左右されない
   - Pages 版の作り方: `python build_pages.py C:/Users/drymp/dev/samurai-motors-miniapp/jp-expense/index.html` → 配信用リポジトリで commit・push（index.html を直したら毎回）
2. 画面の上に Samurai Motors のロゴ。開いたら名前を選び（前回選んだ名前は端末が覚える）、日付・何に使ったか・金額・分類・支払い方法・スクショ・コメントを入れて「登録する」
3. 経費マスターに次の形で入る

| 列 | 入る値 |
|---|---|
| F 負担先 / J 入力者 | 本人の名前（名簿の A 列） |
| B 分類 | 選んだ分類。**任意**＝選ばなければ「その他」で入れ、I 備考に「分類は未指定（要振替）」 |
| G 支払方法 | 「クレカ（五木田）」のように 方法＋本人。**任意**＝選ばなければ空欄 |
| H レシート | 証憑のリンク（1枚＝ファイル、2枚以上＝その件のフォルダ） |
| I 備考 | 「日本側経費アプリから入力 / コメント」 |
| N 出典 / O 元ID | `日本側経費アプリ` / `JP-yyyyMMdd-HHmmss-xxx` |

- 証憑の保存先: Drive「SamuraiMotors_日本側経費_証憑/yyyy-MM/」（ec20921 のマイドライブ。共有はしない）
- Run Kosal の前払い残金（前払い管理 F2）には関係しない

## メンバーを足す・止める

- 経費 GSS のタブ「スタッフマスター」の「経費アプリ」列（チェック）で決める。今は 鈴木・飯泉・五木田・矢口
  - 2026-11-13 に旧タブ「日本側メンバー」をスタッフマスターへ統合して削除した（Daisuke「重複しているので1つに」）
- 選択肢に出る条件: 有効=TRUE かつ 経費アプリ=TRUE。足す: スタッフマスターに行を足して両方にチェック。止める: 経費アプリのチェックを外す
- 氏名(JP) が経費マスターの負担先にそのまま入る。既存の書き方にそろえる
- 1行目の列名は業務Bot・名鑑の同期が読むので変えない（列名で探しているので、列の並び替えは大丈夫）
- ⚠️ リンクを知っている人は誰でも入力できる（合言葉なしの方式を選んだため）。リンクが外に出たら deploymentId を作り直して URL を変える

## 初回だけ（Daisuke）

GAS エディタで `setupJpExpense` を1回実行して、権限を許可する（スプレッドシートと Drive）。

## 変更・デプロイ

```bash
cd jp-expense
"C:/nodejs-global/clasp.cmd" push --force
"C:/nodejs-global/clasp.cmd" deploy --deploymentId AKfycbxAZuGD3MVOKBoGII1wsxl9kE_QIt8GpMYfvpwrvIu3L5BR8B3KwLPBayANrHMSX58 --description "<変更内容>"
```

push だけでは本番の URL に反映されない。必ず同じ deploymentId で deploy する（URL を変えないため）。
