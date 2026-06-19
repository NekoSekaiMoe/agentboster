#!/bin/sh
# agentd browser helper — node.js bootstrap script.
#
# Downloaded on first browser_* tool call by EnsureBridge (browser.go).
# Idempotent: skips if ~/.local/node/bin/node already exists and runs.
#
# Tarball mirror is configurable (default: Tsinghua TUNA). The SHA256
# checksum is ALWAYS fetched from the official nodejs.org because that's
# the trust anchor — a mirror can serve a tampered tarball + tampered
# SHASUMS, but it cannot forge nodejs.org's SHASUMS256.txt.
#
# Environment overrides:
#   AGENTD_NODE_VERSION       e.g. v24.1.0
#   AGENTD_NODE_MIRROR        tarball mirror URL (no trailing slash)
#   AGENTD_NODE_SHASUM_MIRROR SHASUMS256.txt source (default: nodejs.org)
set -eu

NODE_VERSION="${AGENTD_NODE_VERSION:-v24.1.0}"
NODE_MIRROR="${AGENTD_NODE_MIRROR:-https://mirrors.tuna.tsinghua.edu.cn/nodejs-release}"
SHASUM_MIRROR="${AGENTD_NODE_SHASUM_MIRROR:-https://nodejs.org/dist}"
INSTALL_DIR="$HOME/.local/node"

# Idempotent: already installed
if [ -x "$INSTALL_DIR/bin/node" ]; then
  echo "AGENTD_NODE_ALREADY_INSTALLED=$INSTALL_DIR/bin/node"
  "$INSTALL_DIR/bin/node" --version
  exit 0
fi

# Toolchain preflight. The default LXC InitCommands install this set via
# `apk add --no-cache git curl bash ca-certificates xz`, but the script
# also runs in user-supplied sandbox images (custom LXC distros, docker
# strict with arbitrary base images, custom docker_image values) that
# may NOT have the baseline. Rather than failing mid-way with an opaque
# `tar: invalid option -- 'J'` or a truncated download, enumerate every
# required tool up front and report ALL missing ones in a single
# AGENTD_NODE_MISSING_TOOLS line plus an AGENTD_NODE_INSTALL_HINT line
# that gives a copy-pasteable fix command for the detected package
# manager. This error is consumed by browser.go's EnsureBridge, which
# surfaces it as a tool-result error to the LLM — so the LLM can
# self-recover by running the hint via sandbox.exec and retrying.
#
# Two pairs have an either/or contract:
#   - curl OR wget  (download clients)
#   - sha256sum OR shasum  (integrity check)
# Any other tool is strictly required.
check_required_tools() {
  missing=""
  require() {
    if ! command -v "$1" >/dev/null 2>&1; then
      missing="$missing $1"
    fi
  }
  require tar
  require xz
  require awk
  require grep
  require mktemp
  require mv
  require mkdir
  require uname
  # Either curl or wget is fine (the download block below handles both).
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    missing="$missing curl-or-wget"
  fi
  # Either sha256sum (coreutils) or shasum (perl) is fine.
  if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
    missing="$missing sha256sum-or-shasum"
  fi
  if [ -n "$missing" ]; then
    # Trim leading space.
    missing="${missing# }"
    echo "AGENTD_NODE_MISSING_TOOLS=$missing" >&2
    # Emit a package-manager-aware install hint so the LLM (or operator)
    # can recover in one exec call. Translate each missing item to its
    # package name per the detected manager. `ca-certificates` is pulled
    # in unconditionally because HTTPS downloads will fail without it
    # even if the http client binary is present.
    pkgs=""
    add_pkg() {
      pkgs="$pkgs $1"
    }
    emit_hint() {
      # $1 = manager command prefix (e.g. "apk add --no-cache")
      # Build the package list, then trim and print.
      pkgs="${pkgs# }"
      if [ -n "$pkgs" ]; then
        echo "AGENTD_NODE_INSTALL_HINT=$1 $pkgs" >&2
      fi
    }
    case "$(uname -s 2>/dev/null)" in
      Linux)
        if command -v apk >/dev/null 2>&1; then
          # alpine
          for t in $missing; do
            case "$t" in
              tar) add_pkg tar ;;
              xz) add_pkg xz ;;
              awk) add_pkg busybox 2>/dev/null || add_pkg gawk ;;
              grep) add_pkg grep ;;
              curl-or-wget) add_pkg curl ;;
              sha256sum-or-shasum) add_pkg busybox 2>/dev/null || add_pkg perl-utils ;;
            esac
          done
          add_pkg ca-certificates
          emit_hint "apk add --no-cache"
        elif command -v apt-get >/dev/null 2>&1; then
          # debian / ubuntu
          for t in $missing; do
            case "$t" in
              tar) add_pkg tar ;;
              xz) add_pkg xz-utils ;;
              awk) add_pkg gawk ;;
              grep) add_pkg grep ;;
              curl-or-wget) add_pkg curl ;;
              sha256sum-or-shasum) add_pkg coreutils 2>/dev/null || add_pkg perl ;;
            esac
          done
          add_pkg ca-certificates
          emit_hint "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends"
        elif command -v yum >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1; then
          # RHEL / Fedora
          pm="yum install -y"
          if command -v dnf >/dev/null 2>&1; then
            pm="dnf install -y"
          fi
          for t in $missing; do
            case "$t" in
              tar) add_pkg tar ;;
              xz) add_pkg xz ;;
              awk) add_pkg gawk ;;
              grep) add_pkg grep ;;
              curl-or-wget) add_pkg curl ;;
              sha256sum-or-shasum) add_pkg coreutils 2>/dev/null || add_pkg perl-Digest-SHA ;;
            esac
          done
          add_pkg ca-certificates
          emit_hint "$pm"
        else
          echo "AGENTD_NODE_INSTALL_HINT=(unknown package manager — no apk/apt/yum/dnf detected; install the missing tools manually)" >&2
        fi
        ;;
      *)
        echo "AGENTD_NODE_INSTALL_HINT=(unsupported OS — install the missing tools manually)" >&2
        ;;
    esac
    exit 1
  fi
}
check_required_tools

