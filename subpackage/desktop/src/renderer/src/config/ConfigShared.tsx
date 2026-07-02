import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Check, Eye, EyeOff, ChevronDown } from "lucide-react";
import { t } from "../i18n";
import { PROVIDER_API_OPTIONS, API_TYPE_LABELS, API_TYPE_DESCRIPTIONS, API_TYPE_DESCRIPTIONS_EN } from "./providerHeaders";

// ── 复制到剪贴板工具 ──────────────────────────────────

export function CopyButton(props: { text: string }) {
	const [copied, setCopied] = useState(false);
	const handleCopy = async (e: MouseEvent) => {
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(props.text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* 静默失败 */
		}
	};
	return (
		<button
			className={`config-copy-btn ${copied ? "copied" : ""}`}
			onClick={handleCopy}
			title={t("common.copy")}
		>
			{copied ? (
				<>
					<Check size={14} /> {t("terminal.copied")}
				</>
			) : (
				t("common.copy")
			)}
		</button>
	);
}

/** 密码输入框：支持显示/隐藏 + 复制 */
export function SecretInput(props: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
}) {
	const [visible, setVisible] = useState(false);
	return (
		<div className="config-secret-input">
			<input
				type={visible ? "text" : "password"}
				value={props.value}
				onChange={(e) => props.onChange(e.target.value)}
				placeholder={props.placeholder ?? t("config.apiKeyPlaceholder")}
			/>
			<button
				className="config-eye-btn"
				onClick={() => setVisible(!visible)}
				title={visible ? t("common.hide") : t("common.show")}
			>
				{visible ? <EyeOff size={15} /> : <Eye size={15} />}
			</button>
			<CopyButton text={props.value} />
		</div>
	);
}

// ── Models Tab ──────────────────────────────────────────

export function ConfigSelect(props: {
	value: string;
	options: Array<{ value: string; label: string }>;
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	const [open, setOpen] = useState(false);
	const selected = props.options.find((option) => option.value === props.value);
	return (
		<div
			className="config-combobox config-select"
			onBlur={() => {
				// 和 API 类型 combobox 保持一致：先让选项 mouseDown 完成，再关闭菜单。
				window.setTimeout(() => setOpen(false), 80);
			}}
		>
			<button
				type="button"
				className="config-select-trigger"
				onFocus={() => setOpen(true)}
				onMouseDown={(e) => {
					e.preventDefault();
					setOpen((current) => !current);
				}}
			>
				<span>{selected?.label ?? props.placeholder ?? props.value}</span>
				<ChevronDown size={14} />
			</button>
			{open && (
				<div className="config-combobox-menu">
					{props.options.map((option) => (
						<button
							key={option.value || "none"}
							type="button"
							className={option.value === props.value ? "active" : ""}
							onMouseDown={(e) => {
								e.preventDefault();
								props.onChange(option.value);
								setOpen(false);
							}}
						>
							{option.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * 通用 combobox 输入框：支持下拉选择 + 手动输入，选项支持文本过滤。
 * 用于 settings 中 defaultProvider / defaultModel 等需要从已有配置选取但又允许自定义的场景。
 */
export function ConfigComboboxInput(props: {
	value: string;
	options: Array<{ value: string; label?: string }>;
	onChange: (value: string) => void;
	placeholder?: string;
}) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const containerRef = useRef<HTMLDivElement>(null);

	// 点击外部时立即关闭下拉，避免多个 combobox 同时展开重叠
	useEffect(() => {
		if (!open) return;
		const handlePointerDown = (event: PointerEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [open]);

	// 输入框获得焦点时打开下拉，并清空过滤文本以显示全部选项
	const handleFocus = () => {
		setFilter("");
		setOpen(true);
	};

	// 根据过滤文本筛选选项，支持 label 和 value 双向匹配
	const filtered = filter
		? props.options.filter(
				(opt) =>
					opt.value.toLowerCase().includes(filter.toLowerCase()) ||
					(opt.label ?? opt.value).toLowerCase().includes(filter.toLowerCase()),
			)
		: props.options;

	return (
		<div ref={containerRef} className="config-combobox config-settings-combobox">
			<input
				value={open ? filter : props.value}
				onFocus={handleFocus}
				onChange={(e) => {
					setFilter(e.target.value);
					props.onChange(e.target.value);
					setOpen(true);
				}}
				placeholder={props.placeholder}
				className="config-settings-input"
			/>
			<button
				type="button"
				className="config-combobox-toggle"
				onMouseDown={(e) => {
					e.preventDefault();
					if (open) {
						setOpen(false);
					} else {
						setFilter("");
						setOpen(true);
					}
				}}
			>
				<ChevronDown size={14} />
			</button>
			{open && (
				<div className="config-combobox-menu config-settings-combobox-menu">
					{filtered.length === 0 && (
						<div className="config-combobox-empty">{t("config.noMatchingOptions")}</div>
					)}
					{filtered.map((option) => (
						<button
							key={option.value}
							type="button"
							className={option.value === props.value ? "active" : ""}
							onMouseDown={(e) => {
								e.preventDefault();
								props.onChange(option.value);
								setOpen(false);
							}}
						>
							{option.label ?? option.value}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/** API 类型输入：自定义 combobox，避免原生 datalist 在 Electron 滚动容器中出现弹层错位或选项显示不完整。 */
export function ApiTypeInput(props: {
	value: string;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);

	return (
		<div
			className="config-combobox"
			onBlur={() => {
				// 等待 option 的 mouseDown 先写入值，再关闭下拉，避免点击被 blur 截断。
				window.setTimeout(() => setOpen(false), 80);
			}}
		>
			<input
				value={props.value}
				onFocus={() => setOpen(true)}
				onChange={(e) => {
					props.onChange(e.target.value);
					setOpen(true);
				}}
				placeholder={t("config.apiTypePlaceholder")}
			/>
			<button
				type="button"
				className="config-combobox-toggle"
				onMouseDown={(e) => {
					e.preventDefault();
					setOpen((current) => !current);
				}}
				title={t("config.apiTypeExpand")}
			>
				<ChevronDown size={14} />
			</button>
			{open && (
				<div className="config-combobox-menu config-api-type-menu">
					{PROVIDER_API_OPTIONS.map((option) => (
						<button
							key={option}
							type="button"
							className={option === props.value ? "active" : ""}
							onMouseDown={(e) => {
								e.preventDefault();
								props.onChange(option);
								setOpen(false);
							}}
						>
							<span className="config-api-type-label">{API_TYPE_LABELS[option] || option}</span>
							<small className="config-api-type-desc">{API_TYPE_DESCRIPTIONS[option] || ""}</small>
						</button>
					))}
				</div>
			)}
		</div>
	);
}


