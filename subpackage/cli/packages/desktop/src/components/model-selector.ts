/**
 * Model Selector component.
 *
 * A dropdown dialog for choosing AI models. Fetches available models from the
 * pi agent via RPC, supports search filtering and keyboard navigation.
 */

import { html, nothing, render, type TemplateResult } from "lit";
import { rpcBridge } from "../rpc/bridge.js";

// ============================================================================
// Types
// ============================================================================

interface ModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
	cost?: { input: number; output: number };
	input?: string[];
}

// ============================================================================
// Model Selector
// ============================================================================

export class ModelSelector {
	private container: HTMLElement;
	private models: ModelInfo[] = [];
	private filteredModels: ModelInfo[] = [];
	private searchQuery = "";
	private selectedIndex = 0;
	private isOpen = false;
	private isLoading = false;
	private currentModelId = "";
	private currentProvider = "";
	private onSelect: ((provider: string, modelId: string) => void) | null = null;
	private onClose: (() => void) | null = null;
	private keyHandler: ((e: KeyboardEvent) => void) | null = null;
	private clickOutsideHandler: ((e: MouseEvent) => void) | null = null;

	constructor(container: HTMLElement) {
		this.container = container;
	}

	async open(
		currentProvider: string,
		currentModelId: string,
		onSelect: (provider: string, modelId: string) => void,
		onClose?: () => void,
	): Promise<void> {
		this.currentProvider = currentProvider;
		this.currentModelId = currentModelId;
		this.onSelect = onSelect;
		this.onClose = onClose ?? null;
		this.searchQuery = "";
		this.selectedIndex = 0;
		this.isOpen = true;
		this.isLoading = true;
		this.render();

		// Fetch models
		try {
			const rawModels = await rpcBridge.getAvailableModels();
			this.models = rawModels.map((m) => ({
				id: m.id as string,
				name: m.name as string,
				provider: (m.provider as string) ?? "unknown",
				reasoning: (m.reasoning as boolean) ?? false,
				contextWindow: (m.contextWindow as number) ?? 0,
				maxTokens: (m.maxTokens as number) ?? 0,
				cost: m.cost as { input: number; output: number } | undefined,
				input: m.input as string[] | undefined,
			}));
			this.isLoading = false;
			this.applyFilter();
			this.render();
		} catch (err) {
			console.error("Failed to fetch models:", err);
			this.isLoading = false;
			this.render();
		}

		// Focus the search input after render
		requestAnimationFrame(() => {
			const input = this.container.querySelector("#model-search") as HTMLInputElement | null;
			input?.focus();
		});

		// Setup keyboard handler
		this.keyHandler = (e: KeyboardEvent) => this.handleKeyDown(e);
		document.addEventListener("keydown", this.keyHandler);

		// Click outside to close
		this.clickOutsideHandler = (e: MouseEvent) => {
			const dialog = this.container.querySelector(".model-selector-dialog");
			if (dialog && !dialog.contains(e.target as Node)) {
				this.close();
			}
		};
		// Delay to avoid closing from the same click that opened
		setTimeout(() => {
			if (this.clickOutsideHandler) {
				document.addEventListener("mousedown", this.clickOutsideHandler);
			}
		}, 50);
	}

	close(): void {
		this.isOpen = false;
		if (this.keyHandler) {
			document.removeEventListener("keydown", this.keyHandler);
			this.keyHandler = null;
		}
		if (this.clickOutsideHandler) {
			document.removeEventListener("mousedown", this.clickOutsideHandler);
			this.clickOutsideHandler = null;
		}
		this.render();
		this.onClose?.();
	}

