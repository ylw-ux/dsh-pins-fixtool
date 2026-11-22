/**
 * 探针：冲突对比的 markdown（`buildConflictMarkdown`）。
 *
 * 这是"在新标签页查看完整对比"的内容来源。表格里出现未转义的 `|` 会把整行撑坏，
 * 正文里的换行必须变成引用行——否则对比页面读起来是坏的。
 */
const { sandbox, createSuite } = require('./lib');

const { buildConflictMarkdown } = sandbox(['quoteBlock', 'buildConflictMarkdown']);
const suite = createSuite('冲突对比：markdown 生成');

function conflict(overrides = {}) {
  return {
    sessionId: 's1',
    local: { id: 'p1', text: '本机正文\n第二行', tags: ['a'], anchor: { rawQuote: '本机', quote: '本机', rawOffset: 1, rawLength: 2, turn: 1, msgKey: 'k' } },
    incoming: { id: 'p1', text: '备份正文', tags: ['a', 'b'], anchor: { rawQuote: '备份', quote: '备份', rawOffset: 1, rawLength: 2, turn: 1, msgKey: 'k' } },
    diff: [
      { field: 'rawQuote', local: '本机', incoming: '备份' },
      { field: 'tags', local: ['a'], incoming: ['a', 'b'] },
    ],
    ...overrides,
  };
}

{
  const text = buildConflictMarkdown([conflict()]);
  suite.check('包含标题与计数', text.startsWith('# 固定片段导入冲突') && text.includes('共 1 条'));
  suite.check('逐字段表格存在', text.includes('| 字段 | 本机 | 备份 |') && text.includes('| rawQuote | 本机 | 备份 |'));
  suite.check('标签数组渲染成 #tag', text.includes('| tags | #a | #a #b |'));
  suite.check('正文以引用块呈现', text.includes('> 本机正文') && text.includes('> 第二行') && text.includes('> 备份正文'));
}

{
  const text = buildConflictMarkdown([
    conflict({
      diff: [{ field: 'rawQuote', local: '包含 | 竖线', incoming: '另一 | 段' }],
    }),
  ]);
  suite.check('表格里的竖线被转义', text.includes('包含 \\| 竖线') && text.includes('另一 \\| 段'));
}

{
  const text = buildConflictMarkdown([
    conflict({ diff: [{ field: 'rawQuote', local: '多行\n内容', incoming: '单行' }] }),
  ]);
  suite.check('单元格里的换行被压平（不破坏表格）', text.includes('| rawQuote | 多行 内容 | 单行 |'));
}

{
  const text = buildConflictMarkdown([]);
  suite.check('空冲突：只有标题，不抛', text.startsWith('# 固定片段导入冲突') && text.includes('共 0 条'));
}

suite.end();
