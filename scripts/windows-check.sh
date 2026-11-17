#!/usr/bin/env bash
# From WSL: run the test suite with Windows Node, on a copy of this tree on the Windows disk.
#
#   WIN_NODE_DIR=C:\path\to\node-v24-win-x64 scripts/windows-check.sh [test files...]
#
# WIN_NODE_DIR is a Windows path to an unpacked Node 24 (the official zip; nothing is installed).
# The copy goes to %TEMP%\parallax-windows-check\repo and is replaced on every run.
set -euo pipefail
: "${WIN_NODE_DIR:?set WIN_NODE_DIR to a Windows path of an unpacked Node 24}"
cmd=/mnt/c/Windows/System32/cmd.exe
[ -x "$cmd" ] || { echo "no Windows interop here ($cmd)" >&2; exit 2; }
win_temp=$(cd /mnt/c && "$cmd" /c "echo %TEMP%" | tr -d '\r')
dest=$(wslpath "$win_temp")/parallax-windows-check/repo
here=$(cd "$(dirname "$0")/.." && pwd)
rm -rf "$dest" && mkdir -p "$dest"
tar -C "$here" --exclude=./node_modules --exclude=./.git -cf - . | tar -xf - -C "$dest"
cd "$dest"
tests=${*:-test/**/*.test.ts}
"$cmd" /c "set PATH=$WIN_NODE_DIR;%PATH% && node --version && node --test $tests" | tr -d '\r'
