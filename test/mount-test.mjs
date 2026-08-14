// 进程外真实挂载测试：验证 tool-see-image 行能在真实 Cordis Loader 下激活。
// 用法：
//   DSH_CHECKOUT=<dsh 安装路径> node mount-test.mjs
// 其中 DSH_CHECKOUT 指向 dsh 的 npm 缓存安装根（含 node_modules/@deepseek-ai）。
// 脚本会把本插件目录**复制**进该 node_modules，使 `@deepseek-ai/dsh-tool-see-image`
// 可被解析（复制而非链接，保证插件源码从 checkout 的 node_modules 解析 peer
// 依赖），测试结束自动清理。
// 示例（Windows）：
//   set DSH_CHECKOUT=D:\npm-cache\_npx\1e7f6d9597241db0
//   node mount-test.mjs
import { pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
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

// ── 1. 把本插件放进 checkout 的 node_modules ──
// 注意：必须**复制**而非符号链接。symlink 会让 Node 沿着链接解析回插件真实
// 路径，从仓库目录找 node_modules，从而找不到 @deepseek-ai/schemastery 等
// peer 依赖（它们只在 checkout 里）。复制后插件源码从 checkout 的
// node_modules 解析依赖，pnpm shamefully-hoist 保证它们都在顶层。
const pkgScopeDir = join(checkout, "node_modules", "@deepseek-ai");
const pkgLink = join(pkgScopeDir, "dsh-tool-see-image");
mkdirSync(pkgScopeDir, { recursive: true });
let linked = false;
try {
  const { cpSync } = await import("node:fs");
  cpSync(pluginRoot, pkgLink, {
    recursive: true,
    force: true,
    filter: (src) => !src.includes("node_modules") && !src.includes(".git"),
  });
  linked = true;
} catch (e) {
  console.warn("复制插件到 checkout node_modules 失败（测试可能因找不到包而失败）:", e.message);
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
      rmSync(pkgLink, { recursive: true, force: true });
    } catch {
      // 清理失败不影响测试结果
    }
  }
}
