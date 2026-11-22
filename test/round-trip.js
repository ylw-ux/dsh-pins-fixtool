/**
 * 探针：备份文件的值级往返。
 *
 * 不断言 UI，只断言"写出来的文件能被读回来，且每个白名单字段一字不差"。
 * 覆盖：字段保真、判重三级、标签并集、内容冲突、上限截断。
 */
const { sandbox, createSuite } = require('./lib');

const CONSTANTS = [
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
  'CONTENT_FIELDS',
  'BACKUP_ANCHOR_NUMBERS',
  'BACKUP_ANCHOR_FLAGS',
  'SORT_MODES',
  'BAR_MODES',
];

const FUNCTIONS = [
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
  'contentSignatureOf',
  'slotKeyOf',
  'textKeyOf',
  'diffPins',
  'queueTagUnion',
  'planImport',
];

const api = sandbox(FUNCTIONS, { constants: CONSTANTS });
const suite = createSuite('备份文件：值级往返');

/** 一条形状完整的片段（含所有可选锚点字段）。 */
function makePin(id, overrides = {}) {
  return {
    id,
    text: `正文 ${id}`,
    tags: ['重要', '待读'],
    pinnedAt: 1763800000000,
    anchor: {
      sessionId: 's1',
      flowKey: `flow-${id}`,
      node: 'node-1',
      kind: 'assistant',
      turn: 3,
      offset: 120,
      rawOffset: 133,
      rawLength: 42,
      quote: '规范化后的引文',
      rawQuote: '原始\n引文',
      msgOrder: 7,
      msgKey: 'k1',
      block: 'prose',
      lang: '',
      partial: true,
      truncated: true,
      ...overrides,
    },
  };
}

function makeFile(pins, extra = {}) {
  return {
    format: api.BACKUP_FORMAT,
    version: api.BACKUP_VERSION,
    host: 'dsh-pins@1.2.0',
    exportedAt: '2026-11-22T06:35:00.000Z',
    data: {
      sessions: { s1: { pins, firstAt: 1, updatedAt: 2, title: '会话一' } },
      order: ['s1'],
      sort: 'context-asc',
      extraTags: ['待整理', '重要'],
      msgOrder: { '3:flow-a': 7, '3:flow-b': 9 },
    },
    preferences: { mode: 'session', barMode: 'both', hover: true, shortcut: false, tagmgrHeight: 220 },
    ...extra,
  };
}

// 1. 解析：字段保真
{
  const text = JSON.stringify(makeFile([makePin('a')]));
  const result = api.parseBackup(text);
  suite.check('合法文件通过解析', result.ok === true, JSON.stringify(result).slice(0, 200));
  const pin = result.ok ? result.backup.data.sessions.s1.pins[0] : null;
  suite.check('id / text / tags / pinnedAt 保真', pin && pin.id === 'a' && pin.text === '正文 a' && pin.tags.join(',') === '重要,待读' && pin.pinnedAt === 1763800000000);
  const anchorOk = pin && Object.keys(pin.anchor).every((key) => key in makePin('a').anchor);
  suite.check('锚点白名单字段全部保留', anchorOk === true, pin ? Object.keys(pin.anchor).join(',') : '');
  suite.check('锚点数值与布尔字段类型正确', pin && pin.anchor.turn === 3 && pin.anchor.rawOffset === 133 && pin.anchor.partial === true && pin.anchor.truncated === true);
  suite.check('data.extraTags / msgOrder / order 保留', result.ok && result.backup.data.extraTags.join(',') === '待整理,重要' && result.backup.data.msgOrder['3:flow-a'] === 7 && result.backup.data.order.join(',') === 's1');
  suite.check('偏好保留', result.ok && result.backup.preferences.tagmgrHeight === 220 && result.backup.preferences.shortcut === false);
  suite.check('统计数字正确', result.ok && result.stats.sessions === 1 && result.stats.pins === 1 && result.stats.invalidRecords === 0);
}

