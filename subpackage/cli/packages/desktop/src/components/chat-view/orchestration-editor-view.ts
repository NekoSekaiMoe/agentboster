import { html, nothing, type TemplateResult } from 'lit';

interface OrchestrationPlanListItem {
  planId: string;
  title: string;
  itemCount: number;
}

interface OrchestrationPlanDetail {
  planId: string;
  title: string;
  items: Array<{ itemId: string; agentName: string; task: string }>;
}

export interface RenderOrchestrationEditorParams {
  open: boolean;
  loading: boolean;
  plans: OrchestrationPlanListItem[];
  selectedPlan: OrchestrationPlanDetail | null;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSelectPlan: (planId: string) => void;
  onCreatePlan: (title: string) => void;
  onAddItem: (planId: string, agentName: string, task: string) => void;
  onSubmitPlan: (planId: string) => void;
  truncate: (value: string, len: number) => string;
}

/**
 * Local input state for the inline composer flows (new plan / add item).
 * Kept module-local and reset whenever the editor is (re)opened so draft
 * text never leaks across close → open cycles. Re-renders within a single
 * open session preserve in-progress typing.
 */
interface OrchestrationEditorLocalState {
  open: boolean;
  newPlanTitle: string;
  newItemAgentName: string;
  newItemTask: string;
}

const localState: OrchestrationEditorLocalState = {
  open: false,
  newPlanTitle: '',
  newItemAgentName: '',
  newItemTask: '',
};

export function renderOrchestrationEditorView({
  open,
  loading,
  plans,
  selectedPlan,
  error,
  onClose,
  onRefresh,
  onSelectPlan,
  onCreatePlan,
  onAddItem,
  onSubmitPlan,
  truncate,
}: RenderOrchestrationEditorParams): TemplateResult | typeof nothing {
  if (!open) {
    // Reset draft state when the editor is closed so the next open starts fresh.
    if (localState.open) {
      localState.open = false;
      localState.newPlanTitle = '';
      localState.newItemAgentName = '';
      localState.newItemTask = '';
    }
    return nothing;
  }
  localState.open = true;

  const submitNewPlan = () => {
    const title = localState.newPlanTitle.trim();
    if (!title) return;
    localState.newPlanTitle = '';
    onCreatePlan(title);
  };

  const submitNewItem = () => {
    if (!selectedPlan) return;
    const agentName = localState.newItemAgentName.trim();
    const task = localState.newItemTask.trim();
    if (!agentName || !task) return;
    localState.newItemAgentName = '';
    localState.newItemTask = '';
    onAddItem(selectedPlan.planId, agentName, task);
  };

  const body = selectedPlan
    ? html`
			<div class="orchestration-detail">
				<div class="orchestration-detail-header">
					<button class="orchestration-back" @click=${() => onSelectPlan('')} title="Back to plan list">← Plans</button>
					<span class="orchestration-detail-title">${truncate(selectedPlan.title, 80)}</span>
				</div>
				<div class="orchestration-items">
					${
            selectedPlan.items.length === 0
              ? html`<div class="overlay-empty">This plan has no items yet.</div>`
              : selectedPlan.items.map((item, idx) => {
                  return html`
										<div class="orchestration-item">
											<span class="orchestration-item-index">#${idx + 1}</span>
											<div class="orchestration-item-body">
												<span class="orchestration-item-agent">${truncate(item.agentName, 60)}</span>
												<span class="orchestration-item-task">${truncate(item.task, 240)}</span>
											</div>
										</div>
									`;
                })
          }
				</div>
				<div class="orchestration-add-item">
					<div class="orchestration-add-title">Add item</div>
					<input
						type="text"
						class="orchestration-input"
						placeholder="Agent name (e.g. researcher)"
						.value=${localState.newItemAgentName}
						@input=${(event: Event) => {
              localState.newItemAgentName = (
                event.target as HTMLInputElement
              ).value;
            }}
					/>
					<textarea
						class="orchestration-input orchestration-textarea"
						placeholder="Task for this agent"
						rows="2"
						.value=${localState.newItemTask}
						@input=${(event: Event) => {
              localState.newItemTask = (
                event.target as HTMLTextAreaElement
              ).value;
            }}
					></textarea>
					<button
						class="orchestration-confirm"
						?disabled=${!localState.newItemAgentName.trim() || !localState.newItemTask.trim()}
						@click=${submitNewItem}
					>
						Add item
					</button>
				</div>
				<div class="orchestration-actions">
					<button
						class="orchestration-submit"
						?disabled=${selectedPlan.items.length === 0}
						@click=${() => onSubmitPlan(selectedPlan.planId)}
						title=${selectedPlan.items.length === 0 ? 'Add at least one item before submitting' : 'Submit this plan as a chat instruction'}
					>
						Submit plan
					</button>
				</div>
			</div>
		`
    : html`
			<div class="orchestration-new-plan">
				<div class="orchestration-add-title">New plan</div>
				<input
					type="text"
					class="orchestration-input"
					placeholder="Plan title"
					.value=${localState.newPlanTitle}
					@input=${(event: Event) => {
            localState.newPlanTitle = (event.target as HTMLInputElement).value;
          }}
					@keydown=${(event: KeyboardEvent) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submitNewPlan();
            }
          }}
				/>
				<button
					class="orchestration-confirm"
					?disabled=${!localState.newPlanTitle.trim()}
					@click=${submitNewPlan}
				>
					Create plan
				</button>
			</div>
			<div class="overlay-body history-list">
				${
          loading
            ? html`<div class="overlay-empty">Loading orchestration plans…</div>`
            : plans.length === 0
              ? html`<div class="overlay-empty">No orchestration plans yet. Create one above.</div>`
              : plans.map((plan, idx) => {
                  return html`
										<div class="history-item">
											<div class="history-item-main">
												<button
													class="history-jump"
													@click=${() => onSelectPlan(plan.planId)}
													title="Open this plan"
												>
													<div class="history-meta">
														<span class="history-role role-custom">plan</span>
														<span>#${idx + 1}</span>
													</div>
													<div class="history-preview">${truncate(plan.title, 200)}</div>
													<div class="orchestration-plan-count">${plan.itemCount} item${plan.itemCount === 1 ? '' : 's'}</div>
												</button>
											</div>
										</div>
									`;
                })
        }
			</div>
		`;

  return html`
		<div
			class="overlay"
			@click=${(event: Event) =>
        event.target === event.currentTarget && onClose()}
		>
			<div class="overlay-card orchestration-card">
				<div class="overlay-header">
					<div>
						<div>Orchestration Plans</div>
						<div class="history-subtitle">Author and submit multi-agent plans</div>
					</div>
					<button @click=${onClose}>✕</button>
				</div>
				<div class="orchestration-toolbar">
					<button class="orchestration-refresh" @click=${onRefresh} title="Reload plans">↻ Refresh</button>
					${
            error
              ? html`<span class="orchestration-error">${error}</span>`
              : nothing
          }
				</div>
				${body}
			</div>
		</div>
	`;
}
