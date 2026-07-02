import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import type {
	PiExtensionSummary,
	PiSkillSummary,
	Project,
	ProjectResourceListResult,
} from "../../../../shared/types";
import { t } from "../../i18n";

type ProjectResourcesApi = typeof window.piDesktop.projectResources;

type ProjectResourceTab = "skills" | "extensions";

type DeleteTarget =
	| { kind: "skill"; item: PiSkillSummary }
	| { kind: "extension"; item: PiExtensionSummary };

export function ProjectResourcesModal(props: {
	project: Project;
	onClose: () => void;
}) {
	const [data, setData] = useState<ProjectResourceListResult>({ skills: [], extensions: [] });
	const [loading, setLoading] = useState(true);
	const [createBusy, setCreateBusy] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
	const [deleteBusy, setDeleteBusy] = useState(false);
	const [activeTab, setActiveTab] = useState<ProjectResourceTab>("skills");
	const [newName, setNewName] = useState("");
	const [newDescription, setNewDescription] = useState("");
	const [error, setError] = useState<string | null>(null);
	// 内建编辑器状态
	const [editingSkill, setEditingSkill] = useState<PiSkillSummary | null>(null);
	const [editContent, setEditContent] = useState("");
	const [editLoading, setEditLoading] = useState(false);
	const [editSaving, setEditSaving] = useState(false);
	const [editSaved, setEditSaved] = useState(false);
	const api = (window as unknown as { piDesktop: { projectResources: ProjectResourcesApi } }).piDesktop.projectResources;

	const refresh = useMemo(
		() => async () => {
			setLoading(true);
			setError(null);
			try {
				setData(await api.list(props.project.id));
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		},
		[props.project.id],
	);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const canCreateSkill = useMemo(
		() => newName.trim().length > 0 && newDescription.trim().length > 0,
		[newName, newDescription],
	);

	const createSkill = async () => {
		if (!canCreateSkill || createBusy) return;
		setCreateBusy(true);
		setError(null);
		try {
			await api.createSkill({
				projectId: props.project.id,
				name: newName.trim(),
				description: newDescription.trim(),
			});
			setNewName("");
			setNewDescription("");
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreateBusy(false);
		}
	};

	const confirmDelete = async () => {
		if (!deleteTarget || deleteBusy) return;
		setDeleteBusy(true);
		setError(null);
		try {
			if (deleteTarget.kind === "skill") {
				await api.deleteSkill(props.project.id, deleteTarget.item.path);
			} else if (deleteTarget.item.path) {
				await api.deleteExtension(props.project.id, deleteTarget.item.path);
			}
			setDeleteTarget(null);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setDeleteBusy(false);
		}
	};

	/** 打开内建编辑器：读取 SKILL.md 内容 */
	const openEditor = async (skill: PiSkillSummary) => {
		setEditingSkill(skill);
		setEditContent("");
		setEditSaved(false);
		setEditLoading(true);
		setError(null);
		try {
			const content = await window.piDesktop.files.readContent(skill.path);
			setEditContent(content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingSkill(null);
		} finally {
			setEditLoading(false);
		}
	};

	/** 保存编辑内容到 SKILL.md */
	const saveEditor = async () => {
		if (!editingSkill || editSaving) return;
		setEditSaving(true);
		setError(null);
		try {
			await window.piDesktop.files.writeContent(editingSkill.path, editContent);
			setEditSaved(true);
			window.setTimeout(() => setEditSaved(false), 2000);
			// 保存后刷新列表，让 readSkill 读到最新 frontmatter
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setEditSaving(false);
		}
	};

	/** 切换 Skill 启用/禁用 */
	const toggleSkill = async (skill: PiSkillSummary) => {
		const nextEnabled = !skill.enabled;
		try {
			const updated = await api.toggleSkill(props.project.id, skill.path, nextEnabled);
			// 直接更新列表中对应的 skill，避免全量刷新加载闪烁
			setData((prev) => ({
				...prev,
				skills: prev.skills.map((s) => (s.id === skill.id ? updated : s)),
			}));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const toggleExtension = async (extension: PiExtensionSummary) => {
		const nextEnabled = extension.enabled !== false ? false : true;
		try {
			await api.toggleExtension(props.project.id, extension.path!, nextEnabled);
			setData((prev) => ({
				...prev,
				extensions: prev.extensions.map((e) =>
					e.id === extension.id ? { ...e, enabled: nextEnabled } : e
				),
			}));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<div className="modal-backdrop project-resources-backdrop" onClick={props.onClose}>
			<section
				className="project-resources-dialog"
				role="dialog"
				aria-modal="true"
				onClick={(event) => event.stopPropagation()}
			>
				<header className="project-resources-header">
					<div>
						<strong>{t("projectResources.title")}</strong>
						<small>{props.project.path}</small>
					</div>
					<button type="button" onClick={props.onClose} aria-label={t("common.close")}>
						<X size={16} />
					</button>
				</header>

				<div className="project-resources-tabs">
					<button
						type="button"
						className={activeTab === "skills" ? "active" : ""}
						onClick={() => { setActiveTab("skills"); setEditingSkill(null); }}
					>
						{t("projectResources.skillsTab", { count: data.skills.length })}
					</button>
					<button
						type="button"
						className={activeTab === "extensions" ? "active" : ""}
						onClick={() => setActiveTab("extensions")}
					>
						{t("projectResources.extensionsTab", { count: data.extensions.length })}
					</button>
					<button type="button" className="project-resources-refresh" onClick={() => void refresh()} disabled={loading}>
						{loading ? t("common.loading") : t("common.refresh")}
					</button>
				</div>

				{error && <div className="project-resources-error">{error}</div>}

				{editingSkill ? (
					<div className="project-resources-editor-overlay">
						<div className="project-resources-editor-header">
							<strong>{editingSkill.name} · SKILL.md</strong>
							<button type="button" onClick={() => setEditingSkill(null)} aria-label={t("common.close")}>
								<X size={16} />
							</button>
						</div>
						{editLoading ? (
							<div className="config-empty">{t("common.loading")}</div>
						) : (
							<textarea
								value={editContent}
								onChange={(event) => { setEditContent(event.target.value); setEditSaved(false); }}
								spellCheck={false}
							/>
						)}
						<div className="project-resources-editor-footer">
							{editSaved && <span className="project-resources-editor-saved">{t("projectResources.editorSaved")}</span>}
							<div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
								<button className="config-btn" onClick={() => setEditingSkill(null)}>{t("common.cancel")}</button>
								<button className="config-btn primary" onClick={() => void saveEditor()} disabled={editSaving}>
									{editSaving ? t("common.saving") : t("common.save")}
								</button>
							</div>
						</div>
					</div>
				) : activeTab === "skills" ? (
					<div className="project-resources-body">
						<section className="project-skill-create skill-create-card">
							<strong>{t("projectResources.createSkill")}</strong>
							<p>{t("projectResources.createSkillHint")}</p>
							<label className="project-resources-name-field">
								<span>{t("config.name")}</span>
								<input value={newName} placeholder="my-project-skill" onChange={(event) => setNewName(event.target.value)} />
							</label>
							<label className="project-resources-desc-field">
								<span>{t("config.description")}</span>
								<textarea value={newDescription} placeholder="Use when..." onChange={(event) => setNewDescription(event.target.value)} />
							</label>
							<button className="config-btn primary" onClick={createSkill} disabled={!canCreateSkill || createBusy}>
								{createBusy ? t("config.creatingSkill") : t("config.addSkill")}
							</button>
						</section>

						<ResourceListEmpty loading={loading} empty={data.skills.length === 0} label={t("projectResources.emptySkills")} />
						{data.skills.map((skill) => (
							<article key={skill.id} className="project-resource-card">
								<div className="project-resource-info">
									<div className="project-resource-title">
																				<strong>{skill.name}</strong>
										<span className="skill-badges">
											<span className={`skill-state ${skill.enabled ? "enabled" : "disabled"}`}>
												{skill.enabled ? t("common.enabled") : t("common.disabled")}
											</span>
											{!skill.valid && <span className="skill-state invalid">{t("config.needsFix")}</span>}
										</span>
									</div>
									<small>{skill.description || t("config.skillDescriptionMissing")}</small>
									<small>{skill.sourceLabel} · {skill.path}</small>
								</div>
								<div className="skill-card-actions project-resource-actions">
									<button className="session-rename-button" onClick={() => void openEditor(skill)}>
										{t("common.edit")}
									</button>
									<button className="session-rename-button" onClick={() => void toggleSkill(skill)}>
										{skill.enabled ? t("common.disable") : t("common.enabled")}
									</button>
									<button className="session-rename-button danger" onClick={() => setDeleteTarget({ kind: "skill", item: skill })}>
										{t("common.delete")}
									</button>
								</div>
							</article>
						))}
					</div>
				) : (
					<div className="project-resources-body">
						<p className="project-resources-hint">{t("projectResources.extensionsHint")}</p>
						<ResourceListEmpty loading={loading} empty={data.extensions.length === 0} label={t("projectResources.emptyExtensions")} />
						{data.extensions.map((extension) => (
							<article key={extension.id} className="project-resource-card">
								<div className="project-resource-info">
									<div className="project-resource-title">
										<strong>{extension.source}</strong>
										<span className={`skill-state ${extension.enabled === false ? "disabled" : "enabled"}`}>
											{extension.enabled !== false ? t("common.enabled") : t("common.disabled")}
										</span>
										<span className="skill-state enabled">{t("projectResources.projectScope")}</span>
									</div>
									<small>{extension.path}</small>
								</div>
								<div className="skill-card-actions project-resource-actions">
									<button className="session-rename-button" onClick={() => void toggleExtension(extension)}>
										{extension.enabled !== false ? t("common.disable") : t("common.enabled")}
									</button>
									<button className="session-rename-button danger" onClick={() => setDeleteTarget({ kind: "extension", item: extension })} disabled={!extension.path}>
										{t("common.delete")}
									</button>
								</div>
							</article>
						))}
					</div>
				)}
			</section>

			{/* 统一确认删除弹框 */}
			{deleteTarget && (
				<div className="modal-backdrop" onClick={() => { if (!deleteBusy) setDeleteTarget(null); }}>
					<section
						className="project-resources-confirm-dialog"
						role="dialog"
						aria-modal="true"
						onClick={(event) => event.stopPropagation()}
					>
						<strong>{t("common.deleteConfirm")}</strong>
						<p>
							{deleteTarget.kind === "skill"
								? t("projectResources.deleteSkillConfirm", { name: deleteTarget.item.name })
								: t("projectResources.deleteExtensionConfirm", { name: deleteTarget.item.source })}
						</p>
						<div className="rename-dialog-actions">
							<button disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>
								{t("common.cancel")}
							</button>
							<button className="danger" disabled={deleteBusy} onClick={() => void confirmDelete()}>
								{deleteBusy ? t("common.deleting") : t("common.delete")}
							</button>
						</div>
					</section>
				</div>
			)}
		</div>
	);
}

function ResourceListEmpty(props: { loading: boolean; empty: boolean; label: string }) {
	if (props.loading) return <div className="config-empty">{t("common.loading")}</div>;
	if (props.empty) return <div className="config-empty">{props.label}</div>;
	return null;
}
