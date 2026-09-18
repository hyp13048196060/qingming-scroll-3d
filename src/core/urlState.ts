/**
 * 网址状态:把 `spot / tod / q / tags / hud / wire` 写进 query,启动时读回。
 *
 * 两个用途,第二个才是真正的原因:
 *   ① 刷新可复现 —— 用户把链接发给别人,对方看到的是同一幅画面。
 *   ② **批量截图不必模拟点击**。无头脚本要拍五个景点 × 三个画质 × 三个
 *      时辰 = 45 张图,靠 `page.mouse` 点 45 遍既慢又脆(UI 一改选择器
 *      就全废)。改成拼 URL,脚本只依赖**稳定的接口**,不依赖 DOM。
 *
 * 另外提供 `cam` / `look`,直接指定机位。它不属于"状态"(不该被写回),
 * 是给探针与取景用的:**改了哪几个数就拍哪张图**,便于复现一次具体的怀疑。
 *
 * `reflect` 是同一类的**测量参数**,不是界面开关:`?reflect=0` 强制关掉水面
 * 反射。存在的唯一理由是计划书里那条 A/B —— 「水面是否变成海水蓝」用肉眼
 * 争论没有意义,得把两版都拍下来、采样河心像素的颜色再判。既然画质档位也
 * 会影响反射(low 档本来就是关的),就必须有一个**绕过档位**的开关,
 * 否则 A/B 的两个样本会被档位混在一起,比出来的不是反射的差异。
 * 与 `cam` / `look` 一样**不写回** —— 它不是用户状态,是"这一次怎么量"。
 */

import type { Quality } from '../ui/store';

export interface UrlState {
  spot: string | null;
  tod: number | null;
  quality: Quality | null;
  tags: boolean | null;
  hud: boolean | null;
  wire: boolean | null;
  /** 直接指定的机位,给探针用;不写回 URL。 */
  cam: [number, number, number] | null;
  look: [number, number, number] | null;
  /**
   * 强制水面反射的开关。`null` = 听画质档位的;`true/false` = 覆盖它。
   * 只用于 A/B 测量,不写回 URL。
   */
  reflect: boolean | null;
}

const QUALITIES: readonly Quality[] = ['low', 'mid', 'high'];

function vec3(raw: string | null): [number, number, number] | null {
  if (!raw) return null;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    // 不静默忽略:拼错一个数就得到默认机位,而"图看着还行"会让人以为
    // URL 生效了。打一条警告,把拼错的原串原样带出来。
    console.warn(`[urlState] 忽略无法解析的向量参数 "${raw}"(应为 x,y,z)`);
    return null;
  }
  return [parts[0], parts[1], parts[2]];
}

function bool(raw: string | null): boolean | null {
  if (raw === null) return null;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
}

export function readUrlState(search: string = location.search): UrlState {
  const p = new URLSearchParams(search);

  const todRaw = p.get('tod');
  const todNum = todRaw === null ? NaN : Number(todRaw);
  const qRaw = p.get('q');
  const quality = qRaw && (QUALITIES as readonly string[]).includes(qRaw) ? (qRaw as Quality) : null;
  if (qRaw && !quality) console.warn(`[urlState] 忽略无法识别的画质 "${qRaw}"`);

  return {
    spot: p.get('spot'),
    tod: Number.isFinite(todNum) ? Math.min(1, Math.max(0, todNum)) : null,
    quality,
    tags: bool(p.get('tags')),
    hud: bool(p.get('hud')),
    wire: bool(p.get('wire')),
    cam: vec3(p.get('cam')),
    look: vec3(p.get('look')),
    reflect: bool(p.get('reflect')),
  };
}

/**
 * 把状态写回地址栏。
 *
 * ⚠️ 用 `replaceState` 而不是 `pushState`。用 push 的话,每切一次景点就多
 *    一条历史记录 —— 用户想按返回键离开页面,得先按十几次撤销景点切换。
 *    浏览器的返回键属于"离开",不该被本页的状态变化劫持。
 *
 * `cam` / `look` / `reflect` 在这里被**有意丢弃**:它们是"这一次要拍哪张图、
 * 怎么量"的一次性参数,不是界面状态。留着会让用户复制链接时带上一串
 * 没有意义的数字。**注意 `reflect` 的丢弃是有代价的**:用户手动把画质切到
 * high 之后,URL 里的 `reflect=0` 已经没了,画面会**变**成有反射 ——
 * 也就是说刷新后 A/B 的 B 组会自己跑回 A 组。这不是 bug,是"它本来就不是
 * 状态"的必然结果;A/B 脚本因此必须**每次导航都带全参数**,不能指望它留在
 * 地址栏里。
 */
export function writeUrlState(state: Partial<UrlState>): void {
  const p = new URLSearchParams(location.search);
  const put = (k: string, v: string | null) => {
    if (v === null) p.delete(k);
    else p.set(k, v);
  };

  if ('spot' in state) put('spot', state.spot ?? null);
  if ('tod' in state) put('tod', state.tod === null || state.tod === undefined ? null : state.tod.toFixed(2));
  if ('quality' in state) put('q', state.quality ?? null);
  if ('tags' in state) put('tags', state.tags === null || state.tags === undefined ? null : state.tags ? '1' : '0');
  if ('hud' in state) put('hud', state.hud === null || state.hud === undefined ? null : state.hud ? '1' : '0');
  if ('wire' in state) put('wire', state.wire === null || state.wire === undefined ? null : state.wire ? '1' : '0');

  p.delete('cam');
  p.delete('look');
  p.delete('reflect');

  const qs = p.toString();
  history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname);
}
