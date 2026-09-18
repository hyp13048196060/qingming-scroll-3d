/**
 * 原卷横卷浏览 —— 功能组 ④「横向浏览原卷」。
 *
 * 全卷约 21:1,屏幕上只能看一段。所以本面板把四段拼成一条可横向滚动的长条,
 * 并给出「卷首/卷尾」的快速跳转,让"这是一幅长卷"这件事在交互上成立 ——
 * 而不是把整卷缩成一张小图了事。
 *
 * ⚠️ 图片是**单独 fetch 的**,不走 GLB 那套加载器。
 *    因此它可能失败,而失败必须**逐张**报出来:第 2 段 404 与四段全 404
 *    是两种完全不同的问题,笼统报一句"原卷加载失败"把前者的排查线索丢了。
 *    `src/data` 里也没有原卷的清单 —— 四段的文件名写在这里,因为它们是
 *    这个面板自己的资源;若将来段数变了,改这一处即可。
 *
 * ⚠️ 本面板**不影响启动**:原卷是附加内容,取不到不该让作品打不开。
 *    所以它惰性加载(首次打开面板时才 fetch),而不是在启动流程里。
 */

import { el, clear } from '../dom';

export interface ScrollPanel {
  root: HTMLElement;
  /** 首次打开时调用:开始加载四段(幂等)。 */
  load(): void;
  /**
   * 取加载状态。测试靠它断言「图已解码」——
   * 注意是**解码完成**(decode()),不是 onload。onload 只说明字节到了,
   * 真正解码可能在之后,那时截图会拿到空白。
   */
  status(): { url: string; state: 'pending' | 'ok' | 'failed'; error?: string }[];
}

/**
 * 四段的**屏幕排列顺序 = 实物的物理顺序**(左起第 1 段 … 第 4 段)。
 *
 * ⚠️ 这个顺序不能为了"阅读顺序好看"而翻转。曾一度想把卷首放到最左边,
 *    让屏幕从左到右就是"从卷首读到卷尾";那等于把整幅画**镜像**,
 *    与任何其它出版物对不上,而且鉴藏印、题字会反写。
 *    手卷本来就是由右向左展阅的,方向这件事应该**说明白**,不是掰正。
 *
 * ⚠️ 于是「卷首」在最右、「卷尾」在最左 —— 跳转按钮的左右关系与
 *    直觉相反,这是实物决定的,不是写反了。按钮上写清落到哪一段。
 */
const SECTIONS = ['section1.jpg', 'section2.jpg', 'section3.jpg', 'section4.jpg'];
/** 各段在实物上的位置,只用于无障碍文本与说明。 */
const SECTION_WHERE = ['卷尾(左端)', '中左', '中右', '卷首(右端)'];
const BASE = './original/';

