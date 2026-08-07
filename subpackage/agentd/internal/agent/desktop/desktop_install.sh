#!/bin/sh
# agentd desktop helper — GUI bootstrap script.
#
# Downloaded on first desktop_* tool call by EnsureDesktop (desktop.go).
# Installs a minimal X11 desktop stack: Xvfb (headless X server), icewm
# (lightweight X11 window manager — no GTK/Qt deps), x11vnc (VNC server
# attached to the Xvfb display), websockify + noVNC (browser-facing
# WebSocket→RFB bridge), xdotool (mouse/keyboard injection), and
# ImageMagick (for lossless X11 framebuffer screenshots).
#
# Idempotent: skips if Xvfb and x11vnc are both already on PATH.
# Mirrors node_install.sh's preflight pattern — emits
# AGENTD_DESKTOP_MISSING_TOOLS + AGENTD_DESKTOP_INSTALL_HINT when the
# package manager itself is missing or unrecognized, so the LLM (or an
# operator) can self-recover via sandbox.exec.
#
# Environment overrides:
#   AGENTD_DESKTOP_DISPLAY   X11 display number (default :99)
#   AGENTD_DESKTOP_RFB_PORT  VNC/RFB port (default 5999, i.e. 5900+99)
#   AGENTD_DESKTOP_WEB_PORT  noVNC HTTP port (default 6080)
#   AGENTD_DESKTOP_WIDTH     framebuffer width  (default 1280)
#   AGENTD_DESKTOP_HEIGHT    framebuffer height (default 800)
#   AGENTD_DESKTOP_DEPTH     framebuffer depth  (default 24)
set -eu

DISPLAY_NUM="${AGENTD_DESKTOP_DISPLAY:-:99}"
# Strip leading ":" to compute the RFB port (5900+n). DISPLAY_IDX is
# consumed below in the already-installed echo line.
DISPLAY_IDX="${DISPLAY_NUM#:}"
# The following env overrides are documented for completeness but are
# not consumed by this install script — the runtime values live in
# desktop.go (defaultDisplay/defaultRfbPort/defaultWebPort/default*).
# Kept here so `set -u` doesn't trip on a referenced-but-unset env in
# future edits, and so operators grepping for the override names find
# them. shellcheck SC2034 is therefore expected.
# shellcheck disable=SC2034
RFB_PORT="${AGENTD_DESKTOP_RFB_PORT:-$((5900 + DISPLAY_IDX))}"
# shellcheck disable=SC2034
WEB_PORT="${AGENTD_DESKTOP_WEB_PORT:-6080}"
# shellcheck disable=SC2034
WIDTH="${AGENTD_DESKTOP_WIDTH:-1280}"
# shellcheck disable=SC2034
HEIGHT="${AGENTD_DESKTOP_HEIGHT:-800}"
# shellcheck disable=SC2034
DEPTH="${AGENTD_DESKTOP_DEPTH:-24}"

# ── Helpers and constants (must precede the idempotent check) ────────

NOVNC_VERSION="v1.7.0"
NOVNC_INSTALL_DIR="/usr/share/novnc"
NOVNC_TARBALL="novnc-${NOVNC_VERSION}.tar.gz"
NOVNC_URL="https://github.com/novnc/noVNC/archive/refs/tags/${NOVNC_VERSION}.tar.gz"

# a11y helper binary — a small Go CLI that walks the AT-SPI2 tree inside
# the sandbox. Built from subpackage/dbushelper/cmd/a11y-helper and
# attached to a GitHub release; downloaded here on first desktop_* call.
# Override AGENTD_A11Y_HELPER_VERSION / AGENTD_A11Y_HELPER_REPO to test
# pre-release binaries or a fork.
A11Y_HELPER_VERSION="${AGENTD_A11Y_HELPER_VERSION:-v0.1.0}"
A11Y_HELPER_REPO="${AGENTD_A11Y_HELPER_REPO:-NekoSekaiMoe/agentboster}"
A11Y_HELPER_INSTALL_DIR="/usr/local/bin"
A11Y_HELPER_BIN="${A11Y_HELPER_INSTALL_DIR}/agentd-a11y-helper"

