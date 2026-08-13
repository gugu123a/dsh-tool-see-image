# dsh-tool-see-image

> [English](README.md) | 中文

让**没有视觉能力的文本模型**（如 deepseek-v4-flash）也能"看图"：把图片文件通过
`see_image` 工具发给一个可配置的**视觉模型**（默认智谱 GLM-4V-Flash，免费），
视觉模型看完后用文字转述回来，文本模型再把它原样汇报给你。

## 工作原理

```
你: "看看这张图"  ──►  文本模型 (无视觉)
                          │ 调用 see_image(path, question)
                          ▼
                     本插件 (Host 平面)
                          │ 1. ctx.fs 解析并读取图片（遵守沙箱/观察策略）
                          │ 2. 图片转 base64 data URL
                          │ 3. POST {baseURL}/chat/completions（OpenAI 兼容）
                          ▼
                     视觉模型 (GLM-4V-Flash)
                          │ 文字描述
                          ▼
                     文本模型 ──► 汇报给你
```

## 安装（DSH web profile）

1. **拷贝插件**：把本仓库放进你的 profile 目录，例如
   `$DSH_HOME/profiles/web/plugins/dsh-tool-see-image/`
   （在 DSH 中，`$DSH_HOME` 通常是 `~/.dsh`）

2. **声明依赖**：在 `$DSH_HOME/profiles/web/package.json` 的 `dependencies` 中加入：
   ```json
   "@deepseek-ai/dsh-tool-see-image": "file:plugins/dsh-tool-see-image"
   ```
   然后 `pnpm install`（会在 `profiles/node_modules` 下生成指向源码的 junction 链接）。

3. **组合进配置**：在 `$DSH_HOME/profiles/web/cordis.patch.yml` 中加入：
   ```yaml
   - insert:
       - id: tool-see-image
         name: '@deepseek-ai/dsh-tool-see-image'
         config:
           baseURL: https://open.bigmodel.cn/api/paas/v4
           apiKeyEnv: ZHIPU_API_KEY
           model: glm-4v-flash
   ```

4. **设置 API Key**：去 [bigmodel.cn](https://bigmodel.cn) 控制台 → API Keys
   创建一个 Key（形如 `id.secret`），然后设置环境变量（Windows 示例）：
   ```powershell
   setx ZHIPU_API_KEY "你的key"
   ```
   **重开终端**，然后**重启 dsh web**（web profile 的补丁热重载官方尚未启用，
   改 patch 后仅靠 watcher 不会生效——已实测）。

5. **验证**：新会话里工具列表应出现 `see_image`。让它"看"一张图试试：
   ```
   请用 see_image 看一下 path/to/your/image.png
   ```

## 配置项（cordis.patch.yml 的 tool-see-image 行）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `baseURL` | `https://open.bigmodel.cn/api/paas/v4` | OpenAI 兼容端点，插件自动拼 `/chat/completions` |
| `apiKeyEnv` | `ZHIPU_API_KEY` | 读取 API Key 的环境变量名 |
| `model` | `glm-4v-flash` | 视觉模型 id（智谱免费） |
| `maxTokens` | `1024` | 输出上限。**注意：glm-4v-flash 上限为 1024**（实测超限会返回 400 `max_tokens参数非法`）；换更大模型可调大 |
| `timeoutMs` | `60000` | 请求超时 |
| `maxBytes` | `15728640` (15MB) | 单张图片大小上限 |
| `prompt` | （中文详细描述指令） | 缺省问题；`question` 参数优先 |

换其他视觉 API 只需改这三项，例如 SiliconFlow：

```yaml
config:
  baseURL: https://api.siliconflow.cn/v1
  apiKeyEnv: SILICONFLOW_API_KEY
  model: Qwen/Qwen2.5-VL-32B-Instruct
```

## 卸载 / 回滚

1. 删掉 `cordis.patch.yml` 里的 `- insert: ... tool-see-image ...` 段；
2. 删掉 junction：`Remove-Item profiles\node_modules\@deepseek-ai\dsh-tool-see-image`；
3. 删掉 `profiles/web/package.json` dependencies 里那一行；
4. 重启 `dsh web`。

## 实现要点（供学习插件开发）

- 导出 `{ name, inject, Config, apply }`，与所有 DSH 工具插件同构；
- `inject: ["tools", "fs"]`：工具注册表 + 沙箱化文件服务都是 Host 全局服务；
- 注册进全局层 → 所有会话可见（与 TUI 模式 host 工具行同理）；
- 读文件走 `ctx.fs`（自动应用沙箱/观察策略），不用裸 `node:fs`；
- 参数 schema 用 DSH 专用格式：`required: true` 显式必填，可选参数**省略 required 键**
  （`required: false` 会被 defineTool 拒绝）；
- 网络请求带超时与 `exec.signal` 取消；错误信息面向模型可读。

## 回归测试

`test/mount-test.mjs`：用真实 Cordis Loader 挂载本插件行（timer + system-prompt +
tools + 本插件），验证行激活且 `see_image` 进入工具注册表。运行：

```powershell
set DSH_CHECKOUT=<你的 dsh 安装根目录，含 node_modules/@deepseek-ai>
node test/mount-test.mjs
```

期望输出：`tools.schemas() 含 see_image: true` 与 `=== MOUNT TEST PASS ===`。
脚本会自动把插件临时链接进 checkout 的 node_modules（Windows junction / 其它平台
symlink），测试结束自动清理，无本机路径硬编码。

## 实测记录

- 2026-08-13：真实 Key + `triz-workflow.png`（DSH Web GUI 截图）→ HTTP 200，约 6.8s，
  准确识别界面文字（搜索框/MCP 设置/Fetch/Filesystem/Sequential-Thinking）。
- 踩坑：glm-4v-flash 的 `max_tokens` 上限 1024（默认 2048 会 400，已修正默认值）。

## License

MIT
