/**
 * 探针：坏文件一条不写。
 *
 * 逐条构造"能想到的最坏输入"，断言解析器要么整齐拒绝（ok:false + reason），要么把危险内容
 * 剥掉后收下（截断/丢弃非法记录），绝不半途抛异常。
 */
const { sandbox, createSuite } = require('./lib');

const api = sandbox(
  [
    'normalizeTag',
    'normalizeSort',
    'backupObject',
  'backupNumber',
    'backupString',
    'backupTags',
    'backupAnchor',
    'backupPin',
    'backupSession',
    'parseBackup',
  ],
  {
    constants: [
      'BACKUP_FORMAT',
      'BACKUP_VERSION',
      'BACKUP_MAX_BYTES',
      'BACKUP_MAX_PINS',
      'BACKUP_MAX_SESSIONS',
      'BACKUP_MAX_TEXT',
      'BACKUP_MAX_TAGS_PER_PIN',
      'BACKUP_MAX_EXTRA_TAGS',
      'BACKUP_MAX_TITLE',
      'ANCHOR_FIELDS',
      'BACKUP_ANCHOR_NUMBERS',
      'BACKUP_ANCHOR_FLAGS',
      'SORT_MODES',
      'BAR_MODES',
    ],
  },
);

const suite = createSuite('坏文件：整齐拒绝，一条不写');

const file = (overrides = {}) => ({
  format: api.BACKUP_FORMAT,
  version: api.BACKUP_VERSION,
  data: { sessions: {}, extraTags: [], msgOrder: {} },
  ...overrides,
});

const rejected = (name, text, reason) => {
  const result = api.parseBackup(text);
  suite.check(name, result.ok === false && result.reason === reason, JSON.stringify(result).slice(0, 160));
};

// 1. 整包级拒绝
rejected('空文本 → empty', '', 'empty');
rejected('只有空白 → empty', '   \n ', 'empty');
rejected('半截 JSON → json', '{"format":"dsh-pins-backup",', 'json');
rejected('数组根节点 → shape', '[]', 'shape');
rejected('字符串根节点 → shape', '"nope"', 'shape');
rejected('格式不符 → format', JSON.stringify({ format: 'other', version: 1 }), 'format');
rejected('版本过低 → version', JSON.stringify(file({ version: 0 })), 'version');
rejected('版本过高 → version', JSON.stringify(file({ version: 99 })), 'version');
rejected('版本不是数字 → version', JSON.stringify(file({ version: 'abc' })), 'version');
{
  const big = `{"format":"${api.BACKUP_FORMAT}","version":1,"pad":"${'x'.repeat(api.BACKUP_MAX_BYTES)}"}`;
  rejected('超过 20 MB → too-big（未解析）', big, 'too-big');
}

// 2. 原型污染：白名单必须挡住
{
  const text = JSON.stringify({
    format: api.BACKUP_FORMAT,
    version: 1,
    data: {
      sessions: {
        s1: {
          pins: [
            {
              id: 'p1',
              text: 't',
              tags: ['a'],
              __proto__: { polluted: 'yes' },
              anchor: { flowKey: 'f1', quote: 'q', __proto__: { polluted: 'yes' } },
            },
          ],
        },
      },
    },
  });
  const result = api.parseBackup(text);
  const pin = result.ok ? result.backup.data.sessions.s1.pins[0] : null;
  suite.check('__proto__ 不进入解析结果', Boolean(pin) && !Object.prototype.hasOwnProperty.call(pin, '__proto__'));
  suite.check('全局原型未被污染', {}.polluted === undefined, JSON.stringify({}.polluted));
  const anchorKeys = pin ? Object.keys(pin.anchor) : [];
  suite.check('锚点里只有白名单字段', anchorKeys.every((key) => api.ANCHOR_FIELDS.includes(key)), anchorKeys.join(','));
}

