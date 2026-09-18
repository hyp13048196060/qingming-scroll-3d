#!/usr/bin/env node
/**
 * 注入的顶点着色器到底编译没有。
 *
 * 上一版探针读 `geometry.attributes.position` 判断幌子有没有动 —— 那个读数
 * **天生看不见**要测的东西:位移发生在**顶点着色器里**,而着色器不会把结果
 * 写回 CPU 端的属性数组。于是不管风动是否生效,读数永远是 0。
 * 它给出的是"零",错在尺子,不在被测物。
 *
 * 这一版换一把尺子,分三层,从"能不能跑"问到"跑出来的对不对":
 *   1. 控制台有没有 GLSL 编译错误(three 会把编译失败的日志打出来);
 *   2. `renderer.info.programs` 里那份程序的**实际顶点着色器源码**里,
 *      有没有我们注入的那几行 —— 有,说明 onBeforeCompile 真的跑到了;
 *   3. 把该程序的顶点着色器源码**逐字打印**出来,人工核对
 *      `attribute float qmFlex` 是否在、`transformed +=` 是否在。
 *
 * 第 2/3 步是关键:它绕开了"效果看不见"的困局,直接查验**中间产物**。
 */
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/?q=low&hud=0&spot=boat';

const { page, close } = await launch({ width: 900, height: 600 });
try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  const logs = page.collectConsole();
  await sleep(3500);

  const out = await page.evaluate(`(() => {
    const qm = window.__QM__;
    // 找一个被风动的对象,顺藤摸到它的材质
    let target = null;
    qm.scene.traverse((o) => {
      if (target) return;
      if (o.isMesh && o.userData && o.userData.qm_anim === 'wind') target = o;
    });
    if (!target) return { error: '场景里找不到 qm_anim=wind 的对象' };

    const mat = target.material;
    const prog = qm.renderer.info.programs || [];
    // ⚠️ three 的 WebGLProgram 上 vertexShader 是**编译好的 WebGLShader 对象**,
    //    不是字符串。上一版判 typeof === 'string' 直接把它们全滤掉,
    //    于是列表为空、"含 qmFlex 的程序 0 份" —— 一个由空列表造成的**假阴性**,
    //    看着却像"注入没生效"。要拿回源码只能问 GL 自己。
    //    (这一段是模板字符串的内容,注释里**不能出现反引号** —— 会提前闭合。)
    const gl = qm.renderer.getContext();
    const vsList = [];
    for (const p of prog) {
      let src = null;
      try { src = gl.getShaderSource(p.vertexShader); } catch (e) { src = null; }
      if (typeof src === 'string') vsList.push({ id: p.id, used: p.usedTimes, hasQmFlex: src.indexOf('qmFlex') >= 0, src });
    }
    return {
      name: target.name,
      matUuid: mat.uuid,
      matType: mat.type,
      onBeforeCompileSet: typeof mat.onBeforeCompile === 'function',
      // three 用 onBeforeCompile.toString() 当程序缓存键的一部分
      hasQmFlexAttr: !!target.geometry.getAttribute('qmFlex'),
      hasColorAttr: !!target.geometry.getAttribute('color'),
      programs: prog.length,
      srcReadable: vsList.length,
      qmFlexPrograms: vsList.filter((v) => v.hasQmFlex).length,
      firstQmFlexSrc: (vsList.find((v) => v.hasQmFlex) || {}).src || null,
    };
  })()`);

  const errs = logs.filter((l) => l.type === 'error' || l.type === 'exception');
  console.log('===== 控制台 error / 异常 =====');
  if (!errs.length) console.log('  无 ✅');
  else for (const e of errs) console.log(`  [${e.type}] ${e.text.slice(0, 400)}`);

  if (out.error) { console.log('❌ ' + out.error); process.exit(1); }
  console.log('\n===== 取样对象 =====');
  console.log(`  ${out.name}  材质 ${out.matType} uuid=${out.matUuid}`);
  console.log(`  material.onBeforeCompile 已设置: ${out.onBeforeCompileSet}`);
  console.log(`  几何体有 qmFlex 属性: ${out.hasQmFlexAttr}   (原 color 属性还在: ${out.hasColorAttr})`);
  console.log(`  renderer.info.programs 共 ${out.programs} 份,取回源码 ${out.srcReadable} 份,其中含 qmFlex 的 ${out.qmFlexPrograms} 份`);

  if (out.firstQmFlexSrc) {
    const src = out.firstQmFlexSrc;
    const lines = src.split('\n');
    console.log('\n===== 该程序顶点着色器里与 qmFlex 相关的行 =====');
    lines.forEach((l, i) => { if (l.indexOf('qmFlex') >= 0 || l.indexOf('uQm') >= 0) console.log(`  ${String(i).padStart(4)}| ${l}`); });
    console.log('\n===== 注入段的实际样子(begin_vertex 之后 12 行)=====');
    const bi = lines.findIndex((l) => l.indexOf('transformed = vec3( position )') >= 0);
    if (bi >= 0) lines.slice(bi, bi + 12).forEach((l, i) => console.log(`  ${String(bi + i).padStart(4)}| ${l}`));
    else console.log('  ⚠️ 源码里找不到 begin_vertex 展开后的那一行');
  }
} finally {
  await close();
}
