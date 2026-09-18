import * as THREE from 'three';

/**
 * 程序化走路 —— 不用 AnimationMixer、不用任何 AnimationClip。
 *
 * 姿态变体在 Blender 里就被烘成了七套独立的 rest pose(见 07_characters),
 * 网页侧只做**叠加**:每一帧从 rest 四元数出发重新乘一个增量,而不是
 * 在上一帧的结果上继续累加。
 *
 * ⚠️ **`bone.rotation.x += …` 是这条路上最容易犯的错。**
 *    累加写法在单帧看着完全正常,但它把每一帧的增量存进了骨骼本身;
 *    一旦动作停了、速度变了或者帧率抖了,姿态就**停在半路**回不去,
 *    跑够几十秒就拧成麻花。这里一律 `copy(rest).multiply(delta)` ——
 *    每一帧都是"rest + 本帧增量",没有历史。
 *
 * ## 摆动轴是怎么定的(以及计划书那句为什么要改)
 *
 * 计划书的草稿里写的是"绕 worldAxisY 摆"。**绕 Y(竖直轴)摆的是扭腰,
 * 不是甩腿** —— 一条腿绕竖直轴转,得到的是"脚尖左右扫"。真正让腿前后摆的,
 * 是**身体左右方向**那根轴(垂直于"上"和"朝前"的那根)。
 * 所以这里不照抄那一句,改成从骨架里现推:
 *
 *   在**出生姿态**(整个 rig 未旋转)下,取世界侧向轴 `side`,
 *   对每根骨算 `axisLocal = side 在本骨父级坐标系下的方向`,`side` 由
 *   rig 自己的世界朝向推出来(不假设 rig 是朝 +Z 的 —— Blender 导出的
 *   朝向未必是)。
 *
 * 之后实例旋转 yaw 时,骨骼与这根轴**一起刚性旋转**,所以 `axisLocal`
 * 不随 yaw 变 —— 一次算好、永久可用。(前提是本模块只转四肢与脊椎,
 * 不转那些被缓存了轴的骨头的**祖先**;动了祖先就得重算。)
 *
 * ## 相位由**走过的距离**驱动
 *
 * `phase += 速度 × dt / 步长 × π`。按距离而不是按时间推进,是为了让
 * "走得快的人步子迈得大"自然成立:速度变了相位跟着变,不需要另写一段逻辑。
 * 每步 π 弧度、一个完整步态周期 2π。步长取 0.75m(约 1.7m 身高的人的
 * 常步幅),`speed` 来自 actors.json。
 *
 * ## 这套走法**不是**物理
 *
 * 正弦摆腿没有落脚点约束,所以脚在地上会有滑步,膝盖也不会真正锁死。
 * 中远景看是"人挨着人走动的市集",近景凑到脚边看能看出来。
 * 如实记在 docs/08,不声称是动作捕捉级的步态。
 */

/** 摆动幅度(弧度)。这些数是**看着调**的,不是量出来的 —— 见文件尾的自检。 */
const THIGH = 0.42;
const KNEE = 0.55;
const ANKLE = 0.18;
const UPPERARM = 0.30;
const FOREARM = 0.20;

/** 步幅(米/步)。见文件头:每步 π。 */
const STEP_LENGTH = 0.75;

export interface ProceduralWalk {
  /** 推进一帧。`speed` 单位 m/s。 */
  update(dt: number, speed: number): void;
  /** 累计相位(弧度)。诊断与断言用。 */
  readonly phase: number;
  /** 实际驱动到的骨骼数。0 = 一根都没按名字找到。 */
  readonly driven: number;
  /** 读取某根骨当前的世界坐标(断言"腿真的在前后摆"用)。 */
  boneWorld(name: string): THREE.Vector3 | null;
}

interface Driven {
  bone: THREE.Bone;
  rest: THREE.Quaternion;
  axis: THREE.Vector3;
  /** 在步态周期里的相位偏移(左右腿差 π)。 */
  offset: number;
  /** 幅度与符号。 */
  amp: number;
  /** 是否只取正半周(膝盖只往后弯,不能反折)。 */
  halfWave: boolean;
}

/**
 * 去掉 Blender 为**重名**加的 `_<数字>` 后缀。
 *
 * ⚠️ 不这么做的代价,实测过:七具骨架装在一个 GLB 里时,Blender 会
 *    给重名的骨骼去重编号 —— 根骨是 `root / root_1 / … / root_6`,
 *    **每具骨架的其余骨骼也一样带后缀**。于是只有恰好叫 `root` 的那一具
 *    (carry)能按 `thigh_L` 找到骨头,其余六具全部查不到。
 *
 *    实测到的读数是「每具被驱动骨骼数分布 {"0":37,"6":11}」——
 *    11 正是 carry 的人数,其余 37 个人**一根骨头都没在动**。
 *    而画面上这只是"大部分人站着不动",看上去像刻意的静止人群,
 *    不像故障。这就是为什么这类错必须靠**计数**发现,不能靠看图。
 *
 * 只对骨骼名做这个处理,且这些名字(本项目的骨架)本来就不以数字结尾,
 * 所以不会误伤。
 */
