import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: '千问助手', version: '1.0.0' });
const el = (id) => document.getElementById(id);
let state = {};
let connected = false;
let busy = false;
let pollTimer;
let probing = false;

function feedback(text, isError = false) {
  el('feedback').textContent = text;
  el('feedback').dataset.state = isError ? 'error' : '';
}

function updateControls() {
  for (const id of ['login', 'probe', 'stop', 'clear', 'background-mode', 'test-send']) {
    el(id).disabled = !connected || busy || Boolean(state.login_in_progress);
  }
  if (!state.profile_exists) el('clear').disabled = true;
  if (!state.background_running) el('stop').disabled = true;
}

function render(data) {
  if (!data || data.ok !== true) return;
  state = data;
  const blocked = state.last_error?.error === 'CAPTCHA_OR_BLOCKED';
  const login = el('login-status');
  login.textContent = state.login_in_progress ? '正在登录' : blocked ? '需验证'
    : state.logged_in === true ? '已登录' : state.logged_in === false ? '未登录' : '待检查';
  login.dataset.state = blocked ? 'error' : state.logged_in === true ? 'ready' : '';
  el('mode-status').textContent = state.mode_verified ? 'Qwen-快速 · 免费 · 已确认' : 'Qwen-快速 · 免费 · 待确认';
  el('process-status').textContent = state.login_in_progress ? '登录窗口'
    : state.background_running ? (state.headless_running ? '无头运行中' : '最小化运行中') : '休眠中';
  el('background-mode').value = state.background_mode;
  updateControls();
}

async function call(name, args = {}, timeout = 30000) {
  const result = await app.callServerTool({ name, arguments: args }, { timeout });
  const data = result.structuredContent;
  if (result.isError || !data?.ok) {
    throw new Error(data?.message ?? result.content?.find((item) => item.type === 'text')?.text ?? '千问服务未返回有效结果。');
  }
  return data;
}

function statusMessage(data) {
  if (data.last_error) return feedback(data.last_error.message, true);
  if (data.logged_in === false) return feedback('登录后即可在后台检索。');
  if (data.logged_in === true) return feedback('千问登录状态已确认。');
  feedback('点击「检查状态」确认现有登录资料。');
}

async function refresh(probe = false) {
  const data = await call('qwen_get_status', { probe });
  render(data);
  return data;
}

function trackLogin() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      const data = await refresh();
      if (data.login_in_progress) return trackLogin();
      if (data.logged_in === true && !data.last_error) {
        feedback('登录成功。登录资料已保存，下一次提问将在后台运行。');
      } else {
        statusMessage(data);
      }
    } catch (error) {
      feedback(error.message, true);
      // 保留进度跟踪，允许宿主暂时重连。
      if (state.login_in_progress) trackLogin();
    }
  }, 1000);
}

async function operation(work) {
  if (busy || !connected || state.login_in_progress) return;
  busy = true;
  updateControls();
  try {
    await work();
  } catch (error) {
    feedback(error.message, true);
  } finally {
    busy = false;
    updateControls();
  }
}

function confirmAction(title, action) {
  const dialog = el('confirm');
  el('confirm-title').textContent = title;
  el('confirm-copy').textContent = '此操作会删除千问助手保存的本地登录资料。';
  el('confirm-action').textContent = action;
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

el('login').addEventListener('click', () => operation(async () => {
  if (state.logged_in === true && state.last_error?.error !== 'MODE_CHECK_FAILED') {
    if (!await confirmAction('切换千问账号？', '清除资料并登录')) return;
    render(await call('qwen_clear_session', { confirm: true }));
  }
  render(await call('qwen_start_login'));
  feedback('正在打开 Chrome。请在窗口内登录或完成验证，并选择「快速」。完成后窗口会自动关闭。');
  trackLogin();
}));

el('probe').addEventListener('click', () => operation(async () => {
  feedback('正在检查千问连接与登录状态…');
  statusMessage(await refresh(true));
}));
el('stop').addEventListener('click', () => operation(async () => {
  render(await call('qwen_stop_background'));
  feedback('后台进程已释放。');
}));
el('clear').addEventListener('click', () => operation(async () => {
  if (!await confirmAction('退出千问登录？', '退出登录')) return;
  render(await call('qwen_clear_session', { confirm: true }));
  feedback('插件的本地登录资料已清除。');
}));
el('background-mode').addEventListener('change', (event) => {
  const mode = event.currentTarget.value;
  void operation(async () => {
    try {
      render(await call('qwen_set_background_mode', { mode }));
      feedback('后台运行方式已保存。');
    } catch (error) {
      el('background-mode').value = state.background_mode;
      throw error;
    }
  });
});
el('test-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void operation(async () => {
    const query = el('query').value.trim();
    if (!query) return feedback('请输入检索问题。', true);
    feedback('正在等待千问回答…');
    el('test-result').hidden = true;
    try {
      const result = await call('qwen_test_ask', { query, timeout_ms: 60000 }, 70000);
      el('test-answer').textContent = result.answer;
      el('test-meta').textContent = [
        (result.elapsed_ms / 1000).toFixed(1) + ' 秒',
        result.used_web_search ? '已联网 · ' + result.sources_count + ' 篇来源' : '页面未报告联网来源',
      ].join('  /  ');
      el('test-result').hidden = false;
      await refresh();
      feedback('测试完成。');
    } catch (error) {
      await refresh().catch(() => {});
      throw error;
    }
  });
});

function applyTheme(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

app.ontoolinput = () => {};
app.ontoolresult = ({ structuredContent }) => {
  if (!structuredContent || busy) return;
  render(structuredContent);
  if (structuredContent.login_in_progress) trackLogin();
  else if (!probing) statusMessage(structuredContent);
};
app.onhostcontextchanged = applyTheme;
app.onteardown = async () => {
  clearTimeout(pollTimer);
  return {};
};

try {
  await app.connect();
  applyTheme(app.getHostContext());
  connected = true;
  busy = true;
  try {
    const data = await refresh();
    if (data.login_in_progress) {
      feedback('请在 Chrome 窗口完成登录或验证。');
      trackLogin();
    } else if (data.profile_exists && data.logged_in === null && !data.last_error) {
      probing = true;
      feedback('正在检查已保存的登录状态…');
      statusMessage(await refresh(true));
    } else {
      statusMessage(data);
    }
  } finally {
    busy = false;
    probing = false;
    updateControls();
  }
} catch (error) {
  feedback(error.message, true);
}
