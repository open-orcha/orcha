#!/usr/bin/env bash
# E2 SPIKE — throwaway harness (NOT production). Drives a resident `claude` session via
# stream-json stdin and captures stream-json stdout, to validate the resident-worker model.
#
# Usage:
#   ./drive_resident.sh warm     # multi-turn warm-context retention (turn 2 recalls turn 1)
#   ./drive_resident.sh stream   # realtime partial-message streaming (--include-partial-messages)
#   ./drive_resident.sh probe    # single-turn protocol sanity (result event shape)
#
# Findings written up in docs/spikes/e2-resident-session-findings.md.
set -euo pipefail
mode="${1:-warm}"
out="$(mktemp -t e2-resident-XXXX).ndjson"

# A user turn on stdin is one NDJSON line:
turn() { printf '%s\n' "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"$1\"}]}}"; }

# macOS has no `timeout`, so each invocation is backgrounded and bg-killed after a bound (below).
common=(claude -p --input-format stream-json --output-format stream-json --verbose
        --disallowedTools '*' --append-system-prompt 'Answer tersely. No tools.')

case "$mode" in
  probe)
    turn "Reply with exactly: PROBE_OK" | "${common[@]}" > "$out" & ;;
  warm)
    { turn "Remember this codeword: Zephyr-7. Reply with exactly: STORED";
      turn "What codeword did I give you? Reply with exactly that codeword and nothing else."; } \
      | "${common[@]}" > "$out" & ;;
  stream)
    turn "Count slowly from 1 to 8, one number per line." \
      | claude -p --input-format stream-json --output-format stream-json --include-partial-messages \
               --verbose --disallowedTools '*' --append-system-prompt 'No tools.' > "$out" & ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac
cpid=$!
for _ in $(seq 1 120); do kill -0 "$cpid" 2>/dev/null || break; sleep 1; done
kill -0 "$cpid" 2>/dev/null && kill -KILL "$cpid" 2>/dev/null || true
wait "$cpid" 2>/dev/null || true

echo "== per-turn results (warm-context evidence) =="
python3 - "$out" <<'PY'
import json, sys
sids=set(); results=[]; types={}
for l in open(sys.argv[1]):
    l=l.strip()
    if not l: continue
    try: o=json.loads(l)
    except: continue
    types[o.get('type')]=types.get(o.get('type'),0)+1
    if o.get('session_id'): sids.add(o['session_id'])
    if o.get('type')=='result': results.append((o.get('num_turns'), o.get('result')))
print('event types:', types)
print('distinct session_ids:', len(sids), '(1 == one resident session across turns)')
for i,(nt,r) in enumerate(results,1):
    print(f'  result#{i}: num_turns={nt} -> {r!r}')
PY
echo "raw: $out"
