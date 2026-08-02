#!/usr/bin/env bash
#
# Launch the Google Workspace MCP server (Sheets + Drive) for Claude Code.
#
# Why this wrapper exists
# -----------------------
# Claude Code on the web runs in an ephemeral container: local MCP settings from
# the desktop/CLI are not carried over, and there is no browser to complete the
# Google OAuth consent flow. This script re-creates the server's credential
# directory from an environment variable so a headless session can reuse a
# refresh token that was consented once on a machine with a browser.
#
# Secrets are NEVER stored in this repository. They come from environment
# variables set in the Claude Code environment settings:
#
#   GOOGLE_OAUTH_CLIENT_ID       OAuth client id ("Desktop app" type)
#   GOOGLE_OAUTH_CLIENT_SECRET   OAuth client secret
#   USER_GOOGLE_EMAIL            Google account owning the spreadsheets
#   WORKSPACE_MCP_TOKEN_B64      base64 of the consented OAuth token json
#
# See docs/MCP_SETUP.md for how to obtain WORKSPACE_MCP_TOKEN_B64.

set -euo pipefail

CREDS_DIR="${WORKSPACE_MCP_CREDENTIALS_DIR:-$HOME/.google_workspace_mcp/credentials}"
export WORKSPACE_MCP_CREDENTIALS_DIR="$CREDS_DIR"
mkdir -p "$CREDS_DIR"
chmod 700 "$CREDS_DIR"

# Seed the refresh token on first launch in a fresh container.
# The server names credential files quote(email, safe="@._-") + ".json",
# which for a plain address is just the address itself.
if [ -n "${WORKSPACE_MCP_TOKEN_B64:-}" ] && [ -n "${USER_GOOGLE_EMAIL:-}" ]; then
  token_file="${CREDS_DIR}/${USER_GOOGLE_EMAIL}.json"
  if [ ! -s "$token_file" ]; then
    printf '%s' "$WORKSPACE_MCP_TOKEN_B64" | base64 -d > "$token_file"
    chmod 600 "$token_file"
  fi
fi

# --single-user  : skip session mapping and use the credentials in CREDS_DIR
# --tools        : only Sheets and Drive; widen here if Gmail/Calendar is needed
exec uvx workspace-mcp --single-user --tools sheets drive
