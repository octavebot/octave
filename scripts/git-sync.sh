#!/bin/bash
# Pulls the latest cloud-heartbeat / cloud-dedup from the GitHub repo,
# so the local Mac service can dedup against what cloud has already fired.
#
# Designed to be called by a LaunchAgent on a 60s timer.
# Silently fails on network / merge issues — local will fall back to firing
# its own Telegram if heartbeat goes stale.

set -u
REPO="/Users/jqvier/trading-alerts"
cd "$REPO" || exit 0

# Only do anything if this is actually a git repo with a remote
if [ ! -d .git ]; then exit 0; fi
if ! git config --get remote.origin.url >/dev/null 2>&1; then exit 0; fi

# Pull with rebase, autostashing any local changes (drawings.json, dedup.json, etc.)
# We don't care about pull failures; next run will retry.
GIT_TERMINAL_PROMPT=0 git pull --quiet --rebase --autostash origin HEAD 2>/dev/null || true
