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

  // Multi-tab model: every session tracks a Map<tabId, Page> plus the
  // current tab id. session.page is kept as an alias to the current tab
  // so existing single-tab handlers (click/type/get-text/...) work
  // unchanged when there is only one tab.
  const tabs = new Map();
  const initialTabId = 'tab-1';
  tabs.set(initialTabId, page);
  const session = {
    context,
    page,
    profileDir,
    tabs,
    currentTabId: initialTabId,
    tabSeq: 1,
  };
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

/**
 * resolveLocator builds a Playwright Locator from one of several selector
 * strategies the caller may pass. Priority order:
 *
 *   1. selector  — raw CSS / Playwright selector (most flexible, default)
 *   2. role      — ARIA role + optional name (e.g. { role: 'button', role_name: 'Login' })
 *                  Maps to page.getByRole(role, { name }). Robust against
 *                  dynamic Tailwind classes.
 *   3. label     — <label>/aria-label text (page.getByLabel). Best for inputs.
 *   4. text      — exact or substring text (page.getByText). Use when the
 *                  element has no good role/label.
 *   5. placeholder — form placeholder (page.getByPlaceholder).
 *
 * Returns { locator, describe } where `describe` is a short string for the
 * tool result so the LLM can see which strategy actually fired. Throws if
 * none of the selector strategies is provided.
 *
 * `frameChain` is an optional array of selectors for nested iframes; each
 * entry is resolved as a frameLocator inside the previous one. Helps with
 * sites that wrap content in cross-origin iframes (the helper handles
 * same-origin shadow DOM automatically via Playwright's CSS engine).
 */
function resolveLocator(page, options, frameChain) {
  const opts = options || {};

  let root = page;
  if (Array.isArray(frameChain) && frameChain.length > 0) {
    for (const frameSelector of frameChain) {
      root = root.frameLocator(frameSelector);
    }
  }

  if (typeof opts.selector === 'string' && opts.selector.trim() !== '') {
    return {
      locator: root.locator(opts.selector),
      describe: `selector=${opts.selector}`,
    };
  }

  if (typeof opts.role === 'string' && opts.role.trim() !== '') {
    const roleOpts = {};
    if (typeof opts.role_name === 'string' && opts.role_name.trim() !== '') {
      roleOpts.name = opts.role_name;
    }
    if (typeof opts.role_exact === 'boolean') roleOpts.exact = opts.role_exact;
    if (typeof opts.role_checked === 'boolean') roleOpts.checked = opts.role_checked;
    if (typeof opts.role_pressed === 'boolean') roleOpts.pressed = opts.role_pressed;
    if (typeof opts.role_level === 'number') roleOpts.level = opts.role_level;
    return {
      locator: root.getByRole(opts.role, roleOpts),
      describe: `role=${opts.role}${roleOpts.name ? ` name=${JSON.stringify(roleOpts.name)}` : ''}`,
    };
  }

  if (typeof opts.label === 'string' && opts.label.trim() !== '') {
    const labelOpts = { exact: opts.label_exact === true };
    return {
      locator: root.getByLabel(opts.label, labelOpts),
      describe: `label=${JSON.stringify(opts.label)}`,
    };
  }

  if (typeof opts.placeholder === 'string' && opts.placeholder.trim() !== '') {
    return {
      locator: root.getByPlaceholder(opts.placeholder, { exact: opts.placeholder_exact === true }),
      describe: `placeholder=${JSON.stringify(opts.placeholder)}`,
    };
  }

  if (typeof opts.text === 'string' && opts.text.trim() !== '') {
    const textOpts = { exact: opts.text_exact === true };
    return {
      locator: root.getByText(opts.text, textOpts),
      describe: `text=${JSON.stringify(opts.text)}`,
    };
  }

  const err = new Error(
    'no selector strategy provided; pass one of: selector, role (+role_name), label, placeholder, text',
  );
  err.code = 'NO_SELECTOR';
  throw err;
}