// 3. 单条非法：跳过并计数，不中断整个文件
{
  const good = { id: 'ok', text: 't', anchor: { flowKey: 'f', quote: 'q' } };
  const bad = { id: 'bad', text: 't', anchor: { quote: 'q' } };
  const noId = { text: 't', anchor: { flowKey: 'f', quote: 'q' } };
  const notObject = 'nope';
  const result = api.parseBackup(
    JSON.stringify(file({ data: { sessions: { s1: { pins: [good, bad, noId, notObject] } } } })),
  );
  suite.check('合法条目仍然导入', result.ok && result.stats.pins === 1);
  suite.check('非法条目计数为 3', result.ok && result.stats.invalidRecords === 3, JSON.stringify(result.stats));
}

// 4. 上限：条数与文本
{
  const pins = Array.from({ length: api.BACKUP_MAX_PINS + 5 }, (_, index) => ({
    id: `p${index}`,
    text: 't',
    anchor: { flowKey: `f${index}`, quote: 'q' },
  }));
  const result = api.parseBackup(JSON.stringify(file({ data: { sessions: { s1: { pins } } } })));
  suite.check(`条数封顶 ${api.BACKUP_MAX_PINS}`, result.ok && result.stats.pins === api.BACKUP_MAX_PINS, String(result.ok ? result.stats.pins : result.reason));
}
{
  const result = api.parseBackup(
    JSON.stringify(file({ data: { sessions: { s1: { pins: [{ id: 'p', text: 'y'.repeat(api.BACKUP_MAX_TEXT * 2), anchor: { flowKey: 'f', quote: 'q' } }] } } } })),
  );
  const pin = result.ok ? result.backup.data.sessions.s1.pins[0] : null;
  suite.check('单条文本截到 2048', pin && pin.text.length === api.BACKUP_MAX_TEXT);
  suite.check('截断计入 stats.truncatedText', result.ok && result.stats.truncatedText === 1);
}

// 5. 字段类型混乱：坏字段被当作"缺失"，不抛
{
  const result = api.parseBackup(
    JSON.stringify(
      file({
        data: {
          sessions: { s1: { pins: [{ id: 'p', text: 42, tags: [1, null, '合法'], pinnedAt: 'x', anchor: { flowKey: 'f', quote: 'q', turn: 'nope', offset: null, partial: 'yes' } }] } },
          extraTags: 'not-an-array',
          msgOrder: [1, 2, 3],
          order: ['s1', 5, null],
          sort: 'nonsense',
        },
        preferences: { mode: 'weird', barMode: 'nope', hover: 'yes', shortcut: 1, tagmgrHeight: 'tall' },
      }),
    ),
  );
  const pin = result.ok ? result.backup.data.sessions.s1.pins[0] : null;
  suite.check('非字符串 text 被当作缺失（回退到 quote）', pin && pin.text === 'q');
  suite.check('非法标签被丢弃', pin && pin.tags.join(',') === '合法');
  suite.check('非法数值字段被丢弃', pin && !('turn' in pin.anchor) && !('offset' in pin.anchor));
  suite.check('非布尔的 flag 被丢弃', pin && !('partial' in pin.anchor));
  suite.check('extraTags 非数组 → 空', result.ok && result.backup.data.extraTags.length === 0);
  suite.check('msgOrder 非对象 → 空', result.ok && Object.keys(result.backup.data.msgOrder).length === 0);
  suite.check('order 过滤非字符串', result.ok && result.backup.data.order.join(',') === 's1');
  suite.check('sort 回落到默认', result.ok && result.backup.data.sort === 'context-asc');
  suite.check('偏好里的非法值变成 null 或默认', result.ok && result.backup.preferences.mode === 'session' && result.backup.preferences.barMode === null && result.backup.preferences.hover === null);
}

// 6. 空文件仍然合法（只是没内容）
{
  const result = api.parseBackup(JSON.stringify(file()));
  suite.check('空备份可解析、零条', result.ok && result.stats.pins === 0 && result.stats.sessions === 0);
}

suite.end();
