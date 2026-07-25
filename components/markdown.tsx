import Link from 'next/link';
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import 'katex/dist/katex.min.css';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { CodeBlock } from './code-block';
import { DiffViewer } from './diff-viewer';
import { MermaidDiagram } from './mermaid-diagram';

const components: Components = {
  code: ({ node, className, children, ...props }) => {
    const text = extractText(children);
    const lang = extractLanguage(className);
    // Route fenced code blocks to specialized renderers when the language
    // asks for it. ```` ```mermaid ```` -> diagram; ```` ```diff ```` ->
    // unified-diff view. Everything else falls through to CodeBlock.
    if (lang === 'mermaid' && text) {
      return <MermaidDiagram chart={text} />;
    }
    if (lang === 'diff' && text) {
      return <DiffViewer code={text} />;
    }
    return (
      <CodeBlock {...props} inline={false}>
        {children}
      </CodeBlock>
    );
  },
  pre: ({ children }) => <>{children}</>,
  ol: ({ node, children, ...props }) => {
    return (
      <ol className="ml-4 list-outside list-decimal" {...props}>
        {children}
      </ol>
    );
  },
  li: ({ node, children, ...props }) => {
    return (
      <li className="py-1" {...props}>
        {children}
      </li>
    );
  },
  ul: ({ node, children, ...props }) => {
    return (
      <ul className="ml-4 list-outside list-decimal" {...props}>
        {children}
      </ul>
    );
  },
  strong: ({ node, children, ...props }) => {
    return (
      <span className="font-semibold" {...props}>
        {children}
      </span>
    );
  },
  a: ({ node, children, href, ...props }) => {
    return (
      <Link
        className="text-blue-500 hover:underline"
        target="_blank"
        rel="noreferrer"
        href={href ?? '#'}
        {...props}
      >
        {children}
      </Link>
    );
  },
  h1: ({ node, children, ...props }) => {
    return (
      <h1 className="mt-6 mb-2 font-semibold text-2xl md:text-3xl" {...props}>
        {children}
      </h1>
    );
  },
  h2: ({ node, children, ...props }) => {
    return (
      <h2 className="mt-6 mb-2 font-semibold text-xl md:text-2xl" {...props}>
        {children}
      </h2>
    );
  },
  h3: ({ node, children, ...props }) => {
    return (
      <h3 className="mt-6 mb-2 font-semibold text-lg md:text-xl" {...props}>
        {children}
      </h3>
    );
  },
  h4: ({ node, children, ...props }) => {
    return (
      <h4 className="mt-6 mb-2 font-semibold text-base md:text-lg" {...props}>
        {children}
      </h4>
    );
  },
  h5: ({ node, children, ...props }) => {
    return (
      <h5 className="mt-6 mb-2 font-semibold text-base" {...props}>
        {children}
      </h5>
    );
  },
  h6: ({ node, children, ...props }) => {
    return (
      <h6 className="mt-6 mb-2 font-semibold text-sm" {...props}>
        {children}
      </h6>
    );
  },
};

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

/** Extract the joined string content of a react-markdown `children` value. */
function extractText(children: unknown): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) {
    return children.map(extractText).join('');
  }
  if (
    children !== null &&
    typeof children === 'object' &&
    'props' in children
  ) {
    const props = (children as { props?: { children?: unknown } }).props;
    if (props?.children !== undefined) return extractText(props.children);
  }
  return '';
}

/** Pull the language identifier out of a `language-xxx` className string. */
function extractLanguage(className?: string): string | undefined {
  if (!className) return undefined;
  const match = /language-([a-z0-9+-]+)/i.exec(className);
  return match?.[1]?.toLowerCase();
}

const NonMemoizedMarkdown = ({ children }: { children: string }) => {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
};

export const Markdown = memo(
  NonMemoizedMarkdown,
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);
