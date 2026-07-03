/**
 * Session list utilities - TypeScript implementation
 * Replaces Rust session parsing to avoid Desktop parsing CLI internals
 */

export interface SessionInfo {
  id: string;
  name?: string;
  path: string;
  cwd?: string;
  createdAt: number;
  modifiedAt: number;
  tokens: number;
  cost: number;
}

interface SessionEntry {
  type?: string;
  id?: string;
  name?: string;
  cwd?: string;
  message?: {
    role?: string;
    usage?: {
      totalTokens?: number;
      cost?: {
        total?: number;
      };
    };
  };
}

async function getSessionsDir(): Promise<string> {
  const { homeDir } = await import('@tauri-apps/api/path');
  const home = await homeDir();
  return `${home}/.agentboster/agent/sessions`;
}

async function collectJsonlFiles(dir: string): Promise<string[]> {
  const { readDir, exists } = await import('@tauri-apps/plugin-fs');

  if (!(await exists(dir))) {
    return [];
  }

  const files: string[] = [];
  const queue = [dir];

  while (queue.length > 0) {
    const current = queue.shift()!;
    try {
      const entries = await readDir(current);

      for (const entry of entries) {
        const fullPath = `${current}/${entry.name}`;

        if (entry.isDirectory) {
          queue.push(fullPath);
          continue;
        }

        if (entry.isFile && entry.name.toLowerCase().endsWith('.jsonl')) {
          files.push(fullPath);
        }
      }
    } catch (err) {
      // Skip directories that can't be read
      console.warn(`Failed to read directory ${current}:`, err);
    }
  }

  return files;
}

async function getFileTimestamps(
  path: string,
): Promise<{ created: number; modified: number }> {
  const { stat } = await import('@tauri-apps/plugin-fs');

  try {
    const stats = await stat(path);
    const modified = stats.mtime?.getTime() ?? 0;
    const created = stats.birthtime?.getTime() ?? stats.mtime?.getTime() ?? 0;

    return { created, modified };
  } catch {
    return { created: 0, modified: 0 };
  }
}

async function parseSessionInfo(filePath: string): Promise<SessionInfo | null> {
  const { readTextFile } = await import('@tauri-apps/plugin-fs');

  try {
    const content = await readTextFile(filePath);
    const lines = content.split('\n');

    // Extract filename as default ID
    const filename = filePath.split('/').pop() ?? 'unknown';
    let id = filename.replace(/\.jsonl$/i, '');
    let name: string | undefined;
    let cwd: string | undefined;
    let tokens = 0;
    let cost = 0.0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const entry: SessionEntry = JSON.parse(trimmed);

        switch (entry.type) {
          case 'session':
            if (entry.id) {
              id = entry.id;
            }
            if (entry.cwd?.trim()) {
              cwd = entry.cwd.trim();
            }
            break;

          case 'session_info':
            if (entry.name?.trim()) {
              name = entry.name.trim();
            }
            break;

          case 'message':
            if (entry.message?.role === 'assistant') {
              const messageTokens = entry.message.usage?.totalTokens ?? 0;
              tokens += messageTokens;

              const messageCost = entry.message.usage?.cost?.total ?? 0;
              cost += messageCost;
            }
            break;
        }
      } catch (parseErr) {}
    }

    const timestamps = await getFileTimestamps(filePath);

    return {
      id,
      name,
      path: filePath,
      cwd,
      createdAt: timestamps.created,
      modifiedAt: timestamps.modified,
      tokens,
      cost,
    };
  } catch (err) {
    console.warn(`Failed to parse session file ${filePath}:`, err);
    return null;
  }
}

export async function listSessions(): Promise<SessionInfo[]> {
  try {
    const sessionsDir = await getSessionsDir();
    const files = await collectJsonlFiles(sessionsDir);

    const sessions = await Promise.all(
      files.map((file) => parseSessionInfo(file)),
    );

    const validSessions = sessions.filter((s): s is SessionInfo => s !== null);

    // Sort by modified time, newest first
    validSessions.sort((a, b) => b.modifiedAt - a.modifiedAt);

    return validSessions;
  } catch (err) {
    console.error('Failed to list sessions:', err);
    return [];
  }
}

export async function getSessionContent(sessionPath: string): Promise<string> {
  const { readTextFile } = await import('@tauri-apps/plugin-fs');

  try {
    return await readTextFile(sessionPath);
  } catch (err) {
    throw new Error(`Failed to read session file: ${err}`);
  }
}
