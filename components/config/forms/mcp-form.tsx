'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigSection } from '@/hooks/use-config-section';
import type { MCPRemoteServersConfig } from '@/types/config/mcp';

import { createStableId } from './models/models-dev';
import {
  EditableObjectKeyInput,
  Field,
  KeyValueEditor,
  SectionIssues,
  compactRecord,
  createKeyValueEntries,
} from './shared';

const builtinServers = [
  {
    name: 'web',
    description: 'Search the web and fetch URL content.',
    tools: 'web_search, fetch_url',
    requirements:
      'No required API key for basic fetch/search. Optional BRAVE_SEARCH_API_KEY or TAVILY_API_KEY improves fallback quality.',
  },
  {
    name: 'browser',
    description: 'Render and interact with pages using Playwright.',
    tools:
      'browser_navigate, browser_screenshot, browser_click, browser_type, browser_get_text, browser_get_html, browser_get_network_requests, browser_evaluate, browser_close',
    requirements:
      'Requires Playwright browser binaries in the runtime environment.',
  },
  {
    name: 'firecrawl',
    description: 'Scrape and extract web pages with Firecrawl.',
    tools: 'firecrawl_scrape',
    requirements: 'Requires FIRECRAWL_API_KEY.',
  },
  {
    name: 'github',
    description: 'Inspect repositories and manage GitHub issues/PRs.',
    tools:
      'github_get_repository, github_search_issues, github_create_issue, github_update_issue, github_create_pull_request',
    requirements:
      'GITHUB_TOKEN is optional for reads and required for mutations.',
  },
  {
    name: 'context7',
    description: 'Search project documentation through Context7.',
    tools: 'context7_search_docs',
    requirements: 'Uses context7.json bundled with this project.',
  },
];

export function McpForm() {
  const { issues, value, updateValue } = useConfigSection('mcp');
  const { t } = useI18n();
  const servers = (value ?? {}) as MCPRemoteServersConfig;
  const entries = Object.entries(servers);
  const [serverRowIds, setServerRowIds] = useState<Record<string, string>>({});

  useEffect(() => {
    setServerRowIds((current) => {
      const next: Record<string, string> = {};

      for (const [serverKey] of entries) {
        next[serverKey] = current[serverKey] ?? createStableId('server');
      }

      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      const unchanged =
        currentKeys.length === nextKeys.length &&
        nextKeys.every((key) => current[key] === next[key]);

      return unchanged ? current : next;
    });
  }, [entries]);

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.mcp.builtinServers')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.mcp.builtinDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {builtinServers.map((server) => (
            <div key={server.name} className="rounded-2xl border p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-medium">{server.name}</h3>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary text-xs">
                  {t('config.common.enabled')}
                </span>
              </div>
              <p className="mt-2 text-muted-foreground text-sm">
                {server.description}
              </p>
              <p className="mt-3 text-muted-foreground text-xs">
                {t('config.forms.mcp.tools', { tools: server.tools })}
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                {server.requirements}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.mcp.customServers')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.mcp.customDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {entries.map(([serverKey, serverValue]) => (
            <div
              key={serverRowIds[serverKey] ?? serverKey}
              className="rounded-2xl border p-4"
            >
              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t('config.forms.mcp.serverName')}>
                  <EditableObjectKeyInput
                    currentKey={serverKey}
                    onCommit={(nextKey) => {
                      if (nextKey === serverKey) {
                        return;
                      }

                      const rowId =
                        serverRowIds[serverKey] ?? createStableId('server');

                      setServerRowIds((current) => {
                        const next = { ...current };
                        delete next[serverKey];
                        next[nextKey] = rowId;
                        return next;
                      });

                      const nextServers = { ...servers };
                      delete nextServers[serverKey];
                      nextServers[nextKey] = serverValue;
                      updateValue(nextServers);
                    }}
                  />
                </Field>
                <Field label={t('config.forms.mcp.type')}>
                  <Select
                    value={serverValue.type}
                    onValueChange={(nextValue) =>
                      updateValue({
                        ...servers,
                        [serverKey]: {
                          ...serverValue,
                          type: nextValue as 'http' | 'sse',
                        },
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue
                        placeholder={t('config.forms.mcp.transportPlaceholder')}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="http">http</SelectItem>
                      <SelectItem value="sse">sse</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="URL">
                  <Input
                    placeholder="https://mcp.example.com"
                    value={serverValue.url}
                    onChange={(event) =>
                      updateValue({
                        ...servers,
                        [serverKey]: {
                          ...serverValue,
                          url: event.target.value,
                        },
                      })
                    }
                  />
                </Field>
              </div>

              <div className="mt-4">
                <Field label={t('config.common.headers')}>
                  <KeyValueEditor
                    addLabel={t('config.common.addHeader')}
                    entries={createKeyValueEntries(serverValue.headers)}
                    keyLabel={t('config.common.headerKey')}
                    onChange={(entries) =>
                      updateValue({
                        ...servers,
                        [serverKey]: {
                          ...serverValue,
                          headers: compactRecord(entries),
                        },
                      })
                    }
                    valueLabel={t('config.common.headerValue')}
                  />
                </Field>
              </div>

              <div className="mt-4 flex justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    const nextServers = { ...servers };
                    delete nextServers[serverKey];
                    updateValue(nextServers);
                  }}
                >
                  <Trash2 className="size-4" />
                  {t('config.forms.mcp.removeServer')}
                </Button>
              </div>
            </div>
          ))}

          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              updateValue({
                ...servers,
                [`server-${entries.length + 1}`]: {
                  type: 'http',
                  url: '',
                },
              })
            }
          >
            <Plus className="size-4" />
            {t('config.forms.mcp.addServer')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