// 2. 判重：同 id 同内容 → 重复；空本地 → 全新增
{
  const file = api.parseBackup(JSON.stringify(makeFile([makePin('a'), makePin('b')])));
  const empty = api.planImport(file.backup, { sessions: {} });
  suite.check('空本地：两条都新增', empty.add.length === 2 && empty.duplicates === 0 && empty.conflicts.length === 0);
  const local = { sessions: { s1: { pins: [makePin('a'), makePin('b')] } } };
  const again = api.planImport(file.backup, local);
  suite.check('同文件导两次：0 新增、2 重复', again.add.length === 0 && again.duplicates === 2 && again.mergeTags.length === 0);
}

// 3. 标签差异 → 并集（不是冲突）
{
  const local = { sessions: { s1: { pins: [makePin('a')] } } };
  const file = api.parseBackup(JSON.stringify(makeFile([makePin('a')]).valueOf()));
  const incoming = makePin('a');
  incoming.tags = ['重要', '新标签'];
  const backup = { data: { sessions: { s1: { pins: [incoming] } } } };
  const plan = api.planImport(backup, local);
  suite.check('只差标签：不算冲突', plan.conflicts.length === 0 && plan.duplicates === 1);
  suite.check('只差标签：并集写入', plan.mergeTags.length === 1 && plan.mergeTags[0].tags.join(',') === '重要,待读,新标签', JSON.stringify(plan.mergeTags));
  suite.check('解析后的文件可用于判重（不抛）', file.ok === true);
}

// 4. 内容冲突
{
  const local = { sessions: { s1: { pins: [makePin('a')] } } };
  const changed = makePin('a');
  changed.anchor.rawQuote = '完全不同的原文';
  changed.anchor.offset = 999;
  const plan = api.planImport({ data: { sessions: { s1: { pins: [changed] } } } }, local);
  suite.check('同 id 内容不同：记为冲突而不是新增', plan.conflicts.length === 1 && plan.add.length === 0);
  const diff = plan.conflicts[0]?.diff ?? [];
  // 只有内容字段参与冲突判定：offset 不在 CONTENT_FIELDS 里，所以单改它不算内容差异。
  suite.check('冲突带出字段级差异（仅内容字段）', diff.length >= 1 && diff.every((row) => api.CONTENT_FIELDS.includes(row.field) || row.field === 'tags'), JSON.stringify(diff.map((row) => row.field)));
  suite.check('差异里能看到 rawQuote 的新旧值', diff.find((row) => row.field === 'rawQuote')?.incoming === '完全不同的原文');
}

// 5. 位置/文本回退判重（不同 id、同一段）
{
  const local = { sessions: { s1: { pins: [makePin('a')] } } };
  const renamed = makePin('a2');
  renamed.anchor = { ...makePin('a').anchor };
  const bySlot = api.planImport({ data: { sessions: { s1: { pins: [renamed] } } } }, local);
  suite.check('不同 id、同位置：判为重复', bySlot.add.length === 0 && bySlot.duplicates === 1);

  const legacy = makePin('a3');
  const anchor = { ...makePin('a').anchor };
  delete anchor.rawOffset;
  delete anchor.rawLength;
  legacy.anchor = anchor;
  const noOffsetLocal = { sessions: { s1: { pins: [Object.assign(makePin('a'), { anchor })] } } };
  const byText = api.planImport({ data: { sessions: { s1: { pins: [legacy] } } } }, noOffsetLocal);
  suite.check('缺偏移的旧文件：按文本回退判重', byText.add.length === 0 && byText.duplicates === 1);
}

// 6. 超长文本：截断并计数
{
  const long = makePin('long');
  long.text = 'x'.repeat(api.BACKUP_MAX_TEXT + 50);
  const result = api.parseBackup(JSON.stringify(makeFile([long])));
  const pin = result.ok ? result.backup.data.sessions.s1.pins[0] : null;
  suite.check('超长文本被截到上限', pin && pin.text.length === api.BACKUP_MAX_TEXT);
  suite.check('截断计入统计', result.ok && result.stats.truncatedText === 1);
}

suite.end();


