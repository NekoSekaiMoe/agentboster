import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LocalCapabilities {
  hasDisplay: boolean;
  platform: string;
  displayServer: string | null;
  isAdmin: boolean;
  scaleFactor: number;
  hasMcpBinary: boolean;
  issues: string[];
}

export function detectLocalCapabilities(): LocalCapabilities {
  const platform = process.platform;
  const issues: string[] = [];

  const { hasDisplay, displayServer } = detectDisplayServer(platform);
  const isAdmin = process.getuid?.() === 0;
  const hasMcpBinary = !!resolveMcpBinary();

  if (!hasDisplay) {
    issues.push(
      'No display server detected. Computer use tools (screenshot, mouse, keyboard) will not be available.',
    );
  }

  if (hasDisplay && !hasMcpBinary) {
    issues.push(
      'computer-use-mcp binary not found. Only local_* tools (file/shell) will be available for remote control.',
    );
  }

  if (platform === 'linux' && displayServer === 'wayland') {
    issues.push(
      'Wayland detected. Some input injection features may be limited. Consider using X11 for full compatibility.',
    );
  }

  return {
    hasDisplay,
    platform,
    displayServer,
    isAdmin,
    scaleFactor: 1,
    hasMcpBinary,
    issues,
  };
}

function detectDisplayServer(platform: string): {
  hasDisplay: boolean;
  displayServer: string | null;
} {
  switch (platform) {
    case 'darwin':
      return { hasDisplay: true, displayServer: 'quartz' };
    case 'win32':
      return { hasDisplay: true, displayServer: 'win32' };
    case 'linux':
      if (process.env.WAYLAND_DISPLAY) {
        return { hasDisplay: true, displayServer: 'wayland' };
      }
      if (process.env.DISPLAY) {
        return { hasDisplay: true, displayServer: 'x11' };
      }
      return { hasDisplay: false, displayServer: null };
    default:
      return { hasDisplay: false, displayServer: null };
  }
}

function resolveMcpBinary(): string | null {
  const binaryName =
    process.platform === 'win32' ? 'computer-use-mcp.exe' : 'computer-use-mcp';
  const selfDir = dirname(process.argv[1] || __filename);
  const siblingPath = join(selfDir, binaryName);
  if (existsSync(siblingPath)) {
    return siblingPath;
  }
  return null;
}
