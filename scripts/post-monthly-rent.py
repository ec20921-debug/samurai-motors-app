#!/usr/bin/env python3
"""Post the monthly office rent (RT-002) to the 経費マスター sheet.

Rent is a manual routine expense (RT-002 is 🖐手動 in ルーティン経費), so it
never goes through the Bot flow. This script writes the row the same way the
June/July entries were written by hand, using the Google OAuth token that the
workspace-mcp setup left on this machine:

    ~/.google_workspace_mcp/credentials/ec20921@gmail.com.json

No MCP server, no environment variables and no pip installs are required —
only the Python standard library. Safe to re-run: if the month's rent is
already posted (matched by 元ID or by an identical 摘要), it exits without
writing.

Usage (defaults are for 2026-08):

    python scripts/post-monthly-rent.py
    python scripts/post-monthly-rent.py --dry-run
    python scripts/post-monthly-rent.py --month 2026-09 --trx <TrxID> --ref <Ref#>
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

SPREADSHEET_ID_DEFAULT = "1-5rMJW21t4PnpXnDAYdrNXzz672kL2cd4mOSti3Yfc0"
SHEET_NAME = "経費マスター"
USER_EMAIL_DEFAULT = "ec20921@gmail.com"
DATA_START_ROW = 4  # rows 1-3 are title/header
NUM_COLS = 17       # A..Q

# Column indexes within an A..Q row (0-based)
COL_DESC = 2   # C: 項目・摘要
COL_ID = 12    # M: ID
COL_OID = 14   # O: 元ID


def fail(msg):
    print(f"[NG] {msg}", file=sys.stderr)
    sys.exit(1)


def http(method, url, headers=None, body=None):
    """Single HTTP entry point (also the seam the test harness replaces)."""
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode()[:500]
        except Exception:
            pass
        fail(f"{method} {url.split('?')[0]} -> HTTP {e.code}\n{detail}")


def load_token(credentials_path):
    if not os.path.exists(credentials_path):
        fail(
            f"トークンファイルが見つかりません: {credentials_path}\n"
            "  先に scripts/setup-google-mcp-token.py を実行してください。"
        )
    with open(credentials_path, encoding="utf-8") as fh:
        return json.load(fh)


def get_access_token(tok):
    """Exchange the stored refresh token for a fresh access token."""
    for key in ("refresh_token", "client_id", "client_secret"):
        if not tok.get(key):
            fail(f"トークンファイルに {key} がありません。同意フローをやり直してください。")
    body = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": tok["refresh_token"],
        "client_id": tok["client_id"],
        "client_secret": tok["client_secret"],
    }).encode()
    resp = http(
        "POST",
        tok.get("token_uri") or "https://oauth2.googleapis.com/token",
        {"Content-Type": "application/x-www-form-urlencoded"},
        body,
    )
    token = resp.get("access_token")
    if not token:
        fail(f"アクセストークンを取得できませんでした: {resp}")
    return token


def values_url(sid, rng, **params):
    base = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{sid}"
        f"/values/{urllib.parse.quote(rng, safe='')}"
    )
    return base + ("?" + urllib.parse.urlencode(params) if params else "")


def read_rows(sid, headers):
    rng = f"{SHEET_NAME}!A{DATA_START_ROW}:Q"
    resp = http("GET", values_url(sid, rng, majorDimension="ROWS"), headers)
    return resp.get("values", [])


def build_row(r, month, amount, trx, ref, new_id):
    month_num = int(month[5:7])
    k = (
        f'=IF(P{r}<>"○",0,IF(Q{r}<>"●",0,'
        f'IF(E{r}="USD",D{r}*設定!$B$4,'
        f'IF(E{r}="KHR",D{r}*設定!$B$5,'
        f'IF(E{r}="JPY",D{r},0)))))'
    )
    return [
        f"{month}-01",                                   # A 日付（月初計上・6/7月と同じ）
        "賃貸・水道光熱",                                 # B カテゴリ
        f"事務所家賃（{month_num}月分）SOUNG SOPHEAKDEY",  # C 項目・摘要
        str(amount),                                     # D 金額
        "USD",                                           # E 通貨
        "飯泉",                                          # F 負担先
        "ABA直接決済",                                    # G 支払方法
        "",                                              # H レシート（6/7月と同様なし）
        f"ルーティン RT-002 / 大家へ直接 / Trx.ID:{trx} / Ref:{ref}",  # I 備考
        "鈴木",                                          # J 入力者
        k,                                               # K JPY換算
        f'=IFERROR(TEXT(A{r},"yyyy-mm"),"")',            # L 月
        new_id,                                          # M ID
        "サムライモーターズ_手動追加",                     # N 出典
        f"RT-002-{month[5:7]}",                           # O 元ID（6/7月と同形式）
        "○",                                             # P 集計対象
        "●",                                             # Q 経費計上
    ]


def copy_format_from_previous_row(sid, headers, row):
    """Match the look of the rest of the table; failures are cosmetic only."""
    try:
        meta = http(
            "GET",
            f"https://sheets.googleapis.com/v4/spreadsheets/{sid}"
            "?fields=sheets(properties(sheetId,title))",
            headers,
        )
        sheet_id = None
        for s in meta.get("sheets", []):
            if s["properties"]["title"] == SHEET_NAME:
                sheet_id = s["properties"]["sheetId"]
        if sheet_id is None:
            raise RuntimeError("sheetId not found")
        http(
            "POST",
            f"https://sheets.googleapis.com/v4/spreadsheets/{sid}:batchUpdate",
            {**headers, "Content-Type": "application/json"},
            {"requests": [
                {"copyPaste": {
                    "source": {"sheetId": sheet_id, "startRowIndex": row - 2,
                               "endRowIndex": row - 1,
                               "startColumnIndex": 0, "endColumnIndex": NUM_COLS},
                    "destination": {"sheetId": sheet_id, "startRowIndex": row - 1,
                                    "endRowIndex": row,
                                    "startColumnIndex": 0, "endColumnIndex": NUM_COLS},
                    "pasteType": "PASTE_FORMAT",
                }},
                {"updateDimensionProperties": {
                    "range": {"sheetId": sheet_id, "dimension": "ROWS",
                              "startIndex": row - 1, "endIndex": row},
                    "properties": {"pixelSize": 36},
                    "fields": "pixelSize",
                }},
            ]},
        )
    except SystemExit:
        raise
    except Exception as e:
        print(f"[!] 書式コピーは失敗しましたが値は入っています: {e}")


def main():
    # Windows console (cp932) must not crash on Japanese output
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

    ap = argparse.ArgumentParser(description="家賃(RT-002)を経費マスターへ計上")
    ap.add_argument("--month", default="2026-08", help="対象月 yyyy-MM")
    ap.add_argument("--amount", default="750", help="金額 USD")
    ap.add_argument("--trx", default="58561639111", help="ABA Trx. ID")
    ap.add_argument("--ref", default="100FT38509782652", help="ABA Reference #")
    ap.add_argument("--spreadsheet", default=SPREADSHEET_ID_DEFAULT)
    ap.add_argument("--email", default=USER_EMAIL_DEFAULT)
    ap.add_argument("--credentials", default=None,
                    help="トークンファイルのパス（既定: ~/.google_workspace_mcp/credentials/<email>.json）")
    ap.add_argument("--dry-run", action="store_true", help="書き込まず内容だけ表示")
    args = ap.parse_args()

    if len(args.month) != 7 or args.month[4] != "-":
        fail(f"--month は yyyy-MM 形式で指定してください: {args.month}")

    creds_dir = os.environ.get("WORKSPACE_MCP_CREDENTIALS_DIR") or os.path.join(
        os.path.expanduser("~"), ".google_workspace_mcp", "credentials")
    credentials_path = args.credentials or os.path.join(creds_dir, f"{args.email}.json")

    tok = load_token(credentials_path)
    headers = {"Authorization": f"Bearer {get_access_token(tok)}"}
    sid = args.spreadsheet

    rows = read_rows(sid, headers)
    if not rows:
        fail("経費マスターのデータを読めませんでした（0行）。")

    # ── 冪等チェック：元ID（手動形式・自動形式の両方）と摘要の一致 ──
    oid_manual = f"RT-002-{args.month[5:7]}"
    oid_auto = f"RT-002-{args.month}"
    desc = f"事務所家賃（{int(args.month[5:7])}月分）SOUNG SOPHEAKDEY"
    for i, row in enumerate(rows):
        oid = str(row[COL_OID]).strip() if len(row) > COL_OID else ""
        rdesc = str(row[COL_DESC]).strip() if len(row) > COL_DESC else ""
        if oid in (oid_manual, oid_auto) or rdesc == desc:
            print(f"[OK] {args.month} の家賃は既に計上済みです"
                  f"（行 {DATA_START_ROW + i} / 元ID: {oid or 'なし'}）。何もしません。")
            return

    # ── 追記位置と連番ID ──
    last_row = DATA_START_ROW + len(rows) - 1
    new_row = last_row + 1
    max_id = 0
    for row in rows:
        if len(row) > COL_ID:
            try:
                max_id = max(max_id, int(float(str(row[COL_ID]))))
            except (ValueError, TypeError):
                pass
    new_id = max_id + 1

    values = build_row(new_row, args.month, args.amount, args.trx, args.ref, new_id)

    print(f"[i] 追記先: {SHEET_NAME} 行{new_row} / ID={new_id} / 元ID={values[COL_OID]}")
    for label, v in zip("ABCDEFGHIJKLMNOPQ", values):
        if v != "":
            print(f"    {label}: {v}")
    if args.dry_run:
        print("[i] --dry-run のため書き込みは行いません。")
        return

    rng = f"{SHEET_NAME}!A{new_row}:Q{new_row}"
    http(
        "PUT",
        values_url(sid, rng, valueInputOption="USER_ENTERED"),
        {**headers, "Content-Type": "application/json"},
        {"range": rng, "majorDimension": "ROWS", "values": [values]},
    )
    copy_format_from_previous_row(sid, headers, new_row)

    # ── 書けたか読み戻して確認 ──
    verify = http("GET", values_url(sid, rng), headers).get("values", [[]])[0]
    print("[OK] 書き込み完了。読み戻し確認:")
    print("    " + " | ".join(str(v) for v in verify))
    print(f"[i] {args.month} 分 家賃 USD {args.amount} を経費マスター 行{new_row} に計上しました。")


if __name__ == "__main__":
    main()
