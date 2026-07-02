import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "../shared/ipc";
import type {
	AgentRuntimeState,
	AgentTab,
	AppInfo,
	AppLogEntry,
	AppLogLevel,
	AppLogQuery,
	AppSettings,
	AppUpdateDownloadProgress,
	AppUpdateDownloadResult,
	AppUpdateInfo,
	AvailableModel,
	ChatMessage,
	CodexImportReport,
	CodexSessionSummary,
	ClaudeImportReport,
	ClaudeSessionSummary,
	OpenCodeImportReport,
	OpenCodeSessionSummary,
	ConfigFileDiagnostic,
	DraftMeta,
	CreateAgentInput,
	CreatePiSkillInput,
	CreateProjectSkillInput,
 	ProjectResourceListResult,
 	PetAggregateState,
 	PetManifest,
 	PetNotification,
 	PetWindowCaps,
 	ExternalEditor,
	ExternalEditorId,
	ExternalEditorSetting,
	FeedbackEnvironment,
	FeishuBotConfig,
	FeishuBridgeStatus,
	FeishuChatBinding,
	FeishuChatMessage,
	FeishuConnectInput,
	FeishuTestResult,
	FileTreeNode,
	ForkMessage,
	GitBranchInfo,
	PiCliUpdateResult,
	PiCommand,
	PiExtensionListResult,
	PiInstallStatus,
	PiProxyTestResult,
	PiUpdateCheckResult,
	PiSkillListResult,
	PiSkillSummary,
	Project,
	ScratchPadData,
	SendPromptInput,
	SessionSummary,
	TerminalDataEvent,
	TerminalExitEvent,
	TerminalTab,
	ThinkingUpdate,
} from "../shared/types";

