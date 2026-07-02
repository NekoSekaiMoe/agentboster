import { useState, useRef, useCallback, useEffect } from "react";
import { X, Plus, Check } from "lucide-react";
import type { AuthFile, SettingsFile, ModelsFile } from "./configTypes";
import { ConfigComboboxInput } from "./ConfigShared";
import { t } from "../i18n";

// ── 可用模型列表聚合（含供应商信息，供 enabledModels 多选用） ──

interface ModelRecord {
	id: string;
	provider: string;
	name?: string;
}

function collectModels(
	modelsData?: ModelsFile,
	discoveredModels?: Record<string, Array<{ id: string; name?: string }>>,
): ModelRecord[] {
	const map = new Map<string, ModelRecord>();
	if (modelsData) {
		for (const [provider, cfg] of Object.entries(modelsData.providers)) {
			for (const m of cfg.models) {
				const key = `${provider}/${m.id}`;
				if (!map.has(key)) {
					map.set(key, { id: m.id, provider, name: m.name });
				}
			}
		}
	}
	if (discoveredModels) {
		for (const [provider, models] of Object.entries(discoveredModels)) {
			for (const m of models) {
				const key = `${provider}/${m.id}`;
				if (!map.has(key)) {
					map.set(key, { id: m.id, provider, name: m.name });
				}
			}
		}
	}
	return [...map.values()];
}

// ── Settings Tab ────────────────────────────────────────

export function SettingsTab(props: {
	data: SettingsFile;
	saving: boolean;
	/** 已配置的模型/服务商数据，用于 defaultProvider / defaultModel 下拉选项 */
	modelsData?: ModelsFile;
	/** 已配置的认证数据，配合 modelsData 一起为 defaultProvider 聚合所有可用的供应商 */
	authData?: AuthFile;
	/** 通过已知端点自动发现的模型（auth-only 供应商） */
	discoveredModels?: Record<string, Array<{ id: string; name?: string }>>;
	onChange: (data: SettingsFile) => void;
	onSave: () => void;
}) {
	const { data, saving } = props;
	const entries = Object.entries(data);
	// enabledModels 已配置时合并到 entries 前端展示，未配置时通过「添加」按钮单独显示
	const hasEnabledModels = "enabledModels" in data;

	/**
	 * 设置页只暴露外层重试次数和基础延迟。
	 * provider 级 timeout/maxRetries 的单位和 SDK 语义容易误解，写入后可能导致立即超时或长时间重试卡住。
	 */
	const retryConfig = {
		maxRetries: (data as any).retry?.maxRetries ?? 10,
		baseDelayMs: (data as any).retry?.baseDelayMs ?? 5000,
	};

	// 首次进入设置页时清理旧版 UI 写入的 provider/enable 等字段，保证后续保存只留下安全的两个参数。
	const retryInitializedRef = useRef(false);
	useEffect(() => {
		if (retryInitializedRef.current) return;
		const existingRetry = (data as any).retry;
		if (!existingRetry || Object.keys(existingRetry).some((key) => !(key in retryConfig))) {
			props.onChange({ ...data, retry: retryConfig });
		}
		retryInitializedRef.current = true;
	}, []);

	const updateRetry = (patch: Record<string, unknown>) => {
		props.onChange({
			...data,
			retry: { ...retryConfig, ...patch },
		});
	};

	/** 配置键名 → 显示标签（未映射的键名回退显示原始 key） */
	const configLabel = (key: string): string => {
		switch (key) {
			case "enabledModels": return t("config.label.enabledModels");
			case "defaultProvider": return t("config.label.defaultProvider");
			case "defaultModel": return t("config.label.defaultModel");
			case "lastChangelogVersion": return t("config.label.lastChangelogVersion");
			case "customPrompt": return t("config.label.customPrompt");
			case "promptGuidelines": return t("config.label.promptGuidelines");
			case "appendSystemPrompt": return t("config.label.appendSystemPrompt");
			case "proxy": return t("config.label.proxy");
			case "proxyUrl": return t("config.label.proxyUrl");
			case "proxyBypass": return t("config.label.proxyBypass");
			case "theme": return t("config.label.theme");
			case "language": return t("config.label.language");
			case "disabledSkills": return t("config.label.disabledSkills");
			case "disabledExtensions": return t("config.label.disabledExtensions");
			case "noProjectDiscovery": return t("config.label.noProjectDiscovery");
			case "defaultProjectTrust": return t("config.label.defaultProjectTrust");
			case "allowProjectChanges": return t("config.label.allowProjectChanges");
			case "enableSkillCommands": return t("config.label.enableSkillCommands");
			case "temperature": return t("config.label.temperature");
			case "systemPrompt": return t("config.label.systemPrompt");
			case "hideThinkingBlock": return t("config.label.hideThinkingBlock");
			case "packages": return t("config.label.packages");
			case "defaultThinkingLevel": return t("config.label.defaultThinkingLevel");
			case "quietStartup": return t("config.label.quietStartup");
			case "collapseChangelog": return t("config.label.collapseChangelog");
			default: return key;
		}
	};

	return (
		<div className="config-settings-tab">
			<div className="config-toolbar">
				<span className="config-count">
					{t("config.count.configItems", { count: entries.length })}
				</span>
				<button
					className="config-btn primary"
					onClick={props.onSave}
					disabled={saving}
				>
					{saving ? t("common.saving") : t("common.save")}
				</button>
			</div>
			<div className="config-settings-list">
				{/* enabledModels 始终显示在最前面 */}
				<div className="config-settings-row">
					<span className="config-settings-key">{configLabel("enabledModels")}</span>
					<EnabledModelsInput
						value={
							Array.isArray(data.enabledModels) ? data.enabledModels : undefined
						}
						models={collectModels(props.modelsData, props.discoveredModels)}
						onChange={(v) => props.onChange({ ...data, enabledModels: v })}
					/>
				</div>

				{/* ── 重试配置 ── */}
				<div className="config-retry-group">
					<div className="config-settings-row config-retry-header-row">
					<span className="config-settings-section-title">{t("config.retry.title")}</span>
					<span className="config-settings-section-hint">{t("config.retry.hint")}</span>
				</div>
				<div className="config-settings-row">
					<span className="config-settings-key">{t("config.retry.maxRetries")}</span>
					<input className="config-settings-input" type="number" min={0} max={50} value={retryConfig.maxRetries} onChange={(e) => updateRetry({ maxRetries: Number(e.target.value) })} />
				</div>
				<div className="config-settings-row">
					<span className="config-settings-key">{t("config.retry.baseDelayMs")}</span>
					<input className="config-settings-input" type="number" min={100} step={100} value={retryConfig.baseDelayMs} onChange={(e) => updateRetry({ baseDelayMs: Number(e.target.value) })} />
				</div>
				</div>

				{entries
					.filter(([key]) => key !== "enabledModels" && key !== "retry")
					.map(([key, value]) => (
					<div key={key} className="config-settings-row">
						<span className="config-settings-key">{configLabel(key)}</span>
						<SettingsValueInput
							value={value}
							fieldKey={key}
							modelsData={props.modelsData}
							authData={props.authData}
							discoveredModels={props.discoveredModels}
							allSettings={data}
							onChange={(v) => props.onChange({ ...data, [key]: v })}
						/>
					</div>
				))}
				{!hasEnabledModels && (
					<div className="config-settings-row config-settings-row--add">
						<button
							className="config-btn"
							onClick={() => props.onChange({ ...data, enabledModels: [] })}
						>
							<Plus size={14} />
							{t("config.settings.addEnabledModels")}
						</button>
					</div>
				)}
				{entries.length === 0 && <div className="config-empty">{t("config.emptyConfig")}</div>}
			</div>
		</div>
	);
}

