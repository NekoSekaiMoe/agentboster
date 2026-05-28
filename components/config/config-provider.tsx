'use client';

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

import { loadConfigAction, saveConfigAction } from '@/app/(config)/actions';
import {
  type ConfigValidationIssue,
  useConfigValidation,
} from '@/hooks/use-config-validation';
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
  const [debouncedRevision, setDebouncedRevision] = useState(revision);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedRevision(revision), 900);
    return () => window.clearTimeout(timer);
  }, [revision]);
  const saveReminderVisible = isDirty && debouncedRevision === revision;

  const loadConfig = useCallback(async () => {
    setIsLoading(true);

    try {
      const { config, runtimeHealth: nextRuntimeHealth } =
        await loadConfigAction();

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
      const saved = await saveConfigAction(parsed);

      startTransition(() => {
        setDraft(saved);
        setLastValidDraft(saved);
        setJsonText(formatJson(saved));
        setJsonSyntaxError(null);
        setIsDirty(false);
      });

      toast.success('Configuration saved');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to save config';
      toast.error(message);
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
