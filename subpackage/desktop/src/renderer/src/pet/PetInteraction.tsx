import { useRef } from "react";
import type { PetAggregateState } from "@shared/types";

/**
 * PetInteraction —— 拖拽 / 单击跳转 Agent / 双击逗弄。
 * 位移 < 3px 视为点击；两次 click 间隔 < 300ms 视为双击。
 */

const CLICK = 3, DBL_MS = 300;

type Props = { state: PetAggregateState; onDragStateChange?: (d: boolean) => void };

export function PetInteraction({ state, onDragStateChange }: Props) {
	/** 上次鼠标屏幕坐标，用于计算增量 */
	const lastScreen = useRef<{ x: number; y: number } | null>(null);
	/** 起始屏幕坐标，用于判断点击/拖拽 */
	const startScreen = useRef<{ x: number; y: number } | null>(null);
	const moved = useRef(0);
	const lastTap = useRef(0);
	const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const menu = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (state.mode === "hidden") return;
		void window.piDesktop.pet.contextMenu();
	};

	const down = (e: React.PointerEvent) => {
		if (state.mode === "hidden" || e.button !== 0) return;
		lastScreen.current = { x: e.screenX, y: e.screenY };
		startScreen.current = { x: e.screenX, y: e.screenY };
		moved.current = 0;
		onDragStateChange?.(true);
		// 通知主进程暂停巡游：松手后遗留的 tick 可能命中行进反向边界，导致瞬移
		void window.piDesktop.pet.setDragging(true);
		(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
	};

	const move = (e: React.PointerEvent) => {
		if (!lastScreen.current || !startScreen.current) return;
		const dx = e.screenX - lastScreen.current.x;
		const dy = e.screenY - lastScreen.current.y;
		lastScreen.current = { x: e.screenX, y: e.screenY };
		moved.current = Math.max(moved.current, Math.abs(e.screenX - startScreen.current.x) + Math.abs(e.screenY - startScreen.current.y));
		// 发送增量移动（delta 基于连续 screenX 差值，不混用 clientX/screenLeft，
		// 主进程 ipcMain.handle 串行处理，setPosition 同步，不会产生增量竞争）
		void window.piDesktop.pet.moveBy({ dx, dy });
	};

	const up = (e: React.PointerEvent) => {
		if (e.button !== 0) return; // 仅处理主按钮（左键），右键不触发电击/焦点
		lastScreen.current = null;
		startScreen.current = null;
		onDragStateChange?.(false);
		// 拖拽结束：通知主进程，若当前仍为 idle 且巡游开启，则从新位置恢复巡游
		void window.piDesktop.pet.setDragging(false);
		(e.target as HTMLElement).releasePointerCapture?.(e.pointerId);

		if (moved.current < CLICK) {
			const now = Date.now();
			if (now - lastTap.current < DBL_MS) {
				lastTap.current = 0;
				if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = null; }
				void window.piDesktop.pet.tease();
				return;
			}
			lastTap.current = now;
			if (tapTimer.current) clearTimeout(tapTimer.current);
			tapTimer.current = setTimeout(() => { tapTimer.current = null; void window.piDesktop.pet.focusAgent(); }, DBL_MS);
		}
	};

	return <div style={{ position: "absolute", inset: 0, cursor: "grab", touchAction: "none" }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={menu} />;
}