	private applyFilter(): void {
		const query = this.searchQuery.toLowerCase().trim();
		if (!query) {
			this.filteredModels = [...this.models];
		} else {
			const tokens = query.split(/\s+/);
			this.filteredModels = this.models.filter((m) => {
				const text = `${m.id} ${m.name} ${m.provider}`.toLowerCase();
				return tokens.every((t) => text.includes(t));
			});
		}

		// Sort: current model first, then by provider+id
		this.filteredModels.sort((a, b) => {
			const aCurrent = a.id === this.currentModelId && a.provider === this.currentProvider;
			const bCurrent = b.id === this.currentModelId && b.provider === this.currentProvider;
			if (aCurrent && !bCurrent) return -1;
			if (!aCurrent && bCurrent) return 1;
			const provCmp = a.provider.localeCompare(b.provider);
			if (provCmp !== 0) return provCmp;
			return a.id.localeCompare(b.id);
		});

		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private handleKeyDown(e: KeyboardEvent): void {
		if (!this.isOpen) return;

		switch (e.key) {
			case "Escape":
				e.preventDefault();
				this.close();
				break;
			case "ArrowDown":
				e.preventDefault();
				this.selectedIndex = Math.min(this.selectedIndex + 1, this.filteredModels.length - 1);
				this.render();
				this.scrollSelectedIntoView();
				break;
			case "ArrowUp":
				e.preventDefault();
				this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
				this.render();
				this.scrollSelectedIntoView();
				break;
			case "Enter":
				e.preventDefault();
				if (this.filteredModels[this.selectedIndex]) {
					const model = this.filteredModels[this.selectedIndex];
					this.onSelect?.(model.provider, model.id);
					this.close();
				}
				break;
		}
	}

	private scrollSelectedIntoView(): void {
		requestAnimationFrame(() => {
			const item = this.container.querySelector(`[data-model-index="${this.selectedIndex}"]`);
			item?.scrollIntoView({ block: "nearest" });
		});
	}

	private formatContextWindow(tokens: number): string {
		if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
		if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
		return `${tokens}`;
	}

	private formatCost(costPerMillion: number): string {
		if (costPerMillion === 0) return "free";
		if (costPerMillion < 0.01) return `$${costPerMillion.toFixed(4)}`;
		if (costPerMillion < 1) return `$${costPerMillion.toFixed(2)}`;
		return `$${costPerMillion.toFixed(1)}`;
	}

	private renderModelItem(model: ModelInfo, index: number): TemplateResult {
		const isCurrent = model.id === this.currentModelId && model.provider === this.currentProvider;
		const isSelected = index === this.selectedIndex;
		const hasVision = model.input?.includes("image");

		return html`
			<button
				data-model-index=${index}
				class="model-item w-full text-left px-3 py-2 flex items-center gap-2 ${isSelected ? "bg-secondary" : "hover:bg-secondary/50"} ${isCurrent ? "border-l-2 border-primary" : ""} transition-colors"
				@click=${() => {
					this.onSelect?.(model.provider, model.id);
					this.close();
				}}
				@mouseenter=${() => {
					this.selectedIndex = index;
					this.render();
				}}
			>
				<div class="flex-1 min-w-0">
					<div class="flex items-center gap-1.5">
						<span class="text-sm text-foreground truncate">${model.id}</span>
						${isCurrent ? html`<span class="text-[10px] text-primary font-medium">(current)</span>` : nothing}
					</div>
					<div class="flex items-center gap-2 mt-0.5">
						<span class="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">${model.provider}</span>
						${model.reasoning ? html`<span class="text-[10px] px-1 rounded bg-amber-500/10 text-amber-500">thinking</span>` : nothing}
						${hasVision ? html`<span class="text-[10px] px-1 rounded bg-blue-500/10 text-blue-500">vision</span>` : nothing}
					</div>
				</div>
				<div class="text-right shrink-0">
					<div class="text-[10px] text-muted-foreground">${this.formatContextWindow(model.contextWindow)} ctx</div>
					${model.cost ? html`<div class="text-[10px] text-muted-foreground">${this.formatCost(model.cost.input)}/M in</div>` : nothing}
				</div>
			</button>
		`;
	}

	render(): void {
		if (!this.isOpen) {
			render(nothing, this.container);
			return;
		}

		const template = html`
			<div class="model-selector-overlay">
				<div class="model-selector-dialog">
					<!-- Search -->
					<div class="px-3 py-2 border-b border-border">
						<input
							id="model-search"
							type="text"
							class="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
							placeholder="Search models..."
							.value=${this.searchQuery}
							@input=${(e: Event) => {
								this.searchQuery = (e.target as HTMLInputElement).value;
								this.selectedIndex = 0;
								this.applyFilter();
								this.render();
							}}
						/>
					</div>

					<!-- Model list -->
					<div class="model-selector-list overflow-y-auto max-h-[400px]">
						${
							this.isLoading
								? html`<div class="px-3 py-8 text-center text-sm text-muted-foreground">Loading models...</div>`
								: this.filteredModels.length === 0
									? html`<div class="px-3 py-8 text-center text-sm text-muted-foreground">No models found</div>`
									: this.filteredModels.map((m, i) => this.renderModelItem(m, i))
						}
					</div>

					<!-- Footer -->
					<div class="px-3 py-1.5 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
						<span>${this.filteredModels.length} models</span>
						<span>
							<kbd class="px-1 rounded bg-secondary">↑↓</kbd> navigate
							<kbd class="px-1 rounded bg-secondary ml-1">↵</kbd> select
							<kbd class="px-1 rounded bg-secondary ml-1">esc</kbd> close
						</span>
					</div>
				</div>
			</div>
		`;

		render(template, this.container);
	}
}
