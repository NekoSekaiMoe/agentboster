import { t } from "../i18n";
import { ConfigSelect } from "./ConfigShared";

// ── Raw Tab ─────────────────────────────────────────────

const RAW_FILE_OPTIONS = [
	{ value: "models.json", label: "models.json" },
	{ value: "auth.json", label: "auth.json" },
	{ value: "settings.json", label: "settings.json" },
	{ value: "trust.json", label: "trust.json" },
];

export function RawTab(props: {
	fileName: string;
	content: string;
	saving: boolean;
	onChangeFileName: (name: string) => void;
	onChangeContent: (content: string) => void;
	onSave: () => void;
}) {
	return (
		<div className="config-raw-tab">
			<div className="config-toolbar">
				<ConfigSelect
					value={props.fileName}
					options={RAW_FILE_OPTIONS}
					onChange={props.onChangeFileName}
				/>
				<button
					className="config-btn primary"
					onClick={props.onSave}
					disabled={props.saving}
				>
					{props.saving ? t("common.saving") : t("common.save")}
				</button>
			</div>
			<textarea
				className="config-raw-editor"
				value={props.content}
				onChange={(e) => props.onChangeContent(e.target.value)}
				spellCheck={false}
			/>
		</div>
	);
}
