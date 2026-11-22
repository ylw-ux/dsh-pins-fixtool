/**
 * 探针：1.2.0 导出的文件能不能被旧代码读懂。
 *
 * 不跑 UI、不模拟整个旧版本：只断言"旧版本读取时会用到的字段一个不缺、也没有夹带旧版本
 * 没见过的 pin 级字段"。这是 C1 里"导出写全、导入缺字段推导"的另一半。
 */
const { sandbox, createSuite } = require('./lib');

const api = sandbox(
  ['normalizeTag', 'normalizeSort', 'backupObject',
  'backupNumber', 'backupString', 'backupTags', 'backupAnchor', 'backupPin', 'backupSession', 'parseBackup'],
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

const suite = createSuite('降级读取：1.2.0 的文件对 1.1.x 仍然可读');

/** 1.2.0 的导出形状（字段取自 buildBackup）。 */
const exported = {
  format: api.BACKUP_FORMAT,
  version: api.BACKUP_VERSION,
  host: 'dsh-pins@1.2.0',
  exportedAt: '2026-11-22T06:35:00.000Z',
  data: {
    sessions: {
      s1: { pins: [{ id: 'a', text: '正文', tags: ['重要'], pinnedAt: 1, anchor: { sessionId: 's1', flowKey: 'f1', node: 'n', kind: 'assistant', turn: 2, offset: 10, rawOffset: 10, rawLength: 2, quote: '正文', rawQuote: '正文', msgOrder: 1, msgKey: 'k', block: 'prose' } }], firstAt: 1, updatedAt: 2, title: 'T' },
    },
    order: ['s1'],
    sort: 'context-asc',
    extraTags: ['待整理'],
    msgOrder: { '2:f1': 1 },
  },
  preferences: { mode: 'session', barMode: 'both', hover: true, shortcut: true, tagmgrHeight: 200 },
};

const parsed = api.parseBackup(JSON.stringify(exported));

suite.check('文件可解析', parsed.ok === true);

const pins = [];
for (const entry of Object.values(parsed.ok ? parsed.backup.data.sessions : {})) {
  for (const pin of entry.pins) pins.push(pin);
}
suite.check('解析出 1 条片段', pins.length === 1);

// 旧版本读取固件：只认这些字段。
const PIN_KEYS = ['id', 'text', 'tags', 'pinnedAt', 'anchor'];
for (const pin of pins) {
  suite.check(`片段只有旧版本认识的字段（${pin.id}）`, Object.keys(pin).every((key) => PIN_KEYS.includes(key)), Object.keys(pin).join(','));
  suite.check(`锚点字段都在白名单内（${pin.id}）`, Object.keys(pin.anchor).every((key) => api.ANCHOR_FIELDS.includes(key)), Object.keys(pin.anchor).join(','));
  suite.check(
    `旧版本定位所需的四个字段齐全（${pin.id}）`,
    typeof pin.id === 'string' && typeof pin.text === 'string' && typeof pin.anchor.flowKey === 'string' && typeof pin.anchor.quote === 'string',
  );
  suite.check(`标签是字符串数组（${pin.id}）`, Array.isArray(pin.tags) && pin.tags.every((tag) => typeof tag === 'string'));
}

// 顶层 data 不多出旧版本会误解的字段
const DATA_KEYS = ['sessions', 'order', 'sort', 'extraTags', 'msgOrder'];
suite.check('data 只有已知字段', Object.keys(parsed.backup.data).every((key) => DATA_KEYS.includes(key)), Object.keys(parsed.backup.data).join(','));
suite.check('preferences 只有已知字段', Object.keys(parsed.backup.preferences).every((key) => ['mode', 'barMode', 'hover', 'shortcut', 'tagmgrHeight'].includes(key)));

suite.end();
