import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/**
 * see_image — 视觉路由桥（多模型 + 限流自动降级）
 *
 * 当前模型（如 deepseek-v4-flash）本身没有视觉能力。本插件注册一个
 * `see_image` 工具：把图片文件读取出来，按优先级依次尝试一组可配置的
 * 视觉模型（默认智谱 GLM-4.6V-Flash → GLM-4.1V-Thinking-Flash →
 * GLM-4V-Flash，全部免费，OpenAI 兼容接口），把第一个成功的视觉模型的
 * 文字描述转述回给调用它的模型。遇到限流 / 5xx 自动降级到下一个模型，
 * 全部失败才报错。文本模型因此可以间接"看图"。
 *
 * 归属：HOST 平面。它读取文件（ctx.fs）并发出网络请求（视觉 API），
 * 两者都是进程级能力；工具注册进全局层，所有会话可见。
 *
 * @module @deepseek-ai/dsh-tool-see-image
 */
const name = "tool-see-image";

/** 硬依赖：工具注册表（host 全局）与沙箱化文件服务（host 全局）。 */
const inject = ["tools", "fs"];

/** 部署配置：视觉 API 端点、密钥来源、模型优先级与预算。 */
const Config = z.object({
  baseURL: z.string().default("https://open.bigmodel.cn/api/paas/v4"),
  apiKeyEnv: z.string().default("ZHIPU_API_KEY"),
  model: z.string().default("glm-4.6v-flash"),
  fallbackModels: z.array(z.string()).default(["glm-4.1v-thinking-flash", "glm-4v-flash"]),
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
  "查看一张图片：把指定图片文件发送给配置好的视觉模型（默认智谱 GLM-4.6V-Flash，" +
  "免费），返回视觉模型对图片的文字描述/转述。当前模型自身没有视觉能力，" +
  "需要看任何图片时都必须通过这个工具。path 可以是绝对路径或相对当前工作区的路径；" +
  "question 可指定你想从图片中知道的具体信息（缺省为详细描述）。" +
  "注意：本工具只负责把视觉模型的回答原样带回，请直接向用户转述其内容。";

/**
 * 判断错误是否属于"值得换一个模型重试"的限流/过载类错误。
 * 429、5xx、以及智谱常见限流错误码（1113 限流 / 1114 并发超限 / 1130 负载过高）
 * 都触发降级；而 key 无效、请求格式错误等非限流错误直接抛出，不浪费备胎模型。
 */
function isRetryable(err) {
  const msg = String(err?.message ?? "");
  return /429|\b5\d\d\b|1113|1114|1130|限流|繁忙|并发|过载|rate ?limit|too many|temporarily/i.test(msg);
}

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

      // ── 2. 组视觉请求（图片部分）──
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

      // ── 3. 按优先级依次尝试视觉模型：限流/过载 → 降级下一个 ──
      const attempts = [config.model, ...(config.fallbackModels ?? [])];
      let lastError;
      for (const model of attempts) {
        try {
          const text = await callVision(model, question, mime, b64, config, exec);
          return `【视觉模型 ${model} 对图片的描述】\n${text}`;
        } catch (err) {
          lastError = err;
          if (!isRetryable(err)) throw err;   // 非限流错误：不浪费备胎
        }
      }
      throw new Error(`see_image: 所有视觉模型均失败（${attempts.join(" → ")}），最后错误：${lastError?.message}`);
    }
  }));
}

/**
 * 对单个视觉模型发一次请求，返回其文字描述。
 * 对 max_tokens 超上限（如 glm-4v-flash 上限 1024）的 400 做一次减半重试。
 */
async function callVision(model, question, mime, b64, config, exec) {
  let maxTokens = config.maxTokens;
  const apiKey = process.env[config.apiKeyEnv];
  for (let attempt = 0; attempt < 2; attempt++) {
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
        body: JSON.stringify({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: question },
              { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } }
            ]
          }],
          max_tokens: maxTokens
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
      exec.signal?.removeEventListener("abort", onExecAbort);
    }

    if (!response.ok) {
      const snippet = (await response.text().catch(() => "")).slice(0, 500);
      const err = new Error(`see_image: 视觉 API 返回 ${response.status} ${response.statusText}：${snippet}`);
      // 400 且 max_tokens 非法 → 减半重试一次（不同模型输出上限不同）
      if (response.status === 400 && /max_tokens|max tokens/i.test(snippet) && maxTokens > 256) {
        maxTokens = Math.floor(maxTokens / 2);
        continue;
      }
      throw err;
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
    return text;
  }
  throw new Error(`see_image: 模型 ${model} 的 max_tokens 持续超限`);
}

export { Config, apply, inject, name };
