/**
 * 重叠判定探针：抽出 client.js 里的 findOverlappingPin + countOverlappingPins 真跑。
 * 重点是"首尾相接不算重叠"与"读不到偏移时不拦"。
 * 用法：node overlap-probe.js <client.js>
 */
const fs = require('fs');
const path = require('path');

/** Default target: the repo's client.js; override with argv[2]. */
const CLIENT = process.argv[2] || path.join(__dirname, '..', 'client.js');
const src = fs.readFileSync(CLIENT, 'utf8');

function extract(name) {
  const m = new RegExp(`(?:async )?function ${name}\\(`).exec(src);
  if (!m) throw new Error(`找不到 ${name}`);
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error(`${name} 没有闭合`);
}

const factory = new Function(
  `${extract('findOverlappingPin')}\n${extract('countOverlappingPins')}\nreturn { findOverlappingPin, countOverlappingPins };`,
);
const { findOverlappingPin, countOverlappingPins } = factory();

const results = [];
const check = (name, ok, detail = '') => results.push([name, ok, detail]);

/** 造一条 pin 或候选锚点。 */
const mk = (flowKey, offset, quote, node) => ({ id: `${flowKey}#${offset}`, anchor: { flowKey, node: node ?? flowKey, offset, quote } });
const cand = (flowKey, offset, quote, node) => ({ flowKey, node: node ?? flowKey, offset, quote });

// —— 应当拦下 ——
check('完全同一段 → 拦', findOverlappingPin([mk('r1', 10, 'abcdef')], cand('r1', 10, 'abcdef')) !== null);
check('部分重叠 → 拦', findOverlappingPin([mk('r1', 10, 'abcdef')], cand('r1', 13, 'defghi')) !== null);
check('候选被包含 → 拦', findOverlappingPin([mk('r1', 10, 'abcdefgh')], cand('r1', 12, 'cd')) !== null);
check('候选包含旧的 → 拦', findOverlappingPin([mk('r1', 12, 'cd')], cand('r1', 10, 'abcdefgh')) !== null);

// —— 应当放行 ——
check('首尾相接（候选在后）→ 放行', findOverlappingPin([mk('r1', 10, 'abcdef')], cand('r1', 16, 'ghij')) === null);
check('首尾相接（候选在前）→ 放行', findOverlappingPin([mk('r1', 10, 'abcdef')], cand('r1', 4, 'wxyz')) === null);
check('中间有间隔 → 放行', findOverlappingPin([mk('r1', 10, 'abcd')], cand('r1', 20, 'xyz')) === null);
check('不同行 → 放行', findOverlappingPin([mk('r1', 10, 'abcdef')], cand('r2', 10, 'abcdef')) === null);
check('同一行但不同节点 → 放行', findOverlappingPin([mk('r1', 10, 'abcdef', 'n1')], cand('r1', 10, 'abcdef', 'n2')) === null);
check('旧片段偏移读不到 → 放行', findOverlappingPin([mk('r1', -1, 'abcdef')], cand('r1', 10, 'abcdef')) === null);
check('候选偏移读不到 → 放行', findOverlappingPin([mk('r1', 10, 'abcdef')], cand('r1', -1, 'abcdef')) === null);
check('空 quote → 放行', findOverlappingPin([mk('r1', 10, '')], cand('r1', 10, 'abc')) === null);
check('截断片段之后紧接的选区 → 放行', findOverlappingPin([mk('r1', 0, 'x'.repeat(2000))], cand('r1', 2000, 'yy')) === null);

// —— 计数 ——
check('无重叠 → 0', countOverlappingPins([mk('r1', 0, 'abcd'), mk('r1', 10, 'efgh')]) === 0);
check('一对重叠 → 1', countOverlappingPins([mk('r1', 0, 'abcdef'), mk('r1', 4, 'ghij')]) === 1);
check('三条：第三条与第二条首尾相接 → 只算 1', countOverlappingPins([mk('r1', 0, 'abcdefghij'), mk('r1', 5, 'abcdefghij'), mk('r1', 15, 'abcdefghij')]) === 1);
check('三条：第三条咬进第二条 → 算 2', countOverlappingPins([mk('r1', 0, 'abcdefghij'), mk('r1', 5, 'abcdefghij'), mk('r1', 14, 'abcdefghij')]) === 2);
check('嵌套三条 → 2', countOverlappingPins([mk('r1', 0, 'x'.repeat(100)), mk('r1', 10, 'x'.repeat(10)), mk('r1', 30, 'x'.repeat(10))]) === 2);
check('不同行各自独立 → 0', countOverlappingPins([mk('r1', 0, 'abcdef'), mk('r2', 4, 'abcdef')]) === 0);
check('计数忽略读不到偏移的记录', countOverlappingPins([mk('r1', -1, 'abcdef'), mk('r1', 0, 'abc')]) === 0);

for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '\n      ' + detail}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

