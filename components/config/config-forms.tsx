'use client';

import type { ConfigSectionKey } from '@/components/config/config-sections';
import { AgentDConfigPage } from './agentd-config';
import { AgentsForm } from './forms/agents-form';
import { AppearanceForm } from './forms/appearance-form';
import { AuditLogsForm } from './forms/audit-logs-form';
import { AutonomyForm } from './forms/autonomy-form';
import { ChannelsForm } from './forms/channels-form';
import { McpForm } from './forms/mcp-form';
import { ModelsForm } from './forms/models/models-form';
import { MonitoringForm } from './forms/monitoring-form';
import { SecurityForm } from './forms/security-form';
import { ToolsForm } from './forms/tools-form';
import { RawJsonEditor } from './raw-json-editor';

export function ConfigSectionForm({ section }: { section: ConfigSectionKey }) {
  switch (section) {
    case 'models':
      return <ModelsForm />;
    case 'agents':
      return <AgentsForm />;
    case 'channels':
      return <ChannelsForm />;
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
    case 'audit-logs':
      return <AuditLogsForm />;
    case 'appearance':
      return <AppearanceForm />;
    case 'raw-json':
      return <RawJsonEditor />;
    default:
      return null;
  }
}
