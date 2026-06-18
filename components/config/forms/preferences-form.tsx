'use client';

import { Check, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useI18n } from '@/components/i18n-provider';
import {
  getUserModelPreferencesAction,
  updateUserModelPreferencesAction,
} from '@/app/(config)/actions';
import {
  type ModelsDevCatalog,
  buildConfiguredProviderModelSuggestions,
  listProviderNames,
  loadModelsDevCatalog,
} from '@/components/config/forms/models/models-dev';
import { SuggestionInput } from '@/components/config/forms/models/suggestion-input';
import { Field } from '@/components/config/forms/shared';
import { useConfigContextStrict } from '@/components/config/config-provider';
import { toast } from 'sonner';

export function PreferencesForm() {
  const { t } = useI18n();
  const { draft } = useConfigContextStrict();
  const providers = useMemo(
    () => listProviderNames((draft.models?.providers ?? {}) as never),
    [draft.models?.providers],
  );

  const [catalog, setCatalog] = useState<ModelsDevCatalog | null>(null);
  const [model, setModel] = useState<string>('');
  const [globalDefault, setGlobalDefault] = useState<string | null>(null);
  const [allowedModels, setAllowedModels] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let isMounted = true;
    loadModelsDevCatalog().then((c) => {
      if (isMounted) setCatalog(c);
    });
    getUserModelPreferencesAction()
      .then((prefs) => {
        if (!isMounted) return;
        setModel(prefs.model ?? '');
        setGlobalDefault(prefs.globalDefault);
        setAllowedModels(prefs.allowedModels);
      })
      .catch(() => {
        // toast handled below — leave empty here to avoid double toasts
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const suggestions = useMemo(() => {
    // Admin whitelist wins when set; otherwise fall back to every model
    // the configured providers expose via the models.dev catalog. The
    // fallback keeps the combobox useful even when the admin hasn't
    // curated a list yet.
    if (allowedModels && allowedModels.length) {
      return [...allowedModels].sort((a, b) => a.localeCompare(b));
    }
    return buildConfiguredProviderModelSuggestions(providers, catalog);
  }, [allowedModels, providers, catalog]);

  const effectiveModel = model.trim() || globalDefault;

  async function handleSave() {
    setSaving(true);
    try {
      const result = await updateUserModelPreferencesAction({
        model: model.trim() || null,
      });
      setModel(result.model ?? '');
      toast.success(t('config.forms.preferences.saved'));
    } catch {
      toast.error(t('config.common.networkError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    try {
      const result = await updateUserModelPreferencesAction({ model: null });
      setModel(result.model ?? '');
      toast.success(t('config.forms.preferences.cleared'));
    } catch {
      toast.error(t('config.common.networkError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-base">
          {t('config.forms.preferences.title')}
        </CardTitle>
        <CardDescription>
          {t('config.forms.preferences.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t('config.common.loading')}
          </div>
        ) : (
          <>
            <Field label={t('config.forms.preferences.model')}>
              <SuggestionInput
                placeholder="provider/model-id"
                suggestions={suggestions}
                value={model}
                onChange={setModel}
              />
              <p className="mt-1 text-muted-foreground text-xs">
                {effectiveModel
                  ? model.trim()
                    ? t('config.forms.preferences.usingPersonal', {
                        model: effectiveModel,
                      })
                    : t('config.forms.preferences.usingGlobal', {
                        model: effectiveModel,
                      })
                  : t('config.forms.preferences.noModelSet')}
              </p>
              <p className="text-muted-foreground text-xs">
                {allowedModels && allowedModels.length
                  ? t('config.forms.preferences.allowedModelsHint')
                  : t('config.forms.preferences.allowedModelsEmpty')}
              </p>
            </Field>

            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={saving || loading}
                onClick={handleSave}
              >
                {saving ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <Check className="mr-1.5 size-3.5" />
                )}
                {t('config.forms.preferences.save')}
              </Button>
              {model.trim() && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saving || loading}
                  onClick={handleClear}
                >
                  <X className="mr-1.5 size-3.5" />
                  {t('config.forms.preferences.clear')}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
