/**
 * Codex 配额显示扩展 v2
 *
 * 当当前模型来自 openai-codex 时，在 TUI footer 右下角展示
 * ChatGPT Plus/Pro Codex 订阅的剩余计算额度，含彩色进度条。
 *
 * 数据来源：chatgpt.com/backend-api/wham/usage
 *
 * 用法：放入 ~/.pi/agent/extensions/ 后自动加载
 *   /codex-quota — 手动刷新
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 常量 ──────────────────────────────────────────────────

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const API_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_PROVIDER = "openai-codex";
const MIN_REFRESH_INTERVAL_MS = 10_000; // 两次刷新间至少间隔 10s
const BAR_WIDTH = 8; // 进度条宽度（字符数）

// ── 类型 ──────────────────────────────────────────────

interface CodexWindow {
  used_percent: number;
  limit_window_seconds: number;
  reset_at: number;
}

interface CodexUsage {
  plan_type: string;
  rate_limit: {
    primary_window: CodexWindow;
    secondary_window: CodexWindow;
  };
  rate_limit_reset_credits?: { available_count: number };
}

interface QuotaData {
  planType: string;
  pct5h: number; // 已用百分比 (0-100)
  pct7d: number;
  resetCredits: number;
  error?: string;
}

// ── 工具 ──────────────────────────────────────────────

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]!));
  } catch { return null; }
}

function extractAccountId(token: string): string | null {
  const p = decodeJwt(token);
  if (!p) return null;
  const auth = p["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  return (auth?.chatgpt_account_id as string) ?? null;
}

function readCodexAuth(): { token: string; accountId: string } | null {
  try {
    const c = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
    const e = c[CODEX_PROVIDER];
    if (!e || e.type !== "oauth") return null;
    const token: string = e.access;
    if (!token) return null;
    const id = extractAccountId(token);
    return id ? { token, accountId: id } : null;
  } catch { return null; }
}

async function fetchQuota(auth: { token: string; accountId: string }): Promise<QuotaData> {
  try {
    const resp = await fetch(API_URL, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "ChatGPT-Account-Id": auth.accountId,
        "User-Agent": "codex-cli",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { planType: "", pct5h: 0, pct7d: 0, resetCredits: 0, error: `HTTP ${resp.status}` };
    const d = (await resp.json()) as CodexUsage;
    return {
      planType: d.plan_type ?? "unknown",
      pct5h: d.rate_limit?.primary_window?.used_percent ?? 0,
      pct7d: d.rate_limit?.secondary_window?.used_percent ?? 0,
      resetCredits: d.rate_limit_reset_credits?.available_count ?? 0,
    };
  } catch (e) {
    return { planType: "", pct5h: 0, pct7d: 0, resetCredits: 0, error: String(e) };
  }
}

/** 绘制单行进度条，如 `██████░░ 60%` */
function bar(usedPct: number, w: number, fill: (s: string) => string, empty: (s: string) => string): string {
  const filled = Math.round((usedPct / 100) * w);
  const rest = w - filled;
  return fill("▓".repeat(filled)) + empty("░".repeat(rest));
}

// ── 扩展主逻辑 ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let isCodex = false;
  let last: QuotaData | null = null;
  let hasAuth = false;
  let lastFetch = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let footerUnsub: (() => void) | null = null;

  // ── Footer 渲染 ──
  // 只在 footer 右侧显示，不占用左侧
  function setupFooter(ctx: any) {
    if (footerUnsub) { footerUnsub(); footerUnsub = null; }

    if (!isCodex) return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());

      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // 构建右侧配额文本
          let right = "";
          if (last?.error) {
            right = theme.fg("warning", `Codex ${last.error}`);
          } else if (last) {
            const plan = last.planType === "plus" ? "P" : last.planType === "pro" ? "Pro" : last.planType;

            // 进度条颜色
            const c5h = last.pct5h < 50 ? "success" : last.pct5h < 80 ? "warning" : "error";
            const c7d = last.pct7d < 50 ? "success" : last.pct7d < 80 ? "warning" : "error";

            const bar5h = bar(last.pct5h, BAR_WIDTH, (s) => theme.fg(c5h, s), (s) => theme.fg("dim", s));
            const bar7d = bar(last.pct7d, BAR_WIDTH, (s) => theme.fg(c7d, s), (s) => theme.fg("dim", s));

            const p5h = `${(100 - last.pct5h).toFixed(0)}%`;
            const p7d = `${(100 - last.pct7d).toFixed(0)}%`;
            const rc = last.resetCredits > 0 ? ` ♻${last.resetCredits}` : "";

            right = `${theme.fg("accent", "Codex")} ${plan} ${bar5h}${theme.fg("accent", "5h")}${theme.fg(c5h, p5h)} ${bar7d}${theme.fg("accent", "7d")}${theme.fg(c7d, p7d)}${theme.fg("muted", rc)}`;
          }

          // 左侧: 标准 footer 信息（模型 + git）
          const branch = footerData.getGitBranch();
          const branchStr = branch ? ` (${branch})` : "";
          const left = theme.fg("dim", `${ctx.model?.id || ""}${branchStr}`);

          // 拼接：左侧 + 间距 + 右侧
          const leftW = visibleWidth(left);
          const rightW = visibleWidth(right);
          const gap = Math.max(1, width - leftW - rightW);
          const pad = " ".repeat(gap);
          return [truncateToWidth(left + pad + right, width)];
        },
      };
    });
  }

  function restoreFooter(ctx: any) {
    ctx.ui.setFooter(undefined);
    footerUnsub = null;
  }

  // ── 数据刷新 ──
  async function refresh(ctx: any, force = false) {
    if (!isCodex) { restoreFooter(ctx); return; }

    if (!hasAuth) {
      const auth = readCodexAuth();
      if (!auth) { hasAuth = false; return; }
      hasAuth = true;
    }

    const now = Date.now();
    if (!force && last && now - lastFetch < MIN_REFRESH_INTERVAL_MS) return;

    const auth = readCodexAuth();
    if (!auth) { hasAuth = false; restoreFooter(ctx); return; }

    last = await fetchQuota(auth);
    lastFetch = Date.now();
    setupFooter(ctx);
  }

  // ── 命令 ──
  pi.registerCommand("codex-quota", {
    description: "刷新 Codex 订阅额度",
    handler: async (_args, ctx) => {
      isCodex = true;
      await refresh(ctx, true);
      ctx.ui.notify(last?.error ? `Codex: ${last.error}` : "Codex 额度已刷新 ✓", "info");
    },
  });

  // ── 事件 ──

  pi.on("session_start", async (_event, ctx) => {
    const auth = readCodexAuth();
    hasAuth = auth !== null;

    isCodex = ctx.model?.provider === CODEX_PROVIDER;
    if (isCodex) await refresh(ctx, true);

    if (timer) clearInterval(timer);
    timer = setInterval(async () => { if (isCodex) await refresh(ctx); }, 60_000);
  });

  pi.on("session_shutdown", async () => {
    if (timer) { clearInterval(timer); timer = null; }
    isCodex = false; last = null;
  });

  pi.on("model_select", async (event, ctx) => {
    const nowCodex = event.model?.provider === CODEX_PROVIDER;

    if (nowCodex && !isCodex) {
      isCodex = true;
      await refresh(ctx, true);
    } else if (!nowCodex && isCodex) {
      isCodex = false;
      last = null;
      restoreFooter(ctx);
    }
  });

  // ★ 每次 LLM 应答完毕刷新（节流 10s）
  pi.on("turn_end", async (_event, ctx) => {
    if (isCodex) await refresh(ctx);
  });
}
