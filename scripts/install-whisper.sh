#!/usr/bin/env bash
# scripts/install-whisper.sh — build whisper.cpp and fetch a model, without sudo.
#
# The voice journal transcribes on the box (journal/transcribe.mjs) so a recording
# never leaves it and no third-party speech API key can expire. This puts the
# pieces in place:
#
#   $PREFIX/bin/whisper-cli          statically linked whisper.cpp CLI
#   $PREFIX/models/ggml-<model>.bin  the speech model (small.en by default)
#
# and prints the .env lines the bridge reads. Re-running is safe: an existing
# checkout is updated, an existing model is kept. cmake is fetched as a portable
# tarball when the box has none (it doesn't, and there is no sudo).
#
#   scripts/install-whisper.sh              # small.en (best CPU quality/speed balance)
#   scripts/install-whisper.sh base.en      # ~3x faster, noticeably worse on names
#   scripts/install-whisper.sh medium.en    # better, but several minutes per entry on CPU
set -euo pipefail

MODEL="${1:-${JOURNAL_WHISPER_MODEL_NAME:-small.en}}"
PREFIX="${WHISPER_PREFIX:-$HOME/.local/share/totem/whisper}"
CMAKE_VERSION="${CMAKE_VERSION:-3.31.6}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

# Back-compat for the 2026-10-02 Vesper→Totem rename: carry an existing install
# over rather than rebuilding and re-downloading it. (The bridge does the same on
# startup.) Drop once every install has run as Totem.
if [ ! -e "$HOME/.local/share/totem" ] && [ -d "$HOME/.local/share/vesper" ]; then
  echo "==> moving ~/.local/share/vesper -> ~/.local/share/totem"
  mv "$HOME/.local/share/vesper" "$HOME/.local/share/totem"
fi

mkdir -p "$PREFIX/bin" "$PREFIX/models" "$PREFIX/tools"

# --- cmake ------------------------------------------------------------------
CMAKE="$(command -v cmake || true)"
if [ -z "$CMAKE" ]; then
  CMAKE_DIR="$PREFIX/tools/cmake-$CMAKE_VERSION"
  if [ ! -x "$CMAKE_DIR/bin/cmake" ]; then
    echo "==> cmake not found; fetching portable cmake $CMAKE_VERSION"
    arch="$(uname -m)"
    tarball="cmake-$CMAKE_VERSION-linux-$arch.tar.gz"
    curl -fsSL "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/$tarball" -o "$PREFIX/tools/$tarball"
    mkdir -p "$CMAKE_DIR"
    tar -xzf "$PREFIX/tools/$tarball" -C "$CMAKE_DIR" --strip-components=1
    rm -f "$PREFIX/tools/$tarball"
  fi
  CMAKE="$CMAKE_DIR/bin/cmake"
fi
echo "==> using $($CMAKE --version | head -1)"

# --- whisper.cpp --------------------------------------------------------------
SRC="$PREFIX/src/whisper.cpp"
if [ -d "$SRC/.git" ]; then
  echo "==> updating whisper.cpp"
  git -C "$SRC" pull --ff-only --quiet || echo "    (pull failed; building the checkout as-is)"
else
  echo "==> cloning whisper.cpp"
  mkdir -p "$PREFIX/src"
  git clone --depth 1 --quiet https://github.com/ggml-org/whisper.cpp "$SRC"
fi

echo "==> building whisper-cli (this takes a few minutes the first time)"
# Static so the one binary can be copied anywhere without dragging libggml along.
# GGML_NATIVE tunes for this CPU (AVX2 on the i5-8600K); the binary is not portable
# to another machine, which is fine — it is built on the box it runs on.
"$CMAKE" -S "$SRC" -B "$SRC/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_NATIVE=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON > "$SRC/build-configure.log" 2>&1 || { tail -40 "$SRC/build-configure.log"; exit 1; }
"$CMAKE" --build "$SRC/build" --config Release -j "$JOBS" --target whisper-cli > "$SRC/build.log" 2>&1 || { tail -60 "$SRC/build.log"; exit 1; }
install -m 0755 "$SRC/build/bin/whisper-cli" "$PREFIX/bin/whisper-cli"
echo "==> installed $PREFIX/bin/whisper-cli"

# --- model --------------------------------------------------------------------
MODEL_FILE="$PREFIX/models/ggml-$MODEL.bin"
if [ -s "$MODEL_FILE" ]; then
  echo "==> model already present: $MODEL_FILE"
else
  echo "==> downloading ggml-$MODEL.bin"
  curl -fL --progress-bar "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL.bin" -o "$MODEL_FILE.part"
  mv "$MODEL_FILE.part" "$MODEL_FILE"
fi
echo "==> model: $MODEL_FILE ($(du -h "$MODEL_FILE" | cut -f1))"

# --- smoke test -----------------------------------------------------------------
if [ -f "$SRC/samples/jfk.wav" ]; then
  echo "==> smoke test (samples/jfk.wav)"
  "$PREFIX/bin/whisper-cli" -m "$MODEL_FILE" -f "$SRC/samples/jfk.wav" -nt -np 2>/dev/null | sed 's/^/    /' || echo "    (smoke test failed — check the model file)"
fi

cat <<ENV

Add to .env (these are the defaults the bridge already assumes, so they are only
needed if you chose a different prefix or model):

  JOURNAL_WHISPER_BIN=$PREFIX/bin/whisper-cli
  JOURNAL_WHISPER_MODEL=$MODEL_FILE

Then: systemctl --user restart assistant-bridge
ENV
