/**
 * Tests for the local-tool risk assessor.
 *
 * lib/workflow/agent/tools/local/security.ts is the security gate for
 * remote-control / local CLI tools: it scores local_exec commands,
 * local_write_file paths, and key_event combos into a risk level that
 * drives L2 approval. The risk-classification functions are pure; the
 * IM/KV approval plumbing (requestL2ApprovalForRemoteTool) is excluded.
 *
 * Regression focus: the five regex detectors (destructive commands,
 * IFS-obfuscated rm, admin/privilege escalation, network, package
 * install, sensitive paths, dangerous key combos) and the
 * per-level approval policy matrix.
 */

import { describe, expect, it } from 'vitest';
import { assessLocalToolRisk, shouldRequireApproval } from './security';

describe('assessLocalToolRisk — read-only / GUI tools', () => {
  it('classifies read-only tools as low', () => {
    for (const tool of [
      'local_read_file',
      'local_grep',
      'local_ask_question',
    ]) {
      const r = assessLocalToolRisk(tool, {});
      expect(r.level).toBe('low');
      expect(r.ruleId).toBe('rc-read');
    }
  });

  it('classifies GUI observation / interaction tools as low', () => {
    for (const tool of [
      'screenshot',
      'mouse_move',
      'mouse_click',
      'mouse_drag',
      'type_text',
      'get_accessibility_tree',
      'get_focused_element',
    ]) {
      expect(assessLocalToolRisk(tool, {}).level).toBe('low');
    }
  });

  it('classifies unknown tools as medium', () => {
    const r = assessLocalToolRisk('mystery_tool', { x: 1 });
    expect(r.level).toBe('medium');
    expect(r.ruleId).toBe('rc-unknown');
  });
});

describe('assessLocalToolRisk — local_exec destructive commands (block)', () => {
  const blockCases = [
    'rm -rf /',
    'rm -rf /*',
    'rm --recursive --force foo',
    'rm -fr home',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    'fdisk /dev/sda',
    'format c:',
    'shutdown now',
    'reboot',
    'init 0',
    'systemctl halt',
    'systemctl poweroff',
    'systemctl reboot',
    'halt',
    // IFS-obfuscated rm (the second regex)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional shell IFS test case
    'rm ${IFS}-rf /',
    'rm $IFS-rf x',
  ];
  for (const cmd of blockCases) {
    it(`blocks "${cmd}"`, () => {
      const r = assessLocalToolRisk('local_exec', { command: cmd });
      expect(r.level).toBe('block');
      expect(r.ruleId).toBe('rc-exec-block');
    });
  }
});

describe('assessLocalToolRisk — local_exec admin commands (high)', () => {
  const adminCases = [
    'sudo apt update',
    'su root',
    'doas sh',
    'pkexec ls',
    'runas /user:admin cmd',
    'gsudo notepad',
    'chmod 777 /etc/passwd',
    'chmod 666 file',
    'chmod u+s binary',
    'chmod 4755 binary',
    'chown root:root file',
  ];
  for (const cmd of adminCases) {
    it(`flags admin "${cmd}"`, () => {
      const r = assessLocalToolRisk('local_exec', { command: cmd });
      expect(r.level).toBe('high');
      expect(r.ruleId).toBe('rc-exec-admin');
    });
  }
});

describe('assessLocalToolRisk — local_exec network commands (medium)', () => {
  const netCases = [
    'curl https://example.com',
    'wget http://example.com/x',
    'nc -l 4444',
    'ncat example.com 80',
    'nmap -sS 10.0.0.1',
    'telnet example.com 23',
    'ssh user@host',
    'scp file host:/tmp',
    'rsync -av ./ user@host:/dst',
  ];
  for (const cmd of netCases) {
    it(`flags network "${cmd}"`, () => {
      const r = assessLocalToolRisk('local_exec', { command: cmd });
      expect(r.level).toBe('medium');
      expect(r.ruleId).toBe('rc-exec-net');
    });
  }
});

describe('assessLocalToolRisk — local_exec package install (medium)', () => {
  const pkgCases = [
    'npm install left-pad',
    'yarn add react',
    'pip install requests',
    'apt install vim',
    'apt-get install vim',
    'brew install jq',
    'pacman -S gcc',
    'dnf install git',
    'yum install httpd',
    'gem install rails',
    'cargo install ripgrep',
  ];
  for (const cmd of pkgCases) {
    it(`flags package install "${cmd}"`, () => {
      const r = assessLocalToolRisk('local_exec', { command: cmd });
      expect(r.level).toBe('medium');
      expect(r.ruleId).toBe('rc-exec-pkg');
    });
  }
});

describe('assessLocalToolRisk — local_exec benign commands (low)', () => {
  for (const cmd of ['ls -la', 'echo hi', 'git status', 'cat README.md']) {
    it(`allows "${cmd}"`, () => {
      const r = assessLocalToolRisk('local_exec', { command: cmd });
      expect(r.level).toBe('low');
      expect(r.ruleId).toBe('rc-exec-ok');
    });
  }

  it('treats a missing command field as empty string (low)', () => {
    const r = assessLocalToolRisk('local_exec', {});
    expect(r.level).toBe('low');
  });
});

