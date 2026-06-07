'use client';

import { Plus, Trash2 } from 'lucide-react';
import * as React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useI18n } from '@/components/i18n-provider';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export type KeyValueEntry = { id: string; key: string; value: string };
export type StringListEntry = { id: string; value: string };

export function createKeyValueEntries(
  record: Record<string, string> | undefined,
): KeyValueEntry[] {
  return Object.entries(record ?? {}).map(([key, value], index) => ({
    id: `entry-${index}`,
    key,
    value,
  }));
}

export function createStringListEntries(
  values: string[] | undefined,
): StringListEntry[] {
  return (values ?? []).map((value, index) => ({
    id: `item-${index}`,
    value,
  }));
}

export function compactRecord(entries: KeyValueEntry[]) {
  return Object.fromEntries(
    entries
      .map((entry) => [entry.key.trim(), entry.value] as const)
      .filter(([key]) => key.length > 0),
  );
}

function syncKeyValueEntries(
  previousEntries: KeyValueEntry[],
  nextEntries: KeyValueEntry[],
  createId: () => string,
) {
  return nextEntries.map((entry, index) => ({
    ...entry,
    id: previousEntries[index]?.id ?? entry.id ?? createId(),
  }));
}

function syncStringListEntries(
  previousEntries: StringListEntry[],
  nextEntries: StringListEntry[],
  createId: () => string,
) {
  return nextEntries.map((entry, index) => ({
    ...entry,
    id: previousEntries[index]?.id ?? entry.id ?? createId(),
  }));
}

export function compactStringList(entries: StringListEntry[]) {
  return entries
    .map((entry) => entry.value.trim())
    .filter((value) => value.length > 0);
}

function equalCompactedRecords(left: KeyValueEntry[], right: KeyValueEntry[]) {
  const leftEntries = Object.entries(compactRecord(left));
  const rightEntries = Object.entries(compactRecord(right));

  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([leftKey, leftValue], index) =>
        rightEntries[index]?.[0] === leftKey &&
        rightEntries[index]?.[1] === leftValue,
    )
  );
}

function equalCompactedStringLists(
  left: StringListEntry[],
  right: StringListEntry[],
) {
  const leftValues = compactStringList(left);
  const rightValues = compactStringList(right);

  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => rightValues[index] === value)
  );
}

