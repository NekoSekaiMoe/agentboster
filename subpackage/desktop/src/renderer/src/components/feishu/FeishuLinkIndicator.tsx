/**
 * FeishuLinkIndicator — 输入框中的飞书链接状态指示器
 *
 * 在 composer footer 中显示飞书连接状态，提供切换 Bot 的快捷入口。
 * 支持按会话（Agent）指定使用的 Bot，默认使用设置中已配置并连接的 Bot。
 *
 * 设计约束：
 * - 占用组件高度恒定，不随状态变化导致输入框跳动
 * - 状态指示器附带文字 label，hover/active/focus-visible 均有完整交互态
 * - 所有可见文本走 i18n
 */

import { useState, useRef, useEffect, useCallback } from "react";
import type { FeishuBridgeStatus, FeishuBotConfig } from "../../../../shared/types";

type Props = {
	status: FeishuBridgeStatus;
	bots: FeishuBotConfig[];
	/** 当前活跃 Agent ID，用于读取/保存 Bot 分配 */
	activeAgentId: string | undefined;
	/** 当前连接的 Bot ID */
	activeBotId: string | undefined;
	/** 当前 Agent 指定的 Bot ID（可能不同于 activeBotId） */
	sessionBotId: string | undefined;
	isConnected: boolean;
	connecting: boolean;
	onConnectByBot: (botId: string) => Promise<{ success: boolean; message: string }>;
	onDisconnect: () => void;
	onSetSessionBot: (agentId: string, botId: string | null) => Promise<void>;
};

const STATUS_LABEL: Record<string, string> = {
	connected: "已连接",
	connecting: "连接中",
	disconnected: "未连接",
	error: "错误",
};

