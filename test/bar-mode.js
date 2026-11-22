/**
 * 浮条模式接线探针：源码级断言（不是行为测试）。
 *
 * 这些是不变量，一旦被误删就会静默变成"设置没用"或"官方浮层被 display:none 卡死在错误位置"，
 * 肉眼很难发现，所以用字符串断言把它们钉住。
 *
 * 用法：node bar-mode-probe.js <client.js>
 */
const fs = require('fs');
const path = require('path');

/** Default target: the repo's client.js; override with argv[2]. */
const CLIENT = process.argv[2] || path.join(__dirname, '..', 'client.js');
const src = fs.readFileSync(CLIENT, 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push([name, ok, detail]);

// 1) 三种模式与存储键
check('存在三种浮条模式', /const BAR_MODES = \['both', 'pins', 'official'\]/.test(src));
check('使用独立存储键 dsh-pins/bar-mode', src.includes("dsh-pins/bar-mode"));
check('非法存储值回落到 both', /BAR_MODES\.includes\(raw\) \? raw : 'both'/.test(src));

// 2) 隐藏官方浮层必须用 visibility，不能用 display（否则宿主测不到尺寸）
const rule = /html\[data-dsh-pins-bar-mode="pins"\] \[data-text-interaction-surface\]\{([^}]*)\}/.exec(src);
check('存在按模式隐藏官方浮层的 CSS 规则', rule !== null);
if (rule) {
  const body = rule[1];
  check('用 visibility 而不是 display', /visibility:\s*hidden/.test(body) && !/display:\s*none/.test(body), body.trim());
  check('带 !important（要压过宿主的内联样式）', /visibility:hidden!important/.test(body));
  check('同时关掉 pointer-events', /pointer-events:none!important/.test(body));
}

// 3) 模式切换要落盘 + 广播
check('setBarMode 写入存储', /writeJson\(BAR_MODE_KEY, next\)/.test(src));
check('setBarMode 广播 bar-mode 事件', /dispatchEvent\(new CustomEvent\('bar-mode'/.test(src));
check('apply() 启动时应用模式', /applyBarMode\(\);\s*own\(\(\) => \{\s*delete document\.documentElement\.dataset\.dshPinsBarMode/.test(src));

// 4) 只用官方时本插件浮条不渲染
check('FloatingActions 按模式门控浮条', /state && mode !== 'official' \? h\(Toolbar/.test(src));

// 5) 识别宿主浮层用的是公开 hook，不是哈希类名
check('用 data-text-interaction-surface 识别宿主浮层', src.includes('[data-text-interaction-surface]'));
check('不依赖哈希类名（CFlEEG 之类）', !/CFlEEG/.test(src));

// 6) 定位：优先选区下方
check('placeBar 先算 below 并返回', /const below = rect\.bottom \+ gap;/.test(src) && /if \(below \+ barHeight <= floor && !taken\(below\)\) return below;/.test(src));

// 7) 设置页有控制项
check('设置页渲染三种模式按钮', /BAR_MODES\.map\(\(id\) =>/.test(src) && src.includes("title: '选区浮条'"));

for (const [name, ok, detail] of results) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? '\n      ' + detail : ''}`);
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);