# install_novnc_from_release fetches the noVNC tarball from GitHub and
# unpacks it to /usr/share/novnc. Idempotent: skips if vnc.html exists.
# Used on alpine and arch where the distro package is missing or empty
# (alpine's `novnc` apk package is an empty shell with only metadata
# files; arch doesn't ship novnc in the binary repos). On debian / rhel
# the distro `novnc` package already provides vnc.html, so this function
# no-ops.
install_novnc_from_release() {
  if [ -e "${NOVNC_INSTALL_DIR}/vnc.html" ]; then
    echo "AGENTD_DESKTOP_NOVNC_ALREADY_INSTALLED=${NOVNC_INSTALL_DIR}/vnc.html"
    return 0
  fi

  # Need a download client.
  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    echo "AGENTD_DESKTOP_NOVNC_MISSING_TOOLS=curl-or-wget" >&2
    echo "AGENTD_DESKTOP_INSTALL_HINT=install curl or wget first, then retry desktop_screenshot" >&2
    return 1
  fi

  TMPDIR_NOVNC="$(mktemp -d /tmp/agentd-novnc-XXXXXX)"
  # shellcheck disable=SC3047 # RETURN trap is bash/dash/ash-supported; best-effort cleanup
  trap 'rm -rf "$TMPDIR_NOVNC"' RETURN

  echo "AGENTD_DESKTOP_NOVNC_DOWNLOAD_STARTED version=${NOVNC_VERSION}"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$NOVNC_URL" -o "$TMPDIR_NOVNC/$NOVNC_TARBALL"
  else
    wget -q -O "$TMPDIR_NOVNC/$NOVNC_TARBALL" "$NOVNC_URL"
  fi

  # The tarball's top-level dir is "noVNC-<version>" (without the
  # leading v from the tag), so derive the dir name with the v stripped.
  NOVNC_SRC_DIR="noVNC-$(echo "$NOVNC_VERSION" | sed 's/^v//')"
  tar -xzf "$TMPDIR_NOVNC/$NOVNC_TARBALL" -C "$TMPDIR_NOVNC"

  mkdir -p "$NOVNC_INSTALL_DIR"
  # cp -r rather than mv: source (/tmp) and dest (/usr/share) may be on
  # different filesystems. The "/." suffix copies contents-including-
  # hidden-files into the dest dir without nesting.
  cp -r "$TMPDIR_NOVNC/$NOVNC_SRC_DIR/." "$NOVNC_INSTALL_DIR/"

  if [ ! -e "${NOVNC_INSTALL_DIR}/vnc.html" ]; then
    echo "AGENTD_DESKTOP_NOVNC_INSTALL_FAILED=vnc.html not found after extraction" >&2
    return 1
  fi

  echo "AGENTD_DESKTOP_NOVNC_INSTALLED=${NOVNC_INSTALL_DIR}/vnc.html"
}

