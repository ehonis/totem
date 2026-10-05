#!/usr/bin/env bash
# Fetch Smart Turn v3 (pipecat-ai/smart-turn, BSD-2) — the end-of-turn model voice
# mode runs in the browser (web/src/chat/turn/). 8 MB, int8 CPU build. Served by
# the dashboard from /models/; re-run after a fresh clone, then rebuild web/.
set -euo pipefail
cd "$(dirname "$0")/../web/public"
mkdir -p models
url="https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx"
curl -fL --retry 3 -o models/smart-turn-v3.2-cpu.onnx.part "$url"
mv models/smart-turn-v3.2-cpu.onnx.part models/smart-turn-v3.2-cpu.onnx
ls -la models/smart-turn-v3.2-cpu.onnx
