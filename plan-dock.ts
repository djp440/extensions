/**
 * Plan Dock - 编辑器下方 Widget 版
 *
 * 用底部 widget 展示 plan 工具的执行计划,不遮挡对话内容。
 * 与右侧 overlay 版相比:内容被推挤到 plan widget 上方,不会遮挡。
 *
 * 设计要点:
 * - 纯展示层,监听 plan 工具的 tool_result 同步状态(与 plan.ts 的数据格式一致)。
 * - 用 ctx.ui.setWidget() 渲染在编辑器下方,placement: "belowEditor"。
 * - 有计划步骤时自动显示,无计划时自动隐藏。
 * - 顶部显示 Plan (done/total) 标题,每步一行。
 *
 * 命令: /plan-dock [show|hide|toggle]   快捷键: Ctrl+Alt+D
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";

const WIDGET_NAME = "plan-dock";

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

/** 从当前分支重建计划状态:取最后一个 plan 工具结果。 */
function reconstruct(ctx: ExtensionContext): Step[] {
	let steps: Step[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "plan") continue;
		const details = msg.details as PlanDetails | undefined;
		if (details) steps = details.steps;
	}
	return steps;
}

/** 渲染 widget。有计划且可见时显示,否则隐藏。 */
function renderWidget(
	ctx: ExtensionContext,
	steps: Step[],
	visible: boolean,
): void {
	if (!visible || steps.length === 0) {
		ctx.ui.setWidget(WIDGET_NAME, undefined);
		return;
	}

	ctx.ui.setWidget(
		WIDGET_NAME,
		(_tui, theme) => {
			const done = steps.filter((s) => s.status === "completed").length;

			return {
				render: (width: number) => {
					const lines: string[] = [];

					// 标题栏
					lines.push(truncateToWidth(theme.fg("accent", `📋 Plan (${done}/${steps.length})`), width));

					// 各步骤
					for (const s of steps) {
						const icon =
							s.status === "completed"
								? theme.fg("success", "✓")
								: s.status === "in_progress"
									? theme.fg("accent", "◐")
									: theme.fg("dim", "○");
						const id = theme.fg("dim", `#${s.id}`);
						const text =
							s.status === "completed"
								? theme.fg("success", theme.strikethrough(s.text))
								: s.status === "in_progress"
									? theme.fg("accent", s.text)
									: s.text;
						lines.push(truncateToWidth(`  ${icon} ${id} ${text}`, width));
					}

					return lines;
				},
				invalidate: () => {},
			};
		},
		{ placement: "belowEditor" },
	);
}

export default function (pi: ExtensionAPI) {
	let steps: Step[] = [];
	let visible = true;

	const refresh = (ctx: ExtensionContext) => {
		renderWidget(ctx, steps, visible);
	};

	pi.on("session_start", async (_e, ctx) => {
		steps = reconstruct(ctx);
		refresh(ctx);
	});

	pi.on("session_tree", async (_e, ctx) => {
		steps = reconstruct(ctx);
		refresh(ctx);
	});

	// 监听 plan 工具结果,同步状态。
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "plan") return;
		const details = event.details as PlanDetails | undefined;
		if (!details) return;
		steps = details.steps;
		refresh(ctx);
	});

	const setVisibility = (next: boolean, ctx: ExtensionContext) => {
		visible = next;
		refresh(ctx);
		ctx.ui.notify(`Plan 进度条已${next ? "显示" : "隐藏"}`, "info");
	};

	pi.registerCommand("plan-dock", {
		description: "切换 Plan 进度条 (show|hide|toggle)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "show") setVisibility(true, ctx);
			else if (arg === "hide") setVisibility(false, ctx);
			else setVisibility(!visible, ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("d"), {
		description: "切换 Plan 进度条",
		handler: async (ctx) => setVisibility(!visible, ctx),
	});
}
