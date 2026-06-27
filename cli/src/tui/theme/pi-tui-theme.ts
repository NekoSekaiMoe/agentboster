import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from '@earendil-works/pi-tui';
import type { Styles } from './styles';

/**
 * Build the theme objects pi-tui components want, from our Styles
 * helper. Re-built whenever the active palette changes.
 */
export function buildEditorTheme(styles: Styles): EditorTheme {
  return {
    borderColor: (s) => styles.primary(s),
    selectList: {
      selectedPrefix: (s) => styles.primary(s),
      selectedText: (s) => styles.bold(s),
      description: (s) => styles.textDim(s),
      scrollInfo: (s) => styles.textMuted(s),
      noMatch: (s) => styles.textMuted(s),
    },
  };
}

export function buildMarkdownTheme(styles: Styles): MarkdownTheme {
  return {
    heading: (s) => styles.bold(s),
    link: (s) => styles.primary(s),
    linkUrl: (s) => styles.textMuted(s),
    code: (s) => styles.accent(s),
    codeBlock: (s) => styles.dim(s),
    codeBlockBorder: (s) => styles.textMuted(s),
    quote: (s) => styles.italic(s),
    quoteBorder: (s) => styles.textMuted(s),
    hr: (s) => styles.dim(s),
    listBullet: (s) => styles.primary(s),
    bold: (s) => styles.bold(s),
    italic: (s) => styles.italic(s),
    strikethrough: (s) => styles.strikethrough(s),
    underline: (s) => styles.underline(s),
  };
}

export function buildSelectListTheme(styles: Styles): SelectListTheme {
  return {
    selectedPrefix: (s) => styles.primary(s),
    selectedText: (s) => styles.bold(s),
    description: (s) => styles.textDim(s),
    scrollInfo: (s) => styles.textMuted(s),
    noMatch: (s) => styles.textMuted(s),
  };
}
