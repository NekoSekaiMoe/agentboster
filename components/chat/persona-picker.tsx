'use client';

import { Check, ChevronsUpDown, UserCircle2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  listChatPersonasAction,
  type PersonaOption,
} from '@/app/(chat)/actions';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';

/**
 * Persona picker for the chat composer.
 *
 * Mirrors ModelPicker's shape (pill button + dropdown) but switches the
 * conversation persona (system_prompt + optional model override) instead
 * of the model. The selected persona is sent as `agent` in the chat
 * request body and persisted on session.metadata via
 * saveSessionPersonaAction so it survives reload / regenerate.
 *
 * 'main' (Default) is always present; other entries come from
 * config.agents (configured by admins on /config/agents). When only 'main'
 * exists, the picker renders as disabled — there's nothing to switch.
 *
 * Pure UI: this component does NOT touch the toolset. Plan mode and
 * conditional tool registration remain the only toolset filters, on
 * purpose — see AGENTS.md "don't break workflow role boundaries".
 */
export function PersonaPicker({
  selectedAgent,
  onSelectAgent,
}: {
  selectedAgent: string | null;
  onSelectAgent: (agent: string | null) => void;
}) {
  const [personas, setPersonas] = useState<PersonaOption[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listChatPersonasAction()
      .then((result) => {
        if (cancelled) return;
        setPersonas(result.personas ?? []);
      })
      .catch((error) => {
        console.warn('[persona] load failed:', error);
        toast.error('Failed to load personas.');
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only 'main' exists — nothing to switch. Render nothing instead of a
  // disabled pill so the composer stays clean for installs that haven't
  // configured extra personas.
  const switchablePersonas = useMemo(
    () => personas.filter((p) => p.name !== 'main'),
    [personas],
  );

  const isDisabled = loaded && switchablePersonas.length === 0;

  const triggerLabel =
    (selectedAgent && personas.find((p) => p.name === selectedAgent)?.label) ||
    'Default';

  if (isDisabled) {
    // Render a subtle disabled icon so the affordance exists but takes
    // minimal space — admins see this and know to add personas in
    // /config/agents to unlock the picker.
    return (
      <Button
        className="h-9 gap-1 rounded-full px-2 text-muted-foreground/50"
        disabled
        size="sm"
        type="button"
        variant="ghost"
        title="No custom personas configured. Add agents on /config/agents to enable persona switching."
      >
        <UserCircle2 className="size-3.5" />
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className="h-9 gap-1 rounded-full px-3"
          size="sm"
          type="button"
          variant="ghost"
        >
          <UserCircle2 className="size-3.5 shrink-0" />
          <span className="max-w-[140px] truncate text-xs">{triggerLabel}</span>
          <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" collisionPadding={8} side="top">
        {personas.map((persona) => (
          <DropdownMenuItem
            key={persona.name}
            className="flex-col items-start gap-0.5 py-2"
            onSelect={() => {
              // 'main' maps to null (no override) so the request body
              // stays consistent with the "no picker" default path.
              onSelectAgent(persona.name === 'main' ? null : persona.name);
            }}
          >
            <div className="flex w-full items-center gap-2">
              <span className="flex-1 truncate font-medium text-sm">
                {persona.label}
              </span>
              {persona.hasModelOverride ? (
                <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
                  model
                </span>
              ) : null}
              {(selectedAgent ?? 'main') === persona.name ? (
                <Check className="size-4 shrink-0" />
              ) : null}
            </div>
            {persona.description ? (
              <span className="text-muted-foreground text-xs">
                {persona.description}
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}

        {loaded && switchablePersonas.length === 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Add personas on /config/agents
            </DropdownMenuLabel>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
