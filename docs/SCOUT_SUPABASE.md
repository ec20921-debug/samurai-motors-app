# SAMURAI SCOUT を Supabase の写しで速くする（2026-11-07）

Daisuke「読み込み遅いから supabase に移行できないかな？無料でできれば」→ 案 B（SCOUT だけ・無料の Supabase）。

## しくみ（ひとことで）

- **台帳は今までどおりシート（v7 Database）の1つだけ。** 予約Bot・営業ボード・グループ通知は何も変わらない
- GAS がシートの中身を Supabase に **写す**。SCOUT はまず写しを読む（速い）。読めない時は今までどおり GAS から読む
- 写すタイミング: お店の一覧 = 10分ごと＋GAS で一覧を作った時（SCOUT は書いたあと GAS から読み直す）／店の詳細 = GAS で詳細を作った時。書き込みの直後は、その店の詳細の写しを**消すだけ**（重い作り直しはしない。次に開くと GAS から読み、また写る）
- 10分ごとの書き込みが Supabase の「利用」になるので、無料版の「7日使わないと止まる」にかからない
- 守り方: 写しの表は公開の鍵では読めない（RLS）。SCOUT は関数 `scout_read` だけを呼べて、GAS がスタッフを確かめて渡した **通行証（7日）** が無いと何も返さない。通行証は1人6時間に6回まで。スタッフマスターから外した人の通行証は6時間以内に自動で消える

| 場所 | ファイル |
|---|---|
| Supabase（表・関数） | `supabase/scout.sql` |
| GAS（写す・通行証） | `v7-operations/ScoutSupabase.gs`、`Router.gs`（`scout_token` と書き込み後のフック）、`SalesLogManager.gs`（`salesLogShopsData_`） |
| SCOUT（読む） | `saleslog-internal.html`（`sbRead` / `sbRefreshToken` / `loadShops` / `openShop`） |
| テスト | `tests/v7ops_scout_supabase.test.js` |

## 入れる手順

順番が大事です。**画面（SCOUT）は先に公開してあっても害はありません**（GAS 側が未設定のうちは今までどおり GAS から読む）。

### 1. Supabase のプロジェクトを作る（Daisuke・5分・無料）
1. https://supabase.com に Google アカウントで登録
2. New project → 名前 `samurai-scout`／Region **Southeast Asia (Singapore)**／プラン Free／DB パスワードは自動生成のままでよい（保管は 1Password）
3. 左の **SQL Editor** → `supabase/scout.sql` の中身を全部貼る → **Run**（「Success」なら OK）

### 2. 鍵を GAS に入れる（Daisuke・PC）
Supabase の **Project Settings → API Keys** から3つを、v7-operations の GAS エディタ → プロジェクトの設定 → **スクリプト プロパティ** に入れる（チャット・メール・シートには貼らない）。

| プロパティ | 値 |
|---|---|
| `SUPABASE_URL` | `https://〇〇.supabase.co`（Project Settings → Data API の URL） |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…`（無い画面なら Legacy の `anon`） |
| `SUPABASE_SECRET_KEY` | `sb_secret_…`（無い画面なら Legacy の `service_role`）。**外に出さない** |

### 3. GAS を反映する（PC）
1. `v7-operations/` で `clasp push --force`（docs/DEPLOY.md）→ ウェブアプリの版を新しくする
2. GAS エディタで **`scoutSbInstallTrigger`** を1回実行（10分ごとのトリガーを作り、1回写す）
3. **`scoutSbStatus`** を実行 →「✅ お店の一覧を写す: 成功 / 10分ごとのトリガー: 1個」
4. Supabase の Table Editor → `scout_cache` に `shops` の行があることを確認
5. 「システム変更」タブに1行

### 4. スマホで確認
- SCOUT を開く（1回目は今までどおり。裏で通行証をもらう）→ 閉じてもう一度開く → 一覧がすぐ出る
- Supabase の `scout_tokens` に1行増えている
- お店を開く → 2回目からは詳細もすぐ出る

## 戻し方
- **すぐ止める**: GAS のスクリプト プロパティ `SUPABASE_SECRET_KEY` を消す → 通行証が出なくなり、写しも止まる。SCOUT は今までどおり GAS から読む（スマホに残った通行証は最長7日有効だが、写しが更新されなくなるので、止めた時は Supabase の SQL Editor で `delete from scout_tokens;` も実行）
- トリガーは GAS エディタのトリガー画面で `scoutSbSync` を削除

## 気をつけること
- 写しは最大10分遅れることがある（シートを手で直した分）。SCOUT から書いた分はすぐ届く
- 店の詳細は、写しを出したあと GAS の最新で上書きする（間違った古い情報が残り続けることはない）
- コミッション（お店の画面の下の欄）は今までどおり GAS から読む（写していない）
- 無料版の上限: DB 500MB（写しは 1MB 未満の見込み）。プロジェクトは2つまで
- **写すもの**: お店の一覧（店名・業種・状態・位置・電話・オーナー名・前回のメモ・次にやること）と、開いたことのある店の詳細（訪問の履歴・メモ・過去の計算・QR の状態）。**訪問の位置（緯度経度）は写さない**（あり/なしだけ）。置き場所はシンガポールの Supabase。Supabase のアカウントは Daisuke 本人だけが持つ
- スマホをなくした・人を外した時にすぐ止めたい時: GAS エディタで `scoutSbRevoke('<その人の chat_id>')` を実行