async function handleClick(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const timeout = positiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS);
  const button = body.button === 'middle' || body.button === 'right' ? body.button : 'left';
  const clickCount = Math.min(Math.max(positiveInt(body.click_count, 1), 1), 3);

  // Selector strategies (selector / role / label / placeholder / text)
  // take precedence over coordinate click.
  const hasStrategy =
    (typeof body.selector === 'string' && body.selector.trim() !== '') ||
    (typeof body.role === 'string' && body.role.trim() !== '') ||
    (typeof body.label === 'string' && body.label.trim() !== '') ||
    (typeof body.placeholder === 'string' && body.placeholder.trim() !== '') ||
    (typeof body.text === 'string' && body.text.trim() !== '');

  if (hasStrategy) {
    const { locator, describe } = resolveLocator(session.page, body, body.frame_chain);
    await locator.click({ button, clickCount, timeout });
    return sendJSON(res, 200, {
      ok: true,
      data: { clicked: describe, button, clickCount },
    });
  }

  const x = Number(body.x);
  const y = Number(body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return sendJSON(res, 400, {
      ok: false,
      error: 'provide one of: selector, role (+role_name), label, placeholder, text, or both x and y',
    });
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

  // type() uses `text` as the value to type, so the locator-strategy
  // `text` is intentionally skipped — use selector/role/label/placeholder
  // to disambiguate the target. Falling back to focused-element when none
  // of these is provided (matches the serverless-side semantics).
  const locatorOpts = {
    selector: body.selector,
    role: body.role,
    role_name: body.role_name,
    label: body.label,
    placeholder: body.placeholder,
  };
  const hasLocatorStrategy =
    (typeof locatorOpts.selector === 'string' && locatorOpts.selector.trim() !== '') ||
    (typeof locatorOpts.role === 'string' && locatorOpts.role.trim() !== '') ||
    (typeof locatorOpts.label === 'string' && locatorOpts.label.trim() !== '') ||
    (typeof locatorOpts.placeholder === 'string' && locatorOpts.placeholder.trim() !== '');

  if (hasLocatorStrategy) {
    const { locator, describe } = resolveLocator(session.page, locatorOpts, body.frame_chain);
    if (body.clear) {
      await locator.fill(body.text, { timeout });
    } else {
      await locator.click({ timeout });
      await locator.pressSequentially(body.text, { delay, timeout });
    }
    if (body.press_enter) {
      await session.page.keyboard.press('Enter');
    }
    return sendJSON(res, 200, {
      ok: true,
      data: { typed_into: describe, chars: body.text.length, press_enter: Boolean(body.press_enter) },
    });
  }

  await session.page.keyboard.type(body.text, { delay });
  if (body.press_enter) {
    await session.page.keyboard.press('Enter');
  }
  return sendJSON(res, 200, {
    ok: true,
    data: { typed_into: 'focused', chars: body.text.length, press_enter: Boolean(body.press_enter) },
  });
}

async function handleSelectOption(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const timeout = positiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS);
  const values = Array.isArray(body.values) ? body.values.filter((v) => v !== null && v !== '') : [];
  const single = typeof body.value === 'string' || typeof body.value === 'number';
  if (values.length === 0 && !single) {
    return sendJSON(res, 400, { ok: false, error: 'provide "value" (single) or "values" (array)' });
  }
  const allValues = values.length > 0
    ? values.map(String)
    : [String(body.value)];

  try {
    const { locator, describe } = resolveLocator(session.page, body, body.frame_chain);
    const selected = await locator.selectOption(allValues, { timeout });
    return sendJSON(res, 200, {
      ok: true,
      data: { selected_into: describe, selected_count: selected.length, requested: allValues.length },
    });
  } catch (e) {
    return sendJSON(res, 400, {
      ok: false,
      error: `selectOption failed: ${e.message || e}. Element must be an <input type=checkbox|radio> or <select>.`,
    });
  }
}

