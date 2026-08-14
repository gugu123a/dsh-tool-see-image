#!/usr/bin/env node
/**
 * patch-dsh-image-relay.mjs
 *
 * 给 DSH 打"图片转文字路由"补丁：
 *  1. dsh-host-apiproxy：放开 MODEL_DOES_NOT_SUPPORT_IMAGES 检查，
 *     并在 durablePromptContent 里把图片块转成 GLM-4V-Flash 的文字描述。
 *  2. 这样 DeepSeek 适配器只会收到纯文本，图片通过 GLM 桥被"看见"。
 *
 * 用法：
 *   node patch-dsh-image-relay.mjs            # 应用补丁
 *   node patch-dsh-image-relay.mjs --check    # 只检查补丁状态
 *   node patch-dsh-image-relay.mjs --revert   # 撤销补丁（恢复原始备份）
 *
 * 说明：
 *  - 补丁前自动备份原文件为 *.orig.js
 *  - 幂等：已打补丁再次运行会跳过
 *  - npx 升级 dsh 后补丁会丢，重跑本脚本即可
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 目标文件（从 npx 缓存解析，兼容 DSH_CHECKOUT 覆盖）──
const checkout = process.env.DSH_CHECKOUT ?? "D:/npm-cache/_npx/1e7f6d9597241db0";
const APIPROXY = join(checkout, "node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js");

// ── 补丁标记（注入到文件里，用于幂等判断）──
const MARK = "/* [image-relay-patch] */";

/**
 * 正则工具：匹配任意 tab/空格缩进。
 * 用关键唯一子串定位段落，避免硬编码缩进（DSH 升级可能改变缩进风格）。
 */
const ind = "[ \\t]*";

// ── 补丁 1：放开图片能力检查 ──
// 把 if 条件改成 if(false && ...) 旁路拦截（简单字符串替换，不依赖缩进）
const PATCH_1_OLD_SNIPPET = "if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes(\"image\")) return err(request, {";
const PATCH_1_NEW_SNIPPET = "if (false && modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes(\"image\")) return err(request, { /* [image-relay-patch]: 能力检查已旁路，图片走 GLM 转文字 */";

// ── 补丁 2：durablePromptContent 里图片 → GLM 文字 ──
// 匹配 blocks.push({ type: "image", attachment }); 整段
const PATCH_2_OLD_SNIPPET = `blocks.push({
						type: "image",
						attachment
					});`;
// 用正则容错缩进（含换行）
const PATCH_2_RE = new RegExp(
  "blocks\\.push\\(\\{" + "\\s*" + "type: \"image\"," + "[\\s\\S]*?" + "attachment" + "[\\s\\S]*?" + "\\}\\);",
  "g"
);
const PATCH_2_NEW = `/* [image-relay-patch] 保留 image 块供前端渲染，同时附加 hidden 的 GLM 文字描述供模型理解 */
					blocks.push({
						type: "image",
						attachment
					});
					blocks.push({
						type: "text",
						hidden: true,
						text: await relayImageToText(item.data, item.part.mediaType, item.part.name)
					});`;

// ── 补丁 4：dsh-llm-deepseek 适配器忽略 image 块（不再拒绝）──
// 图片已由 apiproxy 的 relayImageToText 转成 text 块；image 块保留给前端渲染，
// 适配器只需跳过它（flattenText 只取 text，天然忽略 image）。
const DEEPSEEK = join(checkout, "node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js");
const PATCH_4_OLD = `function assertTextOnly(blocks) {
	if (contentHasImage(blocks)) throw new LlmError("The DeepSeek chat-completions adapter does not support image content.", "UNSUPPORTED_CONTENT");
}`;
const PATCH_4_NEW = `/* [image-relay-patch] image 块保留给前端渲染，适配器忽略（GLM 描述已在 text 块中） */
function assertTextOnly(blocks) {
	// image blocks are relayed to text by the host proxy; nothing to reject here
	void blocks;
}`;

// ── 补丁 5：前端 contentParts 过滤 hidden 文本块（描述不显示在气泡里）──
// 描述 text 块带 hidden:true 标记；前端拆分内容时跳过，UI 只显示图片。
// 模型侧 flattenText 只取 .text 字段，不受 hidden 标记影响。
const CLIENT_UI = join(checkout, "node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js");
const PATCH_5_OLD = `for (const block of content) {
				const b = block;
				if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
				else if (b.type === "image" && b.attachment !== void 0) images.push({ attachment: b.attachment });
				else rest.push(block);
			}`;
const PATCH_5_NEW = `for (const block of content) {
				const b = block;
				if (b.type === "text" && typeof b.text === "string") {
					/* [image-relay-patch] hidden 标记的文本块（图片的 GLM 描述）不渲染 */
					if (b.hidden !== true) texts.push(b.text);
				} else if (b.type === "image" && b.attachment !== void 0) images.push({ attachment: b.attachment });
				else rest.push(block);
			}`;

