import type { ReactNode } from "react";
import { X } from "lucide-react";

export function IconButton(props: {
	label: string;
	children: ReactNode;
	onClick?: () => void;
	className?: string;
	title?: string;
	type?: "button" | "submit" | "reset";
	disabled?: boolean;
}) {
	return (
		<button
			type={props.type ?? "button"}
			className={["ui-icon-button", props.className].filter(Boolean).join(" ")}
			aria-label={props.label}
			title={props.title ?? props.label}
			onClick={props.onClick}
			disabled={props.disabled}
		>
			{props.children}
		</button>
	);
}

export function CloseIconButton(props: {
	label: string;
	onClick: () => void;
	className?: string;
}) {
	return (
		<IconButton
			className={["modal-close-btn", props.className].filter(Boolean).join(" ")}
			label={props.label}
			onClick={props.onClick}
		>
			<X size={18} strokeWidth={2.2} aria-hidden="true" />
		</IconButton>
	);
}
