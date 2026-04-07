# GitHub ワークフローガイド（Samurai Motors）

## このレポートの目的
どのPCからでも最新のコードにアクセスし、作業できる環境を整えるためのガイドです。

---

## 全体像

```
┌─────────┐      git push      ┌──────────┐      git pull      ┌─────────┐
│  PC-A   │  ───────────────►  │  GitHub  │  ───────────────►  │  PC-B   │
│ (自宅)  │  ◄───────────────  │ (クラウド) │  ◄───────────────  │ (外出先) │
└─────────┘      git pull      └──────────┘      git push      └─────────┘
```

**リポジトリURL:** https://github.com/ec20921-debug/samurai-motors-app.git

---

## 別のPCでのセットアップ（初回のみ）

### 1. Gitをインストール
- https://git-scm.com からダウンロード・インストール

### 2. GitHubにログイン
```bash
git config --global user.name "あなたの名前"
git config --global user.email "あなたのメール"
```

### 3. コードを取得
```bash
git clone https://github.com/ec20921-debug/samurai-motors-app.git
```
これで `samurai-motors-app` フォルダが作成され、全ファイルがダウンロードされます。

---

## 日常の作業フロー

### 作業開始時（最新を取得）
```bash
cd samurai-motors-app
git pull
```

### 作業完了時（変更をアップロード）
```bash
git add .
git commit -m "変更内容をここに書く"
git push
```

### よく使うコマンド一覧

| コマンド | 意味 |
|---------|------|
| `git pull` | 最新のコードを取得 |
| `git status` | 変更されたファイルを確認 |
| `git add .` | 全変更をステージング |
| `git commit -m "メッセージ"` | 変更を記録 |
| `git push` | GitHubにアップロード |
| `git log --oneline -5` | 最近の変更履歴を確認 |

---

## Google Apps Script（GAS）との関係

### 現状の構成

```
GitHub（バックアップ・バージョン管理）        Google側（実際に動いている場所）
─────────────────────────────────────        ────────────────────────────
SamuraiMotors_AppsScript_v4.js     ◄──────►  Apps Script エディタ
SamuraiMotors_AppsScript_v4.txt               （スプレッドシートに紐づき）
```

### 重要なポイント

| 項目 | 説明 |
|------|------|
| **実行される場所** | Google Apps Script エディタ上（Googleのサーバー） |
| **GitHubの役割** | コードのバックアップ・変更履歴の管理 |
| **編集の流れ** | GitHub側で編集 → Apps Scriptエディタにコピペで反映 |

### GASのコード更新手順

1. **GitHub上の `.js` ファイル**を編集（Claude Codeで作業）
2. 編集後、`git push` でGitHubにアップロード
3. **Apps Scriptエディタ**を開く（スプレッドシート → 拡張機能 → Apps Script）
4. GitHub側の最新コードを**コピー＆ペースト**で反映
5. Apps Scriptエディタで**保存**（Ctrl+S）

### なぜ直接同期しないのか？
- GASはGoogle独自の実行環境で動くため、GitHubから自動デプロイはできない
- ただし、**コードの正本（マスター）をGitHubに置く**ことで：
  - 変更履歴が残る
  - 間違えても過去のバージョンに戻せる
  - どのPCからでも最新コードを確認できる

---

## まとめ：何をどこで管理するか

| 管理対象 | 保存場所 | 備考 |
|---------|---------|------|
| Apps Scriptコード | GitHub + GASエディタ | GitHubが正本、GASにコピペで反映 |
| マニュアル（docs/） | GitHub | どのPCからでも閲覧可能 |
| ロゴ・画像 | GitHub | バージョン管理される |
| スプレッドシートデータ | Google Sheets | GASから操作される実データ |
| Telegram Bot設定 | GASエディタ内のプロパティ | トークン等の機密情報はGitHubに置かない |

---

*最終更新: 2026年4月7日*
