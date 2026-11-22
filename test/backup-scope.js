/**
 * 探针：导出范围（`buildBackup`）。
 *
 * 三个范围含义必须互不重叠：
 *   `undefined` = 全部；`'<会话 id>'` = 只有那一个；`null` = **调用方拿不到会话**。
 *
 * 最后一种是这次真出过的事：`null` 曾被当成"全部"，于是「导出本会话」在右侧栏没开时
 * 悄悄导出了整个库。宁可明确拒绝，也不要答错问题。
 */
const { sandbox, createSuite } = require('./lib');

const STATE = {
  version: 1,
  mode: 'session',
  sort: 'context-desc',
  order: ['s1', 's2', 's3'],
  sessions: {
    s1: { pins: [{ id: 'p1', text: '第一条', tags: ['甲'], pinnedAt: 3, anchor: { sessionId: 's1', flowKey: 'f1', quote: '第一条', rawQuote: '第一条', rawOffset: 0, rawLength: 3, turn: 1, msgKey: 'k1', block: 'prose' } }], firstAt: 1, updatedAt: 2, title: '会话一' },
    s2: { pins: [{ id: 'p2', text: '第二条', tags: [], pinnedAt: 4, anchor: { sessionId: 's2', flowKey: 'f2', quote: '第二条', rawQuote: '第二条', rawOffset: 5, rawLength: 3, turn: 2, msgKey: 'k2' } }], firstAt: 1, updatedAt: 2 },
    s3: { pins: [], firstAt: 1, updatedAt: 1 },
  },
};

const PREAMBLE = `
const STATE_KEY = 'dsh-pins/v1';
const STABLE_ORDER_KEY = 'dsh-pins/msg-order';
const PKG = 'dsh-pins';
const PLUGIN_VERSION = '1.2.0';
const FIXTURE = ${JSON.stringify(STATE)};
const MSG_ORDER = { '1:1': 3 };
const readJson = (key, fallback) => {
  if (key === STATE_KEY) return FIXTURE;
  if (key === STABLE_ORDER_KEY) return MSG_ORDER;
  return fallback;
};
const store = { extraTags: () => ['待整理'], getMode: () => 'session' };
let barMode = 'both';
let pinHoverOn = true;
let shortcutOn = false;
const readPanelManagerHeight = () => 200;
`;

const api = sandbox(
  ['normalizeTag', 'normalizeSort', 'backupObject', 'backupNumber', 'backupString', 'backupTags', 'backupAnchor', 'backupPin', 'backupSession', 'buildBackup'],
  {
    preamble: PREAMBLE,
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

const suite = createSuite('导出范围：全部 / 单个会话 / 拿不到会话');

{
  const all = api.buildBackup(undefined);
  suite.check('全部：两个有内容的会话都在（空会话被跳过）', Object.keys(all.data.sessions).join(',') === 's1,s2');
  suite.check('全部：order 只保留真正导出的会话', all.data.order.join(',') === 's1,s2');
  suite.check('全部：host 带版本号', all.host === 'dsh-pins@1.2.0');
  suite.check('全部：偏好快照正确', all.preferences.barMode === 'both' && all.preferences.shortcut === false && all.preferences.tagmgrHeight === 200);
  suite.check('全部：独立标签与 msgOrder 带上', all.data.extraTags.join(',') === '待整理' && all.data.msgOrder['1:1'] === 3);
  suite.check('全部：sort 归一化', all.data.sort === 'context-desc');
}

{
  const one = api.buildBackup('s1');
  suite.check('单会话：只含那一个', Object.keys(one.data.sessions).join(',') === 's1');
  suite.check('单会话：order 收敛到它', one.data.order.join(',') === 's1');
  suite.check('单会话：片段内容完整', one.data.sessions.s1.pins[0].anchor.rawQuote === '第一条');
}

{
  const missing = api.buildBackup('nope');
  suite.check('不存在的会话：空结果、不抛', missing && Object.keys(missing.data.sessions).length === 0);
  suite.check('不存在的会话：order 为空', missing.data.order.length === 0);
}

{
  const nullScope = api.buildBackup(null);
  suite.check('拿不到会话（null）：返回 null，绝不退化成「全部」', nullScope === null, JSON.stringify(nullScope));
}

suite.end();
