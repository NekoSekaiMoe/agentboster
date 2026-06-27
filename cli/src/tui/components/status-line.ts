import { Text } from '@earendil-works/pi-tui';

/**
 * One-line status panel between transcript and editor. Holds a string
 * that the coordinator sets (already styled via theme.styles); empty
 * string means "no status, render nothing".
 *
 * Rendered as a Text component so the layout slot stays a fixed row
 * whether the status is empty or not — avoids the editor jumping
 * around as statuses come and go.
 */
export function buildStatusLine(): Text {
  return new Text('', 0, 0);
}

export function setStatusLine(line: Text, content: string): void {
  line.setText(content);
}
