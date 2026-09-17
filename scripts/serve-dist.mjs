#!/usr/bin/env node
/**
 * 零依赖静态服务器。
 *
 * 为什么不直接用 `vite preview`:本作品需要验证「无 Content-Length 时
 * 加载进度是否仍然准确」,而 vite preview 无法关闭该响应头。
 * 另外它支持 --no-content-length 来复现弱网/分块传输场景。
 *
 * 用法:
 *   node scripts/serve-dist.mjs --dir dist --port 4173
 *   node scripts/serve-dist.mjs --dir dist --port 4173 --no-content-length
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.hdr': 'image/vnd.radiance',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

function parseArgs(argv) {
  const args = { dir: 'dist', port: 4173, noContentLength: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--no-content-length') args.noContentLength = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node scripts/serve-dist.mjs [--dir dist] [--port 4173] [--no-content-length]');
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(process.cwd(), args.dir);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // 防目录穿越:规范化后必须仍在 root 之内
    const target = resolve(join(root, normalize(pathname)));
    if (!target.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    let filePath = target;
    let info;
    try {
      info = await stat(filePath);
      if (info.isDirectory()) {
        filePath = join(filePath, 'index.html');
        info = await stat(filePath);
      }
    } catch {
      // SPA 回退:单页应用的路由请求返回 index.html
      try {
        filePath = join(root, 'index.html');
        info = await stat(filePath);
      } catch {
        res.writeHead(404).end('Not Found');
        return;
      }
    }

    const headers = {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      // 用 SharedArrayBuffer 的模块需要这两个头;这里一并给上,便于将来接 AudioWorklet
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    };

    // --no-content-length:模拟分块传输,用来验证进度条不依赖 Content-Length
    if (!args.noContentLength) {
      headers['Content-Length'] = String(info.size);
      res.writeHead(200, headers);
      createReadStream(filePath).pipe(res);
    } else {
      headers['Transfer-Encoding'] = 'chunked';
      res.writeHead(200, headers);
      const stream = createReadStream(filePath, { highWaterMark: 16 * 1024 });
      // 故意加一点延迟,让进度变化可观测
      stream.on('data', (chunk) => {
        res.write(chunk);
      });
      stream.on('end', () => res.end());
    }
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
});

server.listen(args.port, '127.0.0.1', () => {
  if (!args.quiet) {
    console.log(`静态服务已启动: http://127.0.0.1:${args.port}/  (根目录 ${root})`);
    if (args.noContentLength) console.log('模式: --no-content-length(不发送 Content-Length)');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
