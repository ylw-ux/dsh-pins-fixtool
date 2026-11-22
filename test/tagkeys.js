/**
 * 探针：标签输入框的键盘语义（`tagKeyDown`）。
 *
 * 覆盖：↑↓ 只在列表内移动、末行回绕、列表关闭时放行、未按过 ↑↓ 时回车=创建、
 * 高亮「已有」行时回车=创建、Esc 两步、输入法组合中放行、空格可输入但不冒泡。
 */
const { sandbox, createSuite } = require('./lib');

const { tagKeyDown } = sandbox(['tagKeyDown']);
const suite = createSuite('标签输入框：键盘语义');

function fakeEvent(key, extra = {}) {
  const calls = { prevent: 0, stop: 0 };
  return {
    key,
    nativeEvent: extra.nativeEvent ?? {},
    preventDefault: () => { calls.prevent += 1; },
    stopPropagation: () => { calls.stop += 1; },
    calls,
  };
}

function makeState(over = {}) {
  const log = { active: [], moved: [], closeList: [], submit: [], escape: 0 };
  return {
    log,
    rows: [{ tag: 'guide', taken: false }, { tag: '固定', taken: true }],
    active: -1,
    moved: false,
    listClosed: false,
    onActive: (index) => log.active.push(index),
    onMoved: (value) => log.moved.push(value),
    onCloseList: (value) => log.closeList.push(value),
    onSubmit: (tag) => log.submit.push(tag === undefined ? '<创建>' : tag),
    onEscape: () => { log.escape += 1; },
    ...over,
  };
}

{
  const state = makeState();
  const event = fakeEvent('ArrowDown');
  tagKeyDown(event, state);
  suite.check('↓ 首次高亮第 0 行并被吞掉', state.log.active[0] === 0 && event.calls.stop === 1 && event.calls.prevent === 1);
}
{
  const state = makeState({ active: 1, moved: true });
  tagKeyDown(fakeEvent('ArrowDown'), state);
  suite.check('↓ 末行回绕到首行', state.log.active[0] === 0);
}
{
  const state = makeState();
  tagKeyDown(fakeEvent('ArrowUp'), state);
  suite.check('↑ 首次高亮末行', state.log.active[0] === 1);
}
{
  const state = makeState({ listClosed: true });
  const event = fakeEvent('ArrowDown');
  tagKeyDown(event, state);
  suite.check('列表关闭时方向键放行（不 preventDefault）', event.calls.prevent === 0 && event.calls.stop === 0);
}
{
  const state = makeState();
  tagKeyDown(fakeEvent('Enter'), state);
  suite.check('未按过 ↑↓ 时回车 = 创建输入的名字', state.log.submit[0] === '<创建>');
}
{
  const state = makeState({ active: 0, moved: true });
  tagKeyDown(fakeEvent('Enter'), state);
  suite.check('按过 ↑↓ 时回车 = 应用高亮行', state.log.submit[0] === 'guide');
}
{
  const state = makeState({ active: 1, moved: true });
  tagKeyDown(fakeEvent('Enter'), state);
  suite.check('高亮「已有」行时回车 = 创建（不重复添加）', state.log.submit[0] === '<创建>');
}
{
  const state = makeState();
  const event = fakeEvent('Escape');
  tagKeyDown(event, state);
  suite.check('Esc 先只关列表', state.log.closeList[0] === true && state.log.escape === 0 && event.calls.stop === 1);
}
{
  const state = makeState({ listClosed: true });
  tagKeyDown(fakeEvent('Escape'), state);
  suite.check('Esc 再按关编辑器', state.log.escape === 1);
}
{
  const state = makeState();
  tagKeyDown(fakeEvent('Enter', { nativeEvent: { isComposing: true } }), state);
  suite.check('输入法组合中回车不提交', state.log.submit.length === 0);
}
{
  const state = makeState();
  const event = fakeEvent(' ');
  tagKeyDown(event, state);
  suite.check('空格可输入但不冒泡', event.calls.prevent === 0 && event.calls.stop === 1);
}

suite.end();
