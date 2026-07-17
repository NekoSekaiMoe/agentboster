/**
 * Public L2 decision URL-button endpoint.
 *
 * Used by IM adapters that cannot render native callback buttons (QQ,
 * and any future platform whose button API is gated behind per-bot
 * permission approval). The L2 prompt ships markdown links pointing
 * here, of the form:
 *
 *   /api/l2/<decisionId>/<action>?t=<expires>&s=<hex-hmac>
 *
 * `t` and `s` are produced by signL2Link() and verified by
 * verifyL2Link() using AUTH_SECRET. The route is whitelisted in
 * middleware.ts (IM users may have no web account, so the session
 * gate cannot apply). Replay is handled downstream by
 * processL2Decision's `isDecisionProcessed` dedup — a second click
 * returns the "Already processed" message rather than re-firing the
 * verdict.
 *
 * Returns a minimal mobile-friendly HTML page (no JS) so the link
 * works inside any IM client's in-app browser.
 */

export const dynamic = 'force-dynamic';

import { processL2Decision } from '@/lib/extra/agent/l2-decision';
import { getDecisionQueue } from '@/lib/security/l2-index';
import { verifyL2Link } from '@/lib/security/l2-link';
import { createLogger } from '@/lib/utils/logger';

const logger = createLogger('api.l2.resolve');

const VALID_ACTIONS = new Set([
  'pass_once',
  'pass_until',
  'reject_once',
  'reject_until',
]);

export async function GET(
  request: Request,
  context: { params: Promise<{ decisionId: string; action: string }> },
) {
  const { decisionId, action } = await context.params;
  const url = new URL(request.url);

  if (!VALID_ACTIONS.has(action)) {
    return renderPage({
      ok: false,
      title: 'Invalid action',
      body: `Unknown action: ${action}`,
    });
  }

  const verify = await verifyL2Link({
    decisionId,
    action,
    expiresParam: url.searchParams.get('t'),
    signatureParam: url.searchParams.get('s'),
  });
  if (!verify.ok) {
    logger.warn('L2 link verification failed', {
      decisionId,
      action,
      reason: verify.reason,
    });
    return renderPage({
      ok: false,
      title: 'Link invalid',
      body:
        verify.reason === 'expired'
          ? 'This decision link has expired. Reply to the bot to request a new prompt.'
          : 'The decision link signature could not be verified.',
    });
  }

  // Resolve the real taskId from the decision cache. processL2Decision
  // requires a taskId even though it can also recover one from the L2
  // notification context (mgr.getL2Context) — passing the cached value
  // keeps the dedup + forward paths consistent. If the decision has
  // already expired out of the cache, we still pass the decisionId so
  // the dedup check (`isDecisionProcessed`) has a key to look up.
  const decision = getDecisionQueue().get(decisionId);
  const taskId = decision?.taskId ?? decisionId;

  try {
    const result = await processL2Decision({
      taskId,
      decisionId,
      action,
      // pass_until / reject_until need a time input the user cannot
      // supply through a one-shot link. Leave it null so the user is
      // re-prompted in chat (processL2Decision returns
      // awaitingTimeInput and the IM channel gets the follow-up).
      timeInput: null,
    });

    if (result.success) {
      return renderPage({
        ok: true,
        title: 'Decision recorded',
        body: result.message ?? 'Done.',
        detail: result.awaitingTimeInput
          ? 'A follow-up prompt was sent in chat — reply there with the duration.'
          : undefined,
      });
    }
    return renderPage({
      ok: false,
      title: 'Could not process',
      body: result.error ?? 'The decision could not be applied.',
    });
  } catch (error) {
    logger.error('L2 link resolution threw', {
      decisionId,
      action,
      error: error instanceof Error ? error.message : String(error),
    });
    return renderPage({
      ok: false,
      title: 'Server error',
      body: 'Something went wrong while processing the decision.',
    });
  }
}

function renderPage(input: {
  ok: boolean;
  title: string;
  body: string;
  detail?: string;
}): Response {
  const color = input.ok ? '#16a34a' : '#dc2626';
  const emoji = input.ok ? '✅' : '⚠️';
  const detail = input.detail
    ? `<p style="opacity:.7;font-size:14px;margin-top:8px">${escapeHtml(input.detail)}</p>`
    : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>
  body{margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#fafafa;color:#111;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;border-radius:16px;padding:32px;max-width:420px;width:100%;box-shadow:0 1px 3px rgba(0,0,0,.08);border:1px solid #eee}
  .icon{font-size:48px;margin-bottom:12px}
  h1{margin:0 0 8px;font-size:20px;font-weight:600}
  p{margin:0;line-height:1.5}
  .close{margin-top:24px;display:inline-block;font-size:13px;color:${color};text-decoration:none}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${emoji}</div>
    <h1 style="color:${color}">${escapeHtml(input.title)}</h1>
    <p>${escapeHtml(input.body)}</p>
    ${detail}
    <a class="close" href="javascript:void(0)" onclick="self.close()">Close</a>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: input.ok ? 200 : 400,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
