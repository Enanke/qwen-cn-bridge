import { setTimeout as delay } from 'node:timers/promises';

export const HOME_URL = 'https://www.qianwen.com/';
export const MODE = 'Qwen-快速';
const EDITOR = '[contenteditable="true"][role="textbox"][data-slate-editor="true"]:visible:not(.chat-round *,[role="dialog"] *,dialog *,[inert] *,[aria-hidden="true"] *)';
const PREFIX = '请直接以中国大陆本地视角客观、准确地回答以下问题。不要提及或猜测用户所在地，不要寒暄，不要在结尾追问。如涉及近期动态、热点或平台具体规则，请联网搜索最新信息。';
const JSON_PROMPT = '只输出一个合法 JSON 对象或数组，不要使用 Markdown 代码围栏，不要附加解释。';

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const timeoutError = () => new BridgeError('TIMEOUT', '等待千问超时。请先确认问题是否已发送，再决定是否重试。');
export const modeError = () => new BridgeError('MODE_CHECK_FAILED', '无法确认当前为 Qwen-快速。请打开登录窗口并手动选择「快速」。');
export const loginError = () => new BridgeError('NOT_LOGGED_IN', '无法确认千问登录状态。请点击千问助手面板里的「登录 / 切换千问账号」。');

export function isQwen(url) {
  try {
    return new URL(url).origin === 'https://www.qianwen.com';
  } catch {
    return false;
  }
}

export function inspectPage() {
  const visible = (node) => node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility === 'visible' && !node.closest('[aria-hidden="true"]');
  const visibleNodes = (selector) => [...document.querySelectorAll(selector)].filter(visible);
  const text = (node) => (node.innerText ?? node.textContent).trim().replace(/\s+/g, ' ');
  const status = visibleNodes('[role="dialog"],dialog,[aria-modal="true"],[role="alert"],h1,h2')
    .filter((node) => !node.closest('.chat-round')).map(text).join('\n');
  const blocked = /验证码|安全验证|人机验证|访问受限|请求过于频繁|操作过于频繁|访问异常/.test(status) ||
    visibleNodes('iframe[title*="验证码"],iframe[title*="captcha" i]').length > 0;
  const loggedOut = /手机号登录|扫码登录|二维码登录|登录千问|登录后/.test(status) ||
    visibleNodes('input[type="tel"],input[placeholder*="手机号"]').length > 0 ||
    visibleNodes('button,[role="button"]').some((node) => !node.closest('.chat-round') &&
      /^(?:登录|登录\/注册|立即登录)$/.test(text(node)));
  const controls = visibleNodes('button,[role="button"],[role="tab"],[aria-haspopup],[aria-selected="true"],[aria-pressed="true"]');
  const modes = controls.filter((node) => {
    if (node.closest('.chat-round,[role="menu"],[role="listbox"],[role="dialog"],dialog,[inert]')) return false;
    if (node.matches(':disabled,[aria-disabled="true"],[aria-selected="false"],[aria-pressed="false"],[aria-expanded="true"]')) return false;
    return /^(?:Qwen[-－ ]?快速|快速|思考研究|千问\s*Go[!！]?)$/i.test(text(node));
  });
  const selected = modes.filter((node) => node.matches('[aria-selected="true"],[aria-pressed="true"],[aria-haspopup][aria-expanded="false"]'));
  const currentModes = selected.length ? selected : modes;
  const fast = currentModes.length > 0 && currentModes.every((node) => /^(?:Qwen[-－ ]?)?快速$/i.test(text(node)));
  const editable = visibleNodes('[contenteditable="true"][role="textbox"][data-slate-editor="true"]').filter((node) =>
    !node.closest('.chat-round,[role="dialog"],dialog,[inert]'));
  return { blocked, loggedOut, fast, composerCount: editable.length };
}

export function checkAccess(page, state) {
  if (state.blocked) {
    throw new BridgeError('CAPTCHA_OR_BLOCKED', '千问要求安全验证或限制了访问。请点击千问助手面板里的登录按钮，在打开的窗口中手动验证。');
  }
  if (!isQwen(page.url()) || state.loggedOut) {
    throw new BridgeError('NOT_LOGGED_IN', '请点击千问助手面板里的「登录 / 切换千问账号」。');
  }
}

function jsonAnswer(answer) {
  const trimmed = answer.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced?.[1] ?? trimmed;
  const candidates = [body];
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const first = body.indexOf(open);
    const last = body.lastIndexOf(close);
    if (first >= 0 && last > first) candidates.push(body.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object') return JSON.stringify(parsed);
    } catch {
      // 继续尝试去掉围栏或说明文字后的候选内容。
    }
  }
  throw new BridgeError('DOM_PARSE_ERROR', '千问的回答无法解析为 JSON 对象或数组。');
}

// Slate 占位符和零宽占位文本都不属于编辑器的实际内容。
function readSlate(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const parts = [];
  let previousBlock;
  while (walker.nextNode()) {
    const { currentNode } = walker;
    if (currentNode.parentElement.closest('[data-slate-placeholder],[data-slate-zero-width]')) continue;
    const block = currentNode.parentElement.closest('[data-slate-node="element"]');
    if (parts.length && previousBlock && block && previousBlock !== block) parts.push(' ');
    parts.push(currentNode.nodeValue);
    previousBlock = block;
  }
  return parts.join('').replace(/[\uFEFF\u200B]/gu, '').trim();
}

