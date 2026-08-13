'use client';

import type { WorkflowMessageUIPart } from '@/types/workflow';
import { formatToolName } from './tool-timeline';

export function formatWorkflowEventTitle(part: WorkflowMessageUIPart): string {
  if (part.data.type !== 'system-event') {
    return 'Workflow Event';
  }

  switch (part.data.eventType) {
    case 'compact':
      return 'Context Compacted';
    case 'error':
      return 'Workflow Error';
    default:
      return formatToolName(part.data.eventType);
  }
}
