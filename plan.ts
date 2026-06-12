/**
 * Plan 工具 - 让 LLM 维护一个带状态的执行计划。
 *
 * 设计要点:
 * - 状态存在工具结果的 details 里(不写外部文件),分支/恢复天然正确。
 * - session_start / session_tree 时从分支重建内存状态。
 * - 每个步骤三态: pending / in_progress / completed。
 *
 * 提供:
 * - 工具 `plan`,actions: set / start / complete / show / clear
 * - 命令 `/plan` 给用户查看当前计划
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type StepStatus = "pending" | "in_progress" | "completed";

interface Step {
	id: number;
	text: string;
	status: StepStatus;
}

interface PlanDetails {
	action: "set" | "start" | "complete" | "show" | "clear";
	steps: Step[];
	error?: string;
}

const PlanParams = Type.Object({
	action: StringEnum(["set", "start", "complete", "show", "clear"] as const),
	steps: Type.Optional(
		Type.Array(Type.String(), { description: "步骤文本列表(action=set 时使用,替换整个计划)" }),
	),
	id: Type.Optional(Type.Number({ description: "步骤 ID(action=start/complete 时使用)" })),
});

const ICONS: Record<StepStatus, string> = { pending: "○", in_progress: "◐", completed: "✓" };

function statusColor(theme: Theme, status: StepStatus, text: string): string {
	if (status === "completed") return theme.fg("success", theme.strikethrough(text));
	if (status === "in_progress") return theme.fg("accent", text);
	return theme.fg("muted", text);
}

/** /plan 命令的全屏查看组件 */
class PlanViewComponent {
	private cachedWidth?: number;
	private cachedLines?: string[];
	constructor(
		private steps: Step[],
		private theme: Theme,
		private onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [""];
		const title = th.fg("accent", " Plan ");
		lines.push(truncateToWidth(th.fg("borderMuted", "───") + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 9))), width));
		lines.push("");

		if (this.steps.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "还没有计划。让 agent 用 plan 工具创建一个。")}`, width));
		} else {
			const done = this.steps.filter((s) => s.status === "completed").length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${this.steps.length} 已完成`)}`, width));
			lines.push("");
			for (const s of this.steps) {
				const icon = statusColor(th, s.status, ICONS[s.status]);
				const id = th.fg("dim", `#${s.id}`);
				lines.push(truncateToWidth(`  ${icon} ${id} ${statusColor(th, s.status, s.text)}`, width));
			}
		}
		lines.push("", truncateToWidth(`  ${th.fg("dim", "按 Escape 关闭")}`, width), "");
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function summary(steps: Step[]): string {
	if (steps.length === 0) return "计划为空";
	return steps
		.map((s) => `${ICONS[s.status]} #${s.id} [${s.status}] ${s.text}`)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let steps: Step[] = [];

	const reconstruct = (ctx: ExtensionContext) => {
		steps = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "plan") continue;
			const details = msg.details as PlanDetails | undefined;
			if (details) steps = details.steps;
		}
	};

	pi.on("session_start", async (_e, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_e, ctx) => reconstruct(ctx));

	pi.registerTool({
		name: "plan",
		label: "Plan",
		description:
			"维护一个带状态的执行计划。actions: set(steps 替换整个计划) / start(id 标记某步进行中) / complete(id 标记某步完成) / show / clear。规划复杂多步任务时用 plan 跟踪进度。",
		promptSnippet: "维护带状态的多步执行计划",
		promptGuidelines: [
			"处理需要多个步骤的任务时,先用 plan(action=set) 列出步骤,开始某步时 start,完成后 complete。",
			"plan(set) 会弹出确认框等待用户批准。如果返回内容表明用户未批准,不要开始执行,先问清用户意图再用 plan(set) 重新列计划。",
		],
		parameters: PlanParams,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const fail = (action: PlanDetails["action"], error: string) => ({
				content: [{ type: "text" as const, text: `Error: ${error}` }],
				details: { action, steps: [...steps], error } as PlanDetails,
			});

			switch (params.action) {
				case "set": {
					if (!params.steps?.length) return fail("set", "set 需要非空的 steps 数组");
					const next = params.steps.map((text, i) => ({ id: i + 1, text, status: "pending" as StepStatus }));

					// 列完计划后与用户确认才允许执行。无交互 UI 时(如 -p 打印模式)跳过确认。
					if (ctx.hasUI) {
						const preview = next.map((s) => `${s.id}. ${s.text}`).join("\n");
						const approved = await ctx.ui.confirm(
							`确认执行计划(${next.length} 步)?`,
							`${preview}\n\n选择「是」开始执行,「否」则先与用户讨论调整。`,
						);
						steps = next;
						if (!approved) {
							return {
								content: [
									{
										type: "text",
										text: `用户尚未批准该计划,请勿开始执行。先询问用户希望如何调整,根据反馈再用 plan(set) 更新计划。\n${summary(steps)}`,
									},
								],
								details: { action: "set", steps: [...steps] } as PlanDetails,
							};
						}
					} else {
						steps = next;
					}

					return {
						content: [{ type: "text", text: `用户已批准,可开始执行。已创建 ${steps.length} 步计划:\n${summary(steps)}` }],
						details: { action: "set", steps: [...steps] } as PlanDetails,
					};
				}
				case "start":
				case "complete": {
					if (params.id === undefined) return fail(params.action, `${params.action} 需要 id`);
					const step = steps.find((s) => s.id === params.id);
					if (!step) return fail(params.action, `未找到步骤 #${params.id}`);
					step.status = params.action === "start" ? "in_progress" : "completed";
					return {
						content: [{ type: "text", text: `步骤 #${step.id} -> ${step.status}\n${summary(steps)}` }],
						details: { action: params.action, steps: [...steps] } as PlanDetails,
					};
				}
				case "clear": {
					const n = steps.length;
					steps = [];
					return {
						content: [{ type: "text", text: `已清空 ${n} 步计划` }],
						details: { action: "clear", steps: [] } as PlanDetails,
					};
				}
				default:
					return {
						content: [{ type: "text", text: summary(steps) }],
						details: { action: "show", steps: [...steps] } as PlanDetails,
					};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("plan ")) + theme.fg("muted", args.action);
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.steps?.length) text += ` ${theme.fg("dim", `(${args.steps.length} 步)`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as PlanDetails | undefined;
			if (!details) {
				const t = result.content[0];
				return new Text(t?.type === "text" ? t.text : "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);

			const list = details.steps;
			if (list.length === 0) return new Text(theme.fg("dim", "计划为空"), 0, 0);

			const done = list.filter((s) => s.status === "completed").length;
			let out = theme.fg("muted", `${done}/${list.length} 已完成`);
			const display = expanded ? list : list.slice(0, 6);
			for (const s of display) {
				out += `\n${statusColor(theme, s.status, ICONS[s.status])} ${theme.fg("dim", `#${s.id}`)} ${statusColor(theme, s.status, s.text)}`;
			}
			if (!expanded && list.length > 6) out += `\n${theme.fg("dim", `... 还有 ${list.length - 6} 步`)}`;
			return new Text(out, 0, 0);
		},
	});

	pi.registerCommand("plan", {
		description: "查看当前分支的执行计划",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(summary(steps), "info");
				return;
			}
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => new PlanViewComponent(steps, theme, () => done()));
		},
	});
}