const api = {
	editors: {
		list: () => ipcRenderer.invoke(ipcChannels.editorsList) as Promise<ExternalEditor[]>,
		redetect: () =>
			ipcRenderer.invoke(ipcChannels.editorsRedetect) as Promise<AppSettings>,
		update: (editorId: ExternalEditorId, patch: Partial<ExternalEditorSetting>) =>
			ipcRenderer.invoke(
				ipcChannels.editorsUpdate,
				editorId,
				patch,
			) as Promise<AppSettings>,
		chooseExecutable: () =>
			ipcRenderer.invoke(ipcChannels.editorsChooseExecutable) as Promise<string | null>,
		openProject: (editor: ExternalEditor, projectPath: string) =>
			ipcRenderer.invoke(
				ipcChannels.editorsOpenProject,
				editor,
				projectPath,
			) as Promise<void>,
	},
	projects: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.projectsList) as Promise<Project[]>,
		add: () =>
			ipcRenderer.invoke(ipcChannels.projectsAdd) as Promise<Project | null>,
		remove: (id: string) =>
			ipcRenderer.invoke(ipcChannels.projectsRemove, id) as Promise<Project[]>,
		reorder: (projectIds: string[]) =>
			ipcRenderer.invoke(
				ipcChannels.projectsReorder,
				projectIds,
			) as Promise<Project[]>,
		onChanged: (callback: (projects: Project[]) => void) =>
			subscribe(ipcChannels.projectsChanged, callback),
	},
	projectResources: {
		list: (projectId: string) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesList, projectId) as Promise<ProjectResourceListResult>,
		createSkill: (input: CreateProjectSkillInput) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesCreateSkill, input) as Promise<PiSkillSummary>,
		deleteSkill: (projectId: string, skillPath: string) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesDeleteSkill, projectId, skillPath) as Promise<void>,
		deleteExtension: (projectId: string, extensionPath: string) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesDeleteExtension, projectId, extensionPath) as Promise<void>,
		toggleExtension: (projectId: string, extensionPath: string, enabled: boolean) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesToggleExtension, projectId, extensionPath, enabled) as Promise<void>,
		toggleSkill: (projectId: string, skillPath: string, enabled: boolean) =>
			ipcRenderer.invoke(ipcChannels.projectResourcesToggleSkill, projectId, skillPath, enabled) as Promise<PiSkillSummary>,
	},
	files: {
		list: (projectId: string) =>
			ipcRenderer.invoke(ipcChannels.filesList, projectId) as Promise<
				FileTreeNode[]
			>,
		open: (path: string) =>
			ipcRenderer.invoke(ipcChannels.filesOpen, path) as Promise<void>,
		showInFolder: (path: string) =>
			ipcRenderer.invoke(ipcChannels.filesShowInFolder, path) as Promise<void>,
		readContent: (path: string) =>
			ipcRenderer.invoke(ipcChannels.filesReadContent, path) as Promise<string>,
		writeContent: (path: string, content: string) =>
			ipcRenderer.invoke(ipcChannels.filesWriteContent, path, content) as Promise<void>,
		delete: (path: string, recursive?: boolean) =>
			ipcRenderer.invoke(ipcChannels.filesDelete, path, recursive) as Promise<void>,
		rename: (path: string, newName: string) =>
			ipcRenderer.invoke(ipcChannels.filesRename, path, newName) as Promise<string>,
	},
	sessions: {
		list: (projectId?: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsList, projectId) as Promise<
				SessionSummary[]
			>,
		rename: (filePath: string, newName: string) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsRename,
				filePath,
				newName,
			) as Promise<void>,
		copy: (projectId: string, filePath: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsCopy, projectId, filePath) as Promise<{
				cancelled?: boolean;
				sessionPath?: string;
			}>,
		exportHtml: (projectId: string, filePath: string) =>
			ipcRenderer.invoke(
				ipcChannels.sessionsExportHtml,
				projectId,
				filePath,
			) as Promise<{
				path: string;
			}>,
		delete: (filePath: string) =>
			ipcRenderer.invoke(ipcChannels.sessionsDelete, filePath) as Promise<void>,
	},
	codexSessions: {
		scan: (projectId: string) =>
			ipcRenderer.invoke(ipcChannels.codexSessionsScan, projectId) as Promise<
				CodexSessionSummary[]
			>,
		import: (projectId: string, sourcePaths: string[]) =>
			ipcRenderer.invoke(
				ipcChannels.codexSessionsImport,
				projectId,
				sourcePaths,
			) as Promise<CodexImportReport>,
	},
	claudeSessions: {
		scan: (projectId: string) =>
			ipcRenderer.invoke(ipcChannels.claudeSessionsScan, projectId) as Promise<
				ClaudeSessionSummary[]
			>,
		import: (projectId: string, sourcePaths: string[]) =>
			ipcRenderer.invoke(
				ipcChannels.claudeSessionsImport,
				projectId,
				sourcePaths,
			) as Promise<ClaudeImportReport>,
	},
	openCodeSessions: {
		scan: (projectId: string) =>
			ipcRenderer.invoke(ipcChannels.openCodeSessionsScan, projectId) as Promise<
				OpenCodeSessionSummary[]
			>,
		import: (projectId: string, sourcePaths: string[]) =>
			ipcRenderer.invoke(
				ipcChannels.openCodeSessionsImport,
				projectId,
				sourcePaths,
			) as Promise<OpenCodeImportReport>,
	},
	git: {
		branches: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitBranches,
				projectId,
			) as Promise<GitBranchInfo>,
		checkout: (projectId: string, branch: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitCheckout,
				projectId,
				branch,
			) as Promise<GitBranchInfo>,
		createBranch: (projectId: string, branchName: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitCreateBranch,
				projectId,
				branchName,
			) as Promise<GitBranchInfo>,
		// 读取文件的 Git HEAD 原始内容，供差异编辑器左侧基准列使用。
		originalContent: (filePath: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitOriginalContent,
				filePath,
			) as Promise<string>,
		// 获取工作区中对比 HEAD 有变更的文件列表
		changedFiles: (projectId: string) =>
			ipcRenderer.invoke(
				ipcChannels.gitChangedFiles,
				projectId,
			) as Promise<{ path: string; status: string }[]>,
	},
	pi: {
		check: () =>
			ipcRenderer.invoke(ipcChannels.piCheck) as Promise<PiInstallStatus>,
		/** 验证用户手动输入的 pi 路径，通过后主进程会自动保存到 settings.customPiPath */
		checkCustom: (customPath: string) =>
			ipcRenderer.invoke(
				ipcChannels.piCheckCustom,
				customPath,
			) as Promise<PiInstallStatus>,
		checkUpdate: () =>
			ipcRenderer.invoke(ipcChannels.piUpdateCheck) as Promise<PiUpdateCheckResult>,
		update: () =>
			ipcRenderer.invoke(ipcChannels.piUpdate) as Promise<PiCliUpdateResult>,
	},
	logs: {
		list: (query?: AppLogQuery) =>
			ipcRenderer.invoke(ipcChannels.logsList, query ?? {}) as Promise<AppLogEntry[]>,
		clear: () => ipcRenderer.invoke(ipcChannels.logsClear) as Promise<void>,
		openFolder: () => ipcRenderer.invoke(ipcChannels.logsOpenFolder) as Promise<void>,
		getSize: () =>
			ipcRenderer.invoke(ipcChannels.logsSize) as Promise<number>,
	},
	rpcLogs: {
		getSize: (agentId?: string) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsGetSize, agentId) as Promise<number>,
		get: (options?: { agentId?: string; days?: number; limit?: number }) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsGet, options) as Promise<Array<{ id: string; agentId: string; direction: string; summary: string; time: number; data?: unknown }>>,
		clear: (agentId?: string) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsClear, agentId) as Promise<void>,
		setLogging: (agentId: string, enabled: boolean) =>
			ipcRenderer.invoke(ipcChannels.rpcLoggingSet, agentId, enabled) as Promise<boolean>,
		getLogging: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.rpcLoggingGet, agentId) as Promise<boolean>,
		openFile: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.rpcLogsOpenFile, agentId) as Promise<void>,
	},
	app: {
		info: () => ipcRenderer.invoke(ipcChannels.appInfo) as Promise<AppInfo>,
		checkUpdate: () =>
			ipcRenderer.invoke(ipcChannels.appCheckUpdate) as Promise<AppUpdateInfo>,
		downloadUpdate: (asset: { name: string; url: string }) =>
			ipcRenderer.invoke(
				ipcChannels.appDownloadUpdate,
				asset,
			) as Promise<AppUpdateDownloadResult>,
		installUpdate: (filePath: string) =>
			ipcRenderer.invoke(ipcChannels.appInstallUpdate, filePath) as Promise<void>,
		onUpdateProgress: (callback: (progress: AppUpdateDownloadProgress) => void) =>
			subscribe(ipcChannels.appUpdateProgress, callback),
		feedbackEnvironment: () =>
			ipcRenderer.invoke(
				ipcChannels.appFeedbackEnvironment,
			) as Promise<FeedbackEnvironment>,
		openExternal: (url: string) =>
			ipcRenderer.invoke(ipcChannels.appOpenExternal, url) as Promise<void>,
		restart: () => ipcRenderer.invoke(ipcChannels.appRestart) as Promise<void>,
		rendererLog: (
			level: AppLogLevel,
			scope: string,
			message: string,
			detail?: unknown,
		) =>
			ipcRenderer.invoke(
				ipcChannels.rendererLog,
				level,
				scope,
				message,
				detail,
			) as Promise<void>,
		minimizeWindow: () =>
			ipcRenderer.invoke(ipcChannels.appWindowMinimize) as Promise<void>,
		toggleMaximizeWindow: () =>
			ipcRenderer.invoke(ipcChannels.appWindowToggleMaximize) as Promise<void>,
		toggleAlwaysOnTopWindow: () =>
			ipcRenderer.invoke(
				ipcChannels.appWindowToggleAlwaysOnTop,
			) as Promise<boolean>,
		closeWindow: () =>
			ipcRenderer.invoke(ipcChannels.appWindowClose) as Promise<void>,
		toggleDevTools: () =>
			ipcRenderer.invoke(ipcChannels.appToggleDevTools) as Promise<boolean>,
	},
	skills: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.skillsList) as Promise<PiSkillListResult>,
		create: (input: CreatePiSkillInput) =>
			ipcRenderer.invoke(ipcChannels.skillsCreate, input) as Promise<PiSkillSummary>,
		toggle: (path: string, enabled: boolean) =>
			ipcRenderer.invoke(
				ipcChannels.skillsToggle,
				path,
				enabled,
			) as Promise<PiSkillSummary>,
		delete: (path: string) =>
			ipcRenderer.invoke(ipcChannels.skillsDelete, path) as Promise<void>,
		openFolder: (path?: string) =>
			ipcRenderer.invoke(ipcChannels.skillsOpenFolder, path) as Promise<void>,
	},
	extensions: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.extensionsList) as Promise<PiExtensionListResult>,
		uninstall: (source: string, scope?: "user" | "project" | "unknown") =>
			ipcRenderer.invoke(ipcChannels.extensionsUninstall, source, scope) as Promise<void>,
		install: (source: string) =>
			ipcRenderer.invoke(ipcChannels.extensionsInstall, source) as Promise<string>,
		toggle: (source: string, enabled: boolean) =>
			ipcRenderer.invoke(ipcChannels.extensionsToggle, source, enabled) as Promise<void>,
		update: () =>
			ipcRenderer.invoke(ipcChannels.extensionsUpdate) as Promise<PiCliUpdateResult>,
	},
	settings: {
		get: () =>
			ipcRenderer.invoke(ipcChannels.settingsGet) as Promise<AppSettings>,
		update: (patch: Partial<AppSettings>) =>
			ipcRenderer.invoke(
				ipcChannels.settingsUpdate,
				patch,
			) as Promise<AppSettings>,
		testPiProxy: () =>
			ipcRenderer.invoke(
				ipcChannels.settingsTestPiProxy,
			) as Promise<PiProxyTestResult>,
		onApplyWindow: (callback: (settings: AppSettings) => void) =>
			subscribe(ipcChannels.settingsApplyWindow, callback),
	},
	config: {
		getModels: () =>
			ipcRenderer.invoke(ipcChannels.configGetModels) as Promise<{
				raw: string;
				parsed: { providers: Record<string, unknown> };
				diagnostic?: ConfigFileDiagnostic;
			}>,
		getAuth: () =>
			ipcRenderer.invoke(ipcChannels.configGetAuth) as Promise<{
				raw: string;
				parsed: Record<string, unknown>;
				diagnostic?: ConfigFileDiagnostic;
			}>,
		getSettings: () =>
			ipcRenderer.invoke(ipcChannels.configGetSettings) as Promise<{
				raw: string;
				parsed: Record<string, unknown>;
				diagnostic?: ConfigFileDiagnostic;
			}>,
		getTrust: () =>
			ipcRenderer.invoke(ipcChannels.configGetTrust) as Promise<{
				raw: string;
				parsed: Record<string, unknown>;
				diagnostic?: ConfigFileDiagnostic;
			}>,
		saveModels: (data: unknown) =>
			ipcRenderer.invoke(ipcChannels.configSaveModels, data) as Promise<{
				valid: boolean;
				error?: string;
			}>,
		saveAuth: (data: unknown) =>
			ipcRenderer.invoke(ipcChannels.configSaveAuth, data) as Promise<{
				valid: boolean;
				error?: string;
			}>,
		saveSettings: (settings: Record<string, unknown>) =>
			ipcRenderer.invoke(ipcChannels.configSaveSettings, settings) as Promise<{
				valid: boolean;
				error?: string;
			}>,
		saveRaw: (fileName: string, rawJson: string) =>
			ipcRenderer.invoke(
				ipcChannels.configSaveRaw,
				fileName,
				rawJson,
			) as Promise<{ valid: boolean; error?: string }>,
		export: () =>
			ipcRenderer.invoke(ipcChannels.configExport) as Promise<string>,
		import: (packageJson: string) =>
			ipcRenderer.invoke(
				ipcChannels.configImport,
				packageJson,
			) as Promise<{ valid: boolean; error?: string }>,
		/** 从 provider 的 baseUrl + apiKey 拉取可用模型列表 */
		fetchModels: (baseUrl: string, apiKey: string, apiType?: string) =>
			ipcRenderer.invoke(
				ipcChannels.configFetchModels,
				{ baseUrl, apiKey, apiType },
			) as Promise<{
				success: boolean;
				models?: Array<{ id: string; name?: string }>;
				error?: string;
			}>,
		/** 快速测试 provider 连接：发送一条最小请求验证配置是否正常 */
		testProvider: (
			baseUrl: string,
			apiKey: string,
			modelId: string,
			apiType?: string,
			headers?: Record<string, string>,
		) =>
			ipcRenderer.invoke(
				ipcChannels.configTestProvider,
				{ baseUrl, apiKey, modelId, apiType, headers },
			) as Promise<{
				success: boolean;
				model?: string;
				snippet?: string;
				tokens?: { input?: number; output?: number };
				latencyMs?: number;
				error?: string;
				requestUrl?: string;
				requestBody?: string;
			}>,
	},
	agents: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.agentsList) as Promise<AgentTab[]>,
		create: (input: CreateAgentInput) =>
			ipcRenderer.invoke(ipcChannels.agentsCreate, input) as Promise<AgentTab>,
		rename: (agentId: string, name: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsRename,
				agentId,
				name,
			) as Promise<AgentTab>,
		stop: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsStop, agentId) as Promise<void>,
		prompt: (input: SendPromptInput) =>
			ipcRenderer.invoke(ipcChannels.agentsPrompt, input) as Promise<void>,
		abort: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsAbort, agentId) as Promise<void>,
		exportHtml: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsExportHtml, agentId) as Promise<{
				path: string;
			}>,
		getForkMessages: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsForkMessages, agentId) as Promise<
				ForkMessage[]
			>,
		forkSession: (agentId: string, entryId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsForkSession,
				agentId,
				entryId,
			) as Promise<{ text?: string; cancelled?: boolean }>,
		cloneSession: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsCloneSession, agentId) as Promise<{
				cancelled?: boolean;
			}>,
		switchSession: (agentId: string, sessionPath: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsSwitchSession,
				agentId,
				sessionPath,
			) as Promise<{ cancelled?: boolean }>,
		editMessage: (agentId: string, messageId: string, text: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsEditMessage,
				agentId,
				messageId,
				text,
			) as Promise<void>,
		deleteMessage: (agentId: string, messageId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsDeleteMessage,
				agentId,
				messageId,
			) as Promise<void>,
		reload: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsReload, agentId) as Promise<void>,
		restart: (agentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsRestart,
				agentId,
			) as Promise<AgentTab>,
		compact: (agentId: string, prompt?: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsCompact,
				agentId,
				prompt,
			) as Promise<AgentRuntimeState>,
		runtimeState: (agentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsRuntimeState,
				agentId,
			) as Promise<AgentRuntimeState>,
		cycleModel: (agentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsCycleModel,
				agentId,
			) as Promise<AgentRuntimeState>,
		availableModels: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.agentsAvailableModels, agentId) as Promise<
				AvailableModel[]
			>,
		setModel: (agentId: string, provider: string, modelId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsSetModel,
				agentId,
				provider,
				modelId,
			) as Promise<AgentRuntimeState>,
		cycleThinking: (agentId: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsCycleThinking,
				agentId,
			) as Promise<AgentRuntimeState>,
		setThinking: (agentId: string, level: string) =>
			ipcRenderer.invoke(
				ipcChannels.agentsSetThinking,
				agentId,
				level,
			) as Promise<AgentRuntimeState>,
		commands: (agentId: string) =>
			ipcRenderer.invoke("agents:commands", agentId) as Promise<PiCommand[]>,
		onState: (callback: (tabs: AgentTab[]) => void) =>
			subscribe(ipcChannels.agentsState, callback),
		/** 桌面宠物点击跳转：主进程通知主窗切换到活跃 Agent tab */
		onFocusTarget: (callback: (target: { agentId: string }) => void) =>
			subscribe(ipcChannels.petFocusAgentTarget, callback),
		onMessages: (
			callback: (payload: { agentId: string; messages: ChatMessage[] }) => void,
		) => subscribe(ipcChannels.agentsMessage, callback),
		onLog: (callback: (payload: { agentId: string; text: string }) => void) =>
			subscribe(ipcChannels.agentsLog, callback),
		onThinking: (
			callback: (payload: ThinkingUpdate) => void,
		) => subscribe(ipcChannels.agentsThinking, callback),
		onRpcLog: (
			callback: (payload: { agentId: string; direction: string; summary: string; data: unknown }) => void,
		) => subscribe(ipcChannels.agentsRpcLog, callback),
		onRuntimeState: (
			callback: (payload: {
				agentId: string;
				state: AgentRuntimeState;
			}) => void,
		) => subscribe(ipcChannels.agentsRuntimeState, callback),
		/** 向 Agent 发送扩展 UI 响应（用户回答了 select/confirm/input/editor 对话框） */
		sendUiResponse: (agentId: string, requestId: string, response: { value?: string; cancelled?: boolean }) =>
			ipcRenderer.invoke(ipcChannels.agentsUiResponse, agentId, requestId, response) as Promise<void>,
		/** 监听 Agent 扩展 UI 请求（模型通过扩展调用了 ctx.ui.select/confirm/input/editor） */
		onUiRequest: (callback: (request: { agentId: string; requestId: string; method: string; title: string; options?: string[]; placeholder?: string; prefill?: string; completed?: boolean; value?: string; cancelled?: boolean; widgetKey?: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }) => void) =>
 		subscribe(ipcChannels.agentsUiRequest, callback),
 	},
	/**
	 * Pet module API surface — preserved as no-ops after the desktop-pet
	 * feature was removed. Renderer code still references window.piDesktop.pet
	 * in legacy Settings UI; these stubs keep the type surface stable
	 * until the renderer is cleaned up.
	 */
 	pet: {
 		onState: (callback: (state: PetAggregateState) => void) => () => { void callback; return () => {}; },
 		list: () => Promise.resolve([] as PetManifest[]),
 		setEnabled: (_value: boolean) => Promise.resolve(),
 		setId: (_id: string) => Promise.resolve(),
 		moveWindow: (_pos: { x: number; y: number }) => Promise.resolve(),
 		focusAgent: () => Promise.resolve(),
 		onSprite: (callback: (manifest: PetManifest) => void) => { void callback; return () => {}; },
 		getCurrent: () => Promise.resolve(null) as Promise<PetManifest | null>,
 		onNotify: (callback: (n: PetNotification) => void) => { void callback; return () => {}; },
 		setPreviewMode: (_mode: string) => Promise.resolve(),
 		onPreviewMode: (callback: (mode: string) => void) => { void callback; return () => {}; },
 		onCaps: (callback: (caps: PetWindowCaps) => void) => { void callback; return () => {}; },
 		testNotify: (_type: "error" | "done") => Promise.resolve(),
 		tease: () => Promise.resolve(),
 		setDragging: (_dragging: boolean) => Promise.resolve(),
 		moveBy: (_delta: { dx: number; dy: number }) => Promise.resolve(),
 		ready: () => {},
 		contextMenu: () => Promise.resolve(),
 	},
	terminal: {
		list: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.terminalList, agentId) as Promise<
				TerminalTab[]
			>,
		ensure: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.terminalEnsure, agentId) as Promise<
				TerminalTab[]
			>,
		create: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.terminalCreate, agentId) as Promise<
				TerminalTab
			>,
		input: (tabId: string, data: string) =>
			ipcRenderer.invoke(ipcChannels.terminalInput, tabId, data) as Promise<void>,
		resize: (tabId: string, cols: number, rows: number) =>
			ipcRenderer.invoke(
				ipcChannels.terminalResize,
				tabId,
				cols,
				rows,
			) as Promise<void>,
		close: (tabId: string) =>
			ipcRenderer.invoke(ipcChannels.terminalClose, tabId) as Promise<void>,
		onData: (callback: (payload: TerminalDataEvent) => void) =>
			subscribe(ipcChannels.terminalData, callback),
		onExit: (callback: (payload: TerminalExitEvent) => void) =>
			subscribe(ipcChannels.terminalExit, callback),
	},

	// ===== 飞书桥接 =====
	feishu: {
		connect: (input: FeishuConnectInput) =>
			ipcRenderer.invoke(ipcChannels.feishuConnect, input) as Promise<{
				success: boolean;
				message: string;
			}>,
		connectTemp: (input: FeishuConnectInput) =>
			ipcRenderer.invoke(ipcChannels.feishuConnectTemp, input) as Promise<{
				success: boolean;
				message: string;
				botInfo?: { id: string; name: string };
			}>,
		disconnect: () =>
			ipcRenderer.invoke(ipcChannels.feishuDisconnect) as Promise<{ success: boolean }>,
		connectByBot: (botId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuConnectByBot, botId) as Promise<{
				success: boolean;
				message: string;
			}>,
		statusRequest: () =>
			ipcRenderer.invoke(ipcChannels.feishuStatusRequest) as Promise<FeishuBridgeStatus>,
		onStatus: (callback: (status: FeishuBridgeStatus) => void) =>
			subscribe(ipcChannels.feishuStatus, callback),
		botsList: () =>
			ipcRenderer.invoke(ipcChannels.feishuBotsList) as Promise<FeishuBotConfig[]>,
		botAdd: (input: FeishuConnectInput) =>
			ipcRenderer.invoke(ipcChannels.feishuBotAdd, input) as Promise<{
				success: boolean;
				bot?: FeishuBotConfig;
				error?: string;
			}>,
		botRemove: (botId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuBotRemove, botId) as Promise<boolean>,
		botConfig: (botId: string, patch: Partial<FeishuBotConfig>) =>
			ipcRenderer.invoke(ipcChannels.feishuBotConfig, botId, patch) as Promise<FeishuBotConfig | undefined>,
		botSecret: (botId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuBotSecret, botId) as Promise<string>,
		testConnection: (appId: string, appSecret: string) =>
			ipcRenderer.invoke(ipcChannels.feishuTestConnection, appId, appSecret) as Promise<FeishuTestResult>,
		bindingsList: () =>
			ipcRenderer.invoke(ipcChannels.feishuBindingsList) as Promise<FeishuChatBinding[]>,
		bindingRemove: (chatId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuBindingRemove, chatId) as Promise<boolean>,
		bindingUpdate: (chatId: string, patch: Partial<FeishuChatBinding>) =>
			ipcRenderer.invoke(ipcChannels.feishuBindingUpdate, chatId, patch) as Promise<FeishuChatBinding | undefined>,
		onMessages: (callback: (message: FeishuChatMessage) => void) =>
			subscribe(ipcChannels.feishuMessages, callback),
		onBindingsChanged: (callback: (bindings: FeishuChatBinding[]) => void) =>
			subscribe(ipcChannels.feishuBindingsChanged, callback),
		onWhoamiResult: (callback: (openId: string) => void) =>
			subscribe(ipcChannels.feishuWhoamiResult, callback),
		onBotsChanged: (callback: (bots: FeishuBotConfig[]) => void) =>
			subscribe(ipcChannels.feishuBotsChanged, callback),
		sessionBotGet: (agentId: string) =>
			ipcRenderer.invoke(ipcChannels.feishuSessionBotGet, agentId) as Promise<string | null>,
		sessionBotSet: (agentId: string, botId: string | null) =>
			ipcRenderer.invoke(ipcChannels.feishuSessionBotSet, agentId, botId) as Promise<void>,
	},
	scratchPad: {
		list: () =>
			ipcRenderer.invoke(ipcChannels.scratchPadList) as Promise<DraftMeta[]>,
		create: () =>
			ipcRenderer.invoke(ipcChannels.scratchPadCreate) as Promise<DraftMeta>,
		delete: (draftPath: string) =>
			ipcRenderer.invoke(ipcChannels.scratchPadDelete, draftPath) as Promise<void>,
		load: (draftPath?: string) =>
			ipcRenderer.invoke(ipcChannels.scratchPadLoad, draftPath) as Promise<ScratchPadData>,
		save: (draftPath: string, content: string, cursorPosition: number) =>
			ipcRenderer.invoke(ipcChannels.scratchPadSave, draftPath, content, cursorPosition) as Promise<void>,
		export: (draftPath: string) =>
			ipcRenderer.invoke(ipcChannels.scratchPadExport, draftPath) as Promise<boolean>,
	},
};

function subscribe<T>(channel: string, callback: (payload: T) => void) {
	const listener = (_event: Electron.IpcRendererEvent, payload: T) =>
		callback(payload);
	ipcRenderer.on(channel, listener);
	return () => {
		ipcRenderer.removeListener(channel, listener);
	};
}

try {
	contextBridge.exposeInMainWorld("piDesktop", api);
	ipcRenderer.send(ipcChannels.preloadReady);
} catch (error) {
	const detail =
		error instanceof Error
			? { message: error.message, stack: error.stack }
			: { message: String(error) };
	console.error("[PiDeck preload] Failed to expose desktop API", detail);
	ipcRenderer.send(ipcChannels.preloadError, detail);
}

export type PiDesktopApi = typeof api;
