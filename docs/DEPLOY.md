# DEPLOY.md — GAS デプロイ運用（clasp）

> CLAUDE.md から移設（2026-07-03 コンテキストダイエット）。デプロイの正式手順書。

## 前提

- 2026-04-23 から **clasp（Google 公式 CLI）** で v7 / v7-operations を自動デプロイ。**手動コピペは廃止**
- `clasp` v3.3.0 が `C:\nodejs-global\clasp.cmd` にインストール済み
- ログイン済みアカウント: `ec20921@gmail.com`（GAS 開発系の所有者。Apps Script API 有効化済み）
- 作業ディレクトリは本リポジトリ（`C:\Users\drymp\dev\samurai-motors-app\`）が**唯一の作業場所**
- `C:\Users\drymp\OneDrive\Desktop\samurai-motors-app\` は**旧スナップショット**（保険。編集禁止）

## push コマンド

```bash
# v7（顧客系）を反映
cd "C:/Users/drymp/dev/samurai-motors-app/v7"
"C:/nodejs-global/clasp.cmd" push --force

# v7-operations（社内業務系）を反映
cd "C:/Users/drymp/dev/samurai-motors-app/v7-operations"
"C:/nodejs-global/clasp.cmd" push --force
```

- `--force` は manifest 変更時のプロンプトをスキップする用。通常運用で常用してよい
- コード変更後は必ず `git add` → `git commit` → `git push`（GitHub バックアップ）

## .claspignore ポリシー

- v7 の `Setup.gs` / `SetupProperties.gs` / `GetGroupId.gs` / `WebhookSetup.gs` は **`.claspignore` で除外**（リモート GAS に残さない。肥大化防止）
- v7-operations の `Setup.gs` は本番ファイル扱い（毎回 push される）
- `.txt` ペアファイルは廃止（`.claspignore` でも除外、ローカルにも置かない）
- ⚠️ **既知の除外漏れ（2026-07-03 検出・未対応）**: `Setup_CampaignBooking.gs` / `Setup_MenuV2.gs` / `Setup_MenuV3.gs` / `Migration_ServiceType.gs` が push 対象に残っている。整理する場合は .claspignore 追記＋リモート GAS 側からの削除をセットで行うこと

## 万一壊れた場合の戻し方

1. `git log` で commit 履歴から復元（第一選択）
2. `clasp clone <scriptId>` でリモート GAS から再取得
3. `C:\Users\drymp\OneDrive\Desktop\samurai-motors-app\`（旧スナップショット）は最後の保険

## Script Properties（トークン等の実体）

- Bot トークンは GAS の **スクリプト プロパティ** で管理: `BOT_TOKEN_BOOKING` / `BOT_TOKEN_FIELD` / `BOT_TOKEN_INTERNAL`
- コード・リポジトリにトークンを書かない（2026-07-03 インシデント教訓。settings.local.json は gitignore 済み）
- ローテーション手順: BotFather で Revoke → 新トークンをスクリプト プロパティに設定（Webhook は再設定不要）
