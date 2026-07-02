import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

export function Button(
	props: ButtonHTMLAttributes<HTMLButtonElement> & {
		variant?: ButtonVariant;
		buttonSize?: ButtonSize;
		loading?: boolean;
		children: ReactNode;
	},
) {
	const {
		variant = "secondary",
		buttonSize = "md",
		loading = false,
		className,
		children,
		type = "button",
		disabled,
		...buttonProps
	} = props;

	return (
		<button
			{...buttonProps}
			type={type}
			disabled={disabled || loading}
			className={[
				"ui-button",
				`ui-button-${variant}`,
				`ui-button-${buttonSize}`,
				loading && "ui-button-loading",
				className,
			]
				.filter(Boolean)
				.join(" ")}
		>
			{loading && <span className="ui-button-spinner" />}
			<span className={loading ? "ui-button-content-loading" : ""}>{children}</span>
		</button>
	);
}
