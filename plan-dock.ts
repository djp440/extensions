/**
 * Plan Dock - 把 plan 工具的执行计划停靠在 TUI 最右侧。
 *
 * 设计要点:
 * - 纯展示层,不替换 plan 工具。监听 plan 工具的 tool_result,读取
 *   details.steps 同步状态(与 plan.ts 的数据格式一致)。
 * - 非捕获 overlay: onHandle 里立即 unfocus(),不抢输入焦点。
 * - 宽度自适应: 终端宽度的 25%,最小 28 / 最大 50 列,终端 < 80 列自动隐藏。
 * - 满高度铺满,步骤超出可视区时自动滚动,保持 in_progress 步骤可见。
 * - 顶部标题栏显示 Plan (done/total),底部显示最近 action。
 *
 * 命令: /plan-dock [show|hide|toggle]   快捷键: Ctrl+Alt+D
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const WIDTH_PERCENT = "25%";
const MIN_WIDTH = 28;
const MAX_WIDTH = 50;
const HIDE_BELOW_COLS = 80;

type StepStatus = "pending" | "in_progress" | "completed";

interface Step {
	id: number;
	text: string;
	status: StepStatus;
}

type PlanAction = "set" | "start" | "complete" | "show" | "clear";

interface PlanDetails {
	action: PlanAction;
	steps: Step[];
	error?: string;
}

const ICONS: Record<StepStatus, string> = { pending: "○", in_progress: "◐", completed: "✓" };

function statusColor(theme: Theme, status: StepStatus, text: string): string {
	if (status === "completed") return theme.fg("success", theme.strikethrough(text));
	if (status === "in_progress") return theme.fg("accent", text);
	return theme.fg("muted", text);
}

/** 把字符串截断并右侧补空格到精确的可视宽度,保证右边框对齐。 */
function fit(s: string, width: number): string {
	const truncated = truncateToWidth(s, width, "…", true);
	const pad = width - visibleWidth(truncated);
	return pad > 0 ? truncated + " ".repeat(pad) : truncated;
}

/** 停靠栏组件。状态由外部通过 setState 注入,自身只负责渲染。 */
class PlanDockComponent implements Component {
	private steps: Step[] = [];
	private lastAction: PlanAction | null = null;
	private scrollOffset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(private theme: Theme) {}

	setState(steps: Step[], lastAction: PlanAction | null): void {
		this.steps = steps;
		this.lastAction = lastAction;
		this.syncScroll();
		this.invalidate();
	}

	/** 把滚动位置对到 in_progress 步骤,使其始终可见。 */
	private syncScroll(): void {
		const idx = this.steps.findIndex((s) => s.status === "in_progress");
		if (idx < 0) return;
		const visible = this.availableStepRows();
		if (idx < this.scrollOffset) this.scrollOffset = idx;
		else if (idx >= this.scrollOffset + visible) this.scrollOffset = idx - visible + 1;
		if (this.scrollOffset < 0) this.scrollOffset = 0;
	}

	/** 估算可用于步骤行的高度: 终端高度减去标题/进度/底部/边框约 6 行。 */
	private availableStepRows(): number {
		const rows = process.stdout.rows ?? 24;
		return Math.max(3, rows - 6);
	}

