'use client';

import { Download, Loader2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { useConfigContext } from '@/components/config/config-provider';
import { useI18n } from '@/components/i18n-provider';
import type { TranslationKey } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Backup & restore section (Settings → Backup).
 *
 * Thin UI over the existing API-only endpoints:
 *   GET  /api/export?items=…&redact=…  → JSON download
 *   POST /api/import?items=…&merge=…   → selective restore
 *
 * `config` / `builtin_memories` / `l0_rules` are admin-only on the server;
 * the checkboxes are disabled (and excluded) for non-admin users, who can
 * still export/import their own long-term memories.
 */

type ExportItem =
  | 'config'
  | 'builtin_memories'
  | 'long_term_memories'
  | 'l0_rules';

const ADMIN_ITEMS: ReadonlySet<ExportItem> = new Set([
  'config',
  'builtin_memories',
  'l0_rules',
]);

const ITEM_LABEL_KEYS: Record<ExportItem, TranslationKey> = {
  config: 'config.backup.item.config',
  builtin_memories: 'config.backup.item.builtinMemories',
  long_term_memories: 'config.backup.item.longTermMemories',
  l0_rules: 'config.backup.item.l0Rules',
} as const;

/** Export item id → key used inside the export JSON body. */
const BODY_KEY_BY_ITEM: Record<ExportItem, string> = {
  config: 'config',
  builtin_memories: 'builtinMemories',
  long_term_memories: 'longTermMemories',
  l0_rules: 'l0Rules',
} as const;

type ImportResults = Record<
  string,
  { success: boolean; count?: number; error?: string }
>;

export function BackupSection() {
  const { t } = useI18n();
  const configContext = useConfigContext();
  const isAdmin = configContext?.isAdmin ?? false;

  const availableItems = (Object.keys(ITEM_LABEL_KEYS) as ExportItem[]).filter(
    (item) => isAdmin || !ADMIN_ITEMS.has(item),
  );

  // ---- export state ----
  const [exportItems, setExportItems] = useState<ReadonlySet<ExportItem>>(
    () => new Set(availableItems),
  );
  const [redact, setRedact] = useState(true);
  const [exporting, setExporting] = useState(false);

  // ---- import state ----
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importBody, setImportBody] = useState<Record<string, unknown> | null>(
    null,
  );
  const [importItems, setImportItems] = useState<ReadonlySet<ExportItem>>(
    new Set(),
  );
  const [merge, setMerge] = useState(true);
  const [importing, setImporting] = useState(false);

  function toggleExportItem(item: ExportItem, checked: boolean) {
    setExportItems((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(item);
      } else {
        next.delete(item);
      }
      return next;
    });
  }

  async function handleExport() {
    if (exportItems.size === 0 || exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams({
        items: [...exportItems].join(','),
        redact: String(redact),
      });
      const res = await fetch(`/api/export?${params}`);
      if (!res.ok) {
        throw new Error(`Export failed: ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `agentboster-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setExporting(false);
    }
  }

  function handleFileChosen(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    file
      .text()
      .then((text) => {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        const body = parsed as Record<string, unknown>;
        const present = (Object.keys(BODY_KEY_BY_ITEM) as ExportItem[]).filter(
          (item) =>
            body[BODY_KEY_BY_ITEM[item]] !== undefined &&
            (isAdmin || !ADMIN_ITEMS.has(item)),
        );
        if (present.length === 0) {
          toast.error(t('config.backup.import.noSections'));
          return;
        }
        setImportBody(body);
        setImportItems(new Set(present));
      })
      .catch(() => {
        toast.error(t('config.backup.import.invalidFile'));
      });
  }

  async function handleImport() {
    if (!importBody || importItems.size === 0 || importing) return;
    setImporting(true);
    try {
      const params = new URLSearchParams({
        items: [...importItems].join(','),
        merge: String(merge),
      });
      const res = await fetch(`/api/import?${params}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(importBody),
      });
      const payload = (await res.json()) as {
        ok?: boolean;
        results?: ImportResults;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(payload.error ?? `Import failed: ${res.status}`);
      }
      const failedEntries = Object.entries(payload.results ?? {}).filter(
        ([, result]) => !result.success,
      );
      if (payload.ok && failedEntries.length === 0) {
        toast.success(t('config.backup.import.success'));
        setImportBody(null);
      } else {
        toast.error(
          failedEntries
            .map(([key, result]) => `${key}: ${result.error ?? 'failed'}`)
            .join('; ') || t('config.backup.import.failed'),
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }

  function renderItemCheckbox(
    item: ExportItem,
    checked: boolean,
    onChange: (checked: boolean) => void,
    disabled: boolean,
  ) {
    const id = `backup-item-${item}`;
    return (
      <div className="flex items-center gap-2" key={id}>
        <Checkbox
          checked={checked}
          disabled={disabled}
          id={id}
          onCheckedChange={(value) => onChange(value === true)}
        />
        <Label className="font-normal" htmlFor={id}>
          {t(ITEM_LABEL_KEYS[item])}
        </Label>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t('config.backup.export.title')}</CardTitle>
          <CardDescription>
            {t('config.backup.export.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(ITEM_LABEL_KEYS) as ExportItem[]).map((item) =>
              renderItemCheckbox(
                item,
                exportItems.has(item),
                (checked) => toggleExportItem(item, checked),
                !isAdmin && ADMIN_ITEMS.has(item),
              ),
            )}
          </div>
          {!isAdmin ? (
            <p className="text-muted-foreground text-xs">
              {t('config.backup.adminOnly')}
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <Checkbox
              checked={redact}
              id="backup-redact"
              onCheckedChange={(value) => setRedact(value === true)}
            />
            <Label className="font-normal" htmlFor="backup-redact">
              {t('config.backup.export.redact')}
            </Label>
          </div>
          <Button
            disabled={exporting || exportItems.size === 0}
            onClick={handleExport}
          >
            {exporting ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Download className="mr-2 size-4" />
            )}
            {exporting
              ? t('config.backup.export.exporting')
              : t('config.backup.export.button')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('config.backup.import.title')}</CardTitle>
          <CardDescription>
            {t('config.backup.import.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Input
              accept="application/json,.json"
              className="hidden"
              onChange={handleFileChosen}
              ref={fileInputRef}
              type="file"
            />
            <Button
              onClick={() => fileInputRef.current?.click()}
              variant="outline"
            >
              <Upload className="mr-2 size-4" />
              {t('config.backup.import.chooseFile')}
            </Button>
          </div>
          {importBody ? (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                {(Object.keys(BODY_KEY_BY_ITEM) as ExportItem[])
                  .filter(
                    (item) => importBody[BODY_KEY_BY_ITEM[item]] !== undefined,
                  )
                  .map((item) =>
                    renderItemCheckbox(
                      item,
                      importItems.has(item),
                      (checked) =>
                        setImportItems((prev) => {
                          const next = new Set(prev);
                          if (checked) {
                            next.add(item);
                          } else {
                            next.delete(item);
                          }
                          return next;
                        }),
                      !isAdmin && ADMIN_ITEMS.has(item),
                    ),
                  )}
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={merge}
                  id="backup-merge"
                  onCheckedChange={(value) => setMerge(value === true)}
                />
                <Label className="font-normal" htmlFor="backup-merge">
                  {t('config.backup.import.merge')}
                </Label>
              </div>
              <Button
                disabled={importing || importItems.size === 0}
                onClick={handleImport}
              >
                {importing ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 size-4" />
                )}
                {importing
                  ? t('config.backup.import.importing')
                  : t('config.backup.import.button')}
              </Button>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
