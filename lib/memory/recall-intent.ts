/**
 * Recall-intent detection (OpenClaw active-memory `escalate` analogue).
 *
 * Lane 1 (default recall) runs on every turn with cheap parameters.
 * Lane 2 (deep recall) only pays for wider retrieval when the message
 * actually asks about the past — explicit references to prior
 * conversations, temporal phrasing, or questions about earlier
 * decisions. Detection here is deliberately deterministic (no model
 * call): the whole point of the two-lane split is that deciding WHICH
 * lane to use must cost nothing.
 *
 * English + Chinese patterns; both are first-class because agentboster
 * sessions are commonly zh/en mixed.
 */

/** Deeper-retrieval parameters for recall-intent turns. */
export const DEEP_RECALL_TOP_K = 10;
export const DEEP_RECALL_MIN_CONFIDENCE = 0.03;

const RECALL_INTENT_PATTERNS: RegExp[] = [
  // English — explicit memory / past references.
  /\bremember\b/i,
  /\bremind me (what|how|when|where|why)\b/i,
  /\blast (time|week|month|year)\b/i,
  /\b(?:a|the) (?:while|few (?:days|weeks|months)) ago\b/i,
  /\bprevious(?:ly)?\b/i,
  /\bearlier\b/i,
  /\bbefore\b.*\b(?:we|i|you) (?:discussed|talked|said|decided|chose)\b/i,
  /\bwe (?:discussed|talked about|decided|agreed)\b/i,
  /\bwhat did (?:i|we|you) (?:say|decide|choose|discuss|agree)\b/i,
  /\b(?:back )?(?:in|during) our (?:last|previous) (?:chat|conversation|session)\b/i,
  /\bhistory of\b/i,
  /\bhave (?:i|we) (?:ever|already)\b/i,

  // Chinese — 过去引用 / 时间表述 / 记忆询问。
  /还记得/,
  /记得吗/,
  /上次/,
  /之前(?:说|提|聊|讨论|决定|选)/,
  /以前(?:说|提|聊|讨论|决定|选)/,
  /(?:说|提|聊|讨论|决定|选)过/,
  /当时(?:说|提|决定|选)/,
  /前面(?:说|提|聊)的/,
  /(?:我们|我|你)(?:之前|以前|刚才|上次)?(?:讨论|聊|说|决定)的/,
  /历史(?:记录|消息)/,
  /(?:我|我们)(?:是不是|有没有)(?:说|提|讨论)过/,
];

/**
 * Returns true when the message shows recall intent — it references the
 * past, asks about prior decisions/conversations, or uses temporal
 * phrasing that flat retrieval handles poorly (LongMemEval).
 *
 * Conservative by design: false negatives just mean the turn uses lane-1
 * parameters (current behavior); false positives cost a slightly wider
 * retrieval, never a wrong answer.
 */
export function detectRecallIntent(message: string): boolean {
  const text = message.trim();
  if (text.length < 4) return false;
  return RECALL_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}