const baseBoneName = (n: string): string => n.replace(/_\d+$/, '');

export function createProceduralWalk(
  rig: THREE.Object3D,
  opts: { arms: boolean; legs: boolean },
): ProceduralWalk {
  const bones = new Map<string, THREE.Bone>();
  rig.traverse((o) => {
    if ((o as THREE.Bone).isBone) {
      bones.set(o.name, o as THREE.Bone);
      const base = baseBoneName(o.name);
      if (base !== o.name && !bones.has(base)) bones.set(base, o as THREE.Bone);
    }
  });

  // —— 侧向轴 ——
  // rig 的"朝前"取自身的 +Z 在世界的方向(three 的物体惯例),
  // 侧向 = 上 × 前。出生姿态下算一次即可(见文件头)。
  rig.updateWorldMatrix(true, true);
  const rootQuat = rig.getWorldQuaternion(new THREE.Quaternion());
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rootQuat);
  const up = new THREE.Vector3(0, 1, 0);
  const side = new THREE.Vector3().crossVectors(up, forward).normalize();
  // 退化了(rig 朝正上/正下)就退回世界 X —— 不抛异常,但要能看出来
  if (!Number.isFinite(side.x) || side.lengthSq() < 1e-6) side.set(1, 0, 0);

  const driven: Driven[] = [];
  const skipped: string[] = [];

  const add = (
    name: string,
    amp: number,
    offset: number,
    halfWave = false,
  ): void => {
    const bone = bones.get(name);
    if (!bone || !bone.parent) {
      skipped.push(name);
      return;
    }
    // 父级世界四元数 → 把世界轴搬进本骨的父级坐标系
    const parentQuat = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const axis = side.clone().applyQuaternion(parentQuat.clone().invert()).normalize();
    bone.updateMatrix();
    driven.push({
      bone,
      rest: bone.quaternion.clone(),
      axis,
      offset,
      amp,
      halfWave,
    });
  };

  if (opts.legs) {
    add('thigh_L', THIGH, 0);
    add('thigh_R', THIGH, Math.PI);
    // 膝盖:只往后弯。相位错开一点,让小腿在摆腿的后半程才收起来。
    add('shin_L', -KNEE, Math.PI * 0.5, true);
    add('shin_R', -KNEE, Math.PI * 1.5, true);
    add('foot_L', ANKLE, Math.PI);
    add('foot_R', ANKLE, 0);
  }
  if (opts.arms) {
    // 手臂与**同侧**腿反相 —— 走路的对侧协调
    add('upperarm_L', -UPPERARM, 0);
    add('upperarm_R', -UPPERARM, Math.PI);
    add('forearm_L', -FOREARM, Math.PI * 0.5, true);
    add('forearm_R', -FOREARM, Math.PI * 1.5, true);
  }

  if (skipped.length) {
    // 不抛异常 —— 某个姿态少一根骨头不该让整个市集不动。
    // 但要报出来:静默跳过会变成"这个人走路只有一条腿在动",看图很难归因。
    console.warn(`[walk] ${rig.name} 缺少骨骼: ${skipped.join(', ')}`);
  }

  const scratch = new THREE.Quaternion();
  let phase = 0;

  return {
    update(dt, speed) {
      // 速度为 0 的人(撑船、摆摊)不该在原地踏步 —— 相位不推进,
      // 骨骼被写回 rest(下面照常执行),姿态就停在 Blender 烘好的那个姿势上。
      phase += (speed * dt) / STEP_LENGTH * Math.PI;

      for (let i = 0; i < driven.length; i++) {
        const d = driven[i]!;
        const a = phase + d.offset;
        // halfWave:只取 sin 的正半周,膝盖因此**只会往后弯**。
        // 全周正弦会让膝盖往前反折,那是人做不到的动作。
        const s = d.halfWave ? Math.max(0, Math.sin(a)) : Math.sin(a);
        scratch.setFromAxisAngle(d.axis, d.amp * s);
        d.bone.quaternion.copy(d.rest).multiply(scratch);
      }
    },

    get phase() {
      return phase;
    },
    get driven() {
      return driven.length;
    },

    boneWorld(name) {
      const b = bones.get(name);
      if (!b) return null;
      return b.getWorldPosition(new THREE.Vector3());
    },
  };
}
