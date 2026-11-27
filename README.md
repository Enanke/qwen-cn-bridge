# 千问助手

Antigravity App 2.34.0+ 的本地插件。需要 Windows、Node.js 18+ 和已安装的 Google Chrome。可从左侧栏「插件」或对话右侧 `+` 打开「千问助手」，点「登录 / 切换千问账号」，在打开的 Chrome 窗口完成登录、验证并确认「快速」。窗口自动关闭后可使用面板里的「快捷测试」，也可在对话里请模型用千问检索。

## 构建与部署

```powershell
npm.cmd ci
npm.cmd run build
agy plugin validate . --strict
```

部署时将插件连同生产依赖 `node_modules` 放在 `~/.gemini/config/plugins/qwen-cn-bridge/`（Windows 下即 `%USERPROFILE%\.gemini\config\plugins\qwen-cn-bridge\`）。已启动的 Antigravity 可重新打开以重新发现本地插件。打包结果为 `ui/dist/app.html`，包含全部脚本和样式。Antigravity App 渲染面板，CLI 和 IDE 支持纯文本检索工具。 [Antigravity MCP Apps 官方文档](https://antigravity.google/docs/mcp-apps)

如果仍安装了旧版独立技能 `~/.gemini/config/skills/qwen-cn-bridge/`，可移除或移出技能目录，避免同名入口冲突。

## 浏览器和本地数据

- 登录资料保存在 `${PLUGIN_DATA}/chrome-profile`。Chrome 正常关闭时保存资料，后续可跨重启复用，具体有效期由千问决定。插件使用独立 Chrome 资料目录。
- 默认在无头 Chrome 后台运行，空闲 5 分钟后释放进程。可通过 `QWEN_IDLE_MS` 调整。选用「最小化窗口兜底」时可能短暂显示 Chrome 窗口，且 Windows 可能保留对应任务栏项。
- 运行方式保存在 `${PLUGIN_DATA}/settings.json`。「退出登录」在确认后清除插件自己的 Chrome 资料。切换已经确认的账号时，面板会先请求确认清除旧资料。
- 「检查状态」会按需打开后台 Chrome 探活。遇到风控，请通过登录窗口手动验证。模式无法确认时，在可见 Chrome 窗口手动选择「快速」。
- `ask_qwen` 默认开启新对话。 `new_chat: false` 续接同一 MCP 进程最近一次成功返回的千问对话，后台休眠后仍可续接。重启 MCP 服务后先建立新对话。

## 验收

1. 分别从左侧栏和右侧 `+` 打开面板。确认能看到状态和操作按钮。
2. 完成一次登录。确认 Chrome 窗口自动关闭，面板显示已登录。重启 Antigravity 后点击「检查状态」，确认登录仍然有效。
3. 输入「请检索 12306 官方的铁路电子发票开具流程，列出来源」做快捷测试，再在对话里让模型调用 `ask_qwen`。确认模式为 `Qwen-快速`，面板显示回答、耗时和网页报告的来源统计。

## 免责声明与合规说明

- **非官方项目**：本项目为个人开源的社区工具，与阿里巴巴/通义千问（Qwen）以及 Google/Antigravity 均无任何官方关联或背书。
- **仅供学习与本地研究**：本项目仅操作用户本人在本机合法登录的浏览器会话，不提供任何绕过登录、破解验证码、规避风控或逆向私有 API 的功能。
- **合规与风险自担**：使用者须自行遵守目标网站的服务条款（ToS）以及所在国家和地区的法律法规，切勿向第三方平台发送政治敏感、违规违法内容或个人隐私凭证。因使用本项目引发的任何账号限制、数据损失或法律责任，均由使用者自行承担。



