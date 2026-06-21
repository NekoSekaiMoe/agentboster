'use client';

import dynamic from 'next/dynamic';
import type { ConfigSectionKey } from '@/components/config/config-sections';
import { AgentDConfigPage } from './agentd-config';
import { AgentsForm } from './forms/agents-form';
import { AuditLogsForm } from './forms/audit-logs-form';
import { AutonomyForm } from './forms/autonomy-form';
import { ChatForm } from './forms/chat-form';
import { ChannelsForm } from './forms/channels-form';
import { LanguageForm } from './forms/language-form';
import { McpForm } from './forms/mcp-form';
import { ModelsForm } from './forms/models/models-form';
import { MonitoringForm } from './forms/monitoring-form';
import { SecurityForm } from './forms/security-form';
import { ToolsForm } from './forms/tools-form';
import { TtsForm } from './forms/tts-form';
import { KnowledgeManagement } from './knowledge-management';
import { UsersManagement } from './users-management';

// Lazy load RawJsonEditor (CodeMirror ~80KB) - only loaded when user clicks "Raw JSON" tab
const RawJsonEditor = dynamic(() => import('./raw-json-editor').then(mod => ({ default: mod.RawJsonEditor })), {
  ssr: false,
  loading: () => <div className="p-4 text-muted-foreground">Loading editor...</div>,
});

export function ConfigSectionForm({ section }: { section: ConfigSectionKey }) {
  switch (section) {
    case 'models':
      return <ModelsForm />;
    case 'agents':
      return <AgentsForm />;
    case 'chat':
      return <ChatForm />;
    case 'language':
      return <LanguageForm />;
    case 'channels':
      return <ChannelsForm />;
    case 'tts':
      return <TtsForm />;
    case 'autonomy':
      return <AutonomyForm />;
    case 'security':
      return <SecurityForm />;
    case 'tools':
      return <ToolsForm />;
    case 'mcp':
      return <McpForm />;
    case 'agentd':
      return <AgentDConfigPage />;
    case 'monitoring':
      return <MonitoringForm />;
    case 'users':
      return <UsersManagement />;
    case 'knowledge':
      return <KnowledgeManagement />;
    case 'audit-logs':
      return <AuditLogsForm />;
    case 'raw-json':
      return <RawJsonEditor />;
    default:
      return null;
  }
}