describe('assessLocalToolRisk — local_write_file sensitive paths (high)', () => {
  const sensitivePaths = [
    '/etc/passwd',
    '/etc/shadow',
    '/etc/sudoers',
    '/etc/ssh/sshd_config',
    '/etc/ssl/private.key',
    '/home/user/.ssh/id_rsa',
    '/root/.gnupg/secring.gpg',
    '/home/user/.aws/credentials',
    '/home/user/.config/foo/config',
    'C:\\Users\\x\\.ssh\\id_rsa',
    'D:\\secrets\\.aws\\config',
  ];
  for (const p of sensitivePaths) {
    it(`flags sensitive path "${p}"`, () => {
      const r = assessLocalToolRisk('local_write_file', { path: p });
      expect(r.level).toBe('high');
      expect(r.ruleId).toBe('rc-write-sensitive');
    });
  }
});

describe('assessLocalToolRisk — local_write_file benign paths (low)', () => {
  for (const p of ['/tmp/x.txt', '/home/user/proj/src/index.ts', './README']) {
    it(`allows "${p}"`, () => {
      const r = assessLocalToolRisk('local_write_file', { path: p });
      expect(r.level).toBe('low');
      expect(r.ruleId).toBe('rc-write-ok');
    });
  }

  it('treats a missing path field as empty string (low)', () => {
    expect(assessLocalToolRisk('local_write_file', {}).level).toBe('low');
  });
});

describe('assessLocalToolRisk — key_event dangerous combos (high)', () => {
  const danger = [
    { key: 'del', modifiers: ['ctrl', 'alt'] },
    { key: 'delete', modifiers: ['ctrl', 'alt'] },
    { key: 'f4', modifiers: ['alt'] },
    { key: 'f1', modifiers: ['ctrl', 'alt'] },
    { key: 'F4', modifiers: ['Alt'] }, // case-insensitive
  ];
  for (const { key, modifiers } of danger) {
    it(`flags combo [${modifiers.join('+')}]+${key}`, () => {
      const r = assessLocalToolRisk('key_event', { key, modifiers });
      expect(r.level).toBe('high');
      expect(r.ruleId).toBe('rc-key-danger');
    });
  }
});

describe('assessLocalToolRisk — key_event benign (low)', () => {
  const ok = [
    { key: 'a', modifiers: [] },
    { key: 'c', modifiers: ['ctrl'] },
    { key: 'enter', modifiers: [] },
    { key: 'f4', modifiers: ['ctrl'] }, // ctrl+f4 is fine, only alt+f4
  ];
  for (const { key, modifiers } of ok) {
    it(`allows combo [${modifiers.join('+')}]+${key}`, () => {
      expect(assessLocalToolRisk('key_event', { key, modifiers }).level).toBe(
        'low',
      );
    });
  }
});

describe('shouldRequireApproval — policy matrix', () => {
  it('always requires approval for block, regardless of remote mode', () => {
    expect(
      shouldRequireApproval(
        { level: 'block', reason: 'x', ruleId: 'r' },
        false,
      ),
    ).toBe(true);
    expect(
      shouldRequireApproval({ level: 'block', reason: 'x', ruleId: 'r' }, true),
    ).toBe(true);
  });

  it('never requires approval when NOT in remote-control mode', () => {
    for (const level of ['low', 'medium', 'high'] as const) {
      expect(
        shouldRequireApproval({ level, reason: 'x', ruleId: 'r' }, false),
      ).toBe(false);
    }
  });

  it('requires approval for high and medium in remote-control mode', () => {
    expect(
      shouldRequireApproval({ level: 'high', reason: 'x', ruleId: 'r' }, true),
    ).toBe(true);
    expect(
      shouldRequireApproval(
        { level: 'medium', reason: 'x', ruleId: 'r' },
        true,
      ),
    ).toBe(true);
  });

  it('does NOT require approval for low in remote-control mode', () => {
    expect(
      shouldRequireApproval({ level: 'low', reason: 'x', ruleId: 'r' }, true),
    ).toBe(false);
  });
});

describe('assessLocalToolRisk — detector priority', () => {
  // Pin the order in which the exec detectors run so a future reorder
  // is caught. Priority is: block > admin > network > package > low.
  it('network beats package install ("apt install curl" → net, not pkg)', () => {
    const r = assessLocalToolRisk('local_exec', {
      command: 'apt install curl',
    });
    expect(r.ruleId).toBe('rc-exec-net');
  });

  it('admin beats network ("sudo curl x" → admin, not net)', () => {
    const r = assessLocalToolRisk('local_exec', {
      command: 'sudo curl https://x',
    });
    expect(r.ruleId).toBe('rc-exec-admin');
  });

  it('block beats admin ("sudo rm -rf /" → block, not admin)', () => {
    const r = assessLocalToolRisk('local_exec', { command: 'sudo rm -rf /' });
    expect(r.ruleId).toBe('rc-exec-block');
  });
});
