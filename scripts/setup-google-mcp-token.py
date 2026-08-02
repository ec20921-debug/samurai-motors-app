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


def main():
    if not shutil.which("uvx"):
        fail("uvx が見つかりません。https://docs.astral.sh/uv/ から uv を入れてください。")

    for var in ("GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"):
        if not os.environ.get(var):
            fail(f"{var} が未設定です。export してから再実行してください。")

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

    print("\n[OK] トークンを取得しました。\n")
    print("Claude Code の Environment 設定に以下4つを登録してください:\n")
    print(f"  USER_GOOGLE_EMAIL          = {email}")
    print("  GOOGLE_OAUTH_CLIENT_ID     = (発行したクライアントID)")
    print("  GOOGLE_OAUTH_CLIENT_SECRET = (発行したシークレット)")
    print("  WORKSPACE_MCP_TOKEN_B64    = 下記の1行\n")
    print("-" * 70)
    print(encoded)
    print("-" * 70)
    print("\n※ この文字列はリフレッシュトークンそのものです。")
    print("  リポジトリ・コミット・PR・チャットには貼らないでください。")
    print("※ 登録後、新しいリモートセッションを開くと有効になります。")


if __name__ == "__main__":
    try:
        main()
    finally:
        stop_server()
