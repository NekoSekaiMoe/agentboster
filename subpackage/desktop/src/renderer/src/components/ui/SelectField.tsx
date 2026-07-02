import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export type SelectFieldOption = {
	value: string;
	label: ReactNode;
	disabled?: boolean;
};

export function SelectField(props: {
	label: ReactNode;
	value: string;
	options: SelectFieldOption[];
	onChange: (value: string) => void;
	className?: string;
	description?: ReactNode;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const fieldRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();
	const selectedOption =
		props.options.find((option) => option.value === props.value) ??
		props.options[0];

	useEffect(() => {
		if (!open) return;
		const handlePointerDown = (event: PointerEvent) => {
			if (!fieldRef.current?.contains(event.target as Node)) {
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

	function selectOption(option: SelectFieldOption) {
		if (props.disabled || option.disabled) return;
		props.onChange(option.value);
		setOpen(false);
	}

	return (
		<div
			ref={fieldRef}
			className={["ui-field ui-select-field", props.className]
				.filter(Boolean)
				.join(" ")}
		>
			<span className="ui-field-label">{props.label}</span>
			<button
				type="button"
				className="ui-select-control"
				disabled={props.disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={listboxId}
				onClick={() => setOpen((current) => !current)}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						setOpen(true);
					}
				}}
			>
				<span className="ui-select-value">
					{selectedOption?.label ?? props.value}
				</span>
				<ChevronDown size={15} strokeWidth={2.2} aria-hidden="true" />
			</button>
			{open && !props.disabled && (
				<div id={listboxId} className="ui-select-menu" role="listbox">
					{props.options.map((option) => (
						<button
							key={option.value}
							type="button"
							className={
								option.value === props.value
									? "ui-select-option active"
									: "ui-select-option"
							}
							role="option"
							aria-selected={option.value === props.value}
							disabled={option.disabled}
							onClick={() => selectOption(option)}
						>
							{option.label}
						</button>
					))}
				</div>
			)}
			{props.description && (
				<small className="ui-field-description">{props.description}</small>
			)}
		</div>
	);
}
