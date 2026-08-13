import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * see_image — 视觉路由桥
 *
 * 当前模型（如 deepseek-v4-flash）本身没有视觉能力。本插件注册一个
 * `see_image` 工具：把图片文件读取出来，发给一个可配置的视觉模型
 * （默认智谱 GLM-4V-Flash，OpenAI 兼容接口），再把视觉模型的文字描述
 * 转述回给调用它的模型。文本模型因此可以间接"看图"。
 *
 * 归属：HOST 平面。它读取文件（ctx.fs）并发出网络请求（视觉 API），
 * 两者都是进程级能力；工具注册进全局层，所有会话可见。
 *
 * @module @deepseek-ai/dsh-tool-see-image
 */
const name = "tool-see-image";

/** 硬依赖：工具注册表（host 全局）与沙箱化文件服务（host 全局）。 */
const inject = ["tools", "fs"];

/** 部署配置：视觉 API 端点、密钥来源、模型与预算。 */
const Config = z.object({
  baseURL: z.string().default("https://open.bigmodel.cn/api/paas/v4"),
  apiKeyEnv: z.string().default("ZHIPU_API_KEY"),
  model: z.string().default("glm-4v-flash"),
  maxTokens: z.number().default(1024),
  timeoutMs: z.number().default(60000),
  maxBytes: z.number().default(15 * 1024 * 1024),
  prompt: z.string().default(
    "请详细描述这张图片的内容：主要物体、人物、场景、布局、颜色、风格，以及图中出现的所有文字（请完整转录）。如果图片是截图或图表，请说明其结构和关键信息。"
  )
});

/** 常见图片扩展名 → MIME，用于 data URL。 */
const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp"
};

const DESCRIPTION =
  "查看一张图片：把指定图片文件发送给配置好的视觉模型（默认智谱 GLM-4V-Flash），" +
  "返回视觉模型对图片的文字描述/转述。当前模型自身没有视觉能力，" +
  "需要看任何图片时都必须通过这个工具。path 可以是绝对路径或相对当前工作区的路径；" +
  "question 可指定你想从图片中知道的具体信息（缺省为详细描述）。" +
  "注意：本工具只负责把视觉模型的回答原样带回，请直接向用户转述其内容。";

function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: "see_image",
    description: DESCRIPTION,
    parameters: {
      path: {
        type: "string",
        required: true,
        description: "图片文件的路径（绝对路径，或相对于当前会话工作区的路径）。"
      },
      question: {
        type: "string",
        description: "针对图片的具体问题或关注点；缺省时让视觉模型详细描述整张图片。"
      }
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    presentCall: (args) => ({
      card: "generic",
      title: "查看图片",
      kind: "other",
      rawInput: args.path
    }),
    async execute(args, exec) {
      // ── 1. 解析并读取图片（走 ctx.fs，遵守沙箱与观察策略）──
      const cwd = exec.agent?.session?.header?.cwd;
      const target = await ctx.fs.resolve(args.path, {
        ...(cwd !== undefined ? { cwd } : {}),
        signal: exec.signal
      });
      if (target === undefined) {
        throw new Error(`see_image: 无法解析路径 "${args.path}"`);
      }
      const display = target.displayPath ?? args.path;
      const info = await ctx.fs.stat(target, exec.signal);
      if (info === undefined) {
        throw new Error(`see_image: 找不到文件 "${display}"`);
      }
      if (info.type !== "file") {
        throw new Error(`see_image: "${display}" 不是普通文件`);
      }
      if (info.size !== undefined && info.size > config.maxBytes) {
        throw new Error(`see_image: 图片过大（${info.size} 字节，上限 ${config.maxBytes} 字节）`);
      }
      const bytes = await ctx.fs.readBytes(target, exec.signal, config.maxBytes);

      // ── 2. 组视觉请求 ──
      const ext = (args.path.split(".").pop() || "").toLowerCase();
      const mime = MIME_BY_EXT[ext] ?? "image/png";
      const b64 = Buffer.from(bytes).toString("base64");
      const apiKey = process.env[config.apiKeyEnv];
      if (!apiKey) {
        throw new Error(
          `see_image: 未找到 API Key。请先设置环境变量 ${config.apiKeyEnv} ` +
          `（在启动 dsh 的终端里执行，或在用户环境变量中配置；Key 来自智谱开放平台 bigmodel.cn），` +
          `然后重启 dsh。也可以在插件配置（cordis.patch.yml 的 tool-see-image 行）中修改 apiKeyEnv 指向其他密钥变量。`
        );
      }
      const question = typeof args.question === "string" && args.question.trim() !== ""
        ? args.question.trim()
        : config.prompt;
      const body = {
        model: config.model,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }
          ]
        }],
        max_tokens: config.maxTokens
      };

      // ── 3. 请求视觉 API（带超时与取消）──
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      const onExecAbort = () => controller.abort();
      exec.signal?.addEventListener("abort", onExecAbort);
      let response;
      try {
        response = await fetch(`${config.baseURL.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          },
          body: JSON.stringify(body),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
        exec.signal?.removeEventListener("abort", onExecAbort);
      }

      if (!response.ok) {
        const snippet = (await response.text().catch(() => "")).slice(0, 500);
        throw new Error(`see_image: 视觉 API 返回 ${response.status} ${response.statusText}：${snippet}`);
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (content === undefined || content === null) {
        throw new Error("see_image: 视觉 API 返回了空响应（请检查模型名与配额）");
      }
      const text = Array.isArray(content)
        ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
        : String(content);
      if (text.trim() === "") {
        throw new Error("see_image: 视觉 API 返回了空文本");
      }
      return `【视觉模型 ${config.model} 对图片的描述】\n${text}`;
    }
  }));
}

export { Config, apply, inject, name };
