#!/bin/sh
# shar8-loader: 1
d=$(cd "$(dirname "$0")" && pwd)
. "$d/loader.conf"                     # NODE=... STATE=...
hb() { mkdir -p "$STATE"; printf '{"v":1,"at":"%s","phase":"done","state":"%s","exit":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >"$STATE/heartbeat.json.$$" && mv "$STATE/heartbeat.json.$$" "$STATE/heartbeat.json"; }
[ -n "$NODE" ] && [ -x "$NODE" ] || { hb node_missing 78; exit 78; }
"$NODE" "$d/shim.mjs" "$@"; rc=$?
case $rc in 0|77|78) exit $rc ;; esac                      # any other code means the shim is broken (import, syntax)
if [ -f "$d/shim.prev.mjs" ]; then hb shim_broken 78; "$NODE" "$d/shim.prev.mjs" "$@"; exit $?; fi
hb shim_broken 78; exit 78