	render(width: number): string[] {
		const w = Math.min(width, MAX_WIDTH);
		if (this.cachedLines && this.cachedWidth === w) return this.cachedLines;

		const th = this.theme;
		const innerW = Math.max(1, w - 2);
		const border = (c: string) => th.fg("border", c);
		const row = (content: string) => border("│") + fit(content, innerW) + border("│");
		const lines: string[] = [];

		// 标题栏: Plan (done/total)
		const done = this.steps.filter((s) => s.status === "completed").length;
		const title = this.steps.length > 0 ? ` Plan (${done}/${this.steps.length}) ` : " Plan ";
		const titleStr = truncateToWidth(title, innerW);
		const titleW = visibleWidth(titleStr);
		const left = Math.floor((innerW - titleW) / 2);
		const right = Math.max(0, innerW - titleW - left);
		lines.push(border("╭" + "─".repeat(left)) + th.fg("accent", titleStr) + border("─".repeat(right) + "╮"));

		if (this.steps.length === 0) {
			lines.push(row(""));
			lines.push(row(th.fg("dim", " 暂无计划")));
			lines.push(row(th.fg("dim", " agent 调用 plan 后显示")));
			lines.push(row(""));
		} else {
			const visible = this.availableStepRows();
			const start = this.scrollOffset;
			const end = Math.min(this.steps.length, start + visible);

			if (start > 0) lines.push(row(th.fg("dim", `  ↑ ${start} 更多`)));

			for (let i = start; i < end; i++) {
				const s = this.steps[i]!;
				const icon = statusColor(th, s.status, ICONS[s.status]);
				const id = th.fg("dim", `${s.id}.`);
				const prefix = ` ${icon} ${id} `;
				const textW = Math.max(1, innerW - visibleWidth(prefix));
				const text = statusColor(th, s.status, truncateToWidth(s.text, textW, "…", true));
				lines.push(row(prefix + text));
			}

			if (end < this.steps.length) lines.push(row(th.fg("dim", `  ↓ ${this.steps.length - end} 更多`)));
		}

		// 底部: 最近 action
		const footer = this.lastAction ? th.fg("dim", ` ${this.lastAction}`) : "";
		lines.push(border("├") + border("─".repeat(innerW)) + border("┤"));
		lines.push(row(footer));
		lines.push(border("╰" + "─".repeat(innerW) + "╯"));

		this.cachedWidth = w;
		this.cachedLines = lines;
		return lines;
	}

	// 非捕获,不处理输入。
	handleInput(): void {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	let steps: Step[] = [];
	let lastAction: PlanAction | null = null;
	let dock: PlanDockComponent | null = null;
	let handle: OverlayHandle | null = null;
	let tui: TUI | null = null;
	let visible = true;

	/** 从当前分支重建计划状态(与 plan.ts 一致)。 */
	const reconstruct = (ctx: ExtensionContext) => {
		steps = [];
		lastAction = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "plan") continue;
			const details = msg.details as PlanDetails | undefined;
			if (details) {
				steps = details.steps;
				lastAction = details.action;
			}
		}
	};

	const refresh = () => {
		dock?.setState(steps, lastAction);
		tui?.requestRender();
	};

	/** 创建停靠栏 overlay(fire-and-forget,会话存活期间一直在)。 */
	const launch = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || dock) return;
		void ctx.ui.custom<void>(
			(t, theme) => {
				tui = t;
				dock = new PlanDockComponent(theme);
				dock.setState(steps, lastAction);
				return dock;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "right-center",
					width: WIDTH_PERCENT,
					minWidth: MIN_WIDTH,
					maxHeight: "100%",
					// 非捕获: 永不进入焦点栈,输入始终留在编辑器,toggle 显示也不抢焦点。
					nonCapturing: true,
					visible: (termWidth: number) => visible && termWidth >= HIDE_BELOW_COLS,
				},
				onHandle: (h) => {
					handle = h;
				},
			},
		);
	};

	pi.on("session_start", async (_e, ctx) => {
		reconstruct(ctx);
		launch(ctx);
		refresh();
	});

	pi.on("session_tree", async (_e, ctx) => {
		reconstruct(ctx);
		refresh();
	});

	// 监听 plan 工具结果,同步状态。
	pi.on("tool_result", async (event) => {
		if (event.toolName !== "plan") return;
		const details = event.details as PlanDetails | undefined;
		if (!details) return;
		steps = details.steps;
		lastAction = details.action;
		// 有计划时若被隐藏则自动恢复显示。
		if (steps.length > 0 && !visible) {
			visible = true;
			handle?.setHidden(false);
		}
		refresh();
	});

	const setVisible = (next: boolean, ctx: ExtensionContext) => {
		visible = next;
		handle?.setHidden(!next);
		tui?.requestRender();
		ctx.ui.notify(`Plan 停靠栏已${next ? "显示" : "隐藏"}`, "info");
	};

	pi.registerCommand("plan-dock", {
		description: "切换 Plan 停靠栏 (show|hide|toggle)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "show") setVisible(true, ctx);
			else if (arg === "hide") setVisible(false, ctx);
			else setVisible(!visible, ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "切换 Plan 停靠栏",
		handler: async (ctx) => setVisible(!visible, ctx),
	});
}
