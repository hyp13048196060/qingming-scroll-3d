#!/usr/bin/env node
/**
 * 读一张 PNG 的指定像素,打印数值。
 *
 * 为什么要有这个:贴图这条路线上,"看着对"是**最不可靠的一种判据**。
 * 一张 128×128 的竖条纹图缩到几十像素显示,摩尔纹会把它糊成一片灰白,
 * 于是"亮带在上还是在下"根本看不出来 —— 而亮带在哪儿正是我判断
 * 图像行序的唯一依据。缩略图会骗人,像素值不会。
 *
 * 只用 node 内置的 zlib,不装依赖。
 *
 *   node tasks/png_probe.mjs <file.png> [x,y ...]
 *   node tasks/png_probe.mjs <file.png> --rowscan
 *       --rowscan 打印每一行的平均灰度(用于一眼看出行方向的明暗分布)
 */

import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
  let off = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const typ = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (typ === "IHDR") {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      bd = body.readUInt8(8);
      ct = body.readUInt8(9);
    } else if (typ === "IDAT") idat.push(body);
    else if (typ === "IEND") break;
    off += 12 + len;
  }
  if (bd !== 8) throw new Error(`只处理 8 位 PNG,这张 ${bd} 位`);
  const nch = CH[ct];
  if (!nch) throw new Error(`不支持的颜色类型 ${ct}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * nch;
  const px = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= nch ? line[i - nch] : 0;
      const b = prev[i];
      const c = i >= nch ? prev[i - nch] : 0;
      let add = 0;
      if (ft === 1) add = a;
      else if (ft === 2) add = b;
      else if (ft === 3) add = (a + b) >> 1;
      else if (ft === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 0xff;
    }
    line.copy(px, y * stride);
    prev = line;
  }
  return { w, h, nch, px, at: (x, y) => {
    const o = (y * w + x) * nch;
    return [px[o], nch >= 3 ? px[o + 1] : px[o], nch >= 3 ? px[o + 2] : px[o]];
  }};
}

function main() {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) {
    console.error("用法: node tasks/png_probe.mjs <file.png> [x,y ... | --rowscan]");
    process.exit(2);
  }
  const im = decodePng(readFileSync(file));
  console.log(`${file}: ${im.w}×${im.h}, ${im.nch} 通道`);

  if (rest.includes("--rowscan")) {
    for (let y = 0; y < im.h; y++) {
      let s = 0;
      for (let x = 0; x < im.w; x++) s += im.at(x, y)[0];
      const avg = s / im.w;
      // 只在明显变化处打印,否则 128 行刷屏
      const prevY = y - 1;
      let prevAvg = -1;
      if (prevY >= 0) {
        let s2 = 0;
        for (let x = 0; x < im.w; x++) s2 += im.at(x, prevY)[0];
        prevAvg = s2 / im.w;
      }
      if (y === 0 || Math.abs(avg - prevAvg) > 6 || y === im.h - 1) {
        console.log(`  y=${String(y).padStart(3)}  平均灰度 ${avg.toFixed(1)}`);
      }
    }
    return;
  }

  for (const spec of rest) {
    const [x, y] = spec.split(",").map(Number);
    console.log(`  (${x},${y}) = ${im.at(x, y).join(", ")}`);
  }
  if (!rest.length) {
    const pts = [[0, 0], [im.w >> 2, 0], [im.w - 1, 0], [0, im.h - 1],
                 [im.w >> 1, im.h - 1]];
    for (const [x, y] of pts) console.log(`  (${x},${y}) = ${im.at(x, y).join(", ")}`);
  }
}

// ⚠️ 不要写成 `import.meta.url === \`file://${argv1}\`` —— Windows 上
//    `import.meta.url` 是 `file:///D:/…`(三斜杠),而拼出来的是
//    `file://D:/…`(两斜杠),恒不相等,于是脚本**一声不响地什么都不做**
//    (退出码 0)。这正是本项目那个老形状:静默通过。
//    比文件名(去掉扩展名)才是跨平台稳的。
const _self = import.meta.url.split("/").pop().replace(/\.mjs$/, "");
if ((process.argv[1] || "").replace(/\\/g, "/").split("/").pop()
      ?.replace(/\.mjs$/, "") === _self) main();