/**
 * enabledModels 下拉多选：按供应商分组，搜索过滤可用模型，勾选加入列表。
 * 选中的模型 ID 直接写入 enabledModels 数组，取消勾选即从列表中移除。
 * 输入含 * 或 ? 时可添加 glob 模式。
 */
function EnabledModelsInput(props: {
	value?: string[];
	/** 按模型的 provider/id 分组，每项含 provider 信息 */
	models: ModelRecord[];
	onChange: (value: string[]) => void;
}) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const containerRef = useRef<HTMLDivElement>(null);
	const selected = new Set(props.value ?? []);

	// 点击外部关闭下拉
	useEffect(() => {
		if (!open) return;
		const handlePointerDown = (event: PointerEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("pointerdown", handlePointerDown);
		return () => document.removeEventListener("pointerdown", handlePointerDown);
	}, [open]);

	const toggleModel = (id: string) => {
		const next = new Set(selected);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		props.onChange([...next]);
	};

	const removeSelected = (id: string) => {
		const next = new Set(selected);
		next.delete(id);
		props.onChange([...next]);
	};

	// 过滤 & 按供应商分组
	const normalizedFilter = filter.trim().toLowerCase();
	const isGlob = filter.includes("*") || filter.includes("?");
	const filteredModels = normalizedFilter && !isGlob
		? props.models.filter((m) =>
				[m.id, m.name, m.provider, `${m.provider}/${m.id}`]
					.filter(Boolean)
					.some((v) => v!.toLowerCase().includes(normalizedFilter)),
			)
		: props.models;

	// 按供应商分组
	const grouped = filteredModels.reduce<Record<string, ModelRecord[]>>((acc, m) => {
		if (!acc[m.provider]) acc[m.provider] = [];
		acc[m.provider].push(m);
		return acc;
	}, {});

	const providerNames = Object.keys(grouped).sort((a, b) => {
		const order = ["anthropic", "openai", "google", "deepseek", "other"];
		const ai = order.indexOf(a);
		const bi = order.indexOf(b);
		if (ai !== -1 && bi !== -1) return ai - bi;
		if (ai !== -1) return -1;
		if (bi !== -1) return 1;
		return a.localeCompare(b);
	});

	const hasResults = providerNames.length > 0 || isGlob;

	return (
		<div ref={containerRef} className="config-enabled-models">
			<div className="config-enabled-models-tags" onClick={() => setOpen(true)}>
				{[...selected].map((id) => (
					<span key={id} className="config-enabled-models-tag">
						<span>{id}</span>
						<button
							type="button"
							className="config-enabled-models-tag-remove"
							onClick={(e) => {
								e.stopPropagation();
								removeSelected(id);
							}}
						>
							<X size={12} />
						</button>
					</span>
				))}
				<span className="config-enabled-models-trigger-text">
					{selected.size === 0
						? t("config.settings.enabledModelsPlaceholder")
						: `${selected.size} ${t("config.settings.enabledModelsSelected")}`}
				</span>
			</div>

			{open && (
				<div className="config-enabled-models-dropdown">
					<div className="config-enabled-models-dropdown-search">
						<input
							autoFocus
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder={t("config.settings.enabledModelsSearchPlaceholder")}
						/>
					</div>
					<div className="config-enabled-models-dropdown-list">
						{/* glob 模式行：输入含 * 或 ? 时显示，可勾选为自定义模式 */}
						{filter && isGlob && (
							<div className="config-enabled-models-glob-row">
								<button
									type="button"
									className={`config-enabled-models-glob-add${selected.has(filter) ? " selected" : ""}`}
									onClick={() => toggleModel(filter)}
								>
									<span className="config-enabled-models-checkbox">
										{selected.has(filter) && <Check size={12} />}
									</span>
									<span className="config-enabled-models-glob-label">{filter}</span>
									<span className="config-enabled-models-glob-hint">{t("config.settings.enabledModelsGlobHint")}</span>
								</button>
							</div>
						)}
						{hasResults && providerNames.map((provider) => (
							<div key={provider} className="config-enabled-provider-group">
								{/* 供应商分组头：点击折叠/展开 */}
								<button
									type="button"
									className={`config-enabled-provider-header${collapsed.has(provider) ? " collapsed" : ""}`}
									onClick={() => {
										setCollapsed((prev) => {
											const next = new Set(prev);
											if (next.has(provider)) next.delete(provider);
											else next.add(provider);
											return next;
										});
									}}
								>
									<span className="config-enabled-provider-name">{provider}</span>
									<span className="config-enabled-provider-count">{grouped[provider].length}</span>
								</button>
								{!collapsed.has(provider) && grouped[provider].map((m) => (
									<label
										key={`${m.provider}/${m.id}`}
										className={`config-enabled-models-option${selected.has(m.id) ? " selected" : ""}`}
										onClick={() => toggleModel(m.id)}
									>
										<span className="config-enabled-models-checkbox">
											{selected.has(m.id) && <Check size={12} />}
										</span>
										<span className="config-enabled-model-label">{m.name ?? m.id}</span>
										<span className="config-enabled-model-provider">{m.provider}/{m.id}</span>
									</label>
								))}
							</div>
						))}
						{!hasResults && (
							<div className="config-enabled-models-empty">{t("app.modelPickerEmpty")}</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

function SettingsValueInput(props: {
	value: unknown;
	fieldKey: string;
	modelsData?: ModelsFile;
	authData?: AuthFile;
	discoveredModels?: Record<string, Array<{ id: string; name?: string }>>;
	allSettings?: SettingsFile;
	onChange: (v: unknown) => void;
}) {
	const { value, fieldKey, modelsData, authData, discoveredModels, allSettings } = props;

	// defaultProvider: 从 modelsData.providers + authData 的 key 列表聚合所有可用的供应商
	if (fieldKey === "defaultProvider") {
		const providerSet = new Set<string>();
		if (modelsData) {
			for (const name of Object.keys(modelsData.providers)) {
				providerSet.add(name);
			}
		}
		if (authData) {
			for (const name of Object.keys(authData)) {
				providerSet.add(name);
			}
		}
		const providerOptions = [...providerSet].map((name) => ({ value: name }));
		return (
			<ConfigComboboxInput
				value={typeof value === "string" ? value : ""}
				options={providerOptions}
				onChange={(v) => props.onChange(v)}
				placeholder={t("config.settings.selectProvider")}
			/>
		);
	}

	// defaultModel: 根据当前选中的 defaultProvider 联动过滤
	if (fieldKey === "defaultModel") {
		const selectedProvider = allSettings?.["defaultProvider"];
		const selectedProviderName = typeof selectedProvider === "string" ? selectedProvider : "";
		const currentModel = typeof value === "string" ? value : "";
		const modelOptions: Array<{ value: string; label?: string }> = [];
		const seen = new Set<string>();

		// 始终将当前已配置的值作为首选项，确保已生效的配置在列表中可见
		if (currentModel && !seen.has(currentModel)) {
			seen.add(currentModel);
			const currentLabel = selectedProviderName
				? `${currentModel} (${selectedProviderName})`
				: currentModel;
			modelOptions.push({ value: currentModel, label: currentLabel });
		}

		if (selectedProviderName) {
			// 优先从模型配置中取该供应商的模型
			const provider = modelsData?.providers[selectedProviderName];
			if (provider) {
				for (const model of provider.models) {
					if (!seen.has(model.id)) {
						seen.add(model.id);
						const label = model.name && model.name !== model.id
							? `${model.name} (${selectedProviderName})`
							: `${model.id} (${selectedProviderName})`;
						modelOptions.push({ value: model.id, label });
					}
				}
			}
			// 尝试从自动发现的模型中获取（auth-only 供应商通过已知端点获取）
			const discovered = discoveredModels?.[selectedProviderName];
			if (discovered) {
				for (const model of discovered) {
					if (!seen.has(model.id)) {
						seen.add(model.id);
						modelOptions.push({
							value: model.id,
							label: model.name
								? `${model.name} (${selectedProviderName})`
								: `${model.id} (${selectedProviderName})`,
						});
					}
				}
			}
			// 如果该供应商只有 auth 没有模型配置，尝试从 auth 条目的 model 字段获取
			const authEntry = authData?.[selectedProviderName];
			if (authEntry && typeof authEntry.model === "string" && authEntry.model && !seen.has(authEntry.model)) {
				seen.add(authEntry.model);
				modelOptions.push({ value: authEntry.model, label: `${authEntry.model} (${selectedProviderName})` });
			}
		} else {
			// 未选择供应商时，展示全部模型的精简列表供参考
			if (modelsData) {
				for (const [pName, provider] of Object.entries(modelsData.providers)) {
					for (const model of provider.models) {
						if (!seen.has(model.id)) {
							seen.add(model.id);
							const label = model.name && model.name !== model.id
								? `${model.name} (${pName})`
								: `${model.id} (${pName})`;
							modelOptions.push({ value: model.id, label });
						}
					}
				}
			}
			if (authData) {
				for (const [pName, auth] of Object.entries(authData)) {
					if (typeof auth.model === "string" && auth.model && !seen.has(auth.model)) {
						seen.add(auth.model);
						modelOptions.push({ value: auth.model, label: `${auth.model} (${pName})` });
					}
				}
			}
			// 从自动发现的模型中获取
			if (discoveredModels) {
				for (const [pName, models] of Object.entries(discoveredModels)) {
					for (const model of models) {
						if (!seen.has(model.id)) {
							seen.add(model.id);
							modelOptions.push({
								value: model.id,
								label: model.name
									? `${model.name} (${pName})`
									: `${model.id} (${pName})`,
							});
						}
					}
				}
			}
		}

		return (
			<ConfigComboboxInput
				value={typeof value === "string" ? value : ""}
				options={modelOptions}
				onChange={(v) => props.onChange(v)}
				placeholder={selectedProviderName
					? t("config.settings.selectModelFor", { provider: selectedProviderName })
					: t("config.settings.selectModelFirst")}
			/>
		);
	}

	if (typeof value === "boolean") {
		return (
			<label className="config-checkbox-label">
				<input
					type="checkbox"
					checked={value}
					onChange={(e) => props.onChange(e.target.checked)}
				/>
				<span>{value ? t("common.true") : t("common.false")}</span>
			</label>
		);
	}
	if (typeof value === "number") {
		return (
			<input
				type="number"
				value={value}
				onChange={(e) => props.onChange(Number(e.target.value))}
				className="config-settings-input"
			/>
		);
	}
	if (typeof value === "string") {
		return (
			<input
				value={value}
				onChange={(e) => props.onChange(e.target.value)}
				className="config-settings-input"
			/>
		);
	}
	return (
		<input
			value={JSON.stringify(value)}
			onChange={(e) => {
				try {
					props.onChange(JSON.parse(e.target.value));
				} catch {
					/* 输入过程中 JSON 不合法时暂不更新 */
				}
			}}
			className="config-settings-input"
		/>
	);
}