export function createScrollPanel(onClose: () => void): ScrollPanel {
  const strip = el('div', { class: 'qm-scroll__strip' });
  const statusBox = el('div', { class: 'qm-scroll__status' });

  const scroller = el('div', { class: 'qm-scroll__view' }, [strip]);

  const root = el('section', { class: 'qm-panel qm-panel--scroll qm-interactive' }, [
    el('header', { class: 'qm-panel__head' }, [
      el('h2', { class: 'qm-panel__title' }, ['原卷']),
      el('button', { class: 'qm-btn qm-btn--ghost', type: 'button' }, ['关闭']),
    ]),
    el('div', { class: 'qm-panel__body' }, [
      el('p', { class: 'qm-scroll__hint' }, [
        '手卷由右向左展阅:右端为卷首(郊野),左端为卷尾(城内)。',
        '本图按实物方向摆放,未做镜像。',
      ]),
      scroller,
      el('div', { class: 'qm-scroll__nav' }, [
        el('button', { class: 'qm-btn', type: 'button' }, ['▸ 卷首(右端)']),
        el('button', { class: 'qm-btn', type: 'button' }, ['卷尾(左端) ◂']),
      ]),
      statusBox,
    ]),
  ]);

  // ⚠️ 卷首在**右**端,所以它滚到 scrollWidth;卷尾滚到 0。
  //    写成"卷首→left:0"是很容易犯的错,而且不报错 —— 只是按下去
  //    去到了画卷的另一头,画面上看还"确实动了"。
  const [head, tail] = Array.from(root.querySelectorAll('.qm-scroll__nav .qm-btn'));
  head!.addEventListener('click', () =>
    scroller.scrollTo({ left: scroller.scrollWidth, behavior: 'smooth' }),
  );
  tail!.addEventListener('click', () => scroller.scrollTo({ left: 0, behavior: 'smooth' }));
  root.querySelector('.qm-panel__head .qm-btn')!.addEventListener('click', onClose);

  const states: { url: string; state: 'pending' | 'ok' | 'failed'; error?: string }[] =
    SECTIONS.map((s) => ({ url: BASE + s, state: 'pending' as const }));

  let started = false;

  function renderStatus(): void {
    clear(statusBox);
    const ok = states.filter((s) => s.state === 'ok').length;
    const failed = states.filter((s) => s.state === 'failed');

    if (failed.length === 0 && ok === states.length) {
      statusBox.append(
        el('span', { class: 'qm-k' }, [`四段已就位(${ok}/${states.length})`]),
        el('span', {}, [' —— 可左右拖动查看全卷。']),
      );
      return;
    }

    // 失败时把**哪一段、什么原因**逐条列出来
    statusBox.append(
      el('p', {}, [`已加载 ${ok} / ${states.length} 段。以下未能载入:`]),
    );
    const ul = el('ul', {});
    for (const f of failed) {
      ul.append(
        el('li', {}, [
          el('code', {}, [f.url]),
          el('span', {}, [` —— ${f.error ?? '未知原因'}`]),
        ]),
      );
    }
    statusBox.append(ul);
    // 待网络请求返回前不判定为失败,只说明还在进行
    if (states.some((s) => s.state === 'pending')) {
      statusBox.append(el('p', { class: 'qm-k' }, ['其余仍在加载中…']));
    }
  }

  function load(): void {
    if (started) return;
    started = true;

    for (let i = 0; i < states.length; i++) {
      const st = states[i]!;
      // ⚠️ 这里**不能**加 `loading="lazy"`。
      //    四段拼成一条一万多像素的长条,视口只看得到最左一段,浏览器
      //    于是不急着取右边三段 —— 而本面板的状态区把"没取到"如实报成
      //    「其余仍在加载中…」,那行字会**一直挂着**,看着像卡住了。
      //    惰性加载在面板这一层已经做过了(首次打开才 fetch),
      //    图片这一层再做一次是重复的,而且与状态显示互相矛盾。
      const img = el('img', {
        class: 'qm-scroll__img',
        src: st.url,
        alt: `原卷 ${SECTION_WHERE[i] ?? `第 ${i + 1} 段`}`,
        draggable: 'false',
      }) as HTMLImageElement;
      strip.append(img);

      img.addEventListener('load', () => {
        // ⚠️ onload 只代表字节到齐,不代表**解码**完成。
        //    用 decode() 等真正的解码,否则紧随其后的截图可能是空白。
        //    decode() 在部分浏览器上对已解码的图会 reject,所以失败时
        //    回退成"至少 onload 成功了",并在状态里保留成 ok ——
        //    这里区分不开"解码失败"与"浏览器不支持 decode",但两者
        //    对画面的影响一样(onload 已完成,图能显示)。
        const done = (): void => {
          st.state = 'ok';
          renderStatus();
        };
        if (typeof img.decode === 'function') img.decode().then(done, done);
        else done();
      });

      img.addEventListener('error', () => {
        st.state = 'failed';
        st.error = '网络请求失败或文件不存在(检查 public/original/ 是否随构建产物一起发布)';
        renderStatus();
      });
    }
    renderStatus();
  }

  renderStatus();
  return { root, load, status: () => states.map((s) => ({ ...s })) };
}
