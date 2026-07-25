/**
 * Thin re-export of resolveSpeechModel so callers in lib/audio/ can import
 * it without depending directly on lib/ai (which would create a cycle for
 * modules that also depend on lib/audio — e.g. lib/bot for IM voice).
 *
 * The actual resolver lives in lib/ai/index.ts and is the single source
 * of truth for provider/model resolution.
 */
export { resolveSpeechModel } from '@/lib/ai';
