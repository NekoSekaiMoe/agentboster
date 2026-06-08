import { readAuthSessionFromCookies } from '@/lib/auth';
import {
  readSandboxFileAction,
  runSandboxCommandAction,
  writeSandboxFileAction,
} from '@/lib/core/sandbox/actions';
import { SANDBOX_WORKSPACE_DIR } from '@/lib/core/sandbox/runtime';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const session = await readAuthSessionFromCookies(cookieStore);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { tool, sessionId, params } = body as {
    tool: string;
    sessionId: string;
    params?: Record<string, unknown>;
  };

  if (!tool || !sessionId) {
    return NextResponse.json(
      { error: 'tool and sessionId are required' },
      { status: 400 },
    );
  }

  try {
    switch (tool) {
      case 'exec': {
        const result = await runSandboxCommandAction({
          sessionId,
          command: (params?.command as string) || '',
          args: (params?.args as string[]) || undefined,
          cwd: (params?.cwd as string) || undefined,
          env: (params?.env as Record<string, string>) || undefined,
          sudo: (params?.sudo as boolean) || undefined,
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'exec_background': {
        const result = await runSandboxCommandAction({
          sessionId,
          command: (params?.command as string) || '',
          args: (params?.args as string[]) || undefined,
          cwd: (params?.cwd as string) || undefined,
          env: (params?.env as Record<string, string>) || undefined,
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'read': {
        const result = await readSandboxFileAction({
          sessionId,
          path: (params?.path as string) || '',
          cwd: (params?.cwd as string) || undefined,
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'write': {
        const result = await writeSandboxFileAction({
          sessionId,
          path: (params?.path as string) || '',
          content: (params?.content as string) || '',
          cwd: (params?.cwd as string) || undefined,
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'edit': {
        const readResult = await readSandboxFileAction({
          sessionId,
          path: (params?.path as string) || '',
          cwd: (params?.cwd as string) || undefined,
        });
        const content = readResult.content;
        const oldStr = (params?.old_string as string) || '';
        const newStr = (params?.new_string as string) || '';
        if (!content.includes(oldStr)) {
          return NextResponse.json({
            ok: false,
            error: 'old_string not found in file',
          });
        }
        const newContent = content.replace(oldStr, newStr);
        const writeResult = await writeSandboxFileAction({
          sessionId,
          path: (params?.path as string) || '',
          content: newContent,
          cwd: (params?.cwd as string) || undefined,
        });
        return NextResponse.json({
          ok: true,
          result: { ...writeResult, replaced: true },
        });
      }

      case 'ls': {
        const dirPath = (params?.path as string) || SANDBOX_WORKSPACE_DIR;
        const result = await runSandboxCommandAction({
          sessionId,
          command: `ls -la ${dirPath}`,
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'grep': {
        const pattern = (params?.pattern as string) || '';
        const dirPath = (params?.path as string) || SANDBOX_WORKSPACE_DIR;
        const result = await runSandboxCommandAction({
          sessionId,
          command: `grep -rn ${pattern} ${dirPath}`,
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'glob': {
        const pattern = (params?.pattern as string) || '*';
        const dirPath = (params?.path as string) || SANDBOX_WORKSPACE_DIR;
        const result = await runSandboxCommandAction({
          sessionId,
          command: `find ${dirPath} -name "${pattern}"`,
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'patch': {
        const patchContent = (params?.patch as string) || '';
        const _filePath = (params?.path as string) || '';
        const result = await runSandboxCommandAction({
          sessionId,
          command: `cat > /tmp/patch.diff << 'PATCH_EOF'\n${patchContent}\nPATCH_EOF\npatch -p1 < /tmp/patch.diff`,
          cwd: (params?.cwd as string) || SANDBOX_WORKSPACE_DIR,
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'git_clone':
      case 'git_diff':
      case 'git_status':
      case 'git_push': {
        let command = '';
        const repoPath = (params?.repo_path as string) || SANDBOX_WORKSPACE_DIR;
        switch (tool) {
          case 'git_clone':
            command = `git clone ${(params?.url as string) || ''} ${(params?.target as string) || '.'}`;
            break;
          case 'git_diff':
            command = `git diff ${(params?.args as string) || ''}`;
            break;
          case 'git_status':
            command = 'git status';
            break;
          case 'git_push':
            command = `git add -A && git commit -m "${(params?.message as string) || 'update'}" && git push`;
            break;
        }
        const result = await runSandboxCommandAction({
          sessionId,
          command,
          cwd: repoPath,
          env: (params?.env as Record<string, string>) || undefined,
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'sandbox_install': {
        const packages = (params?.packages as string[]) || [];
        const manager = (params?.manager as string) || 'apt-get';
        let command = '';
        switch (manager) {
          case 'apt-get':
            command = `apt-get update && apt-get install -y ${packages.join(' ')}`;
            break;
          case 'pip':
            command = `pip install ${packages.join(' ')}`;
            break;
          case 'npm':
            command = `npm install -g ${packages.join(' ')}`;
            break;
          case 'go':
            command = packages.map((p) => `go install ${p}`).join(' && ');
            break;
          default:
            command = `${manager} ${packages.join(' ')}`;
        }
        const result = await runSandboxCommandAction({
          sessionId,
          command,
          sudo: manager === 'apt-get',
        });
        return NextResponse.json({ ok: true, result });
      }

      case 'memory_search': {
        const { searchLongTermMemories } = await import(
          '@/lib/memory/long-term'
        );
        const query = (params?.query as string) || '';
        const results = await searchLongTermMemories({
          query,
          minConfidence: (params?.min_confidence as number) || 0.2,
          page: 1,
          pageSize: 10,
        });
        return NextResponse.json({ ok: true, result: results });
      }

      case 'memory_save': {
        const { createLongTermMemory } = await import('@/lib/memory/long-term');
        const content = (params?.content as string) || '';
        if (!content) {
          return NextResponse.json({ ok: false, error: 'content is required' });
        }
        const result = await createLongTermMemory({ content });
        return NextResponse.json({ ok: true, result });
      }

      case 'web_fetch': {
        const url = (params?.url as string) || '';
        if (!url) {
          return NextResponse.json({ ok: false, error: 'url is required' });
        }
        const fetchResult = await fetch(url, {
          headers: { 'User-Agent': 'AgentBoster/1.0' },
          signal: AbortSignal.timeout(30000),
        });
        const text = await fetchResult.text();
        return NextResponse.json({
          ok: true,
          result: {
            status: fetchResult.status,
            body: text.substring(0, 50000),
          },
        });
      }

      case 'web_search': {
        const query = (params?.query as string) || '';
        if (!query) {
          return NextResponse.json({ ok: false, error: 'query is required' });
        }
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const searchResult = await fetch(searchUrl, {
          headers: { 'User-Agent': 'AgentBoster/1.0' },
          signal: AbortSignal.timeout(15000),
        });
        const html = await searchResult.text();
        const results: Array<{ title: string; url: string; snippet: string }> =
          [];
        const resultRegex =
          /<a rel="nofollow" class="result__a" href="([^"]+)">([^<]+)<\/a>.*?<a class="result__snippet"[^>]*>([^<]+)<\/a>/gs;
        let match: RegExpExecArray | null = resultRegex.exec(html);
        while (match !== null && results.length < 5) {
          results.push({ url: match[1], title: match[2], snippet: match[3] });
          match = resultRegex.exec(html);
        }
        return NextResponse.json({ ok: true, result: results });
      }

      case 'subagent': {
        const task = (params?.task as string) || '';
        if (!task) {
          return NextResponse.json({ ok: false, error: 'task is required' });
        }
        return NextResponse.json({
          ok: false,
          error:
            'subagent is not available in Vercel Sandbox mode. Use the main agent directly.',
          unavailable: true,
        });
      }

      case 'sandbox_snapshot': {
        return NextResponse.json({
          ok: false,
          error: 'sandbox_snapshot is not available in Vercel Sandbox mode.',
          unavailable: true,
        });
      }

      case 'ask_question': {
        return NextResponse.json({
          ok: false,
          error:
            'ask_question is not available in Vercel Sandbox mode. Please reply directly in the chat.',
          unavailable: true,
        });
      }

      default:
        return NextResponse.json(
          { ok: false, error: `Unknown tool: ${tool}` },
          { status: 400 },
        );
    }
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}
