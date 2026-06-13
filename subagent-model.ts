/**
 * /subagent-model - 切换子代理使用的模型
 *
 * 工作流：
 *   1. 列出 ~/.pi/agent/agents/ 下的子代理
 *   2. 选中一个后列出可用模型
 *   3. 更新对应 .md 文件的 frontmatter
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const AGENTS_DIR = path.join(getAgentDir(), "agents");

interface AgentInfo {
	name: string;
	file: string;
	currentModel: string | null;
}

function listAgents(): AgentInfo[] {
	if (!fs.existsSync(AGENTS_DIR)) return [];
	const agents: AgentInfo[] = [];
	for (const entry of fs.readdirSync(AGENTS_DIR, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md")) continue;
		const filePath = path.join(AGENTS_DIR, entry.name);
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name) continue;
		agents.push({
			name: frontmatter.name,
			file: filePath,
			currentModel: frontmatter.model || null,
		});
	}
	return agents;
}

async function updateAgentModel(filePath: string, newModel: string | null): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.split("\n");

		// 找到前导 --- 之间的 frontmatter 区域
		let dashCount = 0;
		let fmStart = -1;
		let fmEnd = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === "---") {
				if (dashCount === 0) fmStart = i;
				else if (dashCount === 1) { fmEnd = i; break; }
				dashCount++;
			}
		}

		if (fmStart === -1 || fmEnd === -1) return; // 没有 frontmatter

		let modelUpdated = false;
		const newLines: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			if (i > fmStart && i < fmEnd) {
				// 在 frontmatter 区域内
				if (lines[i].startsWith("model:")) {
					if (newModel) {
						newLines.push(`model: ${newModel}`);
					}
					modelUpdated = true;
				} else {
					newLines.push(lines[i]);
				}
			} else {
				newLines.push(lines[i]);
			}
		}

		// 如果没有找到 model 行，添加到第二个 --- 之前
		if (!modelUpdated && newModel) {
			let dashSeen = 0;
			for (let i = 0; i < newLines.length; i++) {
				if (newLines[i].trim() === "---") {
					dashSeen++;
					if (dashSeen === 2) {
						newLines.splice(i, 0, `model: ${newModel}`);
						break;
					}
				}
			}
		}

		fs.writeFileSync(filePath, newLines.join("\n"), "utf-8");
	});
}

function getModelList(ctx: ExtensionContext): { id: string; label: string }[] {
	const models = ctx.modelRegistry.getAll();
	return models
		.filter((m) => ctx.modelRegistry.hasConfiguredAuth(m))
		.map((m) => {
			// 确保使用完整的 provider/model 格式
			const fullId = m.provider ? `${m.provider}/${m.id}` : m.id;
			return {
				id: fullId,
				label: m.name || fullId,
			};
		})
		.sort((a, b) => a.id.localeCompare(b.id));
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("subagent-model", {
		description: "切换子代理使用的模型。选择 agent → 从可用模型列表中选取",
		handler: async (_args, ctx) => {
			const agents = listAgents();
			if (agents.length === 0) {
				ctx.ui.notify("未在 ~/.pi/agent/agents/ 下找到任何子代理定义", "warning");
				return;
			}

			if (!ctx.hasUI) {
				const lines = agents.map((a) => `${a.name}: ${a.currentModel || "(默认模型)"}`);
				ctx.ui.notify(`可用子代理:\n${lines.join("\n")}`, "info");
				return;
			}

			// 第 1 步：选子代理 — ctx.ui.select 只接受 string[]
			const agentOptions = agents.map((a) =>
				a.currentModel ? `${a.name} (当前: ${a.currentModel})` : `${a.name} (默认模型)`
			);

			const selectedLabel = await ctx.ui.select("选择要切换模型的子代理", agentOptions);
			if (!selectedLabel) {
				ctx.ui.notify("已取消", "info");
				return;
			}
			const selectedAgentName = selectedLabel.split(" (")[0];

			const targetAgent = agents.find((a) => a.name === selectedAgentName);
			if (!targetAgent) {
				ctx.ui.notify(`未找到子代理 "${selectedAgentName}"`, "error");
				return;
			}

			// 第 2 步：选模型 — ctx.ui.select 只接受 string[]
			const allModels = getModelList(ctx);
			if (allModels.length === 0) {
				ctx.ui.notify("没有可用的模型（可能未配置 API key）", "error");
				return;
			}

			const modelOptions = [
				"(默认模型) — 去掉 model 字段，使用 pi 默认模型",
				...allModels.map((m) => m.label),
			];

			const selectedModelLabel = await ctx.ui.select(
				`为 "${targetAgent.name}" 选择模型`,
				modelOptions,
			);
			if (!selectedModelLabel) {
				ctx.ui.notify("已取消", "info");
				return;
			}

			// 第 3 步：更新文件
			let newModel: string | null;
			if (selectedModelLabel.startsWith("(默认模型)")) {
				newModel = null;
			} else {
				const matched = allModels.find((m) => m.label === selectedModelLabel);
				newModel = matched?.id || null;
			}

			try {
				await updateAgentModel(targetAgent.file, newModel);
				const msg = newModel
					? `${targetAgent.name} 的模型已切换为: ${newModel}`
					: `${targetAgent.name} 的模型已清除，使用默认模型`;
				ctx.ui.notify(msg, "success");
			} catch (err) {
				ctx.ui.notify(`更新失败: ${err}`, "error");
			}
		},
	});
}
