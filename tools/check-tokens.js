#!/usr/bin/env node
/**
 * 守卫：client.js 的 CSS 里用到的每个宿主令牌，都必须在宿主里真实定义。
 *
 * 背景：DSH 的令牌是"查到才存在"的。写错一个名字（例如 --dsw-alias-label-muted）
 * 不会报错、不会告警，那条声明会在计算值阶段失效，而且在亮暗两套主题下表现不同，
 * 是最难查的一类 UI bug。本脚本把"肉眼核对"变成一次退出码。
 *
 * 检查对象：
 *   --dsw-*       宿主主题令牌（颜色、圆角、字号、阴影、焦点环、状态色……）
 *   --dsh-*       宿主阅读偏好变量（例如 --dsh-content-font-delta）
 * 不检查以 --dsh-pins- 开头的变量：那是插件自己声明并使用的，不是宿主令牌。
 *
 * 用法：
 *   node "D:\Users\lenovo\Desktop\dsh插件\设计文档\check-tokens.js"
 *   node ...\check-tokens.js --host "C:\...\node_modules\@deepseek-ai"
 *
 * 退出码：0 = 全部存在，1 = 有令牌在宿主里找不到，2 = 参数或文件错误。
 */
const fs = require('fs');
const path = require('path');

const BACKTICK = String.fromCharCode(96);
const ROOT = path.join(__dirname, '..');
const DEFAULT_CLIENT = path.join(ROOT, 'client.js');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const clientPath = argValue('--client') || DEFAULT_CLIENT;
const hostRoot =
  argValue('--host') ||
  process.env.DSH_HOST_PACKAGES ||
  'D:\\DeepSeekHarness\\dsh\\node_cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai';

if (!fs.existsSync(clientPath)) {
  console.error(`找不到 client.js：${clientPath}`);
  process.exit(2);
}
if (!fs.existsSync(hostRoot)) {
  console.error(`找不到宿主目录：${hostRoot}`);
  console.error('用 --host 指定 node_modules/@deepseek-ai 的绝对路径。');
  process.exit(2);
}

/** The CSS template, using the same boundaries as check-css-guard.js. */
function readCss(text) {
  const mark = 'const css = ' + BACKTICK;
  const start = text.indexOf(mark);
  if (start < 0) return null;
  const bodyStart = start + mark.length;
  const end = text.indexOf(BACKTICK + ';', bodyStart);
  if (end < 0) return null;
  return text.slice(bodyStart, end);
}

const source = fs.readFileSync(clientPath, 'utf8');
const css = readCss(source);
if (css === null) {
  console.error('找不到 CSS 模板边界（const css = ' + BACKTICK + ' ... ' + BACKTICK + ';）');
  process.exit(2);
}

/** Every host token the stylesheet reads, our own namespace excluded. */
const used = new Set();
for (const match of css.matchAll(/--(dsw|dsh)-([a-z0-9-]+)/g)) {
  const name = '--' + match[1] + '-' + match[2];
  if (name.startsWith('--dsh-pins-')) continue;
  used.add(name);
}

/** Every token name the installed host packages declare (`--name:` wherever it lives). */
const declared = new Map();
const files = [];
function walk(dir, depth) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 12) walk(full, depth + 1);
      continue;
    }
    if (/\.(js|mjs|cjs|css)$/.test(entry.name)) files.push(full);
  }
}
walk(hostRoot, 0);

for (const file of files) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const match of text.matchAll(/(--(?:dsw|dsh)-[a-z0-9-]+)\s*:/g)) {
    if (!declared.has(match[1])) declared.set(match[1], path.relative(hostRoot, file));
  }
}

const missing = [...used].filter((name) => !declared.has(name)).sort();
const version = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(hostRoot, 'dsh', 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

console.log(`宿主版本：${version}`);
console.log(`扫描文件：${files.length}，宿主声明令牌：${declared.size}，本插件使用：${used.size}`);

if (missing.length > 0) {
  console.error(`FAIL：${missing.length} 个令牌在宿主里找不到定义`);
  for (const name of missing) console.error(`  ${name}`);
  process.exit(1);
}

console.log('令牌 OK（全部在宿主里存在）');
