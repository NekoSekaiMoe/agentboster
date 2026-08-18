'use client';

import { memo } from 'react';

import { ModelPersonaPicker } from '@/components/chat/model-persona-picker';
import { WorkspaceSwitcher } from '@/components/chat/workspace-switcher';

/**
 * Gemini-style chat header: the combined model/persona selector is the
 * title. Everything else from the old header (title, badges, token usage,
 * orchestration link) is gone. The right side carries a single
 * workspace-switcher button — no status dot, no abort button (stopping a
 * run lives in the composer's own stop button).
 */
function PureChatHeader({
  selectedModel,
  allowedModels,
  onSelectModel,
  selectedAgent,
  onSelectAgent,
}: {
  selectedModel: string | null;
  allowedModels: string[];
  onSelectModel: (model: string | null) => void;
  selectedAgent: string | null;
  onSelectAgent: (agent: string | null) => void;
}) {
  return (
    <header className="sticky top-0 z-20 flex items-center gap-1 border-b bg-background/95 py-2 pr-4 pl-14 backdrop-blur md:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <ModelPersonaPicker
          allowedModels={allowedModels}
          onSelectModel={onSelectModel}
          selectedModel={selectedModel}
          onSelectAgent={onSelectAgent}
          selectedAgent={selectedAgent}
        />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* Workspace switcher — scope the session list + long-lived container. */}
        <WorkspaceSwitcher />
      </div>
    </header>
  );
}

export const ChatHeader = memo(PureChatHeader);
