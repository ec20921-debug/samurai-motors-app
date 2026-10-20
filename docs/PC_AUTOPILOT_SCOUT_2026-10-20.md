# PC 自動作業の指示書 — SAMURAI SCOUT 2回目の反映（2026-10-20）

> Daisuke「やることあったら拡張機能とかもつかってすべて自動でできるように指示して」。
> PC の Claude Code がこのファイルを上から順に実行する。シェルの作業は Claude Code 本体で、
> ブラウザの作業（GAS エディタ・スプレッドシート・Drive・claude.ai）は Chrome 拡張 **Claude in Chrome** で行う。
> 経緯と中身: `docs/HANDOFF_SalesVisitSupport_2026-10-20.md`

## 守ること（止まって Daisuke に聞く場面）

- Google のログイン・パスワード・2段階認証・「このアプリは確認されていません」等の画面が出たら **止まって Daisuke に操作を頼む**（代わりに入力しない）
- GAS の権限確認（「権限を確認」→ アカウント ec20921@gmail.com → 「許可」）は、Daisuke が見ている前提で進めてよい。見慣れない権限（Gmail の送信など）が並んでいたら止まって聞く
- 人へのファイル共有・メッセージ送信は **しない**（共有先のメールアドレスが分からない時は聞く）。スタッフ専用リンクは鍵入りなので、ファイルや Vault・git に書かず、最後の報告で Daisuke にだけ見せる
- 削除しない。指定以外のデプロイ・シート・タブは触らない。`git push --force` しない。本体フォルダにある未コミットの `admin-console.html` には触れない
- 途中で失敗したら、そこで止めて「どこまで済んだか・何が出たか」を報告する（推測で先に進まない）

## A. シェル（Claude Code）

1. 本体フォルダを最新にして取り込む
   ```bash
   cd "C:/Users/drymp/dev/samurai-motors-app"
   git status                      # admin-console.html 以外に未コミットが無いか確認
   git checkout main && git pull
   git fetch origin claude/picasso-campaign-response-9jlthu
   git merge origin/claude/picasso-campaign-response-9jlthu   # 衝突したら止めて報告
   git push
   ```
2. GAS（v7-operations）を反映
   ```bash
   cd "C:/Users/drymp/dev/samurai-motors-app/v7-operations"
   "C:/nodejs-global/clasp.cmd" push --force
   "C:/nodejs-global/clasp.cmd" deployments        # 「営業ミニアプリ」の本番（今朝 @41 にした ID）。@35 は検証用なので触らない
   "C:/nodejs-global/clasp.cmd" deploy --deploymentId <本番ID> --description "SCOUT 作り直し・こまめ保存・営業ボード・ホーム画面アプリ"
   ```
   本番の /exec URL（`https://script.google.com/macros/s/<本番ID>/exec`）を控える（C-1 で使う）
3. 反映確認（DEPLOY.md のやり方・`-X POST` を付けない）: `saleslog_update` を chatId なしで送って `MISSING_PARAMS`（`UNKNOWN_ACTION` でない）こと。存在しない action では `UNKNOWN_ACTION` が返ること
4. ミニアプリ同期（DEPLOY.md の「ミニアプリ同期」。リストに `scout.webmanifest`・`scout-icon-192.png`・`scout-icon-512.png`・`scout-apple-touch-icon.png` が入っている）→ push → 1〜2分後に確認:
   - `https://ec20921-debug.github.io/samurai-motors-miniapp/saleslog-internal.html` に `scout.webmanifest` の文字がある
   - `.../scout-icon-192.png` と `.../scout.webmanifest` が 200

## B. ブラウザ（Claude in Chrome）— GAS エディタ（script.google.com・アカウント ec20921@gmail.com・プロジェクト v7-operations）

1. ⚙️「プロジェクトの設定」→「スクリプト プロパティ」に追加（既にあれば値を確認するだけ）
   - `PROSPECT_LIST_SPREADSHEET_ID` = `1hdqIFXA9JFN-UN5P72nlIxrablEtQpi7xBHUan6ReQA`
   - `SCOUT_GAS_URL` = A-2 で控えた本番の /exec URL
2. エディタで関数を選んで ▶ 実行 → 実行ログを読む
   1. `debugSalesHearingPrices` → 料金5件（HEADLIGHT 15 / HEADLIGHT_MAGIC 30 / GLASS_3 15・20 / GLASS_ALL 30・40 / WASH 12・15）が出ること
   2. `prospectImportPreview` → v7 Database（`https://docs.google.com/spreadsheets/d/1Fa-bmpObZ9ZdvtaRIZVzsH2yYDw1ZgBnAkGWmY3b5XI`）の「見込み取込_確認」タブを開き、判定が「要確認」の行だけ、判定の列を書き換える:
      - RTN Auto Garage（クメール名つき）↔ RTN Auto Garage → **重複**
      - それ以外（S-Auto Global ↔ S Auto、LD9 Auto Car ↔ 3IN1-Auto など）→ **重複**（あとから店は足せるが、二重のピンは消すのが手間なので安全側）
      - このタブの判定の列以外・ほかのタブは触らない
   3. `prospectImportRun` → ログの追加件数（2026-10-19 時点の試算で約107）を控える
   4. `scoutBoardSetup` → 初回は権限確認（上の「守ること」）。ログに出た **営業ボードの URL** を控える
   5. `scoutHomeLinks` → ログに出た **Run Kosal のホーム画面用リンク** を控える（ファイルに書かない）

## C. ブラウザ — claude.ai

1. `https://claude.ai/code` の「スケジュール（定時タスク）」→「営業ミニアプリ 自己改善（3日ごと）」→ 編集 → コネクタで **Google Drive をオン** → 保存
   （画面の名前が違って見つからない時は、スクショを撮って Daisuke に報告。Google Drive が一覧に無い時は `https://claude.ai/customize/connectors` で接続が要る → Daisuke に頼む）

## D. 最後の報告（日本語・短く）

- 済んだこと（A-1〜C-1 それぞれ ✅ / ⚠️）・本番のデプロイ番号（@いくつ）・取込の追加件数
- 営業ボードの URL（共有はまだ。Daisuke が Run Kosal に「閲覧者」で共有する。メールアドレスを教えてもらえれば代わりに共有画面まで進める）
- Run Kosal のホーム画面用リンク（**Daisuke にだけ**表示。送るのは Daisuke 本人。Run Kosal は Safari で開く →「ホーム画面に追加」）
- 止まった所があれば、その画面の状態
