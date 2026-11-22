/**
 * 探针：标签补全的排序与匹配（`suggestTags`）。
 *
 * 覆盖：空输入、前缀优先于内部命中、次数兜底、大小写不敏感、`#` 归一化、中文子串、
 * 无匹配、已用标记。这些是"输入体验"的全部规则，退化后肉眼很难发现。
 */
const { sandbox, createSuite } = require('./lib');

const { suggestTags } = sandbox(['normalizeTag', 'suggestTags']);
const suite = createSuite('标签补全：匹配与排序');

const vocab = [
  { tag: 'guide', count: 1 },
  { tag: 'argue', count: 9 },
  { tag: 'Guide', count: 2 },
  { tag: 'guding', count: 4 },
  { tag: '固定', count: 7 },
  { tag: 'tag-a', count: 1 },
  { tag: 'tag-b', count: 5 },
];

const names = (rows) => rows.map((row) => row.tag).join(',');

suite.check('空输入不显示列表', suggestTags(vocab, '', new Set()).length === 0);
suite.check(
  '前缀命中排在内部命中之前（即使次数更少）',
  names(suggestTags(vocab, 'gu', new Set())) === 'guding,Guide,guide,argue',
  names(suggestTags(vocab, 'gu', new Set())),
);
suite.check(
  '同为前缀命中时，次数多的在前',
  names(suggestTags(vocab, 'tag', new Set())) === 'tag-b,tag-a',
  names(suggestTags(vocab, 'tag', new Set())),
);
suite.check('大小写不敏感（大写输入命中），并按次数排序', names(suggestTags(vocab, 'GUI', new Set())) === 'Guide,guide');
suite.check('前导 # 被归一化掉', names(suggestTags(vocab, '#gui', new Set())) === 'Guide,guide');
suite.check('前后空白被忽略', names(suggestTags(vocab, '  gui  ', new Set())) === 'Guide,guide');
suite.check('中文子串命中', names(suggestTags(vocab, '固', new Set())) === '固定');
suite.check('无匹配返回空', suggestTags(vocab, 'zzz', new Set()).length === 0);

{
  const rows = suggestTags(vocab, 'tag', new Set(['tag-b']));
  const marked = rows.find((row) => row.tag === 'tag-b');
  const other = rows.find((row) => row.tag === 'tag-a');
  suite.check('已在该片段上的标签标 taken=true', Boolean(marked) && marked.taken === true);
  suite.check('已用标签不被隐藏', Boolean(marked));
  suite.check('未用标签 taken=false', Boolean(other) && other.taken === false);
}

suite.end();
