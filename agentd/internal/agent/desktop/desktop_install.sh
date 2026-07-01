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

# Idempotent: Xvfb + x11vnc on PATH means the stack is already installed.
# We do NOT require all of (icewm, websockify, novnc, xdotool, import)
# because the user may legitimately not want some (e.g. headless
# screenshot-only use case skips noVNC). The caller (EnsureDesktop) will
# emit per-tool hints if a specific tool is later found missing.
if command -v Xvfb >/dev/null 2>&1 && command -v x11vnc >/dev/null 2>&1; then
  echo "AGENTD_DESKTOP_ALREADY_INSTALLED=Xvfb:$DISPLAY_IDX,x11vnc"
  exit 0
fi

# Toolchain preflight. Detect the package manager and emit a single
# AGENTD_DESKTOP_INSTALL_HINT line listing every package needed for the
# full stack. The caller surfaces this to the LLM as a tool-result error,
# so the model can self-recover by running the hint via sandbox.exec and
# retrying. On Alpine (the agentd default LXC distro) the stack is fully
# installable; on debian/ubuntu it is also fully installable; other
# distros emit the hint but may need manual translation.
emit_hint() {
  # $1 = manager command prefix
  # $2 = package list (space-separated)
  echo "AGENTD_DESKTOP_INSTALL_HINT=$1 $2"
  exit 1
}

if command -v apk >/dev/null 2>&1; then
  # alpine — icewm, xvfb, x11vnc, websockify, novnc, xdotool, imagemagick
  # are all in the community repo. `apk add` auto-enables community if
  # the package is missing from main, but on minimal images we add it
  # explicitly to be safe.
  PKGS="xorg-server-xvfb icewm x11vnc websockify novnc xdotool imagemagick"
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
  # debian / ubuntu
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
  PKGS="xorg-x11-server-Xvfb icewm x11vnc websockify novnc xdotool ImageMagick"
  echo "AGENTD_DESKTOP_MISSING_TOOLS=gui-stack"
  echo "AGENTD_DESKTOP_DISTRO=rhel"
  emit_hint "$PM" "$PKGS"
elif command -v pacman >/dev/null 2>&1; then
  # arch
  PKGS="xorg-server-xvfb icewm x11vnc websockify novnc xdotool imagemagick"
  echo "AGENTD_DESKTOP_MISSING_TOOLS=gui-stack"
  echo "AGENTD_DESKTOP_DISTRO=arch"
  emit_hint "pacman -Sy --noconfirm --needed" "$PKGS"
else
  echo "AGENTD_DESKTOP_MISSING_TOOLS=unknown-package-manager"
  echo "AGENTD_DESKTOP_INSTALL_HINT=(no apk/apt/dnf/yum/pacman detected; install xvfb icewm x11vnc websockify novnc xdotool imagemagick manually)" >&2
  exit 1
fi
