#!/usr/bin/env python3
"""One-time local helper: consent to Google OAuth and print the token to paste
into the WORKSPACE_MCP_TOKEN_B64 environment variable.

Run this on a machine with a browser. The remote container cannot run it —
there is no browser there to complete the consent screen, which is the whole
reason the token has to be carried in as an environment variable.

Usage:

    export GOOGLE_OAUTH_CLIENT_ID='...'
    export GOOGLE_OAUTH_CLIENT_SECRET='...'
    python3 scripts/setup-google-mcp-token.py

The script starts the MCP server, asks it for a consent URL, waits for you to
approve in the browser, then prints the base64 token. Nothing is written to
the repository.
"""

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time

DEFAULT_EMAIL = "ec20921@gmail.com"
POLL_TIMEOUT_SEC = 300
POLL_INTERVAL_SEC = 2


def fail(msg):
    print(f"\n[NG] {msg}", file=sys.stderr)
    sys.exit(1)


def credentials_path(email):
    base = os.environ.get("WORKSPACE_MCP_CREDENTIALS_DIR") or os.path.expanduser(
        "~/.google_workspace_mcp/credentials"
    )
    # The server stores tokens as quote(email, safe="@._-") + ".json", which for
    # an ordinary address is the address unchanged.
    return os.path.join(os.path.expanduser(base), f"{email}.json")


def rpc(proc, payload):
    proc.stdin.write(json.dumps(payload) + "\n")
    proc.stdin.flush()


