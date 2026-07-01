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
# Strip leading ":" to compute the RFB port (5900+n).
DISPLAY_IDX="${DISPLAY_NUM#:}"
RFB_PORT="${AGENTD_DESKTOP_RFB_PORT:-$((5900 + DISPLAY_IDX))}"
WEB_PORT="${AGENTD_DESKTOP_WEB_PORT:-6080}"
WIDTH="${AGENTD_DESKTOP_WIDTH:-1280}"
HEIGHT="${AGENTD_DESKTOP_HEIGHT:-800}"
DEPTH="${AGENTD_DESKTOP_DEPTH:-24}"

# ── Helpers and constants (must precede the idempotent check) ────────

NOVNC_VERSION="v1.7.0"
NOVNC_INSTALL_DIR="/usr/share/novnc"
NOVNC_TARBALL="novnc-${NOVNC_VERSION}.tar.gz"
NOVNC_URL="https://github.com/novnc/noVNC/archive/refs/tags/${NOVNC_VERSION}.tar.gz"

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
  # Phase 2: system packages present. Ensure noVNC web assets are too.
  # On alpine/arch this fetches from GitHub; on debian/rhel the distro
  # package already provided /usr/share/novnc/vnc.html, so
  # install_novnc_from_release no-ops.
  if ! [ -e "${NOVNC_INSTALL_DIR}/vnc.html" ]; then
    install_novnc_from_release || {
      echo "AGENTD_DESKTOP_INSTALL_HINT=install_novnc_from_release failed; check curl/wget availability and GitHub reachability" >&2
      exit 1
    }
  fi
  echo "AGENTD_DESKTOP_ALREADY_INSTALLED=Xvfb:$DISPLAY_IDX,x11vnc,novnc:${NOVNC_INSTALL_DIR}/vnc.html"
  exit 0
fi

# ── Phase 1: detect package manager + emit install hint ─────────────

if command -v apk >/dev/null 2>&1; then
  # alpine — Xvfb, icewm, x11vnc, websockify, xdotool, imagemagick
  # are all in the community repo. **noVNC is NOT in the package list**
  # because alpine's `novnc` apk package is an empty shell (only 5
  # metadata files, no vnc.html). Phase 2 above fetches noVNC from
  # GitHub instead.
  PKGS="xorg-server-xvfb icewm x11vnc websockify xdotool imagemagick"
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
  PKGS="xvfb icewm x11vnc websockify novnc xdotool imagemagick fonts-noto-cjk"
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
  PKGS="xorg-x11-server-Xvfb icewm x11vnc websockify novnc xdotool ImageMagick"
  echo "AGENTD_DESKTOP_MISSING_TOOLS=gui-stack"
  echo "AGENTD_DESKTOP_DISTRO=rhel"
  emit_hint "$PM" "$PKGS"
elif command -v pacman >/dev/null 2>&1; then
  # arch — AUR has novnc, but the binary repos don't. Phase 2 fetches
  # from GitHub instead.
  PKGS="xorg-server-xvfb icewm x11vnc websockify xdotool imagemagick"
  echo "AGENTD_DESKTOP_MISSING_TOOLS=gui-stack"
  echo "AGENTD_DESKTOP_DISTRO=arch"
  emit_hint "pacman -Sy --noconfirm --needed" "$PKGS"
else
  echo "AGENTD_DESKTOP_MISSING_TOOLS=unknown-package-manager"
  echo "AGENTD_DESKTOP_INSTALL_HINT=(no apk/apt/dnf/yum/pacman detected; install xvfb icewm x11vnc websockify xdotool imagemagick manually)" >&2
  exit 1
fi
