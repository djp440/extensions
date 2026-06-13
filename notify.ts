/**
 * 跨平台系统通知扩展
 *
 * 注册 `notify` 工具 (LLM 可调用) 和 `/notify` 命令 (用户输入)，
 * 在 macOS 上使用 osascript，在 Windows 上使用 PowerShell Toast，
 * 并尝试终端 OSC 通知作为 fallback。
 *
 * 额外支持自动通知: /notify-on 开启, /notify-off 关闭
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── 平台判断 ──────────────────────────────────────────────

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

// ── 各平台通知实现 ────────────────────────────────────────

/** macOS: 原生通知中心 */
async function notifyMac(title: string, message: string): Promise<void> {
  const t = title.replace(/"/g, '\\"');
  const m = message.replace(/"/g, '\\"');
  await execFileAsync("osascript", [
    "-e",
    `display notification "${m}" with title "${t}" sound name "default"`,
  ]);
}

/** Windows: PowerShell Toast 通知 */
async function notifyWindows(title: string, message: string): Promise<void> {
  const t = title.replace(/'/g, "''");
  const m = message.replace(/'/g, "''");
  const psScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$textNodes = $template.GetElementsByTagName('text')
$textNodes.Item(0).AppendChild($template.CreateTextNode('${t}')) | Out-Null
$textNodes.Item(1).AppendChild($template.CreateTextNode('${m}')) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
$aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
`.trim();
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    psScript,
  ]);
}

/** 终端 OSC 通知 (Ghostty, iTerm2, WezTerm, Kitty 等) */
function notifyTerminal(title: string, message: string): void {
  try {
    process.stdout.write(`\x1b]777;notify;${title};${message}\x07`);
  } catch {
    // stdout 不可用时静默忽略
  }
}

/** 统一通知入口 */
async function sendNotification(title: string, message: string): Promise<void> {
  if (isMac) {
    await notifyMac(title, message);
  } else if (isWindows) {
    await notifyWindows(title, message);
  } else {
    notifyTerminal(title, message);
  }
}

// ── 工具定义 ──────────────────────────────────────────────

const notifyTool = defineTool({
  name: "notify",
  label: "发送通知",
  description: "向用户的操作系统发送一条原生通知。用于提醒、定时器到期、任务完成等场景。",
  parameters: Type.Object({
    title: Type.String({ description: "通知标题" }),
    message: Type.String({ description: "通知正文" }),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const { title, message } = params;
    try {
      await sendNotification(title, message);
      return {
        content: [{ type: "text", text: `通知已发送: "${title}" — "${message}"` }],
        details: { sent: true, platform: process.platform },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `通知发送失败: ${msg}` }],
        details: { sent: false, error: msg, platform: process.platform },
      };
    }
  },
});

// ── 状态 ──────────────────────────────────────────────────

let autoNotifyOnAgentEnd = false;

// ── 扩展入口 ──────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // 注册 notify 工具
  pi.registerTool(notifyTool);

  // 注册 /notify 命令
  pi.registerCommand("notify", {
    description: "发送一条系统通知。用法: /notify <标题> | <消息>",
    handler: async (args, ctx) => {
      const parts = args.split("|").map((s: string) => s.trim());
      const title = parts[0] || "Pi";
      const message = parts[1] || args || "通知";
      try {
        await sendNotification(title, message);
        if (ctx.hasUI) ctx.ui.notify("通知已发送 ✅", "info");
      } catch {
        if (ctx.hasUI) ctx.ui.notify("通知发送失败 ❌", "error");
      }
    },
  });

  // /notify-on: 开启每次回复后自动通知
  pi.registerCommand("notify-on", {
    description: "开启自动通知:每次LLM回复完成后发送系统通知",
    handler: async (_args, ctx) => {
      autoNotifyOnAgentEnd = true;
      if (ctx.hasUI) ctx.ui.notify("自动通知已开启 🔔", "info");
    },
  });

  // /notify-off: 关闭自动通知
  pi.registerCommand("notify-off", {
    description: "关闭自动通知",
    handler: async (_args, ctx) => {
      autoNotifyOnAgentEnd = false;
      if (ctx.hasUI) ctx.ui.notify("自动通知已关闭 🔕", "info");
    },
  });

  // agent_end: 每次LLM回复完成后自动发送系统通知
  pi.on("agent_end", async () => {
    if (!autoNotifyOnAgentEnd) return;
    await sendNotification("Pi", "回复已完成，可以查看结果");
  });

  // session_start: 提示扩展已加载
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify("通知扩展已加载 📢", "info");
    }
  });
}
