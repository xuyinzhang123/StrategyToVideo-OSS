'use strict';
// 跨机器根目录解析：仅依赖本文件在仓库中的相对位置，与启动 CWD 无关。
// 本文件位于 <root>/web/src/paths.js
const path = require('node:path');

const WEB_DIR = path.resolve(__dirname, '..');                 // <root>/web
const PROJECT_ROOT = process.env.STRATEGY_TO_VIDEO_ROOT
  || path.resolve(__dirname, '..', '..');                      // <root>
const PUBLIC_DIR = path.join(WEB_DIR, 'public');               // <root>/web/public
const DEPS_DIR = path.join(PROJECT_ROOT, 'deps');              // <root>/deps
const ENGINE_NEXT_DIR = path.join(PROJECT_ROOT, 'engine_next');

function resolve() {
  return { PROJECT_ROOT, WEB_DIR, PUBLIC_DIR, DEPS_DIR, ENGINE_NEXT_DIR };
}

module.exports = {
  PROJECT_ROOT, WEB_DIR, PUBLIC_DIR, DEPS_DIR, ENGINE_NEXT_DIR, resolve,
};
