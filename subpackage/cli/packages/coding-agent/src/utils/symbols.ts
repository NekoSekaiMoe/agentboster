/**
 * Unicode status symbols for TUI rendering.
 *
 * Uses U+25CF (●) instead of emoji to keep width predictable and avoid
 * terminal fallback glyphs. Mirrors the kimi-code symbol set.
 */

// Use U+25CF instead of U+23FA to avoid emoji/fallback rendering in terminals.
export const STATUS_BULLET = '● ';
export const USER_MESSAGE_BULLET = '✨ ';
export const SUCCESS_MARK = '✓ ';
export const FAILURE_MARK = '✗ ';
export const SELECT_POINTER = '❯';
export const CURRENT_MARK = '← current';

// Phase / activity glyphs (ad-hoc, used by tool and subagent renderers).
export const QUEUED_MARK = '○';
export const RUNNING_MARK = '↻';
export const BACKGROUND_MARK = '◐';
export const SUBAGENT_PREFIX = '↳';
export const ABORTED_MARK = '⊘';

// Braille spinner frames for the "thinking" / activity indicator.
export const BRAILLE_SPINNER_FRAMES = [
  '⠋',
  '⠙',
  '⠹',
  '⠸',
  '⠼',
  '⠴',
  '⠦',
  '⠧',
  '⠇',
  '⠏',
];
