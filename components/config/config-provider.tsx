'use client';

import { ofetch } from 'ofetch';
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { toast } from 'sonner';

import {
  type ConfigValidationIssue,
  useConfigValidation,
} from '@/hooks/use-config-validation';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import type { RuntimeHealthSnapshot } from '@/lib/utils/runtime-health';
import type { AppConfig } from '@/types/config';
import { appConfigSchema } from '@/types/config';

type ConfigDraft = Partial<AppConfig> & Record<string, unknown>;

interface ConfigContextValue {
  draft: ConfigDraft;
  isDirty: boolean;
  isLoading: boolean;
  isSaving: boolean;
  jsonSyntaxError: string | null;
  jsonText: string;
  lastValidDraft: AppConfig;
  runtimeHealth: RuntimeHealthSnapshot | null;
  saveReminderVisible: boolean;
  updateJsonText: (value: string) => void;
  updateSection: <K extends keyof AppConfig>(
    key: K,
    value: AppConfig[K],
  ) => void;
  validationIssues: ConfigValidationIssue[];
  validationPassed: boolean;
  saveConfig: () => Promise<void>;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

type ConfigLoadResponse = {
  config: AppConfig;
  runtimeHealth: RuntimeHealthSnapshot | null;
};

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function cloneDraft(value: ConfigDraft): ConfigDraft {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractConfigLoadResponse(payload: unknown): ConfigLoadResponse {
  if (!isRecord(payload) || !('config' in payload)) {
    const config = appConfigSchema.parse(payload);
    return {
      config,
      runtimeHealth: null,
    };
  }

  return {
    config: appConfigSchema.parse(payload.config),
    runtimeHealth: isRecord(payload.runtimeHealth)
      ? (payload.runtimeHealth as RuntimeHealthSnapshot)
      : null,
  };
}

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [draft, setDraft] = useState<ConfigDraft>({});
  const [jsonText, setJsonText] = useState('{}');
  const [jsonSyntaxError, setJsonSyntaxError] = useState<string | null>(null);
  const [lastValidDraft, setLastValidDraft] = useState<AppConfig>({});
  const [runtimeHealth, setRuntimeHealth] =
    useState<RuntimeHealthSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [revision, setRevision] = useState(0);

  const validation = useConfigValidation(draft, 250);
  const debouncedRevision = useDebouncedValue(revision, 900);
  const saveReminderVisible = isDirty && debouncedRevision === revision;

  const loadConfig = useCallback(async () => {
    setIsLoading(true);

    try {
      const payload = await ofetch<unknown>('/api/config');
      const { config, runtimeHealth: nextRuntimeHealth } =
        extractConfigLoadResponse(payload);

      startTransition(() => {
        setDraft(config);
        setLastValidDraft(config);
        setRuntimeHealth(nextRuntimeHealth);
        setJsonText(formatJson(config));
        setJsonSyntaxError(null);
        setIsDirty(false);
        setRevision(0);
      });
    } catch {
      toast.error('Failed to load config');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const applyDraftUpdate = useCallback((nextDraft: ConfigDraft) => {
    setDraft(nextDraft);
    setJsonText(formatJson(nextDraft));
    setJsonSyntaxError(null);
    setIsDirty(true);
    setRevision((current) => current + 1);
  }, []);

  const updateSection = useCallback(
    <K extends keyof AppConfig>(key: K, value: AppConfig[K]) => {
      const nextDraft = cloneDraft(draft);

      if (value === undefined) {
        delete nextDraft[key];
      } else {
        nextDraft[key] = value;
      }

      applyDraftUpdate(nextDraft);
    },
    [applyDraftUpdate, draft],
  );

  const updateJsonText = useCallback((value: string) => {
    setJsonText(value);
    setIsDirty(true);
    setRevision((current) => current + 1);

    try {
      const parsedJson = JSON.parse(value) as unknown;
      setJsonSyntaxError(null);

      const parsedConfig = appConfigSchema.safeParse(parsedJson);

      if (!parsedConfig.success) {
        return;
      }

      startTransition(() => {
        setDraft(parsedConfig.data);
        setLastValidDraft(parsedConfig.data);
      });
    } catch (error) {
      setJsonSyntaxError(
        error instanceof Error ? error.message : 'Invalid JSON',
      );
    }
  }, []);

  const saveConfig = useCallback(async () => {
    if (jsonSyntaxError || !validation.isValid) {
      return;
    }

    let parsed: AppConfig;
    try {
      parsed = appConfigSchema.parse(draft);
    } catch {
      toast.error('Configuration validation failed');
      return;
    }

    setIsSaving(true);

    try {
      const savedPayload = await ofetch<unknown>('/api/config/update', {
        method: 'PUT',
        body: parsed,
      });
      const saved = appConfigSchema.parse(savedPayload);

      startTransition(() => {
        setDraft(saved);
        setLastValidDraft(saved);
        setJsonText(formatJson(saved));
        setJsonSyntaxError(null);
        setIsDirty(false);
      });

      toast.success('Configuration saved');
    } catch {
      toast.error('Failed to save config');
    } finally {
      setIsSaving(false);
    }
  }, [draft, jsonSyntaxError, validation.isValid]);

  const value = useMemo<ConfigContextValue>(
    () => ({
      draft,
      isDirty,
      isLoading,
      isSaving,
      jsonSyntaxError,
      jsonText,
      lastValidDraft,
      runtimeHealth,
      saveReminderVisible,
      updateJsonText,
      updateSection,
      validationIssues: validation.issues,
      validationPassed: !jsonSyntaxError && validation.isValid,
      saveConfig,
    }),
    [
      draft,
      isDirty,
      isLoading,
      isSaving,
      jsonSyntaxError,
      jsonText,
      lastValidDraft,
      runtimeHealth,
      saveReminderVisible,
      updateJsonText,
      updateSection,
      validation.issues,
      validation.isValid,
      saveConfig,
    ],
  );

  return (
    <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>
  );
}

export function useConfigContext() {
  const value = useContext(ConfigContext);

  if (!value) {
    throw new Error('useConfigContext must be used within ConfigProvider');
  }

  return value;
}
