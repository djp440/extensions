import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ── 路径 ────────────────────────────────────────────
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(EXT_DIR, "api.json");

// ── 类型 ────────────────────────────────────────────
interface ProviderConfig {
  name: string;
  base_url: string;
  api_key?: string;
  enabled?: boolean;
  info_endpoint?: string; // e.g. "/api/v1/models" for rich model data
}

interface AppConfig {
  providers: ProviderConfig[];
}

// ── Extension 主入口 ─────────────────────────────────
export default async function (pi: ExtensionAPI) {
  // 读取配置
  const config = readConfig();

  // 注册 /provider 命令
  pi.registerCommand("provider", {
    description: "管理自定义 API 供应商。用法：/provider list|add|remove|enable|disable",
    handler: async (args, ctx) => {
      await handleCommand(args, ctx, pi, config);
    },
  });

  // 加载所有已启用的供应商
  for (const provider of config.providers) {
    if (provider.enabled === false) continue;
    await registerProviderFromConfig(pi, provider);
  }
}

// ── 读取配置文件 ─────────────────────────────────────
function readConfig(): AppConfig {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as AppConfig;
  } catch {
    return { providers: [] };
  }
}

function writeConfig(config: AppConfig) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), "utf-8");
}

// ── 注册单个供应商 ───────────────────────────────────
async function registerProviderFromConfig(
  pi: ExtensionAPI,
  provider: ProviderConfig,
): Promise<void> {
  const { name, base_url, api_key, info_endpoint } = provider;
  const resolvedKey = resolveApiKey(api_key || "");

  const headers: Record<string, string> = {};
  if (resolvedKey) {
    headers["Authorization"] = `Bearer ${resolvedKey}`;
  }

  // 判断是否有丰富信息接口
  if (info_endpoint) {
    const origin = new URL(base_url).origin;
    const infoUrl = `${origin}${info_endpoint}`;
    try {
      const resp = await fetch(infoUrl, { headers });
      if (resp.ok) {
        const body = (await resp.json()) as {
          data?: Array<{
            model_id: string;
            model_name?: string;
            types?: string;
            features?: string;
            input_modalities?: string;
            context_length?: number;
            max_output?: number;
            pricing?: {
              input?: number;
              output?: number;
              cache_read?: number;
              cache_write?: number;
            };
          }>;
        };

        if (body.data && body.data.length > 0) {
          const llmModels = body.data.filter((m) => !m.types || m.types === "llm");

          const models = llmModels.map((m) => {
            const features = m.features ? m.features.split(",").map((s) => s.trim()) : [];
            const modalities = m.input_modalities
              ? m.input_modalities.split(",").map((s) => s.trim())
              : [];

            const input: ("text" | "image")[] = ["text"];
            if (modalities.includes("image") || modalities.includes("video")) {
              input.push("image");
            }

            return {
              id: m.model_id,
              name: m.model_name || m.model_id,
              reasoning: features.includes("thinking"),
              input,
              contextWindow: m.context_length || 128000,
              maxTokens: m.max_output || 8192,
              cost: {
                input: m.pricing?.input ?? 0,
                output: m.pricing?.output ?? 0,
                cacheRead: m.pricing?.cache_read ?? 0,
                cacheWrite: m.pricing?.cache_write ?? 0,
              },
            };
          });

          pi.registerProvider(name, {
            name: `${name}`,
            baseUrl: base_url,
            apiKey: api_key || undefined,
            api: "openai-completions",
            models,
          });

          console.log(`[${name}] 注册 ${models.length} 个模型（信息接口）`);
          return;
        }
      }
      console.log(`[${name}] 信息接口不可用 (${resp.status})，回退到标准接口`);
    } catch (e) {
      console.log(`[${name}] 信息接口请求失败，回退到标准接口:`, e);
    }
  }

  // 标准 OpenAI /v1/models
  try {
    const resp = await fetch(`${base_url.replace(/\/$/, "")}/models`, { headers });
    if (!resp.ok) {
      console.log(`[${name}] 获取模型列表失败 (${resp.status})`);
      return;
    }

    const body = (await resp.json()) as {
      data?: Array<{ id: string }>;
    };

    if (!body.data || body.data.length === 0) {
      console.log(`[${name}] 模型列表为空`);
      return;
    }

    const models = body.data.map((m) => {
      const heuristics = inferModelMeta(m.id);
      return {
        id: m.id,
        name: m.id,
        reasoning: heuristics.reasoning,
        input: heuristics.input,
        contextWindow: heuristics.contextWindow,
        maxTokens: heuristics.maxTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    });

    pi.registerProvider(name, {
      name: `${name}`,
      baseUrl: base_url,
      apiKey: api_key || undefined,
      api: "openai-completions",
      models,
    });

    console.log(`[${name}] 注册 ${models.length} 个模型（标准接口）`);
  } catch (e) {
    console.log(`[${name}] 请求失败:`, e);
  }
}

// ── 模型名称启发式推断 ───────────────────────────────
function inferModelMeta(id: string): {
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
} {
  const lower = id.toLowerCase();

  // 图片支持
  const imageKeywords = [
    "vision", "vl", "multimodal", "image", "visual",
    "gemini-pro-vision", "llava", "cogvlm", "internvl",
  ];
  const input: ("text" | "image")[] = ["text"];
  if (imageKeywords.some((k) => lower.includes(k))) {
    input.push("image");
  }

  // Reasoning
  const reasoningKeywords = [
    "reasoner", "reasoning", "r1", "thinking",
    "o1", "o3", "qwq",
  ];
  const reasoning = reasoningKeywords.some((k) => lower.includes(k));

  // 上下文
  let contextWindow = 128000;
  if (lower.includes("claude")) contextWindow = 200000;
  else if (lower.includes("gemini")) contextWindow = 1048576;
  else if (lower.includes("deepseek")) contextWindow = 64000;
  else if (lower.includes("command-r")) contextWindow = 128000;

  // 最大输出
  let maxTokens = 8192;
  if (lower.includes("gpt-4o")) maxTokens = 16384;
  else if (lower.includes("o1") || lower.includes("o3")) maxTokens = 100000;
  else if (lower.includes("claude")) maxTokens = 8192;

  return { reasoning, input, contextWindow, maxTokens };
}

// ── 命令处理 ─────────────────────────────────────────
async function handleCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
  config: AppConfig,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0]?.toLowerCase();

  switch (subcommand) {
    case "list": {
      if (config.providers.length === 0) {
        ctx.ui.notify("还没有配置任何供应商", "info");
        return;
      }
      const lines = config.providers.map((p) => {
        const status = p.enabled === false ? "🔴 已禁用" : "🟢 已启用";
        return `  ${status} ${p.name} → ${p.base_url}${p.info_endpoint ? ` (info: ${p.info_endpoint})` : ""}`;
      });
      ctx.ui.notify(`已配置的供应商：\n${lines.join("\n")}`, "info");
      break;
    }

    case "add": {
      // /provider add <name> <base_url> [api_key] [--info <path>] [--disabled]
      if (parts.length < 3) {
        ctx.ui.notify("用法：/provider add <名称> <API地址> [API密钥] [--info <信息接口路径>] [--disabled]", "warn");
        return;
      }
      const name = parts[1];
      const baseUrl = parts[2];

      // 查找 --info 和 --disabled 标记
      const infoIdx = parts.indexOf("--info");
      const infoEndpoint = infoIdx !== -1 ? parts[infoIdx + 1] : undefined;

      const isDisabled = parts.includes("--disabled");

      // API key 是 base_url 后面、任何 -- 标记之前的第一个参数
      let apiKey: string | undefined;
      if (parts.length > 3) {
        // 找第一个不是 -- 开头的参数，在 name 和 base_url 之后
        const keyCandidate = parts[3];
        if (!keyCandidate.startsWith("--")) {
          apiKey = keyCandidate;
        }
      }

      // 检查是否已存在
      if (config.providers.some((p) => p.name === name)) {
        ctx.ui.notify(`供应商 "${name}" 已存在，请先删除或使用不同名称`, "warn");
        return;
      }

      const newProvider: ProviderConfig = {
        name,
        base_url: baseUrl,
        api_key: apiKey,
        enabled: !isDisabled,
        info_endpoint: infoEndpoint,
      };

      config.providers.push(newProvider);
      writeConfig(config);

      if (!isDisabled) {
        ctx.ui.notify(`正在获取 "${name}" 的模型列表...`, "info");
        await registerProviderFromConfig(pi, newProvider);
        ctx.ui.notify(`供应商 "${name}" 已添加并启用`, "info");
      } else {
        ctx.ui.notify(`供应商 "${name}" 已添加（当前禁用，启用请运行 /provider enable ${name}）`, "info");
      }
      break;
    }

    case "remove": {
      if (parts.length < 2) {
        ctx.ui.notify("用法：/provider remove <名称>", "warn");
        return;
      }
      const name = parts[1];
      const idx = config.providers.findIndex((p) => p.name === name);
      if (idx === -1) {
        ctx.ui.notify(`未找到供应商 "${name}"`, "warn");
        return;
      }

      config.providers.splice(idx, 1);
      writeConfig(config);

      try {
        pi.unregisterProvider(name);
      } catch { /* ignore */ }

      ctx.ui.notify(`供应商 "${name}" 已删除`, "info");
      break;
    }

    case "enable": {
      if (parts.length < 2) {
        ctx.ui.notify("用法：/provider enable <名称>", "warn");
        return;
      }
      const name = parts[1];
      const provider = config.providers.find((p) => p.name === name);
      if (!provider) {
        ctx.ui.notify(`未找到供应商 "${name}"`, "warn");
        return;
      }

      provider.enabled = true;
      writeConfig(config);

      ctx.ui.notify(`正在获取 "${name}" 的模型列表...`, "info");
      await registerProviderFromConfig(pi, provider);
      ctx.ui.notify(`供应商 "${name}" 已启用`, "info");
      break;
    }

    case "disable": {
      if (parts.length < 2) {
        ctx.ui.notify("用法：/provider disable <名称>", "warn");
        return;
      }
      const name = parts[1];
      const provider = config.providers.find((p) => p.name === name);
      if (!provider) {
        ctx.ui.notify(`未找到供应商 "${name}"`, "warn");
        return;
      }

      provider.enabled = false;
      writeConfig(config);

      try {
        pi.unregisterProvider(name);
      } catch { /* ignore */ }

      ctx.ui.notify(`供应商 "${name}" 已禁用`, "info");
      break;
    }

    default: {
      ctx.ui.notify(
        "用法：\n" +
        "  /provider list                    — 列出所有供应商\n" +
        "  /provider add <名称> <URL> [密钥] [--info <路径>] [--disabled]  — 添加供应商\n" +
        "  /provider remove <名称>           — 删除供应商\n" +
        "  /provider enable <名称>           — 启用供应商\n" +
        "  /provider disable <名称>          — 禁用供应商",
        "info",
      );
    }
  }
}

// ── API Key 解析 ────────────────────────────────────
function resolveApiKey(input: string): string | null {
  if (!input) return null;
  if (input.startsWith("$")) {
    return process.env[input.slice(1)] ?? null;
  }
  return input || null;
}
