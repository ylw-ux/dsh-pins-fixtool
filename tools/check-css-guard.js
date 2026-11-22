#!/usr/bin/env node
/**
 * 守卫：client.js 里那段 CSS 模板字符串不得包含反引号。
 *
 * 背景：插件的样式写在 `const css = ` + 反引号 + `...` 里。CSS 内部一旦出现反引号，
 * 整个模块变成非法 JS → 白屏，而且报错位置常常离真正的编辑处很远，极难定位。
 *
 * 用法：
 *   node "D:\Users\lenovo\Desktop\dsh插件\设计文档\check-css-guard.js"
 *   node ...\check-css-guard.js <别的 client.js 路径>
 *
 * 退出码：0 = 通过，1 = 发现反引号，2 = 找不到模板边界。
 */
const fs = require('fs');
const path = require('path');

const BACKTICK = String.fromCharCode(96);
const target = process.argv[2] || path.join(__dirname, '..', 'client.js');

if (!fs.existsSync(target)) {
  console.error(`找不到文件：${target}`);
  process.exit(2);
}

const text = fs.readFileSync(target, 'utf8');
const mark = 'const css = ' + BACKTICK;
const start = text.indexOf(mark);
if (start < 0) {
  console.error('找不到 CSS 模板起点（const css = ' + BACKTICK + '）');
  process.exit(2);
}

const body = text.slice(start + mark.length);
const end = body.indexOf(BACKTICK + ';');
if (end < 0) {
  console.error('找不到 CSS 模板终点（' + BACKTICK + ';）');
  process.exit(2);
}

const css = body.slice(0, end);
const bad = css.indexOf(BACKTICK);
if (bad >= 0) {
  const line = text.slice(0, start + mark.length + bad).split('\n').length;
  console.error(`FAIL：CSS 模板里出现反引号，约在 ${path.basename(target)} 第 ${line} 行`);
  process.exit(1);
}

console.log(`CSS OK（${css.length} 字符，无反引号）`);