export function parseOptionalNumber(value: string) {
  if (!value.trim()) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function SectionIssues({
  issues,
}: {
  issues: Array<{ message: string; path: string }>;
}) {
  const { t } = useI18n();

  if (!issues.length) {
    return null;
  }

  return (
    <Card className="fixed bottom-2 z-10 border-amber-500/5 backdrop:blur-sm">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          {t('config.common.validationIssues')}
        </CardTitle>
        <CardDescription>
          {t('config.common.validationIssuesDescription')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">
          {issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`}>
              <span className="font-medium">
                {issue.path || t('config.common.root')}
              </span>{' '}
              {issue.message}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  const reactId = useId();
  const controlId = `${reactId}-control`;
  const labelId = `${reactId}-label`;
  let content = children;

  if (React.isValidElement(children)) {
    const child = children as React.ReactElement<{
      'aria-labelledby'?: string;
      id?: string;
    }>;

    content = React.cloneElement(child, {
      'aria-labelledby': child.props['aria-labelledby'] ?? labelId,
      id: child.props.id ?? controlId,
    });
  }

  return (
    <div className="space-y-2">
      <Label id={labelId} htmlFor={controlId}>
        {label}
      </Label>
      {content}
    </div>
  );
}

export function EditableObjectKeyInput({
  currentKey,
  onCommit,
}: {
  currentKey: string;
  onCommit: (nextKey: string) => void;
}) {
  const [draftKey, setDraftKey] = useState(currentKey);

  useEffect(() => {
    setDraftKey(currentKey);
  }, [currentKey]);

  return (
    <Input
      value={draftKey}
      onBlur={() => {
        if (draftKey !== currentKey) {
          onCommit(draftKey);
        }
      }}
      onChange={(event) => setDraftKey(event.target.value)}
    />
  );
}

export function ToggleField({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-xl border px-4 py-3">
      <div>
        <p className="font-medium text-sm">{label}</p>
      </div>
      <input
        checked={checked}
        className="h-4 w-4 rounded border-input"
        onChange={(event) => onCheckedChange(event.target.checked)}
        type="checkbox"
      />
    </label>
  );
}

export function KeyValueEditor({
  addLabel = 'Add entry',
  entries,
  keyLabel = 'Key',
  onChange,
  valueLabel = 'Value',
}: {
  addLabel?: string;
  entries: KeyValueEntry[];
  keyLabel?: string;
  onChange: (entries: KeyValueEntry[]) => void;
  valueLabel?: string;
}) {
  const nextIdRef = useRef(entries.length);
  const createId = useCallback(() => `entry-${nextIdRef.current++}`, []);
  const [draftEntries, setDraftEntries] = useState<KeyValueEntry[]>(() =>
    entries.length ? entries : [{ id: createId(), key: '', value: '' }],
  );

  useEffect(() => {
    setDraftEntries((currentEntries) => {
      if (equalCompactedRecords(currentEntries, entries)) {
        return currentEntries;
      }

      return entries.length
        ? syncKeyValueEntries(currentEntries, entries, createId)
        : [{ id: currentEntries[0]?.id ?? createId(), key: '', value: '' }];
    });
  }, [createId, entries]);

  const safeEntries = draftEntries;

  return (
    <div className="space-y-3">
      {safeEntries.map((entry, index) => (
        <div key={entry.id} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
          <Input
            aria-label={keyLabel}
            placeholder={keyLabel}
            value={entry.key}
            onChange={(event) => {
              const next = safeEntries.map((item, itemIndex) =>
                itemIndex === index
                  ? { ...item, key: event.target.value }
                  : item,
              );
              setDraftEntries(next);
              onChange(next);
            }}
          />
          <Input
            aria-label={valueLabel}
            placeholder={valueLabel}
            value={entry.value}
            onChange={(event) => {
              const next = safeEntries.map((item, itemIndex) =>
                itemIndex === index
                  ? { ...item, value: event.target.value }
                  : item,
              );
              setDraftEntries(next);
              onChange(next);
            }}
          />
          <Button
            className="md:self-start"
            size="icon"
            type="button"
            variant="outline"
            onClick={() => {
              const next = safeEntries.filter(
                (_, itemIndex) => itemIndex !== index,
              );
              setDraftEntries(
                next.length ? next : [{ id: createId(), key: '', value: '' }],
              );
              onChange(next);
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}

      <Button
        size="sm"
        type="button"
        variant="secondary"
        onClick={() => {
          const next = [...safeEntries, { id: createId(), key: '', value: '' }];
          setDraftEntries(next);
          onChange(next);
        }}
      >
        <Plus className="size-4" />
        {addLabel}
      </Button>
    </div>
  );
}

export function StringListEditor({
  addLabel = 'Add item',
  entries,
  onChange,
  placeholder,
}: {
  addLabel?: string;
  entries: StringListEntry[];
  onChange: (entries: StringListEntry[]) => void;
  placeholder: string;
}) {
  const nextIdRef = useRef(entries.length);
  const createId = useCallback(() => `item-${nextIdRef.current++}`, []);
  const [draftEntries, setDraftEntries] = useState<StringListEntry[]>(() =>
    entries.length ? entries : [{ id: createId(), value: '' }],
  );

  useEffect(() => {
    setDraftEntries((currentEntries) => {
      if (equalCompactedStringLists(currentEntries, entries)) {
        return currentEntries;
      }

      return entries.length
        ? syncStringListEntries(currentEntries, entries, createId)
        : [{ id: currentEntries[0]?.id ?? createId(), value: '' }];
    });
  }, [createId, entries]);

  const safeEntries = draftEntries;

  return (
    <div className="space-y-3">
      {safeEntries.map((entry, index) => (
        <div key={entry.id} className="grid gap-2 md:grid-cols-[1fr_auto]">
          <Input
            placeholder={placeholder}
            value={entry.value}
            onChange={(event) => {
              const next = safeEntries.map((item, itemIndex) =>
                itemIndex === index
                  ? { ...item, value: event.target.value }
                  : item,
              );
              setDraftEntries(next);
              onChange(next);
            }}
          />
          <Button
            className="md:self-start"
            size="icon"
            type="button"
            variant="outline"
            onClick={() => {
              const next = safeEntries.filter(
                (_, itemIndex) => itemIndex !== index,
              );
              setDraftEntries(
                next.length ? next : [{ id: createId(), value: '' }],
              );
              onChange(next);
            }}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}

      <Button
        size="sm"
        type="button"
        variant="secondary"
        onClick={() => {
          const next = [...safeEntries, { id: createId(), value: '' }];
          setDraftEntries(next);
          onChange(next);
        }}
      >
        <Plus className="size-4" />
        {addLabel}
      </Button>
    </div>
  );
}
