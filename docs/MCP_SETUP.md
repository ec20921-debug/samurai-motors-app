# MCP_SETUP.md — Claude Code から Google スプレッドシートを直接操作する

メインスプシ『📒Samurai Motors 経費・勤務関連』を Claude Code から**読み書き**するための設定手順。

## 背景（なぜこの設定が要るのか）

| 環境 | ローカルMCP設定 | 状態 |
|---|---|---|
| ローカルの Claude Code（デスクトップ/CLI） | 引き継がれる | 従来どおり動く |
| **Claude Code on the web（リモートコンテナ）** | **引き継がれない** | この設定が必要 |

リモートセッションはリポジトリを clone しただけの使い捨てコンテナで起動するため、ローカルに入れた MCP サーバ設定は届かない。届くのは claude.ai 側のコネクタだけで、Google Drive コネクタには**セル書き込みツールが無い**（`create_file` / `read_file_content` / `search_files` など読み取り系のみ）。

そこでリポジトリに `.mcp.json` を置き、`workspace-mcp`（[taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp)）をリモートでも起動させる。CLAUDE.md にある `user_google_email` パラメータはこのサーバの作法。

## 構成ファイル

| ファイル | 役割 |
|---|---|
| `.mcp.json` | MCP サーバ定義（**秘密情報なし**・コミット対象） |
| `scripts/google-workspace-mcp.sh` | 起動ラッパー。環境変数からトークンを復元してサーバを exec |
| 環境変数 | 秘密情報の実体。**リポジトリには置かない** |

## 環境変数（Claude Code の Environment 設定に登録）

| 変数 | 値 | 備考 |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth クライアントID | GCP で「デスクトップアプリ」種別で発行 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth クライアントシークレット | 同上 |
| `USER_GOOGLE_EMAIL` | `ec20921@gmail.com` | スプシの所有アカウント |
| `WORKSPACE_MCP_TOKEN_B64` | 同意済みトークンの base64 | 下記手順で1回だけ取得 |

> ⚠️ サービスアカウント方式（`GOOGLE_SERVICE_ACCOUNT_KEY_JSON`）は**使えない**。このサーバのサービスアカウント対応はドメイン全体の委任（domain-wide delegation）専用で、`subject=` によるユーザー偽装を必須とする。`ec20921@gmail.com` は Workspace ドメインではなく通常の Gmail アカウントのため委任を設定できない。したがって OAuth ユーザー認証一択。

## セットアップ手順

### 1. GCP で OAuth クライアントを発行（初回のみ）

1. GCP コンソール → APIs & Services → **Google Sheets API** と **Google Drive API** を有効化
2. OAuth 同意画面を作成（External / テストユーザーに `ec20921@gmail.com` を追加）
3. 認証情報 → OAuth クライアント ID → 種別「**デスクトップアプリ**」で作成
4. クライアント ID とシークレットを控える

> **リダイレクトURI**: 認証は `http://localhost:8000/oauth2callback` に返ってくる。
> 「デスクトップアプリ」種別ならループバックは自動的に許可されるので登録不要。
> 誤って「ウェブアプリケーション」種別で作った場合は、このURLを承認済みリダイレクトURIに明示登録すること（しないと `redirect_uri_mismatch` になる）。

要求されるスコープは `spreadsheets` / `drive` / `userinfo.email` / `userinfo.profile` / `openid` とその readonly 版。

### 2. ブラウザのあるマシンで1回だけ同意する

まず GCP の認証情報画面でクライアントの **「JSON をダウンロード」** を押す。
ID とシークレットを手で書き写す必要はない。

ローカル（デスクトップ/CLI の Claude Code が動く環境）で、リポジトリのルートから：

```bash
python3 scripts/setup-google-mcp-token.py
```

`~/Downloads` にある最新の `client_secret*.json` を自動で拾う。
別の場所に置いた場合はパスを渡す：

```bash
python3 scripts/setup-google-mcp-token.py ~/場所/client_secret_xxx.json
```

このスクリプトが クライアント情報の読み込み → 同意URLの発行 → トークン待機 →
base64 化までまとめて行い、Environment 設定に貼る4項目をそのまま出力する。
表示されたURLをブラウザで開き、`ec20921@gmail.com` で同意すれば完了。

環境変数 `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` が既に export
されている場合はそちらが優先され、JSON は探しに行かない。

トークンの実体はローカルの下記に保存される（リポジトリには書かれない）：

```
~/.google_workspace_mcp/credentials/ec20921@gmail.com.json
```

<details>
<summary>スクリプトを使わず手作業でやる場合</summary>

```bash
export USER_GOOGLE_EMAIL='ec20921@gmail.com'
uvx workspace-mcp --single-user --tools sheets drive
# 別ターミナルでツールを1回呼ぶと同意URLが出る。同意後:
base64 -w0 ~/.google_workspace_mcp/credentials/ec20921@gmail.com.json
```

macOS の `base64` には `-w0` が無いので `base64 -i <ファイル>` を使う。

</details>

### 3. 出力された4つの環境変数を登録する

スクリプトの出力どおり、`USER_GOOGLE_EMAIL` / `GOOGLE_OAUTH_CLIENT_ID` /
`GOOGLE_OAUTH_CLIENT_SECRET` / `WORKSPACE_MCP_TOKEN_B64` を
Claude Code の Environment 設定に登録する。

### 4. リモートセッションを開き直す

`.mcp.json` は**セッション開始時に読まれる**ため、設定後は新しいセッションを立ち上げること。`scripts/google-workspace-mcp.sh` が起動時にトークンファイルを復元し、以後 `modify_sheet_values` などが使えるようになる。

## 動作確認

新しいセッションで:

```
経費マスターの最終行を読んで
```

読めれば認証は通っている。書き込みは `modify_sheet_values`（`user_google_email` に `ec20921@gmail.com` を必ず指定）。

## セキュリティ上の注意

- `WORKSPACE_MCP_TOKEN_B64` は **リフレッシュトークンそのもの**。Gmail 等を含まない最小スコープ（`--tools sheets drive`）で発行しているが、漏れれば当該アカウントのシート・ドライブを操作できる。リポジトリ・コミットメッセージ・PR 本文には絶対に貼らない
- トークンを失効させたい場合は [Google アカウントのサードパーティ接続](https://myaccount.google.com/connections) から該当アプリのアクセスを削除する
- `.gitignore` は `.env` 系と鍵ファイルを既に除外済み。認証情報はコンテナ内の `~/.google_workspace_mcp/` にのみ展開され、リポジトリには書かれない

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| ツールが一覧に出ない | `.mcp.json` はセッション開始時読み込み。セッションを開き直す |
| `No credentials found for user` | `WORKSPACE_MCP_TOKEN_B64` 未設定、または `USER_GOOGLE_EMAIL` がトークンのアカウントと不一致 |
| `invalid_grant` | リフレッシュトークン失効（同意画面が「テスト」段階だと7日で切れる）。同意画面を「本番」に昇格させ、手順2からやり直す |
| スコープ不足エラー | `--tools` を広げた場合は再同意が必要。手順2をやり直してトークンを取り直す |

## 関連

- `docs/DEPLOY.md` — clasp デプロイ手順
- CLAUDE.md 「📊 メインスプシ」節 — スプシ ID とタブ構成
