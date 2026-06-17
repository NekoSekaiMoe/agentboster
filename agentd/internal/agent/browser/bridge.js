/**
 * agentd browser bridge — Playwright helper inside the sandbox.
 *
 * Lifecycle:
 *   - Started on first browser_* tool call via EnsureBridge (browser.go).
 *   - Daemon invokes it through `sbMgr.Exec("curl --unix-socket ...")`.
 *   - Lives for the lifetime of the sandbox. SIGHUP on sandbox teardown
 *     closes all contexts and exits.
 *
 * Profile model mirrors the serverless browser pool (lib/mcp/browser/pool.ts):
 *   - launchPersistentContext with profile dir = /workspace/browser-profiles/<profile>/
 *     → cookies + localStorage persist on disk automatically.
 *   - storageState.json inside the profile dir is an *additional* explicit
 *     snapshot that can be exported/imported for cross-side interop
 *     (serverless browser_load_state accepts the same JSON shape).
 *
 * Anti-detection is aligned with the serverless side:
 *   - realistic Chrome UA (no AgentBoster token)
 *   - --disable-blink-features=AutomationControlled
 *   - navigator.webdriver masked via addInitScript
 *
 * HTTP API (all responses: { ok: true, data: ... } | { ok: false, error: ... }):
 *   GET  /health
 *   POST /navigate      { url, profile?, user_agent?, wait_until?, timeout_ms?, width?, height? }
 *   POST /click         { profile?, selector?, x?, y?, button?, click_count?, timeout_ms? }
 *   POST /type          { profile?, selector?, text, clear?, press_enter?, delay_ms?, timeout_ms? }
 *   GET  /get-text      ?profile=&selector=&max_length=&timeout_ms=
 *   GET  /get-html      ?profile=&selector=&max_length=&timeout_ms=
 *   POST /screenshot    { profile?, selector?, full_page?, type?, quality?, timeout_ms? }
 *   POST /evaluate      { profile?, script, timeout_ms? }
 *   POST /save-state    { profile? }                                 → writes storageState.json, returns it
 *   POST /load-state    { profile, state }                           → overwrites storageState.json, closes current context
 *   GET  /list-profiles                                                 → scans PROFILES_ROOT dirs
 *   POST /close          { profile? }                                  → close current context
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SOCKET_PATH = process.env.AGENTD_BROWSER_SOCKET || '/workspace/browser.sock';
const PROFILES_ROOT = process.env.AGENTD_PROFILES_ROOT || '/workspace/browser-profiles';
const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_TEXT_LIMIT = 20000;
const DEFAULT_HTML_LIMIT = 50000;

// profile → { context, page, profileDir }
const sessions = new Map();

function log(level, msg, extra) {
  const line = { ts: new Date().toISOString(), level, msg };
  if (extra) Object.assign(line, extra);
  process.stdout.write(JSON.stringify(line) + '\n');
}

async function getOrCreateSession(profile, options = {}) {
  if (sessions.has(profile)) return sessions.get(profile);

  const profileDir = path.join(PROFILES_ROOT, profile);
  await fs.promises.mkdir(profileDir, { recursive: true });

  const launchOptions = {
    headless: true,
    userAgent: options.userAgent || DEFAULT_UA,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    viewport: { width: 1280, height: 720 },
  };

  log('info', 'launch_persistent_context', { profile, profileDir });
  const context = await chromium.launchPersistentContext(profileDir, launchOptions);

  // Mask navigator.webdriver — the loudest headless signal Cloudflare/Akamai probe.
  // Not full stealth (no canvas/webGL spoofing); matches the serverless side exactly.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true,
    });
  });

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  const session = { context, page, profileDir };
  sessions.set(profile, session);
  return session;
}

function resolveProfile(body) {
  const p = (body && body.profile && String(body.profile).trim()) || 'default';
  return p;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // Defensive cap: 5MB. Screenshots etc. are GET; bodies here are small.
      if (data.length > 5 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function truncate(value, maxLength) {
  if (typeof value !== 'string') return value;
  if (value.length <= maxLength) return value;
  const removed = value.length - maxLength;
  return value.slice(0, maxLength) + `\n\n[truncated: ${removed} characters removed]`;
}

function requireSession(profile) {
  const session = sessions.get(profile);
  if (!session) {
    const err = new Error(
      `no active session for profile "${profile}". Call /navigate first.`,
    );
    err.code = 'NO_SESSION';
    throw err;
  }
  return session;
}

function waitUntilEnum(v) {
  if (v === 'commit' || v === 'domcontentloaded' || v === 'load' || v === 'networkidle') {
    return v;
  }
  return 'domcontentloaded';
}

function positiveInt(v, fallback) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function sanitizeFilename(name) {
  // Profiles become directory names; block path traversal.
  if (typeof name !== 'string' || name.length === 0) return null;
  if (/[\/\\\0]/.test(name)) return null;
  if (name === '.' || name === '..') return null;
  return name;
}

async function handleNavigate(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  if (!body || typeof body.url !== 'string' || !/^https?:\/\//.test(body.url)) {
    return sendJSON(res, 400, { ok: false, error: 'invalid url' });
  }
  const session = await getOrCreateSession(profile, { userAgent: body.user_agent });

  const width = positiveInt(body.width, 0);
  const height = positiveInt(body.height, 0);
  if (width > 0 && height > 0) {
    await session.page.setViewportSize({ width, height });
  }

  const response = await session.page.goto(body.url, {
    waitUntil: waitUntilEnum(body.wait_until),
    timeout: positiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS),
  });
  const title = await session.page.title();
  return sendJSON(res, 200, {
    ok: true,
    data: {
      url: session.page.url(),
      title,
      status: response ? response.status() : null,
      ok: response ? response.ok() : null,
    },
  });
}

async function handleClick(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const timeout = positiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS);
  const button = body.button === 'middle' || body.button === 'right' ? body.button : 'left';
  const clickCount = Math.min(Math.max(positiveInt(body.click_count, 1), 1), 3);

  if (body.selector && typeof body.selector === 'string') {
    await session.page
      .locator(body.selector)
      .click({ button, clickCount, timeout });
    return sendJSON(res, 200, {
      ok: true,
      data: { clicked: body.selector, button, clickCount },
    });
  }

  const x = Number(body.x);
  const y = Number(body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return sendJSON(res, 400, { ok: false, error: 'provide either selector, or both x and y' });
  }
  await session.page.mouse.click(x, y, { button, clickCount });
  return sendJSON(res, 200, { ok: true, data: { clicked: [x, y], button, clickCount } });
}

async function handleType(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  if (typeof body.text !== 'string' || body.text.length === 0) {
    return sendJSON(res, 400, { ok: false, error: 'text is required' });
  }

  const timeout = positiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS);
  const delay = Math.min(Math.max(positiveInt(body.delay_ms, 0), 0), 1000);

  if (body.selector && typeof body.selector === 'string') {
    const locator = session.page.locator(body.selector);
    if (body.clear) {
      await locator.fill(body.text, { timeout });
    } else {
      await locator.click({ timeout });
      await locator.pressSequentially(body.text, { delay, timeout });
    }
  } else {
    await session.page.keyboard.type(body.text, { delay });
  }

  if (body.press_enter) {
    await session.page.keyboard.press('Enter');
  }

  return sendJSON(res, 200, {
    ok: true,
    data: { typed: body.text.length, press_enter: Boolean(body.press_enter) },
  });
}

async function handleGetText(req, res, params) {
  const profile = sanitizeFilename(params.profile || 'default');
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const timeout = positiveInt(params.timeout_ms, DEFAULT_TIMEOUT_MS);
  const limit = Math.min(positiveInt(params.max_length, DEFAULT_TEXT_LIMIT), DEFAULT_TEXT_LIMIT);
  const selector = typeof params.selector === 'string' && params.selector ? params.selector : null;

  const text = selector
    ? await session.page.locator(selector).innerText({ timeout })
    : await session.page.locator('body').innerText({ timeout });

  return sendJSON(res, 200, { ok: true, data: { text: truncate(text, limit) } });
}

async function handleGetHtml(req, res, params) {
  const profile = sanitizeFilename(params.profile || 'default');
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const timeout = positiveInt(params.timeout_ms, DEFAULT_TIMEOUT_MS);
  const limit = Math.min(positiveInt(params.max_length, DEFAULT_HTML_LIMIT), DEFAULT_HTML_LIMIT);
  const selector = typeof params.selector === 'string' && params.selector ? params.selector : null;

  const html = selector
    ? await session.page.locator(selector).innerHTML({ timeout })
    : await session.page.content();

  return sendJSON(res, 200, { ok: true, data: { html: truncate(html, limit) } });
}

async function handleScreenshot(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const type = body.type === 'jpeg' ? 'jpeg' : 'png';
  const timeout = positiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS);
  const options = { type, timeout };
  if (type === 'jpeg' && Number.isFinite(Number(body.quality))) {
    options.quality = Math.min(Math.max(Math.floor(Number(body.quality)), 0), 100);
  }

  const buf =
    body.selector && typeof body.selector === 'string'
      ? await session.page.locator(body.selector).screenshot(options)
      : await session.page.screenshot({ ...options, fullPage: Boolean(body.full_page) });

  return sendJSON(res, 200, {
    ok: true,
    data: {
      bytes: buf.length,
      mime: `image/${type}`,
      base64: buf.toString('base64'),
    },
  });
}

async function handleEvaluate(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  if (typeof body.script !== 'string' || body.script.trim().length === 0) {
    return sendJSON(res, 400, { ok: false, error: 'script is required' });
  }
  if (body.script.length > 10000) {
    return sendJSON(res, 400, { ok: false, error: 'script too long (max 10000 chars)' });
  }

  const timeout = positiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS);
  session.page.setDefaultTimeout(timeout);

  // Wrap as expression first, fall back to statement. Matches the serverless
  // browser_evaluate semantics so L0 output rules see the same envelope.
  const result = await session.page.evaluate(`(() => {
    const source = ${JSON.stringify(body.script)};
    try {
      return Function('"use strict"; return (' + source + ');')();
    } catch (expressionError) {
      if (expressionError instanceof SyntaxError) {
        return Function('"use strict";' + source)();
      }
      throw expressionError;
    }
  })()`);

  // Result may be undefined / function / circular — coerce to a safe shape.
  let safe;
  try {
    safe = JSON.parse(JSON.stringify(result ?? null));
  } catch (_) {
    safe = String(result);
  }

  return sendJSON(res, 200, { ok: true, data: { result: safe } });
}

async function handleSaveState(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const state = await session.context.storageState();
  await fs.promises.writeFile(
    path.join(session.profileDir, 'storageState.json'),
    JSON.stringify(state),
  );

  return sendJSON(res, 200, {
    ok: true,
    data: {
      profile,
      cookieCount: Array.isArray(state.cookies) ? state.cookies.length : 0,
      originCount: Array.isArray(state.origins) ? state.origins.length : 0,
      // Echo the full blob so a host (daemon → memory_save → serverless)
      // can capture it from the tool result without a second round-trip.
      storageState: state,
    },
  });
}

async function handleLoadState(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  if (!body || body.state == null) {
    return sendJSON(res, 400, { ok: false, error: 'state is required' });
  }

  let parsed;
  if (typeof body.state === 'string') {
    try {
      parsed = JSON.parse(body.state);
    } catch (e) {
      return sendJSON(res, 400, { ok: false, error: 'state must be valid JSON' });
    }
  } else {
    parsed = body.state;
  }
  if (typeof parsed !== 'object' || parsed === null || !('cookies' in parsed)) {
    return sendJSON(res, 400, {
      ok: false,
      error: 'state must be a Playwright storageState object (needs cookies field)',
    });
  }

  const profileDir = path.join(PROFILES_ROOT, profile);
  await fs.promises.mkdir(profileDir, { recursive: true });

  // Close existing in-memory context so the next launch re-reads the new state.
  const existing = sessions.get(profile);
  if (existing) {
    await existing.context.close().catch(() => {});
    sessions.delete(profile);
  }

  await fs.promises.writeFile(
    path.join(profileDir, 'storageState.json'),
    JSON.stringify(parsed),
  );

  return sendJSON(res, 200, { ok: true, data: { profile, loaded: true } });
}

async function handleListProfiles(req, res) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(PROFILES_ROOT, { withFileTypes: true });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const profiles = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ profile: e.name, active: sessions.has(e.name) }));
  return sendJSON(res, 200, { ok: true, data: { profiles } });
}

async function handleClose(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = sessions.get(profile);
  if (!session) {
    return sendJSON(res, 200, { ok: true, data: { closed: false } });
  }
  await session.context.close().catch(() => {});
  sessions.delete(profile);
  return sendJSON(res, 200, { ok: true, data: { closed: true } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const method = req.method;
  const params = Object.fromEntries(url.searchParams.entries());

  try {
    if (pathname === '/health' && method === 'GET') {
      return sendJSON(res, 200, {
        ok: true,
        data: { sessions: sessions.size, profiles: [...sessions.keys()], uptime: process.uptime() },
      });
    }

    if (pathname === '/navigate' && method === 'POST') {
      return await handleNavigate(req, res, await parseBody(req));
    }
    if (pathname === '/click' && method === 'POST') {
      return await handleClick(req, res, await parseBody(req));
    }
    if (pathname === '/type' && method === 'POST') {
      return await handleType(req, res, await parseBody(req));
    }
    if (pathname === '/get-text' && method === 'GET') {
      return await handleGetText(req, res, params);
    }
    if (pathname === '/get-html' && method === 'GET') {
      return await handleGetHtml(req, res, params);
    }
    if (pathname === '/screenshot' && method === 'POST') {
      return await handleScreenshot(req, res, await parseBody(req));
    }
    if (pathname === '/evaluate' && method === 'POST') {
      return await handleEvaluate(req, res, await parseBody(req));
    }
    if (pathname === '/save-state' && method === 'POST') {
      return await handleSaveState(req, res, await parseBody(req));
    }
    if (pathname === '/load-state' && method === 'POST') {
      return await handleLoadState(req, res, await parseBody(req));
    }
    if (pathname === '/list-profiles' && method === 'GET') {
      return await handleListProfiles(req, res);
    }
    if (pathname === '/close' && method === 'POST') {
      return await handleClose(req, res, await parseBody(req));
    }

    return sendJSON(res, 404, { ok: false, error: `not found: ${method} ${pathname}` });
  } catch (e) {
    const status = e && e.code === 'NO_SESSION' ? 400 : 500;
    log('error', 'request_failed', {
      method,
      path: pathname,
      error: e && e.message ? e.message : String(e),
      stack: e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : undefined,
    });
    return sendJSON(res, status, {
      ok: false,
      error: e && e.message ? e.message : String(e),
    });
  }
});

// Clean up any stale socket file left by a crashed predecessor.
try {
  fs.unlinkSync(SOCKET_PATH);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}

server.listen(SOCKET_PATH, async () => {
  // Sandbox may run helpers under a different uid than the daemon's curl caller;
  // open the socket wide. (Same trust domain: inside one sandbox.)
  try {
    await fs.promises.chmod(SOCKET_PATH, 0o777);
  } catch (_) {
    // best-effort
  }
  log('info', 'listening', { socket: SOCKET_PATH, profilesRoot: PROFILES_ROOT });
});

// Graceful teardown. Sandbox destruction sends SIGHUP (nohup) which lands here.
const shutdown = async (signal) => {
  log('info', 'shutdown_started', { signal });
  for (const [profile, session] of sessions) {
    try {
      await session.context.close();
    } catch (e) {
      log('warn', 'context_close_failed', { profile, error: e.message });
    }
  }
  sessions.clear();
  try {
    await new Promise((resolve) => server.close(resolve));
  } catch (_) {}
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch (_) {}
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (e) => {
  log('error', 'uncaught_exception', { error: e.message, stack: e.stack });
});
process.on('unhandledRejection', (e) => {
  log('error', 'unhandled_rejection', { error: e && e.message ? e.message : String(e) });
});
