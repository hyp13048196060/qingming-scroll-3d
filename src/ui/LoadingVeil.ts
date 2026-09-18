/**
 * 加载遮罩。
 *
 * 两条硬要求(来自计划,也是这个组件存在的全部理由):
 *   1. **进度必须是真的**。数字直接来自 store.load,分母是 manifest 里的
 *      真实字节数,不是"第 n 个资源 / 总数"这种假装出来的平滑。
 *   2. **失败必须说清楚**。显示"哪个文件、哪一步、什么错误",并给重试按钮。
 *      只显示"加载失败"等于把排查成本全推给用户。
 */

import { store, type AppState } from './store';
import { loadRetry } from './actions';

const STAGE_LABEL: Record<string, string> = {
  manifest: '读取清单',
  fetch: '下载',
  parse: '解析',
  compile: '编译着色器',
};

function phaseLabel(s: AppState['load']): string {
  switch (s.phase) {
    case 'idle':
      return '准备中';
    case 'manifest':
      return '读取清单';
    case 'fetching':
      return '下载模型';
    case 'parsing':
      return '解析模型';
    case 'compiling':
      return '编译着色器';
    case 'ready':
      return '就绪';
    case 'failed':
      return '加载失败';
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

export class LoadingVeil {
  private readonly root: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly pct: HTMLSpanElement;
  private readonly phase: HTMLDivElement;
  private readonly detail: HTMLDivElement;
  private readonly errorBox: HTMLDivElement;
  private readonly gpuBox: HTMLDivElement;
  private readonly gpuMsg: HTMLParagraphElement;
  private readonly gpuDetail: HTMLParagraphElement;

  private unsubscribe: (() => void) | null = null;

  constructor(mount: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'veil';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.innerHTML = `
      <div class="veil__panel">
        <h1 class="veil__title">清明上河图 · 三维长卷</h1>
        <p class="veil__sub">汴河 · 编木虹桥 · 两岸市井</p>
        <div class="veil__track"><div class="veil__bar"></div></div>
        <div class="veil__row">
          <span class="veil__phase">准备中</span>
          <span class="veil__pct">0%</span>
        </div>
        <div class="veil__detail"></div>
        <div class="veil__error" hidden></div>
        <div class="veil__gpu" hidden>
          <p class="veil__gpu-msg"></p>
          <p class="veil__gpu-detail"></p>
        </div>
      </div>
    `;

    this.bar = this.root.querySelector('.veil__bar') as HTMLDivElement;
    this.pct = this.root.querySelector('.veil__pct') as HTMLSpanElement;
    this.phase = this.root.querySelector('.veil__phase') as HTMLDivElement;
    this.detail = this.root.querySelector('.veil__detail') as HTMLDivElement;
    this.errorBox = this.root.querySelector('.veil__error') as HTMLDivElement;
    this.gpuBox = this.root.querySelector('.veil__gpu') as HTMLDivElement;
    this.gpuMsg = this.root.querySelector('.veil__gpu-msg') as HTMLParagraphElement;
    this.gpuDetail = this.root.querySelector('.veil__gpu-detail') as HTMLParagraphElement;

    // 「刷新页面」按钮**只建一次**,不做成每次渲染重建的节点。
    // 重建会丢掉焦点,而键盘用户正停在它上面的时候正是最需要它稳定的时刻。
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'veil__reload';
    reload.textContent = '刷新页面';
    reload.addEventListener('click', () => location.reload());
    this.gpuBox.appendChild(reload);

    mount.appendChild(this.root);

    this.unsubscribe = store.subscribe((s) => this.render(s));
  }

  /**
   * 渲染。
   *
   * ⚠️ **两件事分开渲染,谁也不许提前 return。**
   *
   * 第一版写成"丢了就先画 GPU 那块然后 return",有两个后果,都是实测
   * 截图看出来的:
   *
   *   ① 丢失期间进度行还挂在那里显示「就绪 100% 12.73 MB / 12.73 MB」——
   *      下面紧跟着"画面已暂停"。两句都是真话,但并排放着像在互相打脸,
   *      而且进度行是这里唯一**看起来还在推进**的东西。所以丢失时把它收起来。
   *
   *   ② 更要命的是:加载失败与上下文丢失同时发生时,失败列表**整个消失**——
   *      而那正是最需要看到"哪个文件没拿到"的时刻。真正的错因是
   *      "两个独立的状态被写成了同一条 if-else 链"。
   *      现在两者各自渲染,互不遮蔽。
   */
  private render(s: Readonly<AppState>): void {
    const load = s.load;
    const gpu = s.gpu;
    const lost = gpu.contextLost;
    const failed = load.phase === 'failed';

    this.root.hidden = !(s.ui.veil || lost);
    this.root.classList.toggle('is-failed', failed);
    this.root.classList.toggle('is-gpu-lost', lost);

    if (!lost) {
      const pct = Math.round(load.progress * 100);
      this.bar.style.width = `${pct}%`;
      this.pct.textContent = `${pct}%`;
      this.phase.textContent = phaseLabel(load);

      const bits: string[] = [];
      if (load.current) bits.push(load.current);
      if (load.bytesTotal > 0) {
        bits.push(`${formatBytes(load.bytesLoaded)} / ${formatBytes(load.bytesTotal)}`);
      }
      this.detail.textContent = bits.join(' · ');
    }

    if (failed) {
      // 失败时进度行没有意义(它停在失败那一刻),让位给失败列表
      if (!lost) this.detail.textContent = '';
      this.renderErrors(load);
    } else {
      this.errorBox.hidden = true;
      this.errorBox.textContent = '';
    }

    if (lost) this.renderGpuLost(gpu);
    else this.gpuBox.hidden = true;
  }

  /**
   * 上下文丢失时的遮罩内容。
   *
   * 文案要说清三件事:**出了什么事**、**画面为什么停着**、**现在能做什么**。
   * 只说"出错了"等于把排查成本推给用户,而这类故障用户根本无从查起 ——
   * 页面不报错、控制台干净,画面就是不动了。
   *
   * ⚠️ `recoveryTimedOut` 与"重建项失败"是**两种不同的处境**,
   *    文案必须分开:
   *      · 超时     → 浏览器不会恢复了,只剩刷新这一条路;
   *      · 重建失败 → 上下文回来了,但画面会有具体的地方不对。
   *    合成一句"恢复失败"的话,用户既不知道要不要刷新,
   *    也不知道刷新能不能解决问题。
   */
  private renderGpuLost(gpu: AppState['gpu']): void {
    this.gpuBox.hidden = false;
    this.root.classList.remove('is-failed');

    const failed = gpu.lastRebuild.filter((r) => !r.ok);

    if (failed.length > 0) {
      this.gpuMsg.textContent = '图形上下文已恢复,但有一部分画面未能重建:';
      this.gpuDetail.textContent = failed
        .map((r) => `${r.name}(${r.error ?? '未知原因'})`)
        .join('、');
      return;
    }

    this.gpuMsg.textContent = gpu.recoveryTimedOut
      ? '图形上下文没有恢复。浏览器已经不打算重建它了,需要刷新页面。'
      : '图形上下文已丢失,画面已暂停。正在等待浏览器恢复……';
    this.gpuDetail.textContent =
      `已丢失 ${gpu.lostCount} 次` +
      (gpu.restoredCount > 0 ? `,此前成功恢复 ${gpu.restoredCount} 次` : '') +
      '。显卡驱动重置、系统休眠唤醒、GPU 进程重启都会造成这种情况。';
  }

  private renderErrors(load: AppState['load']): void {
    this.errorBox.hidden = false;
    this.errorBox.textContent = '';

    const intro = document.createElement('p');
    intro.textContent = '以下资源未能加载:';
    this.errorBox.appendChild(intro);

    const list = document.createElement('ul');
    for (const f of load.failures) {
      const li = document.createElement('li');
      const where = document.createElement('code');
      where.textContent = f.url;
      const what = document.createElement('span');
      const status = f.status === undefined ? '' : ` (HTTP ${f.status})`;
      what.textContent = ` — ${STAGE_LABEL[f.stage] ?? f.stage}${status}:${f.message}`;
      li.append(where, what);
      list.appendChild(li);
    }
    this.errorBox.appendChild(list);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'veil__retry';
    retry.textContent = '重试';
    retry.addEventListener('click', () => loadRetry());
    this.errorBox.appendChild(retry);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.root.remove();
  }
}