def read_result(proc, want_id, timeout=120):
    """Read stdout lines until the response with the requested id shows up."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            return None
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("id") == want_id:
            return msg
    return None


# The server process also serves the OAuth callback, so it must stay alive
# until the token file lands. Keep a module-level reference.
_server_proc = None


def request_consent_url(email):
    """Start the server and ask it for an OAuth consent URL."""
    global _server_proc
    _server_proc = subprocess.Popen(
        ["uvx", "workspace-mcp", "--single-user", "--tools", "sheets", "drive"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    proc = _server_proc

    rpc(proc, {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "setup-google-mcp-token", "version": "1"},
        },
    })
    if read_result(proc, 1) is None:
        fail("MCP サーバの初期化に失敗しました。uvx workspace-mcp が動くか確認してください。")

    rpc(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
    rpc(proc, {
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {
            "name": "start_google_auth",
            "arguments": {"service_name": "sheets", "user_google_email": email},
        },
    })

    resp = read_result(proc, 2)
    if resp is None:
        fail("認証URLの取得に失敗しました。")

    text = json.dumps(resp, ensure_ascii=False)
    urls = re.findall(r"https://accounts\.google\.com/[^\s\"'\\)]+", text)
    return urls[0] if urls else None


def stop_server():
    if _server_proc and _server_proc.poll() is None:
        _server_proc.terminate()
        try:
            _server_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            _server_proc.kill()


def find_client_secret_json():
    """Locate the client secret JSON downloaded from the Cloud console.

    Copying the id and secret by hand is the step people get wrong, so accept
    the file the console hands out instead: an explicit path argument first,
    then the newest client_secret*.json sitting in the usual download folders.
    """
    if len(sys.argv) > 1:
        path = os.path.expanduser(sys.argv[1])
        if not os.path.exists(path):
            fail(f"指定されたファイルが見つかりません: {path}")
        return path

    candidates = []
    for folder in ("~/Downloads", "~/ダウンロード", "."):
        directory = os.path.expanduser(folder)
        if not os.path.isdir(directory):
            continue
        for name in os.listdir(directory):
            if name.startswith("client_secret") and name.endswith(".json"):
                full = os.path.join(directory, name)
                candidates.append((os.path.getmtime(full), full))
    if not candidates:
        return None
    return max(candidates)[1]


def prompt_client_credentials():
    """Ask for the id and secret directly.

    The Cloud console no longer shows or exports an existing client secret —
    it can only be replaced — so there is often no JSON file to read and the
    value has to come from whatever the console displayed once, at creation.
    """
    print("=" * 70)
    print("クライアント情報を入力してください")
    print("=" * 70)
    print("Google Cloud の「クライアント」画面から、2つコピーして貼り付けます。")
    print("（貼り付けたら Enter キーを押してください）\n")

    print("① クライアント ID")
    print("   画面右側「Additional information」の一番上にあります。")
    print("   .apps.googleusercontent.com で終わる長い文字列です。")
    client_id = input("   ここに貼り付け > ").strip()
    if not client_id:
        fail("クライアント ID が入力されませんでした。")
    if not client_id.endswith(".apps.googleusercontent.com"):
        print("   [!] 通常 .apps.googleusercontent.com で終わります。間違っていないか確認してください。")

    print("\n② クライアント シークレット")
    print("   画面右下「クライアント シークレット」の「+ Add secret」を押すと、")
    print("   その場で1回だけ全体が表示されます。それをコピーしてください。")
    print("   （既存の ****aF4A のようなマスク表示は、もう中身を見られません）")
    client_secret = input("   ここに貼り付け > ").strip()
    if not client_secret:
        fail("クライアント シークレットが入力されませんでした。")
    if not client_secret.startswith("GOCSPX-"):
        print("   [!] 通常 GOCSPX- で始まります。間違っていないか確認してください。")

    os.environ["GOOGLE_OAUTH_CLIENT_ID"] = client_id
    os.environ["GOOGLE_OAUTH_CLIENT_SECRET"] = client_secret
    print("\n[i] クライアント情報を受け取りました。\n")


def load_client_credentials():
    """Fill GOOGLE_OAUTH_CLIENT_ID/SECRET from the environment or a JSON file."""
    if os.environ.get("GOOGLE_OAUTH_CLIENT_ID") and os.environ.get(
        "GOOGLE_OAUTH_CLIENT_SECRET"
    ):
        return

    path = find_client_secret_json()
    if not path:
        prompt_client_credentials()
        return

    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"JSON を読めませんでした ({path}): {exc}")

    section = data.get("installed") or data.get("web") or {}
    client_id = section.get("client_id")
    client_secret = section.get("client_secret")
    if not client_id or not client_secret:
        fail(
            f"{path} に client_id / client_secret がありません。\n"
            "  OAuth クライアント ID の JSON をダウンロードしたか確認してください。"
        )

    os.environ["GOOGLE_OAUTH_CLIENT_ID"] = client_id
    os.environ["GOOGLE_OAUTH_CLIENT_SECRET"] = client_secret
    print(f"[i] クライアント情報を読み込みました: {path}")


def main():
    if not shutil.which("uvx"):
        fail("uvx が見つかりません。https://docs.astral.sh/uv/ から uv を入れてください。")

    load_client_credentials()

    email = os.environ.get("USER_GOOGLE_EMAIL") or DEFAULT_EMAIL
    os.environ["USER_GOOGLE_EMAIL"] = email

    token_file = credentials_path(email)
    if os.path.exists(token_file) and os.path.getsize(token_file) > 0:
        print(f"[i] 既存のトークンを使います: {token_file}")
    else:
        print(f"[i] {email} の同意フローを開始します...")
        url = request_consent_url(email)
        print("\n" + "=" * 70)
        if url:
            print("下記URLをブラウザで開き、対象アカウントで同意してください:\n")
            print(f"  {url}\n")
        else:
            print("ブラウザが自動で開いたはずです。開かない場合はサーバのログのURLを使ってください。")
        print(f"同意先アカウント: {email}")
        print("=" * 70 + "\n")

        print(f"[i] トークン待機中 (最大 {POLL_TIMEOUT_SEC // 60} 分)...", flush=True)
        deadline = time.time() + POLL_TIMEOUT_SEC
        while time.time() < deadline:
            if os.path.exists(token_file) and os.path.getsize(token_file) > 0:
                break
            time.sleep(POLL_INTERVAL_SEC)
        else:
            fail(f"時間内にトークンが作成されませんでした: {token_file}")

    with open(token_file, "rb") as fh:
        encoded = base64.b64encode(fh.read()).decode()

    print("\n[OK] 準備できました。\n")
    print("=" * 70)
    print("Claude Code の Environment 設定に、以下4つをそのまま登録してください")
    print("（名前と値をひとつずつコピーして貼るだけです）")
    print("=" * 70)
    for name, value in (
        ("USER_GOOGLE_EMAIL", email),
        ("GOOGLE_OAUTH_CLIENT_ID", os.environ["GOOGLE_OAUTH_CLIENT_ID"]),
        ("GOOGLE_OAUTH_CLIENT_SECRET", os.environ["GOOGLE_OAUTH_CLIENT_SECRET"]),
        ("WORKSPACE_MCP_TOKEN_B64", encoded),
    ):
        print(f"\n■ 名前: {name}\n  値:")
        print(f"{value}")
    print("\n" + "=" * 70)
    print("※ 登録が終わったら、新しいセッションを開くと使えるようになります。")
    print("※ 上の値は他人に見せないでください（チャットに貼るのも不要です）。")


if __name__ == "__main__":
    try:
        main()
    finally:
        stop_server()