// ── 补丁 3：注入 relayImageToText 辅助函数（放在 durablePromptContent 定义后）──
const PATCH_3_ANCHOR = "/** Search durable content for an image reference, including nested tool results. */";
const PATCH_3_NEW = `/* [image-relay-patch] GLM vision relay helper (cached + parallel + degraded) */
const IMAGE_RELAY_CACHE_DIR = (() => {
	try {
		const { homedir } = require("node:os");
		const { join: j } = require("node:path");
		const dir = j(homedir(), ".dsh", "cache", "image-relay");
		require("node:fs").mkdirSync(dir, { recursive: true });
		return dir;
	} catch {
		return null;
	}
})();
async function relayImageToText(data, mediaType, name) {
	try {
		const apiKey = process.env.ZHIPU_API_KEY;
		if (!apiKey) return "【图片：用户粘贴了一张图片，但未配置 ZHIPU_API_KEY，无法转成文字】";
		const mime = mediaType ?? "image/png";
		const b64 = Buffer.from(data).toString("base64");
		// 缓存：图片字节 hash 作 key，同图秒回（不再重复识别）
		const { createHash } = await import("node:crypto");
		const hash = createHash("sha256").update(b64).digest("hex").slice(0, 24);
		const cacheFile = IMAGE_RELAY_CACHE_DIR === null ? null : (await import("node:path")).join(IMAGE_RELAY_CACHE_DIR, hash + ".txt");
		if (cacheFile !== null) {
			try {
				const { readFileSync } = await import("node:fs");
				const cached = readFileSync(cacheFile, "utf8");
				if (cached.length > 0) return cached;
			} catch { /* cache miss */ }
		}
		// 识别（8 秒超时，避免长时间卡住发送）
		const response = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": \`Bearer \${apiKey}\`
			},
			body: JSON.stringify({
				model: "glm-4v-flash",
				messages: [{
					role: "user",
					content: [
						{ type: "text", text: "这是用户粘贴到聊天里的一张图片，请用简洁的2-3句话客观描述图片内容，帮助只看文字的模型理解它。直接描述内容本身，不要加'这是一张图片'之类的开场白。" },
						{ type: "image_url", image_url: { url: \`data:\${mime};base64,\${b64}\` } }
					]
				}],
				max_tokens: 512
			}),
			signal: AbortSignal.timeout(8000)
		});
		if (!response.ok) {
			return "【图片：用户粘贴了一张图片】";
		}
		const payload = await response.json();
		const content = payload?.choices?.[0]?.message?.content;
		const text = Array.isArray(content)
			? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
			: String(content ?? "");
		const result = text.trim() === "" ? "【图片：用户粘贴了一张图片】" : \`【图片：\${text}】\`;
		// 写缓存
		if (cacheFile !== null) {
			try {
				const { writeFileSync } = await import("node:fs");
				writeFileSync(cacheFile, result, "utf8");
			} catch { /* cache write failure is non-fatal */ }
		}
		return result;
	} catch (error) {
		return "【图片：用户粘贴了一张图片】";
	}
}

${PATCH_3_ANCHOR}`;

// ── 工具 ──
function read(path) {
	return readFileSync(path, "utf8");
}
function write(path, content) {
	writeFileSync(path, content);
}