# Arch detection (Linux only — agentd is Linux-only too)
case "$(uname -m)" in
  x86_64)  ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
  armv7l)  ARCH="armv7l" ;;
  ppc64le) ARCH="ppc64le" ;;
  s390x)   ARCH="s390x" ;;
  *) echo "AGENTD_NODE_UNSUPPORTED_ARCH=$(uname -m)" >&2; exit 1 ;;
esac

TARBALL="node-$NODE_VERSION-linux-$ARCH.tar.xz"
TMPDIR="$(mktemp -d /tmp/agentd-node-XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

echo "AGENTD_NODE_DOWNLOAD_STARTED mirror=$NODE_MIRROR version=$NODE_VERSION arch=$ARCH"

# 1. Download tarball from mirror
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$NODE_MIRROR/$NODE_VERSION/$TARBALL" -o "$TMPDIR/$TARBALL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMPDIR/$TARBALL" "$NODE_MIRROR/$NODE_VERSION/$TARBALL"
else
  echo "AGENTD_NODE_NO_HTTP_CLIENT" >&2
  exit 1
fi

# 2. Download official SHASUMS256.txt from nodejs.org (trust anchor)
SHA_FILE="SHASUMS256.txt"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SHASUM_MIRROR/$NODE_VERSION/$SHA_FILE" -o "$TMPDIR/$SHA_FILE"
else
  wget -q -O "$TMPDIR/$SHA_FILE" "$SHASUM_MIRROR/$NODE_VERSION/$SHA_FILE"
fi

# 3. Verify SHA256
EXPECTED=$(grep "  $TARBALL\$" "$TMPDIR/$SHA_FILE" | awk '{print $1}')
if [ -z "$EXPECTED" ]; then
  echo "AGENTD_NODE_SHASUM_NOT_FOUND tarball=$TARBALL shasum_file=$SHASUM_MIRROR/$NODE_VERSION/$SHA_FILE" >&2
  exit 1
fi

# Use sha256sum (coreutils) or shasum (perl fallback)
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TMPDIR/$TARBALL" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "$TMPDIR/$TARBALL" | awk '{print $1}')
else
  echo "AGENTD_NODE_NO_SHA_TOOL" >&2
  exit 1
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "AGENTD_NODE_SHASUM_MISMATCH expected=$EXPECTED actual=$ACTUAL" >&2
  echo "Mirror may be compromised. Set AGENTD_NODE_MIRROR=https://nodejs.org/dist to use official source." >&2
  exit 1
fi

echo "AGENTD_NODE_SHASUM_VERIFIED"

# 4. Extract to ~/.local
mkdir -p "$HOME/.local"
tar -xJf "$TMPDIR/$TARBALL" -C "$HOME/.local"
mv "$HOME/.local/node-$NODE_VERSION-linux-$ARCH" "$INSTALL_DIR"

# 5. Configure npm to use a fast registry mirror (Playwright install is heavy)
cat > "$HOME/.npmrc" <<'EOF'
registry=https://registry.npmmirror.com
EOF

# 6. Persist Playwright binary download host so bridge.js can source it.
#    Playwright's postinstall fetches chromium from this host.
cat > "$HOME/.agentd-browser.env" <<'EOF'
PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright
EOF

echo "AGENTD_NODE_INSTALLED=$INSTALL_DIR/bin/node"
"$INSTALL_DIR/bin/node" --version