function captureReplies(page) {
  return page.evaluateHandle(() => {
    const nodes = [...document.querySelectorAll('.qk-markdown')];
    return {
      entries: new Map(nodes.map((node) => [node, node.innerText])),
      oldTexts: new Set(nodes.map((node) => node.innerText)),
      last: nodes.at(-1),
      lastText: nodes.at(-1)?.innerText,
      candidate: null,
      signature: '',
      since: 0,
    };
  });
}

function readReply(snapshot) {
  return snapshot.evaluate((saved) => {
    const target = [...document.querySelectorAll('.qk-markdown')].at(-1);
    const raw = target?.innerText ?? '';
    const isNew = target && (saved.entries.has(target)
      ? target === saved.last && raw !== saved.lastText
      : !saved.oldTexts.has(raw) || target === saved.candidate);
    if (!isNew) {
      saved.candidate = null;
      saved.since = 0;
      return null;
    }
    const complete = target.classList.contains('qk-markdown-complete');
    if (target !== saved.candidate || raw !== saved.signature || !complete) {
      saved.candidate = target;
      saved.signature = raw;
      saved.since = complete ? performance.now() : 0;
      return null;
    }
    if (!saved.since) saved.since = performance.now();
    if (performance.now() - saved.since < 1000) return null;

    const parts = [];
    for (const child of target.childNodes) {
      if (child.nodeName === 'HR') break;
      parts.push({
        value: child.innerText ?? child.textContent ?? '',
        block: child.nodeType === 1 && /^(block|list-item|flex|grid|table|flow-root)/.test(getComputedStyle(child).display),
        lineBreak: child.nodeName === 'BR',
      });
    }
    const answer = parts.map(({ value, block, lineBreak }, i) =>
      (i > 0 && (block || parts[i - 1].block) ? '\n' : '') + (lineBreak ? '\n' : value)
    ).join('').trim();
    const round = target.closest('.chat-round');
    const sources = Number(round?.innerText.match(/(\d+)\s*篇来源/u)?.[1] ?? 0);
    return { answer, raw, sources };
  });
}

export async function waitForComposer(page, remaining) {
  const readyBy = Date.now() + Math.min(12000, remaining());
  while (true) {
    const state = await page.evaluate(inspectPage);
    checkAccess(page, state);
    if (state.composerCount === 1 && state.fast) return;
    if (Date.now() >= readyBy) {
      if (!state.composerCount) throw loginError();
      if (!state.fast) throw modeError();
      throw new BridgeError('DOM_PARSE_ERROR', '页面存在多个可用输入框，无法确认发送位置。');
    }
    await delay(Math.min(200, remaining()));
  }
}

export async function submitQuestion(page, options, remaining) {
  const { query, new_chat, json_mode, wrap_cn_context } = options;
  const prompt = [wrap_cn_context && PREFIX, query, json_mode && JSON_PROMPT].filter(Boolean).join('\n\n');
  const editor = page.locator(EDITOR);
  const snapshot = await captureReplies(page);
  try {
    const previous = await snapshot.evaluate((saved) => ({
      hasReply: Boolean(saved.last),
      streaming: Boolean(saved.last && !saved.last.classList.contains('qk-markdown-complete')),
    }));
    if ((new_chat && previous.hasReply) || previous.streaming) {
      throw new BridgeError('DOM_PARSE_ERROR', '页面尚未进入空白新对话，或上一条回复仍在生成。');
    }
    if (await editor.evaluate(readSlate, undefined, { timeout: remaining() })) {
      throw new BridgeError('DOM_PARSE_ERROR', '输入框已有草稿。请在千问窗口中查看或清空草稿。');
    }
    await editor.focus({ timeout: remaining() });
    await page.keyboard.insertText(prompt);
    const input = await editor.evaluate(readSlate, undefined, { timeout: remaining() });
    const normalize = (value) => value.replace(/[\uFEFF\u200B]/gu, '').replace(/\s+/gu, ' ').trim();
    if (normalize(input) !== normalize(prompt)) {
      throw new BridgeError('DOM_PARSE_ERROR', '未能完整写入千问输入框，问题未提交。');
    }
    const state = await page.evaluate(inspectPage);
    checkAccess(page, state);
    if (!state.fast) throw modeError();
    if (state.composerCount !== 1) throw new BridgeError('DOM_PARSE_ERROR', '发送前无法确认千问输入框。');
    await editor.press('Enter', { timeout: remaining() });

    while (true) {
      remaining();
      checkAccess(page, await page.evaluate(inspectPage));
      const reply = await readReply(snapshot);
      if (reply) {
        if (!reply.answer) throw new BridgeError('DOM_PARSE_ERROR', '回复已结束，但没有找到有效正文。');
        return {
          answer: json_mode ? jsonAnswer(reply.answer) : reply.answer,
          used_web_search: reply.sources > 0,
          sources_count: reply.sources,
        };
      }
      await delay(Math.min(200, remaining()));
    }
  } finally {
    await snapshot.dispose().catch(() => {});
  }
}