export function FeishuLinkIndicator({
	status,
	bots,
	activeAgentId,
	activeBotId,
	sessionBotId,
	isConnected,
	connecting,
	onConnectByBot,
	onDisconnect,
	onSetSessionBot,
}: Props) {
	const [open, setOpen] = useState(false);
	const [selectingBotId, setSelectingBotId] = useState<string | null>(null);
	const popoverRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);

	// 点击 Popover 外部时关闭
	useEffect(() => {
		if (!open) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (
				popoverRef.current &&
				!popoverRef.current.contains(e.target as Node) &&
				triggerRef.current &&
				!triggerRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, [open]);

	// ESC 关闭
	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [open]);

	/** 当前全局 Bridge 连接中的 Bot 名称 */
	const activeBotName = activeBotId
		? bots.find((b) => b.id === activeBotId)?.name
		: undefined;
	/** 当前会话手动绑定的 Bot；会话未绑定时不应展示为已连接。 */
	const sessionBot = sessionBotId
		? bots.find((b) => b.id === sessionBotId)
		: undefined;
	const sessionConnected = Boolean(isConnected && sessionBot && sessionBot.id === activeBotId);

	/** 是否有任何 Bot 配置 */
	const hasBots = bots.length > 0;

	const handleSelectBot = useCallback(async (botId: string) => {
		setSelectingBotId(botId);
		try {
			// 如果选择的 Bot 不是当前连接的，先连接全局 Bridge；随后持久化当前会话绑定并创建群组。
			if (botId !== activeBotId) {
				await onConnectByBot(botId);
			}
			if (activeAgentId) {
				await onSetSessionBot(activeAgentId, botId);
			}
			// 成功后稍作停留，让用户看到完成态，避免点击后弹框瞬间消失造成“没生效”的错觉。
			window.setTimeout(() => setOpen(false), 220);
		} finally {
			window.setTimeout(() => setSelectingBotId(null), 220);
		}
	}, [activeBotId, activeAgentId, onConnectByBot, onSetSessionBot]);

	const handleClearSessionBot = useCallback(async () => {
		if (activeAgentId) {
			// 这里只断开当前会话的飞书关联，不影响其他会话或全局 Bridge 连接。
			await onSetSessionBot(activeAgentId, null);
		}
		setOpen(false);
	}, [activeAgentId, onSetSessionBot]);

	const handleDisconnect = useCallback(async () => {
		await handleClearSessionBot();
	}, [handleClearSessionBot]);

	if (!hasBots) {
		// 没有配置任何 Bot 时不显示指示器
		return null;
	}

	const statusClass = connecting
		? "connecting"
		: sessionConnected
			? "connected"
			: "disconnected";

	return (
		<div className="feishu-link-indicator">
			<button
				ref={triggerRef}
				className={`feishu-link-trigger ${statusClass}${sessionBotId ? " session-assigned" : ""}`}
				onClick={() => setOpen((prev) => !prev)}
				title={sessionConnected && sessionBot ? `当前会话飞书: ${sessionBot.name}` : "当前会话未连接飞书"}
				aria-label="飞书连接状态"
			>
				<span className={`feishu-link-dot ${statusClass}`} />
				<span className="feishu-link-label">
					{sessionConnected && sessionBot
						? `飞书: ${sessionBot.name}`
						: statusClass === "connecting"
							? "飞书: 连接中"
							: "飞书: 未连接"}
				</span>
			</button>

			{open && (
				<div
					ref={popoverRef}
					className="feishu-link-popover"
					role="menu"
				>
					{/* ── 头部：状态 + 断开 ── */}
					<div className="feishu-link-popover-header">
						<div className="feishu-link-popover-heading">
							<span className={`feishu-link-dot ${statusClass}`} />
							<div className="feishu-link-popover-heading-text">
								<strong>飞书机器人</strong>
								<span>
									{sessionConnected ? "当前会话已连接" : STATUS_LABEL[statusClass] || statusClass}
									{sessionConnected && sessionBot ? ` · ${sessionBot.name}` : activeBotName ? ` · 全局已连接 ${activeBotName}` : ""}
								</span>
							</div>
						</div>
						{sessionBotId && (
							<button
								className="feishu-link-popover-action"
								onClick={handleDisconnect}
								disabled={connecting}
							>
								断开当前会话
							</button>
						)}
					</div>

					{status.errorMessage && (
						<div className="feishu-link-popover-error">{status.errorMessage}</div>
					)}

					{/* ── Bot 列表 ── */}
					<div className="feishu-link-popover-section-title">选择机器人</div>
					<div className="feishu-link-popover-list">
						{bots.map((bot) => {
							const isActive = bot.id === activeBotId;
							const isSessionPinned = bot.id === sessionBotId;
							const isSessionConnectedBot = isActive && isSessionPinned;
							const isSelecting = selectingBotId === bot.id;
							return (
								<button
									key={bot.id}
									className={`feishu-link-bot-item${isActive ? " active" : ""}${isSessionPinned ? " pinned" : ""}`}
									onClick={() => handleSelectBot(bot.id)}
									disabled={connecting || Boolean(selectingBotId)}
									role="menuitem"
								>
									<span className="feishu-link-bot-avatar">飞</span>
									<div className="feishu-link-bot-info">
										<span className="feishu-link-bot-name">{bot.name}</span>
										<span className="feishu-link-bot-meta">App ID · {bot.appId.slice(0, 16)}…</span>
										<div className="feishu-link-bot-badges">
											{isSelecting && <span className="feishu-link-bot-badge active">正在连接…</span>}
											{!isSelecting && isSessionConnectedBot && <span className="feishu-link-bot-badge active">当前会话已连接</span>}
											{!isSelecting && isActive && !isSessionPinned && <span className="feishu-link-bot-badge active">全局在线</span>}
											{isSessionPinned && !isActive && (
												<span className="feishu-link-bot-badge pinned" title="此会话已选择该 Bot，但当前未连接">
													当前会话未连接
												</span>
											)}
										</div>
									</div>
									<span className={`feishu-link-bot-check${isSelecting || isSessionConnectedBot || isSessionPinned ? " visible" : ""}`}>
										{isSelecting ? <span className="feishu-link-spinner" /> : "✓"}
									</span>
								</button>
							);
						})}
					</div>

					{/* ── 底部操作 ── */}
					{sessionBotId && (
						<div className="feishu-link-popover-footer">
							<button
								className="feishu-link-popover-action"
								onClick={handleClearSessionBot}
							>
								清除此会话的固定设置
							</button>
						</div>
					)}
					{!sessionConnected && bots.length > 0 && (
						<div className="feishu-link-popover-footer">
							<div className="feishu-link-popover-hint">
								当前会话未连接飞书，选择一个 Bot 后才会创建群组并同步消息
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
