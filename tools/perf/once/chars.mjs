// 一次性探针:人物模板在**运行时的层级**长什么样?
//
// 当初要回答的问题:actors.json 里排好了 48 个人,而场景里只有 9 个模板网格。
// 要凭空复制出 48 个,第一件必须搞清的事是 **SkeletonUtils.clone() 该克隆谁** ——
// 克隆 SkinnedMesh 本身、还是克隆它上面的骨架根?
//
// 计划书里的风险 #3 写的就是这件事("蒙皮克隆共享 Skeleton → 全员同步抽搐")。
// 但那条只说了"共享会坏",没说**这几个模板之间到底谁和谁共享**:
//   · char_carry 与 acc_carry_pole 在 Blender 里是同一副骨架下的两个网格,
//     GLB 里很可能指向**同一个 skin** → 同一个 Skeleton 实例;
//   · 若真如此,只克隆其中一个网格,另一个仍指着原骨架,
//     于是"人走了、扁担留在原地" —— 而且不报错。
//
// 这类"必须知道的接口事实"只能量,不能猜:猜错了的代价是一个
// 看起来正常、实际上胳膊腿连在别人身上的画面。
import { launch, sleep } from '../lib/cdp.mjs';

const URL = process.argv[2] || 'http://127.0.0.1:4173/';

const { page, close } = await launch({ width: 1280, height: 720 });

// ⚠️ 注释里不要出现反引号(整段在模板字符串里)。
const SCRIPT = `(() => {
  const qm = window.__QM__;
  const S = qm.scene;

  const chars = [];
  S.traverse((o) => {
    const u = o.userData || {};
    if (u.qm_kind === 'character' || /^char_|^acc_/.test(o.name)) chars.push(o);
  });

  // 按 Skeleton 实例分组 —— 组内成员就是"必须一起克隆"的集合。
  const skelGroups = {};
  const rows = chars.map((o) => {
    const sk = o.isSkinnedMesh ? o.skeleton : null;
    if (sk) {
      const g = skelGroups[sk.uuid] || (skelGroups[sk.uuid] = {
        uuid: sk.uuid, bones: sk.bones.length, rootBone: sk.bones[0] && sk.bones[0].name, users: [],
      });
      g.users.push(o.name);
    }
    return {
      name: o.name,
      type: o.type,
      kind: (o.userData || {}).qm_kind || '',
      anim: (o.userData || {}).qm_anim || '',
      isSkinned: !!o.isSkinnedMesh,
      isBone: !!o.isBone,
      parent: o.parent ? o.parent.name || o.parent.type : null,
      children: o.children.map((c) => c.name).slice(0, 8),
      skelUuid: sk ? sk.uuid.slice(0, 8) : null,
      bones: sk ? sk.bones.length : 0,
      verts: o.geometry ? (o.geometry.attributes.position ? o.geometry.attributes.position.count : 0) : 0,
      mat: o.material ? (Array.isArray(o.material) ? o.material.length + '个' : (o.material.name || '(无名)')) : null,
      // 有没有 flex 属性(风动的顶点权重)
      attrs: o.geometry ? Object.keys(o.geometry.attributes).join(',') : '',
      pos: o.position ? [+o.position.x.toFixed(2), +o.position.y.toFixed(2), +o.position.z.toFixed(2)] : null,
    };
  });

  // 骨架根节点:名字以 _rig 结尾的那些
  const rigs = [];
  S.traverse((o) => {
    if (/_rig$/.test(o.name)) {
      rigs.push({
        name: o.name, type: o.type,
        parent: o.parent ? o.parent.name || o.parent.type : null,
        children: o.children.map((c) => c.name + '(' + c.type + ')').slice(0, 24),
        pos: [+o.position.x.toFixed(3), +o.position.y.toFixed(3), +o.position.z.toFixed(3)],
        scale: [+o.scale.x.toFixed(3), +o.scale.y.toFixed(3), +o.scale.z.toFixed(3)],
      });
    }
  });

  return { rows, skelGroups: Object.values(skelGroups), rigs };
})()`;

try {
  await page.goto(URL);
  await page.waitForReady({ timeout: 120000 });
  await sleep(4000);
  const r = await page.evaluate(SCRIPT);

  console.log('─'.repeat(88));
  console.log('—— 骨架实例分组(同组 = 共享一个 Skeleton,必须一起克隆)——');
  for (const g of r.skelGroups) {
    console.log(`  ${g.uuid}  骨 ${g.bones}  首骨 ${g.rootBone}`);
    console.log(`     使用者(${g.users.length}): ${g.users.join(', ')}`);
  }

  console.log('');
  console.log('—— 骨架根节点(_rig)$ ——');
  for (const g of r.rigs) {
    console.log(`  ${g.name}  (${g.type})  父=${g.parent}`);
    console.log(`     位置 ${g.pos.join(', ')}   缩放 ${g.scale.join(', ')}`);
    console.log(`     子: ${g.children.join(', ')}`);
  }

  console.log('');
  console.log('—— 人物相关对象 ——');
  const hdr = ['名称', '类型', 'kind', 'anim', '蒙皮', '骨', '顶点', '材质', '父'];
  console.log('  ' + hdr.map((h, i) => h.padEnd([22, 13, 10, 10, 6, 4, 6, 14, 16][i], ' ')).join(''));
  for (const x of r.rows) {
    const cols = [
      x.name, x.type, x.kind, x.anim, x.isSkinned ? '是' : (x.isBone ? '骨' : '否'),
      x.bones || '', x.verts || '', x.mat || '', x.parent || '',
    ];
    const w = [22, 13, 10, 10, 6, 4, 6, 14, 16];
    console.log('  ' + cols.map((c, i) => String(c).padEnd(w[i], ' ')).join(''));
    if (x.attrs && x.attrs !== 'position,normal,uv') console.log('      属性: ' + x.attrs);
  }
  console.log('─'.repeat(88));
} finally {
  await close();
}
