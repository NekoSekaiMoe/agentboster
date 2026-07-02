import type { KeyboardEventHandler, ReactNode } from "react";

export function TextField(props: {
	label: ReactNode;
	value: string;
	onChange: (value: string) => void;
	className?: string;
	description?: ReactNode;
	placeholder?: string;
	disabled?: boolean;
	type?: "text" | "number" | "password";
	min?: number;
	max?: number;
	onBlur?: () => void;
	onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}) {
	return (
		<label
			className={["ui-field ui-text-field", props.className]
				.filter(Boolean)
				.join(" ")}
		>
			<span className="ui-field-label">{props.label}</span>
			<input
				type={props.type ?? "text"}
				value={props.value}
				placeholder={props.placeholder}
				disabled={props.disabled}
				min={props.min}
				max={props.max}
				onChange={(event) => props.onChange(event.target.value)}
				onBlur={props.onBlur}
				onKeyDown={props.onKeyDown}
			/>
			{props.description && (
				<small className="ui-field-description">{props.description}</small>
			)}
		</label>
	);
}