# install_a11y_helper_from_release fetches the prebuilt a11y helper
# binary from a GitHub release and installs it at
# /usr/local/bin/agentd-a11y-helper. Idempotent: skips if the binary
# already exists and matches the configured version.
#
# Architecture mapping:
#   x86_64  → amd64
#   aarch64 → arm64
#   (others → emit hint + return 1; the helper is currently only built
#   for linux/amd64 and linux/arm64 by the release pipeline)
install_a11y_helper_from_release() {
  if [ -x "${A11Y_HELPER_BIN}" ]; then
    echo "AGENTD_DESKTOP_A11Y_HELPER_ALREADY_INSTALLED=${A11Y_HELPER_BIN}"
    return 0
  fi

  # Resolve Go arch from uname -m.
  case "$(uname -m)" in
    x86_64)  A11Y_ARCH="amd64" ;;
    aarch64) A11Y_ARCH="arm64" ;;
    *)
      echo "AGENTD_DESKTOP_A11Y_HELPER_UNSUPPORTED_ARCH=$(uname -m)" >&2
      echo "AGENTD_DESKTOP_INSTALL_HINT=unsupported arch for a11y helper; build manually from subpackage/dbushelper/cmd/a11y-helper and place at ${A11Y_HELPER_BIN}" >&2
      return 1
      ;;
  esac

  if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
    echo "AGENTD_DESKTOP_A11Y_HELPER_MISSING_TOOLS=curl-or-wget" >&2
    echo "AGENTD_DESKTOP_INSTALL_HINT=install curl or wget first, then retry desktop_inspect" >&2
    return 1
  fi

  A11Y_TARBALL="agentd-a11y-helper-linux-${A11Y_ARCH}-${A11Y_HELPER_VERSION}"
  A11Y_URL="https://github.com/${A11Y_HELPER_REPO}/releases/download/${A11Y_HELPER_VERSION}/${A11Y_TARBALL}"

  echo "AGENTD_DESKTOP_A11Y_HELPER_DOWNLOAD_STARTED arch=${A11Y_ARCH} version=${A11Y_HELPER_VERSION}"

  TMPDIR_A11Y="$(mktemp -d /tmp/agentd-a11y-XXXXXX)"
  # shellcheck disable=SC3047 # RETURN trap is bash/dash/ash-supported; best-effort cleanup
  trap 'rm -rf "$TMPDIR_A11Y"' RETURN

  if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL "$A11Y_URL" -o "$TMPDIR_A11Y/agentd-a11y-helper"; then
      echo "AGENTD_DESKTOP_A11Y_HELPER_DOWNLOAD_FAILED=$A11Y_URL" >&2
      echo "AGENTD_DESKTOP_INSTALL_HINT=a11y helper download failed; build manually from subpackage/dbushelper/cmd/a11y-helper and place at ${A11Y_HELPER_BIN}" >&2
      return 1
    fi
  else
    if ! wget -q -O "$TMPDIR_A11Y/agentd-a11y-helper" "$A11Y_URL"; then
      echo "AGENTD_DESKTOP_A11Y_HELPER_DOWNLOAD_FAILED=$A11Y_URL" >&2
      echo "AGENTD_DESKTOP_INSTALL_HINT=a11y helper download failed; build manually from subpackage/dbushelper/cmd/a11y-helper and place at ${A11Y_HELPER_BIN}" >&2
      return 1
    fi
  fi

  chmod +x "$TMPDIR_A11Y/agentd-a11y-helper"
  mkdir -p "$A11Y_HELPER_INSTALL_DIR"
  # cp + mv to make the swap atomic from concurrent readers.
  cp "$TMPDIR_A11Y/agentd-a11y-helper" "${A11Y_HELPER_BIN}.tmp"
  mv "${A11Y_HELPER_BIN}.tmp" "${A11Y_HELPER_BIN}"

  if ! [ -x "${A11Y_HELPER_BIN}" ]; then
    echo "AGENTD_DESKTOP_A11Y_HELPER_INSTALL_FAILED=bin not executable after install" >&2
    return 1
  fi

  echo "AGENTD_DESKTOP_A11Y_HELPER_INSTALLED=${A11Y_HELPER_BIN}"
}

# emit_hint prints a single AGENTD_DESKTOP_INSTALL_HINT line listing the
# system packages needed, then exits 1. The caller (EnsureDesktop)
# surfaces this to the LLM as a tool-result error; the model runs the
# hint via sandbox.exec (which has root in the LXC container), then
# retries the desktop_* tool.
emit_hint() {
  # $1 = manager command prefix, $2 = package list (space-separated)
  echo "AGENTD_DESKTOP_INSTALL_HINT=$1 $2"
  exit 1
}

# ── Two-phase install ────────────────────────────────────────────────
#
# Phase 1 (first call): Xvfb / x11vnc are NOT on PATH yet. The script
# detects the package manager, emits AGENTD_DESKTOP_INSTALL_HINT with
# the system package list, and exits 1. The LLM runs the hint via
# sandbox.exec, then retries.
#
# Phase 2 (second call): Xvfb / x11vnc are now on PATH, but on alpine
# and arch the noVNC web assets are still missing. We fetch noVNC from
# its GitHub release tarball here — this doesn't need root (writes to
# /usr/share/novnc, which the LXC user can create), so the script does
# it inline rather than emitting another hint. Once vnc.html exists,
# the script reports already-installed and exits 0.
if command -v Xvfb >/dev/null 2>&1 && command -v x11vnc >/dev/null 2>&1; then
  # Phase 2: system packages present. Ensure noVNC web assets + the
  # a11y helper binary are too. Both fetch from GitHub; on debian/rhel
  # the distro novnc package already provided vnc.html, so
  # install_novnc_from_release no-ops there.
  if ! [ -e "${NOVNC_INSTALL_DIR}/vnc.html" ]; then
    install_novnc_from_release || {
      echo "AGENTD_DESKTOP_INSTALL_HINT=install_novnc_from_release failed; check curl/wget availability and GitHub reachability" >&2
      exit 1
    }
  fi
  # a11y helper failure is non-fatal — desktop_screenshot/click still
  # work, only desktop_inspect/a11y_click/a11y_type degrade. We don't
  # exit 1 here; the tool layer surfaces a per-call error if invoked.
  if ! [ -x "${A11Y_HELPER_BIN}" ]; then
    install_a11y_helper_from_release || true
  fi
  echo "AGENTD_DESKTOP_ALREADY_INSTALLED=Xvfb:$DISPLAY_IDX,x11vnc,novnc:${NOVNC_INSTALL_DIR}/vnc.html,a11y:${A11Y_HELPER_BIN}"
  exit 0
