'use client';

import { useEffect, useId, useRef, useState } from 'react';

/**
 * Mermaid diagram renderer.
 *
 * Loads the `mermaid` package via dynamic import on first render so it never
 * lands in the main route bundle — diagrams are relatively rare in chat and
 * mermaid + its deps are heavy (~150MB in node_modules, ~600KB gzipped on the
 * wire). Until the import resolves we show the raw definition in a `<pre>` so
 * the user still sees the content.
 *
 * On parse error we render the definition as a normal code block with the
 * error message beneath it, so a malformed diagram doesn't break the whole
 * message.
 */
export function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'base',
          securityLevel: 'loose',
          fontFamily: 'inherit',
        });
        // Mermaid mutates the DOM when given an element id; render into an
        // off-DOM container we control, then lift the SVG out.
        const renderId = `mermaid-${id}-${Date.now()}`;
        const { svg: rendered } = await mermaid.render(renderId, chart);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (error) {
    return (
      <div className="not-prose my-2 overflow-x-auto rounded-xl border border-red-300 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950/40">
        <div className="mb-2 font-medium text-red-700 dark:text-red-400">
          Mermaid 渲染失败
        </div>
        <pre className="whitespace-pre-wrap break-words text-xs text-zinc-700 dark:text-zinc-300">
          {chart}
        </pre>
        <div className="mt-2 text-red-600 text-xs dark:text-red-400">
          {error}
        </div>
      </div>
    );
  }

  if (!svg) {
    return (
      <pre className="not-prose my-2 w-full overflow-x-auto rounded-xl border border-zinc-200 p-4 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50">
        {chart}
      </pre>
    );
  }

  return (
    <div
      ref={containerRef}
      className="not-prose my-2 flex justify-center overflow-x-auto rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900"
      // mermaid.render output is a sanitized SVG string we generated locally.
      // securityLevel: 'loose' still strips <script> and event handlers.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