function applyPatch() {
	if (!existsSync(APIPROXY) || !existsSync(DEEPSEEK)) {
		console.error(`找不到目标文件:\n  ${APIPROXY}\n  ${DEEPSEEK}`);
		console.error("请设置 DSH_CHECKOUT 环境变量指向 dsh 的 npm 缓存安装根");
		process.exit(1);
	}
	let source = read(APIPROXY);
	let dsSource = read(DEEPSEEK);
	let uiSource = read(CLIENT_UI);

	// 幂等检查（三个文件都打了才跳过）
	const apiDone = source.includes(MARK);
	const dsDone = dsSource.includes(MARK);
	const uiDone = uiSource.includes(MARK);
	if (apiDone && dsDone && uiDone) {
		console.log("✅ 补丁已应用，跳过（幂等）");
		return;
	}

	// 备份 apiproxy
	const backup = APIPROXY.replace(/\.js$/, ".orig.js");
	if (!existsSync(backup)) {
		copyFileSync(APIPROXY, backup);
		console.log(`📦 已备份 apiproxy 到: ${backup}`);
	}
	// 备份 deepseek adapter
	const dsBackup = DEEPSEEK.replace(/\.js$/, ".orig.js");
	if (!existsSync(dsBackup)) {
		copyFileSync(DEEPSEEK, dsBackup);
		console.log(`📦 已备份 deepseek adapter 到: ${dsBackup}`);
	}
	// 备份 client-ui
	const uiBackup = CLIENT_UI.replace(/\.js$/, ".orig.js");
	if (!existsSync(uiBackup)) {
		copyFileSync(CLIENT_UI, uiBackup);
		console.log(`📦 已备份 client-ui 到: ${uiBackup}`);
	}

	let changed = false;
	let dsChanged = false;
	let uiChanged = false;

	// ── apiproxy 补丁 ──
	if (!apiDone) {
		// 补丁 1：放开能力检查（把 if 条件改成 if(false && ...)）
		if (source.includes(PATCH_1_OLD_SNIPPET)) {
			source = source.replace(PATCH_1_OLD_SNIPPET, PATCH_1_NEW_SNIPPET);
			changed = true;
			console.log("✅ 补丁 1 应用：放开 MODEL_DOES_NOT_SUPPORT_IMAGES 检查");
		} else {
			console.warn("⚠️ 补丁 1 未匹配（代码结构可能已变化，请检查）");
		}

		// 补丁 2：图片转文字（保留 image 块 + 附加 text 块）
		const m2 = source.match(PATCH_2_RE);
		if (m2 && m2.length >= 1) {
			source = source.replace(PATCH_2_RE, () => PATCH_2_NEW);
			changed = true;
			console.log("✅ 补丁 2 应用：durablePromptContent 保留 image + 附加 GLM 文字");
		} else {
			console.warn("⚠️ 补丁 2 未匹配（代码结构可能已变化，请检查）");
		}

		// 补丁 3：注入 helper
		if (source.includes(PATCH_3_ANCHOR) && !source.includes("async function relayImageToText")) {
			source = source.replace(PATCH_3_ANCHOR, PATCH_3_NEW);
			changed = true;
			console.log("✅ 补丁 3 应用：注入 relayImageToText helper");
		} else if (source.includes("async function relayImageToText")) {
			console.log("ℹ️ relayImageToText 已存在，跳过");
		} else {
			console.warn("⚠️ 补丁 3 未匹配（代码结构可能已变化，请检查）");
		}
	} else {
		console.log("ℹ️ apiproxy 已打补丁，跳过");
	}

	// ── deepseek adapter 补丁 4 ──
	if (!dsDone) {
		if (dsSource.includes(PATCH_4_OLD)) {
			dsSource = dsSource.replace(PATCH_4_OLD, PATCH_4_NEW);
			dsChanged = true;
			console.log("✅ 补丁 4 应用：deepseek 适配器忽略 image 块");
		} else {
			console.warn("⚠️ 补丁 4 未匹配（代码结构可能已变化，请检查）");
		}
	} else {
		console.log("ℹ️ deepseek adapter 已打补丁，跳过");
	}

	// ── client-ui 补丁 5 ──
	if (!uiDone) {
		if (uiSource.includes(PATCH_5_OLD)) {
			uiSource = uiSource.replace(PATCH_5_OLD, PATCH_5_NEW);
			uiChanged = true;
			console.log("✅ 补丁 5 应用：前端 contentParts 过滤 hidden 描述块");
		} else {
			console.warn("⚠️ 补丁 5 未匹配（代码结构可能已变化，请检查）");
		}
	} else {
		console.log("ℹ️ client-ui 已打补丁，跳过");
	}

	if (changed) {
		write(APIPROXY, source);
		console.log("💾 已写入补丁后的 apiproxy");
	}
	if (dsChanged) {
		write(DEEPSEEK, dsSource);
		console.log("💾 已写入补丁后的 deepseek adapter");
	}
	if (uiChanged) {
		write(CLIENT_UI, uiSource);
		console.log("💾 已写入补丁后的 client-ui");
	}
	if (!changed && !dsChanged && !uiChanged) {
		console.log("ℹ️ 无变更写入（所有补丁都未匹配？请人工检查）");
	}
}

function checkStatus() {
	const targets = [
		["apiproxy", APIPROXY],
		["deepseek adapter", DEEPSEEK],
		["client-ui", CLIENT_UI],
	];
	for (const [label, path] of targets) {
		if (!existsSync(path)) {
			console.log(`❌ ${label} 文件不存在: ${path}`);
			continue;
		}
		const source = read(path);
		const applied = source.includes(MARK);
		const backupExists = existsSync(path.replace(/\.js$/, ".orig.js"));
		console.log(`${applied ? "✅" : "❌"} ${label} 补丁${applied ? "已应用" : "未应用"}`);
		if (backupExists) console.log(`   📦 有原始备份`);
	}
}

function revertPatch() {
	const targets = [
		["apiproxy", APIPROXY],
		["deepseek adapter", DEEPSEEK],
		["client-ui", CLIENT_UI],
	];
	for (const [label, path] of targets) {
		if (!existsSync(path)) {
			console.error(`找不到 ${label} 文件`);
			continue;
		}
		const backup = path.replace(/\.js$/, ".orig.js");
		if (!existsSync(backup)) {
			console.log(`ℹ️ ${label} 无备份文件，无需回滚`);
			continue;
		}
		write(path, read(backup));
		console.log(`✅ ${label} 已从备份恢复原文件`);
	}
}

// ── 主流程 ──
const flag = process.argv[2];
if (flag === "--check") checkStatus();
else if (flag === "--revert") revertPatch();
else applyPatch();