fi

# ── Phase 1: detect package manager + emit install hint ─────────────

if command -v apk >/dev/null 2>&1; then
  # alpine — Xvfb, icewm, x11vnc, websockify, xdotool, imagemagick
  # are all in the community repo. **noVNC is NOT in the package list**
  # because alpine's `novnc` apk package is an empty shell (only 5
  # metadata files, no vnc.html). Phase 2 above fetches noVNC from
  # GitHub instead.
  # at-spi2-core + dbus-x11 enable the AT-SPI2 a11y bus (consumed by
  # the a11y helper binary for desktop_inspect/desktop_a11y_click).
  PKGS="xorg-server-xvfb xorg-xdpyinfo procps-ng icewm x11vnc websockify xdotool imagemagick at-spi2-core dbus-x11 xset"
  echo "AGENTD_DESKTOP_MISSING_TOOLS=gui-stack"
  echo "AGENTD_DESKTOP_DISTRO=alpine"
  # Probe whether community repo is enabled; if not, emit a hint that
  # enables it first. The /etc/apk/repositories file lists active repos
  # one per line; community is identified by the "community" suffix.
  if ! grep -q 'community' /etc/apk/repositories 2>/dev/null; then
    # Read the first main repo line and derive its community twin.
    MAIN_REPO=$(head -n1 /etc/apk/repositories 2>/dev/null || true)
    if [ -n "$MAIN_REPO" ]; then
      COMMUNITY_REPO=$(echo "$MAIN_REPO" | sed 's#/main#/community#')
      emit_hint "echo '$COMMUNITY_REPO' >> /etc/apk/repositories && apk add --no-cache --no-progress" "$PKGS"
    fi
  fi
  emit_hint "apk add --no-cache --no-progress" "$PKGS"
elif command -v apt-get >/dev/null 2>&1; then
  # debian / ubuntu — the `novnc` package here is the full upstream
  # release (vnc.html + core JS + app/ assets), so we install it
  # through apt. Phase 2's install_novnc_from_release no-ops.
  # at-spi2-core + dbus-x11 enable the AT-SPI2 a11y bus (consumed by
  # the a11y helper binary for desktop_inspect/desktop_a11y_click).
  PKGS="xvfb x11-utils procps icewm x11vnc websockify novnc xdotool imagemagick fonts-noto-cjk at-spi2-core dbus-x11 x11-xserver-utils"
  echo "AGENTD_DESKTOP_MISSING_TOOLS=gui-stack"
  echo "AGENTD_DESKTOP_DISTRO=debian"
  emit_hint "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends" "$PKGS"
elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
  PM="yum install -y"
  if command -v dnf >/dev/null 2>&1; then
    PM="dnf install -y"
  fi
  # xdotool is in EPEL on RHEL; the hint assumes EPEL is already enabled.
  # novnc on RHEL/Fedora is the full upstream release (same as debian).
  # at-spi2-core + dbus-x11 enable the AT-SPI2 a11y bus.
  PKGS="xorg-x11-server-Xvfb xorg-x11-utils procps-ng icewm x11vnc websockify novnc xdotool ImageMagick at-spi2-core dbus-x11 xorg-x11-server-utils"
  echo "AGENTD_DESKTOP_MISSING_TOOLS=gui-stack"
  echo "AGENTD_DESKTOP_DISTRO=rhel"
  emit_hint "$PM" "$PKGS"
elif command -v pacman >/dev/null 2>&1; then
  # arch — AUR has novnc, but the binary repos don't. Phase 2 fetches
  # from GitHub instead.
  # at-spi2-core + dbus-x11 enable the AT-SPI2 a11y bus.
  PKGS="xorg-server-xvfb xorg-xdpyinfo procps-ng icewm x11vnc websockify xdotool imagemagick at-spi2-core dbus-x11 xorg-xset"
  echo "AGENTD_DESKTOP_MISSING_TOOLS=gui-stack"
  echo "AGENTD_DESKTOP_DISTRO=arch"
  emit_hint "pacman -Sy --noconfirm --needed" "$PKGS"
else
  echo "AGENTD_DESKTOP_MISSING_TOOLS=unknown-package-manager"
  echo "AGENTD_DESKTOP_INSTALL_HINT=(no apk/apt/dnf/yum/pacman detected; install xvfb x11-utils x11vnc websockify xdotool imagemagick at-spi2-core dbus-x11 manually)" >&2
  exit 1
fi
