/**
 * 探针：版本号是否一致。
 *
 * 浏览器半边读不到 package.json，所以 `PLUGIN_VERSION` 是手写常量。这个探针保证它不会
 * 落后于已发布的版本（落后会让备份文件里的 host 标签说谎），并在不一致时给出提示。
 */
const fs = require('fs');
const path = require('path');
const { createSuite } = require('./lib');

const ROOT = path.join(__dirname, '..');
const suite = createSuite('版本号一致性');

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const versionOf = (value) => String(value).split('.').map((part) => Number.parseInt(part, 10) || 0);

function compare(left, right) {
  const a = versionOf(left);
  const b = versionOf(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const one = a[i] ?? 0;
    const other = b[i] ?? 0;
    if (one !== other) return one > other ? 1 : -1;
  }
  return 0;
}

const pkg = JSON.parse(read('package.json'));
const client = read('client.js');
const constant = /const PLUGIN_VERSION = '([^']+)';/.exec(client);
const pluginVersion = constant ? constant[1] : '';

suite.check('client.js 里有 PLUGIN_VERSION', pluginVersion !== '', '未找到常量');

// 常量可以领先（正在开发下一个版本），但绝不允许落后于已发布的版本。
suite.check(
  `PLUGIN_VERSION (${pluginVersion}) 不低于 package.json (${pkg.version})`,
  compare(pluginVersion, pkg.version) >= 0,
  '常量落后于 package.json —— 备份文件里的 host 标签会说谎',
);

// README 的「最近更新」不能比包版本旧，否则 npm 页面会显示一个过时的版本号。
const readme = read('README.md');
const heading = /## 最近更新：([0-9]+\.[0-9]+\.[0-9]+)/.exec(readme);
const headingVersion = heading ? heading[1] : '';
suite.check(`README「最近更新」不低于 package.json（${headingVersion || '未找到'}）`, headingVersion !== '' && compare(headingVersion, pkg.version) >= 0);

if (pluginVersion !== pkg.version) {
  console.log(`提示：PLUGIN_VERSION=${pluginVersion}，package.json=${pkg.version}；发版时两者应相同。`);
}

suite.end();
