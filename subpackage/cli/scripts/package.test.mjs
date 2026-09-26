import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('packages the single CI artifact with a working compile-cache launcher', () => {
  // Model a separate CI packaging runner: no workspace build or runtime sidecar.
  const root = mkdtempSync(join(tmpdir(), 'agentboster package '));
  try {
    const dist = join(root, 'packages', 'coding-agent', 'dist');
    const scripts = join(root, 'scripts');
    const mcp = join(root, 'mcp-bin');
    const extracted = join(root, 'extracted');
    for (const dir of [dist, scripts, mcp, extracted]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(dist, '..', 'package.json'), JSON.stringify({
      name: '@agentboster-cli/core',
      version: '0.1.0',
      piConfig: { name: 'agentboster', configDir: '.agentboster' },
    }));
    copyFileSync(new URL('./package.mjs', import.meta.url), join(scripts, 'package.mjs'));
    const runtime = [
      "const { getCompileCacheDir } = require('node:module');",
      'console.log(JSON.stringify({ cacheEnabled: !!getCompileCacheDir(), args: process.argv.slice(2) }));',
    ].join('\n');
    writeFileSync(join(dist, 'agentboster-cli.cjs'), runtime);
    const binary = process.platform === 'win32' ? 'computer-use-mcp.exe' : 'computer-use-mcp';
    writeFileSync(join(mcp, binary), 'synthetic MCP artifact');

    execFileSync(process.execPath, [join(scripts, 'package.mjs')], {
      cwd: root,
      env: { ...process.env, MCP_BINARY_PATH: mcp, AGENTBOSTER_CLI_VERSION: 'test' },
      stdio: 'pipe',
    });
    execFileSync('tar', ['-xzf', join(root, 'agentboster-cli-test.tar.gz'), '-C', extracted]);
    const packaged = join(extracted, 'agentboster-cli-test');
    assert.equal(readFileSync(join(packaged, 'agentboster-cli-runtime.cjs'), 'utf8'), runtime);
    assert.equal(readFileSync(join(packaged, binary), 'utf8'), 'synthetic MCP artifact');
    assert.equal(JSON.parse(readFileSync(join(packaged, 'package.json'), 'utf8')).version, 'test');
    assert.ok(!existsSync(join(root, '.pkg-staging')));

    // No inherited cache setting: the packaged launcher must enable it itself.
    const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
    delete env.NODE_COMPILE_CACHE;
    delete env.NODE_DISABLE_COMPILE_CACHE;
    const output = execFileSync(process.execPath, [join(packaged, 'agentboster-cli.cjs'), '--version'], {
      cwd: extracted,
      env,
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(output), { cacheEnabled: true, args: ['--version'] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
