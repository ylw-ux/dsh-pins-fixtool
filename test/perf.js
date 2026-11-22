/**
 * 性能不变量探针：源码级断言，防这些优化被后续改动悄悄退回。
 *
 * 这些都不是"有没有功能"，而是"每帧/每次重绘做多少工作"，肉眼很难发现退化。
 *
 * 用法：node perf-probe.js <client.js>
 */
const fs = require('fs');
const path = require('path');

/** Default target: the repo's client.js; override with argv[2]. */
const CLIENT = process.argv[2] || path.join(__dirname, '..', 'client.js');
const src = fs.readFileSync(CLIENT, 'utf8');

const results = [];
const check = (name, ok, detail = '') => results.push([name, ok, detail]);

// 1) 行查找不再是对每个 pin 扫所有行
check('绘制用 byKey 查找表定位行', src.includes('const byKey = new Map();') && src.includes('byKey.get(pin.anchor?.flowKey)'));
check('绘制里不再有 rows.find 的 O(片段×行) 扫描', !/const row = rows\.find\(/.test(src));

// 2) 行查询限定在会话滚动容器内（找不到时回退 document）
check('markedRows 优先限定会话容器', /document\.querySelector\('\[data-conversation-scroll\]'\) \?\? document/.test(src));

// 3) 已定位 Range 复用
check('存在 located 缓存', /located: new Map\(\)/.test(src));
check('绘制复用缓存（行相同即复用）', /const reusable =/.test(src) && /cached\.row === row/.test(src));
check('缓存复用前校验 Range 仍在 DOM 上', /cached\.range\.startContainer\?\.isConnected !== false/.test(src));
check('被改动的行会丢弃缓存', /function dropLocatedFor\(row\)/.test(src) && /dropLocatedFor\(owner\)/.test(src));
check('删除的 pin 会从缓存修剪', /markerState\.located\.delete\(id\)/.test(src));
check('切换会话清空缓存', /markerState\.located\.clear\(\)/.test(src));

// 4) 集合未变时跳过高亮重绘
check('存在 painted 快照', /painted: \[\]/.test(src));
check('按身份比较后跳过 registry.set', /const unchanged =/.test(src) && /if \(!unchanged\) \{/.test(src));

// 5) 指针层：关闭时不排帧、微小移动不排帧
check('指针层受开关门控（不排帧）', /if \(!pinHoverOn\) return;/.test(src));
check('微小移动不重新排帧', /Math\.abs\(previous\.clientX - event\.clientX\) < 2/.test(src));
check('指针路径只在有标记时工作', /markerState\.ranges\.size === 0/.test(src));

// 6) 绘制节流：非立即的重绘走 120ms 合并
check('非立即重绘有合并延迟', /immediate === true \? 0 : 120/.test(src));

// 7) 划选读取：按帧合并 + 拖动期间跳过
check('选区读取按帧合并', /if \(readFrame === 0\) readFrame = window\.requestAnimationFrame\(readNow\)/.test(src));
check('拖动期间跳过读取', /if \(dragging\) return;/.test(src) && /let dragging = false;/.test(src));
check('松手时读一次', /const onPointerUp = \(\) => \{\s*\r?\n\s*if \(!dragging\) return;\s*\r?\n\s*dragging = false;/.test(src));
check('窗口失焦重置拖动状态', /dragging = false;\s*\r?\n\s*if \(!stateRef\.current\) return;/.test(src));
// 7) 声明顺序：presenceById 依赖 sessionGroups，必须声明在后面（否则 TDZ 崩溃）
const orderIndex = (needle) => src.indexOf(needle);
check(
  'presenceById 在 sessionGroups 之后声明',
  orderIndex('const sessionGroups = React.useMemo') >= 0 &&
    orderIndex('const presenceById = React.useMemo') > orderIndex('const sessionGroups = React.useMemo'),
);
for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + detail}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);



