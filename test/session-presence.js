/**
 * 探针：会话是否在本机（`sessionPresence`）。
 *
 * 重点是三态：目录没就绪时必须是 `unknown`（不标记），否则会把本机的卡片误标成
 * 「原会话不在本机」，而这个值只在渲染时推导、写进数据就永远错。
 */
const { sandbox, createSuite } = require('./lib');

const { sessionPresence } = sandbox(['backupObject', 'sessionPresence']);
const suite = createSuite('会话是否在本机：三态判定');

const contextWith = (snapshot) => ({
  get: (name) => (name === 'sessions' ? { list: { getSnapshot: () => snapshot } } : null),
});

suite.check('没有 sessionId → unknown', sessionPresence(contextWith({ byId: { s1: {} } }), '') === 'unknown');
suite.check(
  '目录就绪且存在 → present',
  sessionPresence(contextWith({ phase: 'ready', byId: { s1: {}, s2: {} } }), 's1') === 'present',
);
suite.check(
  '目录就绪但不存在 → missing',
  sessionPresence(contextWith({ phase: 'ready', byId: { s1: {}, s2: {} } }), 's9') === 'missing',
);
suite.check('phase 不是 ready → unknown（不标记）', sessionPresence(contextWith({ phase: 'loading', byId: {} }), 's9') === 'unknown');
suite.check('快照里没有 byId → unknown', sessionPresence(contextWith({ phase: 'ready' }), 's9') === 'unknown');
suite.check('byId 为空 → unknown（当作还没加载）', sessionPresence(contextWith({ phase: 'ready', byId: {} }), 's9') === 'unknown');
suite.check('拿不到快照 → unknown', sessionPresence({ get: () => null }, 's9') === 'unknown');
suite.check(
  '取服务抛异常 → unknown（不拖垮渲染）',
  sessionPresence({ get: () => { throw new Error('boom'); } }, 's9') === 'unknown',
);
suite.check('byId 是数组（坏形状）→ unknown', sessionPresence(contextWith({ phase: 'ready', byId: ['s1'] }), 's9') === 'unknown');

suite.end();
