// 进程外真实挂载测试：验证 tool-see-image 行能在真实 Cordis Loader 下激活。
// 用法：
//   DSH_CHECKOUT=<dsh 安装路径> node mount-test.mjs
// 其中 DSH_CHECKOUT 指向 dsh 的 npm 缓存安装根（含 node_modules/@deepseek-ai）。
// 脚本会把本插件目录临时链接进该 node_modules，使 `@deepseek-ai/dsh-tool-see-image`
// 可被解析（Windows 用 junction，其它平台用 symlink），测试结束自动清理。
// 示例（Windows）：
//   set DSH_CHECKOUT=D:\npm-cache\_npx\1e7f6d9597241db0
//   node mount-test.mjs
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = dirname(__dirname); // 插件根目录（test/ 的上一级）
const checkout = process.env.DSH_CHECKOUT;
if (!checkout) {
  console.error("请设置环境变量 DSH_CHECKOUT 指向 dsh 安装根目录（含 node_modules/@deepseek-ai）");
  process.exit(1);
}

// ── 1. 把本插件临时链接进 checkout 的 node_modules ──
const pkgScopeDir = join(checkout, "node_modules", "@deepseek-ai");
const pkgLink = join(pkgScopeDir, "dsh-tool-see-image");
mkdirSync(pkgScopeDir, { recursive: true });
let linked = false;
try {
  if (process.platform.startsWith("win")) {
    // Windows junction（目录符号链接无需管理员权限）
    const { execFileSync } = await import("node:child_process");
    execFileSync("cmd", ["/c", "mklink", "/J", pkgLink, pluginRoot], { stdio: "ignore" });
  } else {
    // Linux / macOS / CI：普通 symlink
    symlinkSync(pluginRoot, pkgLink, "dir");
  }
  linked = true;
} catch (e) {
  console.warn("链接插件到 checkout node_modules 失败（测试可能因找不到包而失败）:", e.message);
}

try {
  const dir = join(tmpdir(), "dsh-mount-test");
  const rootConfig = `${dir}/cordis.yml`;
  const bareModuleBaseUrl = pathToFileURL(join(checkout, "node_modules")).href;
  const bootUrl = pathToFileURL(
    join(checkout, "node_modules/@deepseek-ai/dsh-app-boot/lib/index.js")
  ).href;

  mkdirSync(dir, { recursive: true });
  writeFileSync(rootConfig, `
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
  config:
    persona: test
- id: tools
  name: '@deepseek-ai/dsh-tools'
- id: tool-see-image
  name: '@deepseek-ai/dsh-tool-see-image'
`, "utf8");

  const { boot: bootFn } = await import(bootUrl);

  const ctx = await bootFn("mount-test", rootConfig, [], (hostCtx) => {
    // fs 服务 stub：工具行 inject ["tools","fs"]，fs 必须有服务才激活
    hostCtx.provide("fs", {
      resolve: async (p) => ({ displayPath: p }),
      stat: async () => ({ type: "file", size: 1 }),
      readBytes: async () => new Uint8Array(0)
    });
  }, bareModuleBaseUrl);

  console.log("=== boot OK ===");
  console.log("loader:", ctx.get("loader") !== undefined ? "present" : "MISSING");
  console.log("tools:", ctx.get("tools") !== undefined ? "present" : "MISSING");
  console.log("fs:", ctx.get("fs") !== undefined ? "present" : "MISSING");

  // 验证工具真的注册进了 tools 注册表
  const tools = ctx.get("tools");
  if (tools) {
    let found = false;
    let text = "";
    try {
      const r = await tools.schemas();
      text = JSON.stringify(r);
      found = text.includes("see_image");
    } catch (e) {
      console.log("schemas() 抛错:", e.message);
    }
    console.log("tools.schemas() 含 see_image:", found);
    if (!found) {
      const idx = text.indexOf("see_image");
      if (idx >= 0) console.log("context:", text.slice(Math.max(0, idx - 60), idx + 60));
    }
  }

  await ctx.fiber.dispose();
  console.log("=== MOUNT TEST PASS ===");
} finally {
  if (linked) {
    try {
      if (process.platform.startsWith("win")) {
        const { execFileSync } = await import("node:child_process");
        execFileSync("cmd", ["/c", "rmdir", pkgLink], { stdio: "ignore" });
      } else {
        rmSync(pkgLink, { recursive: true, force: true });
      }
    } catch {
      // 清理失败不影响测试结果
    }
  }
}
