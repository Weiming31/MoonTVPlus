#!/usr/bin/env node
/**
 * EdgeOne / 通用构建前的皮肤覆盖（skin overlay）。
 *
 * 皮肤放在 .skin/ 下，按上游相对路径组织：
 *   .skin/files/**                  → 直接覆盖到仓库根（16 个文件）
 *   .skin/theme.css                 → 额外落到 public/icons/skin/theme.css
 *
 * 为什么 theme.css 要单独搬：
 *   后台「主题设置 → 自定义 CSS」里那行 `@import url("/icons/skin/theme.css")`
 *   要求这个 URL 真实存在。.skin/files/ 里没有它（Docker 镜像也一样），
 *   所以过去用户必须手动把 30KB 的 theme.css 粘进后台文本框。
 *   overlay 顺手把它放到 public/icons/skin/ 下，部署完只要粘一行 @import 就行。
 *
 * 设计约束：
 *   1. 只做文件覆盖，不碰任何业务逻辑、不改任何 className。
 *   2. 幂等：反复执行结果一致；--check 只校验不写盘。
 *   3. 覆盖后立刻断言「页面确实是皮肤版」，否则直接失败退出，
 *      绝不让半覆盖的产物静默部署出去。
 *
 * 用法：
 *   node scripts/skin-overlay.mjs            # 覆盖 + 断言
 *   node scripts/skin-overlay.mjs --check    # 只断言当前工作区是不是皮肤版
 *   SKIN_OVERLAY=0 node scripts/skin-overlay.mjs   # 显式跳过（返回 0）
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIN_DIR = join(ROOT, '.skin');
const SKIN_FILES = join(SKIN_DIR, 'files');
const SKIN_THEME = join(SKIN_DIR, 'theme.css');
const THEME_TARGET = join(ROOT, 'public', 'icons', 'skin', 'theme.css');

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');
const QUIET = args.has('--quiet');

function log(msg) {
  if (!QUIET) console.log(`[skin] ${msg}`);
}

function fail(msg) {
  console.error(`[skin] ✗ ${msg}`);
  process.exit(1);
}

/** 递归列出目录下所有文件（相对路径，统一用 / 分隔，跨平台可比对）。 */
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

function applyOverlay() {
  if (!existsSync(SKIN_FILES)) {
    fail(`缺少皮肤目录：${SKIN_FILES}`);
  }

  const files = walk(SKIN_FILES);
  if (files.length === 0) fail('.skin/files 是空的');

  let written = 0;
  for (const rel of files) {
    const src = join(SKIN_FILES, rel);
    const dst = join(ROOT, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    written += 1;
  }
  log(`覆盖 ${written} 个皮肤文件到仓库根`);

  // theme.css：让 /icons/skin/theme.css 这个 URL 真实可用
  if (existsSync(SKIN_THEME)) {
    mkdirSync(dirname(THEME_TARGET), { recursive: true });
    copyFileSync(SKIN_THEME, THEME_TARGET);
    log(`主题皮肤 → public/icons/skin/theme.css（${(statSync(SKIN_THEME).size / 1024).toFixed(1)} KB）`);
  } else {
    console.warn('[skin] ! .skin/theme.css 不存在，/icons/skin/theme.css 将 404');
  }
}

function read(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 断言工作区确实是皮肤版。
 * 前三条与 .github/workflows/skin-image.yml 保持一致（同一套护栏），
 * 后面几条是 EdgeOne 特有的（静态资源、theme.css）。
 */
function assertSkinApplied() {
  const errors = [];

  const login = read(join(ROOT, 'src', 'app', 'login', 'page.tsx'));
  const register = read(join(ROOT, 'src', 'app', 'register', 'page.tsx'));

  if (!login.includes('AuthShell')) {
    errors.push('src/app/login/page.tsx 不是皮肤版（缺 AuthShell）');
  }
  if (!register.includes('AuthShell')) {
    errors.push('src/app/register/page.tsx 不是皮肤版（缺 AuthShell）');
  }
  if (!existsSync(join(ROOT, 'src', 'components', 'auth-skin', 'AuthShell.tsx'))) {
    errors.push('缺 src/components/auth-skin/AuthShell.tsx');
  }
  if (!existsSync(join(ROOT, 'src', 'components', 'auth-skin', 'auth-skin.css'))) {
    errors.push('缺 src/components/auth-skin/auth-skin.css');
  }

  // 登录页标题居中标记（皮肤版的版式依赖它）
  if (!login.includes('auth-title--center')) {
    errors.push('登录页标题未居中（缺 auth-title--center）');
  }
  // 残留的旧版副标题：注意用 className 精确匹配，
  // 按钮类名 auth-submit 也含 auth-sub 子串，裸匹配会误判。
  if (login.includes("className='auth-sub'")) {
    errors.push('登录页残留旧版 auth-sub 副标题');
  }

  // 背景资源必须齐全，缺一个就会掉档到纯色
  const bgDir = join(ROOT, 'public', 'icons', 'skin');
  const need = [
    'login-bg-1440.av1.mp4',
    'login-bg-1440.h264.mp4',
    'login-bg-640.av1.mp4',
    'login-bg-640.h264.mp4',
    'login-bg-poster-1440.webp',
    'login-bg-poster-640.webp',
  ];
  const missing = need.filter((n) => {
    const p = join(bgDir, n);
    return !existsSync(p) || statSync(p).size === 0;
  });
  if (missing.length) {
    errors.push(`背景资源不全：缺 ${missing.join(', ')}`);
  }

  // PWA / iOS 主屏图标：尺寸必须齐全，否则会挑到上游旧图
  for (const s of [192, 256, 384, 512]) {
    const p = join(ROOT, 'public', 'icons', `icon-${s}x${s}.png`);
    if (!existsSync(p) || statSync(p).size === 0) {
      errors.push(`缺 public/icons/icon-${s}x${s}.png`);
    }
  }
  if (!existsSync(join(ROOT, 'public', 'favicon.ico'))) {
    errors.push('缺 public/favicon.ico');
  }

  if (errors.length) {
    for (const e of errors) console.error(`[skin] ✗ ${e}`);
    fail(`皮肤覆盖校验失败（${errors.length} 项）`);
  }

  log('校验通过：登录/注册页、auth-skin 组件、6 个背景资源、PWA 图标齐全');
}

export function applySkinOverlay({ checkOnly = false, quiet = false } = {}) {
  const say = quiet ? () => {} : log;

  if (process.env.SKIN_OVERLAY === '0' || process.env.SKIN_OVERLAY === 'false') {
    log('SKIN_OVERLAY=0，跳过皮肤覆盖（将部署上游原生外观）');
    return { skipped: true };
  }

  if (checkOnly) {
    say('--check 模式：只校验，不写盘');
    assertSkinApplied();
    return { checked: true };
  }

  applyOverlay();
  assertSkinApplied();

  if (!existsSync(THEME_TARGET)) {
    console.warn('[skin] ! /icons/skin/theme.css 未就位，主站主题皮肤需手动粘贴');
  } else {
    say('主站主题皮肤已就位：部署后在后台自定义 CSS 粘一行 @import url("/icons/skin/theme.css");');
  }
  return { applied: true };
}

// 作为 CLI 直接调用时执行；被 edgeone-build.mjs import 时只导出函数。
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  applySkinOverlay({ checkOnly: CHECK_ONLY, quiet: QUIET });
}