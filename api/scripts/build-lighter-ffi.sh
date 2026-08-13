#!/usr/bin/env bash
set -euo pipefail

# Build script for Lighter FFI binaries
# Produces:
#   - lighter-wrapper.dylib       (macOS arm64, native compile)
#   - lighter-wrapper-linux-amd64.so (Linux x86_64, Docker cross-compile)
# Downloads signer binaries from GitHub if missing or checksum mismatch.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FFI_DIR="$SCRIPT_DIR/../../packages/perps/lighter/ffi"
WRAPPER_SRC="$FFI_DIR/wrapper.c"
SIGNER_HEADER_DIR="$FFI_DIR"

# Lighter-go release
RELEASE_TAG="v1.0.4"
RELEASE_BASE="https://github.com/elliottech/lighter-go/releases/download/$RELEASE_TAG"

# Expected SHA-256 checksums for signer binaries
SIGNER_DARWIN_ARM64_SHA256="99c6bf2d8589ba2b5f687ada675c9cbd1764744a5ee323ba3b464c928772d170"
SIGNER_LINUX_AMD64_SHA256="967282174fa5969a936098e4522bf02492c35dba4c6cf185594be16495d6b067"

# Signer binary filenames
SIGNER_DARWIN="lighter-signer-darwin-arm64.dylib"
SIGNER_LINUX="lighter-signer-linux-amd64.so"

# Wrapper output filenames
WRAPPER_DARWIN="lighter-wrapper.dylib"
WRAPPER_LINUX="lighter-wrapper-linux-amd64.so"

log() { echo "==> $*"; }
err() { echo "ERROR: $*" >&2; exit 1; }

verify_checksum() {
  local file="$1" expected="$2"
  if [[ ! -f "$file" ]]; then
    return 1
  fi
  local actual
  actual=$(shasum -a 256 "$file" 2>/dev/null | awk '{print $1}')
  [[ "$actual" == "$expected" ]]
}

download_signer() {
  local filename="$1" expected_sha="$2"
  local target="$FFI_DIR/$filename"

  if verify_checksum "$target" "$expected_sha"; then
    log "$filename: already present, checksum OK"
    return
  fi

  log "$filename: downloading from $RELEASE_BASE/$filename"
  curl -fSL -o "$target" "$RELEASE_BASE/$filename"

  if ! verify_checksum "$target" "$expected_sha"; then
    err "$filename: checksum mismatch after download!"
  fi
  log "$filename: downloaded, checksum OK"
}

compile_darwin() {
  log "Compiling $WRAPPER_DARWIN (macOS arm64, native)"
  gcc -shared -o "$FFI_DIR/$WRAPPER_DARWIN" \
    -arch arm64 \
    -ldl \
    "$WRAPPER_SRC"
  log "$WRAPPER_DARWIN: built OK"
}

compile_linux_docker() {
  log "Cross-compiling $WRAPPER_LINUX (Linux x86_64 via Docker)"

  docker run --rm \
    -v "$FFI_DIR:/src" \
    --platform linux/amd64 \
    gcc:14 \
    gcc -shared -fPIC -o "/src/$WRAPPER_LINUX" \
      -ldl \
      "/src/wrapper.c"

  log "$WRAPPER_LINUX: built OK"
}

compile_linux_native() {
  log "Compiling $WRAPPER_LINUX (Linux x86_64, native)"
  gcc -shared -fPIC -o "$FFI_DIR/$WRAPPER_LINUX" \
    -ldl \
    "$WRAPPER_SRC"
  log "$WRAPPER_LINUX: built OK"
}

# --- Main ---

[[ -f "$WRAPPER_SRC" ]] || err "wrapper.c not found at $WRAPPER_SRC"

log "Ensuring signer binaries..."
download_signer "$SIGNER_DARWIN" "$SIGNER_DARWIN_ARM64_SHA256"
download_signer "$SIGNER_LINUX" "$SIGNER_LINUX_AMD64_SHA256"

# Also download the header if missing
SIGNER_HEADER="lighter-signer-darwin-arm64.h"
if [[ ! -f "$FFI_DIR/$SIGNER_HEADER" ]]; then
  log "$SIGNER_HEADER: downloading..."
  curl -fSL -o "$FFI_DIR/$SIGNER_HEADER" "$RELEASE_BASE/$SIGNER_HEADER" || true
fi

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    compile_darwin
    # Cross-compile Linux via Docker
    if command -v docker &>/dev/null; then
      compile_linux_docker
    else
      log "Docker not found — skipping Linux cross-compile"
      log "Install Docker to build $WRAPPER_LINUX on macOS"
    fi
    ;;
  Linux)
    if [[ "$ARCH" == "x86_64" ]]; then
      compile_linux_native
    else
      err "Unsupported Linux architecture: $ARCH"
    fi
    ;;
  *)
    err "Unsupported OS: $OS"
    ;;
esac

log "Done! Binaries in $FFI_DIR:"
ls -lh "$FFI_DIR"/*.dylib "$FFI_DIR"/*.so 2>/dev/null || true
