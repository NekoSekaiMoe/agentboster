import { Container, Image, Spacer, Text } from '@agentboster-cli/tui';
import { theme } from '../theme/theme.ts';
import { DynamicBorder } from './dynamic-border.ts';
import { getClankolasBase64 } from '../assets/clankolas.ts';

const BLOG_URL = 'https://mariozechner.at/posts/2026-04-08-ive-sold-out/';
const IMAGE_FILENAME = 'clankolas.png';

export class EarendilAnnouncementComponent extends Container {
  constructor() {
    super();

    this.addChild(new DynamicBorder((text) => theme.fg('accent', text)));
    this.addChild(
      new Text(theme.bold(theme.fg('accent', 'pi has joined Earendil')), 1, 0),
    );
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg('muted', 'Read the blog post:'), 1, 0));
    this.addChild(new Text(theme.fg('mdLink', BLOG_URL), 1, 0));
    this.addChild(new Spacer(1));

    const imageBase64 = getClankolasBase64();
    if (imageBase64) {
      this.addChild(
        new Image(
          imageBase64,
          'image/png',
          { fallbackColor: (text) => theme.fg('muted', text) },
          { maxWidthCells: 56, filename: IMAGE_FILENAME },
        ),
      );
      this.addChild(new Spacer(1));
    }

    this.addChild(new DynamicBorder((text) => theme.fg('accent', text)));
  }
}
