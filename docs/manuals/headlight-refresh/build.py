# -*- coding: utf-8 -*-
"""
ビルドスクリプト — index.html（assets 参照版）から、画像を Base64 で
すべて埋め込んだ「単一ファイル版」を生成する。
編集は index.html 側で行い、その後このスクリプトを実行して配布用ファイルを更新する。

    python build.py
"""
import base64, re, pathlib

BASE = pathlib.Path(__file__).parent
SRC = BASE / "index.html"
OUT = BASE / "SAMURAI_Headlight_Manual.html"   # 配布・共有用の単一ファイル
MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}

def inline(match):
    rel = match.group(1)                       # 例: ./assets/logo_full.jpg
    path = BASE / rel.lstrip("./")
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    mime = MIME[path.suffix.lower()]
    return f'src="data:{mime};base64,{b64}"'

html = SRC.read_text(encoding="utf-8")
html, n = re.subn(r'src="(\./assets/[^"]+)"', inline, html)
OUT.write_text(html, encoding="utf-8")

size_mb = round(len(html.encode("utf-8")) / 1_000_000, 2)
print(f"画像 {n} 枚を埋め込み → {OUT.name}（{size_mb} MB）")