async function handleHover(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const timeout = positiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS);
  const modifiers = Array.isArray(body.modifiers)
    ? body.modifiers.filter((m) => ['Shift', 'Control', 'Alt', 'Meta'].includes(m))
    : undefined;

  try {
    const { locator, describe } = resolveLocator(session.page, body, body.frame_chain);
    await locator.hover({ timeout, modifiers });
    return sendJSON(res, 200, { ok: true, data: { hovered: describe, modifiers: modifiers || [] } });
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: `hover failed: ${e.message || e}` });
  }
}

async function handleUpload(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const timeout = positiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS);
  // Three input shapes supported:
  //   paths: "/abs/file1,/abs/file2"   (comma-separated; sandbox-friendly)
  //   paths_array: ["/abs/file1", "/abs/file2"]
  //   payload + name (+ mime): single in-memory file (no sandbox filesystem hit)
  let paths = null;
  if (typeof body.paths === 'string' && body.paths.trim() !== '') {
    paths = body.paths.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (Array.isArray(body.paths_array) && body.paths_array.length > 0) {
    paths = body.paths_array.map(String).filter((s) => s.trim() !== '');
  }

  try {
    const { locator, describe } = resolveLocator(session.page, body, body.frame_chain);

    if (paths) {
      await locator.setInputFiles(paths, { timeout });
      return sendJSON(res, 200, {
        ok: true,
        data: { uploaded_to: describe, mode: 'paths', count: paths.length, paths },
      });
    }

    if (typeof body.payload === 'string' && body.payload.length > 0 && typeof body.name === 'string' && body.name) {
      // payload is raw text; for binary, callers should write to a sandbox path first.
      const buffer = Buffer.from(body.payload, 'utf8');
      await locator.setInputFiles(
        { name: body.name, mimeType: body.mime || 'application/octet-stream', buffer },
        { timeout },
      );
      return sendJSON(res, 200, {
        ok: true,
        data: { uploaded_to: describe, mode: 'payload', name: body.name, bytes: buffer.length },
      });
    }

    return sendJSON(res, 400, {
      ok: false,
      error: 'provide "paths"/"paths_array" (filesystem) or "payload"+"name" (in-memory text)',
    });
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: `upload failed: ${e.message || e}` });
  }
}

async function handleTabNew(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const url = typeof body.url === 'string' ? body.url : 'about:blank';
  const page = await session.context.newPage();
  session.tabSeq += 1;
  const tabId = `tab-${session.tabSeq}`;
  session.tabs.set(tabId, page);
  session.currentTabId = tabId;
  session.page = page;

  if (url && url !== 'about:blank') {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: positiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS) });
    } catch (e) {
      // Navigation failure does not undo the tab creation; report + leave tab open.
      return sendJSON(res, 200, {
        ok: true,
        data: { tabId, url, navigated: false, error: `tab created but navigation failed: ${e.message || e}` },
      });
    }
  }
  return sendJSON(res, 200, { ok: true, data: { tabId, url, navigated: url !== 'about:blank' } });
}

async function handleTabSwitch(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const tabId = typeof body.tab_id === 'string' ? body.tab_id.trim() : '';
  if (!tabId) return sendJSON(res, 400, { ok: false, error: 'tab_id is required' });
  const page = session.tabs.get(tabId);
  if (!page) {
    return sendJSON(res, 404, { ok: false, error: `tab "${tabId}" not found; call /tab-list for valid ids` });
  }
  if (page.isClosed()) {
    session.tabs.delete(tabId);
    return sendJSON(res, 410, { ok: false, error: `tab "${tabId}" was closed` });
  }
  session.currentTabId = tabId;
  session.page = page;
  await page.bringToFront();
  let currentUrl = 'about:blank';
  try { currentUrl = page.url(); } catch (_) {}
  return sendJSON(res, 200, { ok: true, data: { switched_to: tabId, url: currentUrl } });
}

