# dsh-tool-see-image

[![npm version](https://img.shields.io/npm/v/dsh-tool-see-image)](https://www.npmjs.com/package/dsh-tool-see-image)
[![npm downloads](https://img.shields.io/npm/dm/dsh-tool-see-image)](https://www.npmjs.com/package/dsh-tool-see-image)
[![npm license](https://img.shields.io/npm/l/dsh-tool-see-image)](https://www.npmjs.com/package/dsh-tool-see-image)
[![CI](https://github.com/gugu123a/dsh-tool-see-image/actions/workflows/test.yml/badge.svg)](https://github.com/gugu123a/dsh-tool-see-image/actions/workflows/test.yml)

Glad to make a plugin for #deepseekharness （or #dsh）.

Give a **text-only model** (e.g. `deepseek-v4-flash`) the ability to **"see" images**:
the `see_image` tool sends an image file to a configurable **vision model**
(default: Zhipu GLM-4V-Flash, free), which describes it in text; the text-only
model relays that description back to you.

## How it works

```
You: "Look at this image" ──►  Text-only model (no vision)
                                  │ calls see_image(path, question)
                                  ▼
                             This plugin (Host plane)
                                  │ 1. ctx.fs resolves & reads the image (sandbox/observation policy aware)
                                  │ 2. encodes it as a base64 data URL
                                  │ 3. POST {baseURL}/chat/completions (OpenAI-compatible)
                                  ▼
                             Vision model (GLM-4V-Flash)
                                  │ text description
                                  ▼
                             Text-only model ──► reports to you
```

## Install (DSH web profile)

1. **Copy the plugin** into your profile directory, e.g.
   `$DSH_HOME/profiles/web/plugins/dsh-tool-see-image/`
   (`$DSH_HOME` is usually `~/.dsh`).

2. **Declare the dependency** in `$DSH_HOME/profiles/web/package.json`:
   ```json
   "@deepseek-ai/dsh-tool-see-image": "file:plugins/dsh-tool-see-image"
   ```
   Then run `pnpm install` (creates a junction to the source under
   `profiles/node_modules`).

3. **Compose it into the profile** in `$DSH_HOME/profiles/web/cordis.patch.yml`:
   ```yaml
   - insert:
       - id: tool-see-image
         name: '@deepseek-ai/dsh-tool-see-image'
         config:
           baseURL: https://open.bigmodel.cn/api/paas/v4
           apiKeyEnv: ZHIPU_API_KEY
           model: glm-4v-flash
   ```

4. **Set your API key**: create one at the [Zhipu (bigmodel) console](https://bigmodel.cn)
   (format `id.secret`), then set the environment variable (Windows example):
   ```powershell
   setx ZHIPU_API_KEY "your-key"
   ```
   **Restart your terminal**, then **restart `dsh web`** (the web profile does not
   hot-reload patch layers yet — tested).

5. **Verify**: in a new session the `see_image` tool should appear. Try it:
   ```
   Use see_image to look at path/to/your/image.png
   ```

## Configuration (tool-see-image line in cordis.patch.yml)

| Key | Default | Description |
| --- | --- | --- |
| `baseURL` | `https://open.bigmodel.cn/api/paas/v4` | OpenAI-compatible endpoint; the plugin appends `/chat/completions` |
| `apiKeyEnv` | `ZHIPU_API_KEY` | Env var name that holds the API key |
| `model` | `glm-4v-flash` | Vision model id (free on Zhipu) |
| `maxTokens` | `1024` | Max output tokens. **Note: glm-4v-flash caps at 1024** (higher returns 400 `max_tokens参数非法`; raise it if you switch to a bigger model) |
| `timeoutMs` | `60000` | Request timeout |
| `maxBytes` | `15728640` (15MB) | Per-image size limit |
| `prompt` | (Chinese detailed-description instruction) | Default question; the `question` argument takes precedence |

To use a different vision API, change these three keys, e.g. SiliconFlow:

```yaml
config:
  baseURL: https://api.siliconflow.cn/v1
  apiKeyEnv: SILICONFLOW_API_KEY
  model: Qwen/Qwen2.5-VL-32B-Instruct
```

## Uninstall / rollback

1. Remove the `- insert: ... tool-see-image ...` block from `cordis.patch.yml`;
2. Remove the junction: `Remove-Item profiles\node_modules\@deepseek-ai\dsh-tool-see-image`;
3. Remove that line from `profiles/web/package.json` dependencies;
4. Restart `dsh web`.

## Implementation notes (for plugin developers)

- Exports `{ name, inject, Config, apply }`, same shape as every DSH tool plugin;
- `inject: ["tools", "fs"]` — the tool registry and the sandboxed file service
  are both Host-global services;
- Registered at the global layer, so every session sees it (same as TUI-mode
  host tool rows);
- Reads files through `ctx.fs` (sandbox/observation policy applied), never raw
  `node:fs`;
- Parameter schema uses the DSH-specific format: `required: true` for required,
  **omit the `required` key** for optional (`required: false` is rejected by
  `defineTool`);
- Network request carries a timeout and `exec.signal` cancellation; errors are
  model-readable.

## Regression test

`test/mount-test.mjs` mounts this plugin line under a real Cordis Loader
(timer + system-prompt + tools + this plugin) and asserts that `see_image`
lands in the tool registry. Run:

```powershell
set DSH_CHECKOUT=<your dsh install root, containing node_modules/@deepseek-ai>
node test/mount-test.mjs
```

Expected output: `tools.schemas() 含 see_image: true` and `=== MOUNT TEST PASS ===`.
The script temporarily links the plugin into the checkout's node_modules
(Windows junction / other-platform symlink) and cleans up afterwards — no
hardcoded local paths.

## Field notes

- 2026-08-13: real key + `triz-workflow.png` (a DSH Web GUI screenshot) →
  HTTP 200 in ~6.8s, correctly read the UI text (search box / MCP settings /
  Fetch / Filesystem / Sequential-Thinking).
- Pitfall: glm-4v-flash's `max_tokens` cap is 1024 (the default of 2048 caused
  a 400; the default has been fixed).

## License

MIT
