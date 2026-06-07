'use client';

import { json, jsonParseLinter } from '@codemirror/lang-json';
import { lintGutter, linter } from '@codemirror/lint';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { AlertCircle, CheckCircle2, Code2 } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfigDraft } from '@/hooks/use-config-draft';

export function RawJsonEditor() {
  const {
    jsonSyntaxError,
    jsonText,
    updateJsonText,
    validationIssues,
    validationPassed,
  } = useConfigDraft();
  const editorRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editorValueRef = useRef(jsonText);

  useEffect(() => {
    if (!editorRef.current || viewRef.current) {
      return;
    }

    const state = EditorState.create({
      doc: jsonText,
      extensions: [
        json(),
        linter(jsonParseLinter()),
        lintGutter(),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) {
            return;
          }

          const nextValue = update.state.doc.toString();
          editorValueRef.current = nextValue;
          updateJsonText(nextValue);
        }),
        EditorView.theme({
          '&': {
            borderRadius: '0.75rem',
            fontSize: '12px',
            minHeight: '440px',
          },
          '.cm-content': {
            minHeight: '440px',
          },
          '.cm-scroller': {
            fontFamily: 'geist-mono, monospace',
            overflow: 'auto',
          },
        }),
      ],
    });

    viewRef.current = new EditorView({
      parent: editorRef.current,
      state,
    });

    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [jsonText, updateJsonText]);

  useEffect(() => {
    const view = viewRef.current;

    if (!view) {
      return;
    }

    // Skip updates that originated from the editor itself.
    if (jsonText === editorValueRef.current) {
      return;
    }

    const currentValue = view.state.doc.toString();

    if (currentValue === jsonText) {
      editorValueRef.current = currentValue;
      return;
    }

    const anchor = Math.min(view.state.selection.main.anchor, jsonText.length);
    const head = Math.min(view.state.selection.main.head, jsonText.length);

    view.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: jsonText,
      },
      selection: EditorSelection.range(anchor, head),
    });

    editorValueRef.current = jsonText;
  }, [jsonText]);

  const shownIssues = validationIssues.slice(0, 8);

  return (
    <Card className="border-border/70 shadow-none">
      <CardHeader className="space-y-3 pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Code2 className="size-4" />
              Raw JSON
            </CardTitle>
          </div>
          <div
            className={`inline-flex items-center gap-2 rounded-full px-3 py-1 font-medium text-xs ${
              validationPassed
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
            }`}
          >
            {validationPassed ? (
              <CheckCircle2 className="size-3.5" />
            ) : (
              <AlertCircle className="size-3.5" />
            )}
            {validationPassed ? 'PASSED' : 'ERROR'}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Editor */}
        <div ref={editorRef} />

        {jsonSyntaxError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
            <div className="flex items-center gap-2 font-medium">
              <AlertCircle className="size-4" />
              JSON syntax error
            </div>
            <p className="mt-1 text-destructive/90 text-xs">
              {jsonSyntaxError}
            </p>
          </div>
        ) : null}

        {!jsonSyntaxError && shownIssues.length > 0 ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-amber-900 text-sm dark:text-amber-200">
            <div className="flex items-center gap-2 font-medium">
              <AlertCircle className="size-4" />
              Schema validation issues
            </div>
            <ul className="mt-2 space-y-1 text-xs">
              {shownIssues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`}>
                  <span className="font-medium">{issue.path || '(root)'}</span>{' '}
                  {issue.message}
                </li>
              ))}
            </ul>
            {validationIssues.length > shownIssues.length ? (
              <p className="mt-2 text-muted-foreground text-xs">
                Showing {shownIssues.length} of {validationIssues.length}{' '}
                issues.
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
