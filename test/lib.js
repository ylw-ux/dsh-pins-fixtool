/**
 * 探针公共设施：把 client.js 里的函数/常量抽出来做「值级断言」。
 *
 * 插件的浏览器半边没有导出、也没有构建步骤，所以探针直接读源码、只求值它要断言的那几段。
 * 这不是重构许可：抽出来的必须是与 UI 无关的纯函数（解析、判重、比对）。
 */
const fs = require('fs');
const path = require('path');

const CLIENT = path.join(__dirname, '..', 'client.js');

function readClient() {
  return fs.readFileSync(CLIENT, 'utf8');
}

/** 一个 `function name(...) { ... }` 声明的源码。 */
function functionSource(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`找不到函数 ${name}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${name} 没有闭合`);
}

/** 一个 `const NAME = ...;` 声明（支持多行数组/Set 字面量）。 */
function constantSource(source, name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`找不到常量 ${name}`);
  let depth = 0;
  for (let i = start + marker.length; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') depth -= 1;
    else if (ch === ';' && depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`常量 ${name} 没有结束`);
}

/**
 * 求值一组声明，返回它们组成的对象。
 *
 * @param {string[]} functions 需要的函数（按依赖顺序）。
 * @param {{constants?: string[], source?: string}} options 需要的常量与源码。
 */
function sandbox(functions, options = {}) {
  const source = options.source ?? readClient();
  const constants = options.constants ?? [];
  const parts = [];
  // Definitions the probe supplies itself (stubs for storage, the store, module `let`s), placed
  // before the extracted source so extracted declarations can read them.
  if (options.preamble) parts.push(options.preamble);
  for (const name of constants) parts.push(constantSource(source, name));
  for (const name of functions) parts.push(functionSource(source, name));
  const names = [...constants, ...functions];
  const factory = new Function(`${parts.join('\n')}\nreturn { ${names.join(', ')} };`);
  return factory();
}

/** 最小断言集：每条一行 PASS/FAIL，最后汇总并设置退出码。 */
function createSuite(title) {
  const rows = [];
  return {
    check(name, ok, detail = '') {
      rows.push([name, Boolean(ok), detail]);
    },
    end() {
      console.log(`\n${title}`);
      for (const [name, ok, detail] of rows) {
        console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `\n      ${detail}` : ''}`);
      }
      const failed = rows.filter(([, ok]) => !ok).length;
      console.log(failed === 0 ? `全部通过（${rows.length} 项）` : `${failed} 项失败`);
      if (failed > 0) process.exitCode = 1;
      return failed === 0;
    },
  };
}

module.exports = { CLIENT, readClient, functionSource, constantSource, sandbox, createSuite };

