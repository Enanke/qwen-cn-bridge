import { mkdir, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import {
  HOME_URL, MODE, BridgeError, inspectPage, isQwen, loginError, modeError,
  submitQuestion, timeoutError, waitForComposer,
} from './dom_helpers.mjs';

const configuredIdle = Number(process.env.QWEN_IDLE_MS);
const IDLE_MS = Number.isInteger(configuredIdle) && configuredIdle > 0 && configuredIdle <= 2147483647
  ? configuredIdle : 300000;

export function toolError(error) {
  if (error instanceof BridgeError) return { ok: false, error: error.code, message: error.message };
  if (error.name === 'TimeoutError') return toolError(timeoutError());
  return { ok: false, error: 'DOM_PARSE_ERROR', message: '无法读取千问页面或本地状态。请在面板检查状态后重试。' };
}

export class QwenBrowser {
  constructor(dataDir) {
    this.dataDir = resolve(dataDir);
    this.profileDir = join(this.dataDir, 'chrome-profile');
    this.settingsPath = join(this.dataDir, 'settings.json');
    this.queue = Promise.resolve();
    this.context = null;
    this.page = null;
    this.activeMode = null;
    this.lastChat = null;
    this.loggedIn = null;
    this.fast = false;
    this.lastError = null;
    this.loginPending = false;
    this.closing = false;
    const profileKey = createHash('sha256').update(this.profileDir.toLowerCase()).digest('hex');
    this.profilePipe = '\\\\.\\pipe\\qwen-cn-bridge-' + profileKey;
  }

  serial(work, signal) {
    const job = this.queue.then(async () => {
      if (this.closing) throw new BridgeError('DOM_PARSE_ERROR', '千问服务正在退出。');
      if (signal?.aborted) throw timeoutError();
      clearTimeout(this.idleTimer);
      try {
        return await work();
      } catch (error) {
        this.lastError = toolError(error);
        if (this.lastError.error === 'NOT_LOGGED_IN') this.loggedIn = false;
        if (this.lastError.error === 'CAPTCHA_OR_BLOCKED') this.loggedIn = null;
        if (this.lastError.error === 'MODE_CHECK_FAILED') this.fast = false;
        throw error;
      } finally {
        if (this.context && this.activeMode !== 'login' && !this.closing) {
          this.idleTimer = setTimeout(() => {
            this.serial(() => this.close()).catch(() => {});
          }, IDLE_MS);
          this.idleTimer.unref();
        }
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }

  async settings() {
    try {
      const value = JSON.parse(await readFile(this.settingsPath, 'utf8'));
      if (!['headless', 'minimized'].includes(value.backgroundMode)) throw new Error('Invalid backgroundMode');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { backgroundMode: 'headless' };
      throw new BridgeError('DOM_PARSE_ERROR', '本地 settings.json 无法读取或格式不正确。');
    }
  }

  async status() {
    let profileExists;
    try {
      profileExists = (await lstat(this.profileDir)).isDirectory();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      profileExists = false;
    }
    const { backgroundMode } = await this.settings();
    return {
      ok: true,
      logged_in: profileExists ? this.loggedIn : false,
      mode: MODE,
      mode_verified: this.fast,
      headless_running: Boolean(this.context && this.activeMode === 'headless'),
      background_running: Boolean(this.context && this.activeMode !== 'login'),
      background_mode: backgroundMode,
      login_in_progress: this.loginPending,
      profile_exists: profileExists,
      profile_dir: this.profileDir,
      last_error: this.lastError,
    };
  }

  async close() {
    clearTimeout(this.idleTimer);
    const context = this.context;
    if (!context) return;
    await context.close();
    // close 事件通常已清理引用。
    if (this.context === context) this.resetBrowser();
  }

  resetBrowser() {
    this.context = null;
    this.page = null;
    this.activeMode = null;
    clearTimeout(this.idleTimer);
    this.releaseProfile();
  }

  // Windows 命名管道在进程退出时由系统释放，防止另一宿主实例清除正在使用的资料。
  async reserveProfile() {
    if (process.platform !== 'win32') return;
    const lock = createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        lock.once('error', reject);
        lock.listen(this.profilePipe, resolve);
      });
    } catch (error) {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        throw new BridgeError('PROFILE_IN_USE', '另一处千问助手正在使用本地 Chrome 资料。请先释放其后台进程。');
      }
      throw error;
    }
    this.profileLock = lock;
  }

  releaseProfile() {
    // 本服务不接受命名管道请求，close 会立即解除监听。
    this.profileLock?.close();
    this.profileLock = null;
  }

  async launch(mode, remaining) {
    if (this.context && this.activeMode === mode && this.page && !this.page.isClosed()) return this.page;
    await this.close();
    await mkdir(this.dataDir, { recursive: true });
    const headless = mode === 'headless';
    const options = {
      channel: 'chrome',
      headless,
      args: ['--no-first-run', '--no-default-browser-check', ...(headless ? ['--headless=new'] : [])],
      locale: 'zh-CN',
      viewport: { width: 1280, height: 900 },
      timeout: remaining(),
    };
    let context;
    await this.reserveProfile();
    try {
      context = await chromium.launchPersistentContext(this.profileDir, options);
    } catch (error) {
      this.releaseProfile();
      if (/executable doesn't exist|distribution .* is not found|chrome.*not installed/i.test(error.message)) {
        throw new BridgeError('CHROME_NOT_FOUND', '找不到本机 Google Chrome。请安装 Chrome 后重试。');
      }
      if (/ProcessSingleton|profile.*in use|user data dir.*in use/i.test(error.message)) {
        throw new BridgeError('PROFILE_IN_USE', '千问插件的浏览器资料正被占用。请关闭另一处千问助手窗口或后台后重试。');
      }
      throw error;
    }
    this.context = context;
    this.activeMode = mode;
    context.once('close', () => { if (this.context === context) this.resetBrowser(); });
    try {
      this.page = context.pages()[0] ?? await context.newPage();
      if (mode === 'minimized') {
        const session = await context.newCDPSession(this.page);
        try {
          const { windowId } = await session.send('Browser.getWindowForTarget');
          await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        } finally {
          await session.detach().catch(() => {});
        }
      }
      return this.page;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  deadline(started, timeout, signal) {
    return () => {
      const remaining = started + timeout - Date.now();
      if (this.closing || signal?.aborted || remaining <= 0) throw timeoutError();
      return remaining;
    };
  }

  ask(options, signal) {
    const started = Date.now();
    const remaining = this.deadline(started, options.timeout_ms, signal);
    if (this.loginPending) return Promise.reject(new BridgeError('NOT_LOGGED_IN', '请先在打开的千问窗口完成登录或验证。'));
    return this.serial(async () => {
      remaining();
      const { backgroundMode } = await this.settings();
      if (!options.new_chat && !this.lastChat) {
        throw new BridgeError('DOM_PARSE_ERROR', '当前服务没有可续聊的千问对话。请先开启新对话。');
      }
      const interrupt = () => { void this.close().catch(() => {}); };
      const watchdog = setTimeout(interrupt, remaining());
      signal?.addEventListener('abort', interrupt, { once: true });
      try {
        const page = await this.launch(backgroundMode, remaining);
        const url = options.new_chat ? HOME_URL : this.lastChat;
        if (options.new_chat || page.url() !== url) {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
        }
        if (options.new_chat) this.lastChat = null;
        await waitForComposer(page, remaining);
        this.loggedIn = true;
        this.fast = true;
        const reply = await submitQuestion(page, options, remaining);
        remaining();
        const chatUrl = page.url();
        if (isQwen(chatUrl) && new URL(chatUrl).pathname.startsWith('/chat/')) this.lastChat = chatUrl;
        this.lastError = null;
        return { ok: true, mode: MODE, ...reply, elapsed_ms: Date.now() - started, chat_url: chatUrl };
      } catch (error) {
        // 中断后关闭可能仍在流式输出的页面，避免下一条请求混入旧回复。
        await this.close().catch(() => {});
        if (signal?.aborted || Date.now() - started >= options.timeout_ms) throw timeoutError();
        throw error;
      } finally {
        clearTimeout(watchdog);
        signal?.removeEventListener('abort', interrupt);
      }
    }, signal);
  }

  getStatus(probe, signal) {
    if (!probe || this.loginPending) return this.status();
    const remaining = this.deadline(Date.now(), 20000, signal);
    return this.serial(async () => {
      const cached = await this.status();
      if (!cached.profile_exists) return cached;
      try {
        const page = await this.launch(cached.background_mode, remaining);
        if (!isQwen(page.url())) {
          await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: remaining() });
        }
        await waitForComposer(page, remaining);
        this.loggedIn = true;
        this.fast = true;
        this.lastError = null;
      } catch (error) {
        this.lastError = toolError(error);
        this.fast = false;
        this.loggedIn = this.lastError.error === 'NOT_LOGGED_IN' ? false
          : this.lastError.error === 'MODE_CHECK_FAILED' ? true : null;
      }
      return this.status();
    }, signal);
  }

  async startLogin() {
    if (this.loginPending) return this.status();
    if (this.closing) throw new BridgeError('DOM_PARSE_ERROR', '千问服务正在退出。');
    this.loginPending = true;
    this.lastError = null;
    // 窗口可能等待用户三分钟。立即返回进度，面板用轻量状态查询跟踪。
    this.serial(async () => {
      const started = Date.now();
      const remaining = this.deadline(started, 180000);
      let sawEditor = false;
      const watchdog = setTimeout(() => { void this.close().catch(() => {}); }, 180000);
      try {
        const page = await this.launch('login', remaining);
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: remaining() });
        while (!page.isClosed()) {
          const state = await page.evaluate(inspectPage);
          const ready = isQwen(page.url()) && !state.blocked && !state.loggedOut && state.composerCount === 1;
          sawEditor = ready;
          if (ready && state.fast) {
            await delay(Math.min(1500, remaining()));
            remaining();
            const confirmed = await page.evaluate(inspectPage);
            if (isQwen(page.url()) && !confirmed.blocked && !confirmed.loggedOut &&
                confirmed.composerCount === 1 && confirmed.fast) {
              await this.close();
              this.loggedIn = true;
              this.fast = true;
              return;
            }
          }
          await delay(Math.min(500, remaining()));
        }
        throw new BridgeError('NOT_LOGGED_IN', '登录窗口已关闭。可重新打开窗口完成登录。');
      } catch (error) {
        if (error.name === 'TimeoutError' || error.code === 'TIMEOUT' || Date.now() - started >= 180000) {
          if (sawEditor) throw modeError();
          throw new BridgeError('TIMEOUT', '180 秒内未完成登录或验证。请重新打开千问登录窗口。');
        }
        if (this.page?.isClosed() || /Target page, context or browser has been closed/.test(error.message)) {
          throw new BridgeError('NOT_LOGGED_IN', '登录窗口已关闭。可重新打开窗口完成登录。');
        }
        throw error;
      } finally {
        clearTimeout(watchdog);
        await this.close();
      }
    }).catch(() => {}).finally(() => { this.loginPending = false; });
    return this.status();
  }

  stop() {
    return this.serial(async () => {
      await this.close();
      return this.status();
    });
  }

  clearSession() {
    return this.serial(async () => {
      await this.close();
      await this.reserveProfile();
      try {
        const profile = await lstat(this.profileDir);
        if (!profile.isDirectory() || profile.isSymbolicLink()) {
          throw new BridgeError('DOM_PARSE_ERROR', '浏览器资料路径不是普通目录，无法清除。');
        }
        await rm(this.profileDir, { recursive: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      } finally {
        this.releaseProfile();
      }
      this.loggedIn = false;
      this.fast = false;
      this.lastChat = null;
      this.lastError = null;
      return this.status();
    });
  }

  setBackgroundMode(backgroundMode) {
    return this.serial(async () => {
      await this.close();
      await mkdir(this.dataDir, { recursive: true });
      const temporary = join(this.dataDir, 'settings-' + randomUUID() + '.tmp');
      try {
        await writeFile(temporary, JSON.stringify({ backgroundMode }) + '\n', { flag: 'wx' });
        await rename(temporary, this.settingsPath);
      } finally {
        await rm(temporary, { force: true });
      }
      return this.status();
    });
  }

  async shutdown() {
    this.closing = true;
    await this.close().catch(() => {});
    await this.queue;
    await this.close().catch(() => {});
  }
}

