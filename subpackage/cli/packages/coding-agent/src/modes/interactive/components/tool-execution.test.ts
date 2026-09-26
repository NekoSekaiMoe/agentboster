// biome-ignore-all lint/complexity/useLiteralKeys: Bracket access exercises private lifecycle boundaries in tests.
import type { TUI } from '@agentboster-cli/tui';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { convertToPng } from '../../../utils/image-convert.ts';
import { initTheme } from '../theme/theme.ts';
import { ToolExecutionComponent } from './tool-execution.ts';

vi.mock('@agentboster-cli/tui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agentboster-cli/tui')>()),
  getCapabilities: () => ({ images: 'kitty' }),
}));
vi.mock('../../../core/tools/index.ts', () => ({
  createAllToolDefinitions: () => ({}),
}));
vi.mock('../../../utils/image-convert.ts', () => ({ convertToPng: vi.fn() }));

beforeAll(() => {
  initTheme('dark');
});

describe('converted image cache', () => {
  it.each([
    ['new-data', 'image/jpeg'],
    ['old-data', 'image/webp'],
    ['new-data', 'image/png'],
  ])(
    'does not display a stale conversion after source changes to %s (%s)',
    async (data, mimeType) => {
      const convert = vi.mocked(convertToPng);
      convert.mockResolvedValueOnce({
        data: 'converted-old',
        mimeType: 'image/png',
      });
      const component = new ToolExecutionComponent(
        'custom',
        'call',
        {},
        {},
        undefined,
        { requestRender: vi.fn() } as unknown as TUI,
        process.cwd(),
      );
      component.updateResult(
        {
          content: [
            { type: 'image', data: 'old-data', mimeType: 'image/jpeg' },
          ],
          isError: false,
        },
        true,
      );
      await Promise.resolve();
      expect(component['imageComponents']).toHaveLength(1);
      const oldImage = component['imageComponents'][0];
      let finishConversion!: (image: {
        data: string;
        mimeType: string;
      }) => void;
      convert.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishConversion = resolve;
          }),
      );
      component.updateResult({
        content: [{ type: 'image', data, mimeType }],
        isError: false,
      });
      if (mimeType === 'image/png') {
        expect(component['imageComponents']).toHaveLength(1);
        expect(component['imageComponents'][0]).not.toEqual(oldImage);
      } else {
        expect(component['imageComponents']).toHaveLength(0);
        finishConversion({ data: 'converted-new', mimeType: 'image/png' });
        await Promise.resolve();
        expect(component['imageComponents']).toHaveLength(1);
      }
    },
  );
});