async function handleTabClose(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  // Default: close the current tab.
  const tabId = (typeof body.tab_id === 'string' && body.tab_id.trim()) || session.currentTabId;
  const page = session.tabs.get(tabId);
  if (!page) return sendJSON(res, 404, { ok: false, error: `tab "${tabId}" not found` });

  try { await page.close(); } catch (_) {}
  session.tabs.delete(tabId);

  // Pick a fallback tab if we just closed the current one.
  if (session.currentTabId === tabId) {
    if (session.tabs.size === 0) {
      // Keep the BrowserContext alive with a fresh blank tab so subsequent
      // tool calls don't trip NO_SESSION-style states.
      const blank = await session.context.newPage();
      session.tabSeq += 1;
      const newId = `tab-${session.tabSeq}`;
      session.tabs.set(newId, blank);
      session.currentTabId = newId;
      session.page = blank;
    } else {
      const [nextId, nextPage] = session.tabs.entries().next().value;
      session.currentTabId = nextId;
      session.page = nextPage;
      try { await nextPage.bringToFront(); } catch (_) {}
    }
  }
  return sendJSON(res, 200, { ok: true, data: { closed: tabId, remaining: session.tabs.size, current: session.currentTabId } });
}

async function handleTabList(req, res, bodyOrParams) {
  const body = bodyOrParams && typeof bodyOrParams === 'object' ? bodyOrParams : {};
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const items = [];
  for (const [tabId, page] of session.tabs.entries()) {
    let url = 'about:blank';
    let title = '';
    let closed = false;
    try {
      if (page.isClosed()) {
        closed = true;
      } else {
        url = page.url();
        title = await page.title().catch(() => '');
      }
    } catch (_) {}
    items.push({ tabId, url, title, closed, current: tabId === session.currentTabId });
  }
  return sendJSON(res, 200, { ok: true, data: { tabs: items, current: session.currentTabId, count: items.length } });
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

/**
 * handleInspect scans the page for interactive elements (a, button, input,
 * select, textarea, and elements with role= or onclick), returns a compact
 * list with the most useful Playwright selector strategies for each.
 *
 * Designed to cut token cost when the LLM is asked to click/type on a page
 * with dynamic class names — instead of guessing selectors from raw HTML,
 * the model calls inspect and gets pre-computed { role, name, selector }.
 *
 * Output element shape:
 *   { tag, role, name, text, selector, role_hint, label_hint, placeholder_hint }
 * where:
 *   - selector       = best CSS selector (id > [data-testid] > tag+name)
 *   - role_hint      = { role, name } if get-by-role would work
 *   - label_hint     = label text if findable
 *   - placeholder_hint = placeholder attribute (for inputs)
 *
 * Body params:
 *   - profile           (default: 'default')
 *   - selector          CSS scope (default: 'body')
 *   - limit             max items returned (default 200)
 *   - include_hidden    include elements outside viewport (default false)
 *   - filter_visible_only  alias of include_hidden=false
 */
async function handleInspect(req, res, body) {
  const profile = sanitizeFilename(resolveProfile(body));
  if (!profile) return sendJSON(res, 400, { ok: false, error: 'invalid profile' });
  const session = requireSession(profile);

  const scope = (typeof body.selector === 'string' && body.selector.trim()) || 'body';
  const limit = Math.min(Math.max(positiveInt(body.limit, 200), 1), 500);
  const includeHidden = body.include_hidden === true;

  // Run inside the page so we can read layout/attributes directly.
  const items = await session.page.evaluate(
    ({ scopeSelector, includeHiddenFlag, maxItems }) => {
      const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
      const INTERACTIVE_ROLES = new Set([
        'button', 'link', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox',
        'menuitemradio', 'option', 'switch', 'tab', 'textbox', 'searchbox',
        'combobox', 'listbox', 'spinbutton', 'slider',
      ]);

      /** Build a stable CSS selector for an element if possible. */
      function buildSelector(el) {
        if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) {
          return '#' + CSS.escape(el.id);
        }
        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
        if (testId) return `[data-testid="${testId}"]`;

        // name= attribute on form controls
        const nameAttr = el.getAttribute('name');
        if (nameAttr && INTERACTIVE_TAGS.has(el.tagName)) {
          const tag = el.tagName.toLowerCase();
          return `${tag}[name="${CSS.escape(nameAttr)}"]`;
        }

        // tag + nth-of-type within parent (last-resort positional)
        const tag = el.tagName.toLowerCase();
        const parent = el.parentElement;
        if (!parent) return tag;
        let index = 0;
        let sibling = el;
        while ((sibling = sibling.previousElementSibling) !== null) {
          if (sibling.tagName === el.tagName) index++;
        }
        return `${tag}:nth-of-type(${index + 1})`;
      }

      function getAccessibleName(el) {
        // aria-label wins, then aria-labelledby, then <label for>, then
        // text content (truncated), then title attribute.
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const target = document.getElementById(labelledBy);
          if (target) {
            const txt = (target.textContent || '').trim();
            if (txt) return txt.slice(0, 200);
          }
        }

        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          const id = el.id;
          if (id) {
            const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (label) {
              const txt = (label.textContent || '').trim();
              if (txt) return txt.slice(0, 200);
            }
          }
          // wrapping label
          const wrapping = el.closest('label');
          if (wrapping) {
            const txt = (wrapping.textContent || '').trim();
            if (txt) return txt.slice(0, 200);
          }
        }

        const titleAttr = el.getAttribute('title');
        if (titleAttr && titleAttr.trim()) return titleAttr.trim();

        const txt = (el.textContent || '').trim();
        if (txt && txt.length <= 200) return txt;
        if (txt) return txt.slice(0, 200);
        return '';
      }

      function isVisible(el) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (style.opacity === '0') return false;
        return true;
      }

      const root = document.querySelector(scopeSelector) || document.body;
      const all = root.querySelectorAll('*');
      const out = [];
      for (const el of all) {
        if (out.length >= maxItems) break;

        const tag = el.tagName.toUpperCase();
        const roleAttr = el.getAttribute('role');
        const isInteractive =
          INTERACTIVE_TAGS.has(tag) ||
          (roleAttr && INTERACTIVE_ROLES.has(roleAttr)) ||
          el.hasAttribute('onclick') ||
          el.tabIndex >= 0;
        if (!isInteractive) continue;

        if (!includeHiddenFlag && !isVisible(el)) continue;

        const name = getAccessibleName(el);
        const role =
          roleAttr ||
          (tag === 'A' ? 'link' : tag === 'BUTTON' ? 'button' : '');

        // type attribute for inputs (helps the model pick the right one)
        const typeAttr = tag === 'INPUT' ? el.getAttribute('type') || 'text' : null;

        out.push({
          tag: tag.toLowerCase(),
          type: typeAttr,
          role: role || null,
          name: name || null,
          text: ((el.textContent || '').trim()).slice(0, 100) || null,
          selector: buildSelector(el),
          // Hints that map 1:1 to Playwright getBy* — empty when not viable.
          role_hint: role ? { role, name: name || undefined } : null,
          label_hint:
            tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
              ? name || null
              : null,
          placeholder_hint: el.getAttribute('placeholder') || null,
        });
      }
      return out;
    },
    { scopeSelector: scope, includeHiddenFlag: includeHidden, maxItems: limit },
  );

  return sendJSON(res, 200, {
    ok: true,
    data: {
      scope,
      count: items.length,
      items,
    },
  });
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
    if (pathname === '/select-option' && method === 'POST') {
      return await handleSelectOption(req, res, await parseBody(req));
    }
    if (pathname === '/hover' && method === 'POST') {
      return await handleHover(req, res, await parseBody(req));
    }
    if (pathname === '/upload' && method === 'POST') {
      return await handleUpload(req, res, await parseBody(req));
    }
    if (pathname === '/tab-new' && method === 'POST') {
      return await handleTabNew(req, res, await parseBody(req));
    }
    if (pathname === '/tab-switch' && method === 'POST') {
      return await handleTabSwitch(req, res, await parseBody(req));
    }
    if (pathname === '/tab-close' && method === 'POST') {
      return await handleTabClose(req, res, await parseBody(req));
    }
    if (pathname === '/tab-list' && method === 'POST') {
      return await handleTabList(req, res, await parseBody(req));
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
    if (pathname === '/inspect' && method === 'POST') {
      return await handleInspect(req, res, await parseBody(req));
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
