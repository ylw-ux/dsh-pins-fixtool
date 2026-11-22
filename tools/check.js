#!/usr/bin/env node
/**
 * 一条命令跑完全部守卫与探针。
 *
 * 顺序：先语法（最便宜、失败最致命），再两道守卫，最后逐组探针。任何一步非零即停，
 * 后续不再执行——半套绿灯比红灯更误导。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const steps = [
  { title: '语法检查', args: ['--check', 'client.js'] },
  { title: 'CSS 反引号守卫', args: ['tools/check-css-guard.js'] },
  { title: '主题令牌守卫', args: ['tools/check-tokens.js'] },
  { title: '版本号一致性', args: ['test/version-sync.js'] },
  { title: '备份往返（值级）', args: ['test/round-trip.js'] },
  { title: '坏文件拒绝', args: ['test/bad-file.js'] },
  { title: '降级可读性', args: ['test/downgrade.js'] },
  { title: '冲突对比 markdown', args: ['test/conflict-markdown.js'] },
  { title: '标签补全排序', args: ['test/suggest-tags.js'] },
  { title: '标签键盘语义', args: ['test/tagkeys.js'] },
  { title: '独立标签容错', args: ['test/extra-tags.js'] },
  { title: '浮条模式接线', args: ['test/bar-mode.js'] },
  { title: '重叠判定', args: ['test/overlap.js'] },
  { title: '性能不变量', args: ['test/perf.js'] },
];

let failed = 0;
for (const step of steps) {
  console.log(`\n── ${step.title} ─────────────────────────────`);
  const result = spawnSync(process.execPath, step.args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) {
    console.error(`✗ 无法执行 ${step.args.join(' ')}：${result.error.message}`);
    failed = 1;
    break;
  }
  if (result.status !== 0) {
    console.error(`✗ ${step.title} 失败（退出码 ${result.status}）`);
    failed = result.status ?? 1;
    break;
  }
}

if (failed === 0) console.log('\n✓ 全部检查通过');
process.exit(failed);

