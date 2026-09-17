/**
 * 零依赖 Chrome DevTools Protocol 客户端。
 *
 * 为什么不用 puppeteer:
 *   1. Node 24 已内置 WebSocket 与 fetch,CDP 本身只是 JSON over WebSocket;
 *   2. 少一个会随版本漂移的依赖,「全新 clone → npm ci」更稳;
 *   3. 我们只需要截图 / 取数 / 简单输入三类能力,不需要 puppeteer 的全套 API。
 *
 * 同时强制使用系统 Chrome,而不是下载一份 Chromium —— 既省几百 MB,
 * 也保证测出来的性能就是用户实际浏览器的性能。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** 启动参数。GPU 相关几项是拿到真实渲染器的前提。 */
function buildArgs({ width, height, mobile }) {
  const args = [
    '--headless=new',
    // 拿真实 GPU 而不是 SwiftShader —— 否则性能数据毫无意义
    '--enable-gpu',
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-component-update',
    '--mute-audio',
    // 关掉后台节流,否则测量期间 rAF 会被降频,帧时数据失真
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=' + width + ',' + height,
  ];
  if (mobile) args.push('--touch-events=enabled');
  return args;
}

class Connection {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} [${msg.method ?? ''}]`));
        else p.resolve(msg.result);
      } else {
        for (const fn of this.#listeners) fn(msg);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify(payload));
      // 兜底:CDP 命令不应超过 60s,避免脚本永久挂起
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP 超时: ${method}`));
      }, 60000);
    });
  }

  on(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  waitForEvent(method, { timeout = 30000, sessionId, predicate } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待事件超时: ${method}`));
      }, timeout);
      const off = this.on((msg) => {
        if (msg.method !== method) return;
        if (sessionId && msg.sessionId !== sessionId) return;
        if (predicate && !predicate(msg.params)) return;
        clearTimeout(timer);
        off();
        resolve(msg.params);
      });
    });
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/** 页面会话。一个 Browser 下可以有多个。 */
export class Page {
  constructor(conn, sessionId, targetId) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params) {
    return this.conn.send(method, params, this.sessionId);
  }

  /** 在页面里求值。默认等待 Promise 并返回值。 */
  async evaluate(fnOrExpr, { awaitPromise = true, returnByValue = true } = {}) {
    const expression =
      typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})()` : String(fnOrExpr);
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(`页面内求值异常: ${d.exception?.description ?? d.text}`);
    }
    return res.result?.value;
  }

  async goto(url, { timeout = 60000 } = {}) {
    const done = this.conn.waitForEvent('Page.loadEventFired', {
      timeout,
      sessionId: this.sessionId,
    });
    await this.send('Page.navigate', { url });
    await done;
  }

  async setViewport({ width, height, deviceScaleFactor = 1, mobile = false }) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
      screenWidth: width,
      screenHeight: height,
    });
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    const { writeFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(data, 'base64'));
    return path;
  }

  /** 等待页面自身报告就绪(window.__QM_READY__)。 */
  async waitForReady({ timeout = 120000, pollMs = 200 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok = await this.evaluate('Boolean(window.__QM_READY__)').catch(() => false);
      if (ok) return true;
      await sleep(pollMs);
    }
    // 超时时把页面上的错误捞出来,便于定位而不是只报"超时"
    const diag = await this.evaluate(
      `(() => ({ ready: Boolean(window.__QM_READY__),
                 hasQM: Boolean(window.__QM__),
                 title: document.title,
                 bodyText: (document.body?.innerText || '').slice(0, 300) }))()`,
    ).catch(() => null);
    throw new Error(`等待 __QM_READY__ 超时(${timeout}ms)。页面诊断: ${JSON.stringify(diag)}`);
  }

  /** 收集控制台错误与未捕获异常。 */
  collectErrors() {
    const errors = [];
    this.conn.on((msg) => {
      if (msg.sessionId !== this.sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push(`未捕获异常: ${d.exception?.description ?? d.text}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(
          `console.error: ${msg.params.args.map((a) => a.description ?? a.value).join(' ')}`,
        );
      }
    });
    return errors;
  }

  /** 鼠标事件。用于脚本化验证环视/缩放/右键平移。 */
  async mouse(type, x, y, { button = 'left', buttons, clickCount = 1, modifiers = 0 } = {}) {
    const btnMask = { none: 0, left: 1, right: 2, middle: 4 };
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      buttons: buttons ?? (type === 'mouseMoved' ? btnMask[button] ?? 1 : btnMask[button] ?? 1),
      clickCount,
      modifiers,
      pointerType: 'mouse',
    });
  }

  async wheel(x, y, deltaY) {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY,
      pointerType: 'mouse',
    });
  }

  async close() {
    try {
      await this.conn.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 启动 Chrome 并打开一个页面。
 * @returns {Promise<{ page: Page, close: () => Promise<void> }>}
 */
export async function launch(opts = {}) {
  const {
    chromePath = DEFAULT_CHROME,
    width = 1600,
    height = 900,
    deviceScaleFactor = 1,
    mobile = false,
    allowSoftware = false,
    extraArgs = [],
    startupTimeoutMs = 40000,
    keepProfile = false,
  } = opts;

  if (!existsSync(chromePath)) {
    throw new Error(
      `找不到 Chrome 可执行文件: ${chromePath}\n` +
        `请设置环境变量 CHROME_PATH 指向你的 Chrome。`,
    );
  }

  const profileDir = await mkdtemp(join(tmpdir(), 'qm-cdp-'));
  const args = [
    ...buildArgs({ width, height, mobile }),
    `--user-data-dir=${profileDir}`,
    // 端口写 0 让系统分配,避免固定端口冲突;实际端口从 DevToolsActivePort 读取
    '--remote-debugging-port=0',
    ...extraArgs,
  ];
  if (!allowSoftware) args.push('--disable-software-rasterizer');
  args.push('about:blank');

  const proc = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 8000) stderr = stderr.slice(-8000);
  });

  const portFile = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + startupTimeoutMs;
  let port = null;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      try {
        const txt = await readFile(portFile, 'utf8');
        const first = txt.split('\n')[0]?.trim();
        if (first) {
          port = Number(first);
          break;
        }
      } catch {
        /* 文件可能正在写入,重试 */
      }
    }
    if (proc.exitCode !== null) {
      throw new Error(`Chrome 启动即退出(退出码 ${proc.exitCode})。stderr:\n${stderr}`);
    }
    await sleep(100);
  }
  if (!port) {
    proc.kill();
    throw new Error(`等待 DevToolsActivePort 超时。stderr:\n${stderr}`);
  }

  const version = await retry(
    async () => {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (!r.ok) throw new Error(`/json/version 返回 ${r.status}`);
      return r.json();
    },
    { attempts: 20, delayMs: 150 },
  );

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('连接浏览器级 WebSocket 失败')), {
      once: true,
    });
  });

  const conn = new Connection(ws);

  const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });

  const page = new Page(conn, sessionId, targetId);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.setViewport({ width, height, deviceScaleFactor, mobile });

  const close = async () => {
    try {
      page.conn.close();
    } catch {
      /* 忽略 */
    }
    try {
      proc.kill();
    } catch {
      /* 忽略 */
    }
    // 给 Chrome 一点时间释放文件句柄再删目录
    await sleep(300);
    if (!keepProfile) {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  return { page, close, port, browserVersion: version.Browser, stderr: () => stderr };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function retry(fn, { attempts = 5, delayMs = 200 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
