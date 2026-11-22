/**
 * 探针：独立标签键（`dsh-pins/extra-tags`）的读取容错（`normalizeExtraTags`）。
 *
 * 这个键是"升级/降级都安全"的支点：旧版本从没听说过它，所以它必须容忍任意形状的
 * 输入，而不是抛错。
 */
const { sandbox, createSuite } = require('./lib');

const api = sandbox(['normalizeTag', 'normalizeExtraTags'], { constants: ['MAX_EXTRA_TAGS'] });
const suite = createSuite('独立标签键：读取容错');

suite.check('缺键（null）→ 空数组', api.normalizeExtraTags(null).length === 0);
suite.check('不是数组 → 空数组', api.normalizeExtraTags({ a: 1 }).length === 0);
suite.check('字符串 → 空数组', api.normalizeExtraTags('待整理').length === 0);
suite.check('非字符串条目被丢弃', api.normalizeExtraTags([1, null, '待整理', {}]).join(',') === '待整理');
suite.check('归一化后去重', api.normalizeExtraTags(['论文', ' 论文 ', '#论文']).join(',') === '论文');
suite.check('去掉开头的 #', api.normalizeExtraTags(['#待读', '##待读']).join(',') === '待读');
suite.check('空白折叠', api.normalizeExtraTags(['a   b']).join(',') === 'a b');
suite.check('空串与纯空白被丢弃', api.normalizeExtraTags(['', '   ', '#']).length === 0);
suite.check('超过 24 字被截断', api.normalizeExtraTags(['x'.repeat(30)])[0].length === 24);

const many = Array.from({ length: api.MAX_EXTRA_TAGS + 50 }, (_, index) => `t${index}`);
suite.check(`超过上限 ${api.MAX_EXTRA_TAGS} 条时截断`, api.normalizeExtraTags(many).length === api.MAX_EXTRA_TAGS);

suite.end();
