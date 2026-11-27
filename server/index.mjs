import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BridgeError } from './dom_helpers.mjs';
import { QwenBrowser, toolError } from './qwen_browser.mjs';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
const supplied = values['data-dir'];
if (supplied !== undefined && (!supplied.trim() || supplied.startsWith('${'))) {
  process.stderr.write('千问助手：Antigravity 未提供有效的插件数据目录。\n');
  process.exit(1);
}
const dataDir = supplied ?? join(process.env.LOCALAPPDATA || homedir(), 'QwenBridge', 'data');
const browser = new QwenBrowser(dataDir);
const server = new McpServer({ name: 'qwen-cn-bridge', version: '1.0.0' }, {
  capabilities: { resources: {}, tools: {} },
});
const uri = 'ui://qwen-cn-bridge/panel.html';
const mimeType = 'text/html;profile=mcp-app';
const htmlFile = new URL('../ui/dist/app.html', import.meta.url);
const transport = new StdioServerTransport();

server.registerResource('千问助手', uri, { mimeType }, async () => ({
  contents: [{ uri, mimeType, text: await readFile(htmlFile, 'utf8') }],
}));

const askInput = {
  query: z.string().trim().min(1).max(12000).describe('精简的中文检索问题'),
  new_chat: z.boolean().default(true).describe('开启新对话'),
  json_mode: z.boolean().default(false).describe('验证输出为 JSON 对象或数组'),
  wrap_cn_context: z.boolean().default(true).describe('添加中国大陆本地视角的前缀'),
  timeout_ms: z.number().int().min(10000).max(180000).default(60000),
};
const entrypoints = [
  { type: 'aux_pane', title: '千问助手' },
  { type: 'global', title: '千问助手' },
];

function renderResult(data, summary) {
  return {
    content: [{ type: 'text', text: summary ?? JSON.stringify(data) }],
    structuredContent: data,
    ...(data.ok === false ? { isError: true } : {}),
  };
}

function register(name, description, inputSchema, run, metadata = {}) {
  const { appOnly = false, summary, ...meta } = metadata;
  server.registerTool(name, { description, inputSchema, _meta: appOnly ? { ui: { visibility: ['app'] } } : meta },
    async (args, extra) => {
      try {
        if (appOnly && !server.server.getClientCapabilities()?.extensions?.['io.modelcontextprotocol/ui']) {
          throw new BridgeError('PANEL_REQUIRED', '请在 Antigravity 客户端的千问助手面板中执行此操作。');
        }
        const data = await run(args, extra.signal);
        return renderResult(data, summary?.(data));
      } catch (error) {
        return renderResult(toolError(error));
      }
    });
}

register('open_qwen_panel', '打开千问助手面板，查看登录与后台状态。', {},
  () => browser.getStatus(false), {
    ui: { resourceUri: uri },
    'com.google.antigravity/ui': { entrypoints },
    summary: (data) => data.login_in_progress ? '千问登录或验证正在进行。'
      : data.logged_in === true ? '千问登录状态已确认。' : '打开千问助手面板以登录或检查状态。',
  });

register('ask_qwen', '使用免费的 Qwen-快速检索中国大陆近期信息、国内平台规则和中文互联网语境。仅发送公开、合规的检索问题。',
  askInput, (args, signal) => browser.ask(args, signal));

const appOnly = { appOnly: true };
register('qwen_get_status', '查看千问状态，可选启动浏览器探活。', { probe: z.boolean().default(false) },
  ({ probe }, signal) => browser.getStatus(probe, signal), appOnly);
register('qwen_start_login', '打开可见 Chrome 窗口，用户可手动登录或验证。', {},
  () => browser.startLogin(), appOnly);
register('qwen_test_ask', '在千问助手面板中测试检索。', askInput,
  (args, signal) => browser.ask(args, signal), appOnly);
register('qwen_stop_background', '释放插件启动的后台 Chrome。', {},
  () => browser.stop(), appOnly);
register('qwen_clear_session', '删除本插件保存的 Chrome 登录资料。', { confirm: z.literal(true) },
  () => browser.clearSession(), appOnly);
register('qwen_set_background_mode', '保存千问后台窗口运行方式。', { mode: z.enum(['headless', 'minimized']) },
  ({ mode }) => browser.setBackgroundMode(mode), appOnly);

let shutdown;
function stopServer() {
  shutdown ??= browser.shutdown()
    .then(() => server.close())
    .catch((error) => {
      process.stderr.write('千问助手退出时出错：' + error.name + '\n');
      process.exitCode = 1;
    });
  return shutdown;
}
server.server.onclose = () => { void stopServer(); };
process.once('SIGINT', () => { void stopServer(); });
process.once('SIGTERM', () => { void stopServer(); });
process.stdin.once('end', () => { void stopServer(); });

await server.connect(transport);

