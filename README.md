# 固定片段 · dsh-pins

**中文** | [English](README.en.md)

> 把对话里划选的段落固定到右侧栏，像便签一样排成一列；点一下跳回原文，打 `@` 引用进消息。

一个 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Web UI 插件。读长回复时最容易丢的东西是"我刚刚读到哪、哪几句是关键"——划选、固定、回头看，就这么一件事。

## 安装

需要 Harness 的 Web 界面（`dsh web`）。一条命令，装完会**自动把这个 bundle 选进 profile**：

```bash
# 从 GitHub 安装
dsh plugin --profile web add github:ylw-ux/dsh-pins-fixtool

# 已发布到 npm 之后
dsh plugin --profile web add dsh-pins

# 从本地目录安装（开发用，会建立 link 依赖，改完刷新页面即可）
dsh plugin --profile web add D:\path\to\dsh-pins
```

然后**刷新浏览器**。若没有生效，重启 `dsh`。

卸载：

```bash
dsh plugin --profile web remove dsh-pins
```

几点说明：

- **不需要 pnpm 构建授权。** 这个包没有任何 `prepare` / `postinstall` 脚本，也没有构建步骤——纯 JavaScript，装完即可用，不会弹 "allow build scripts"。
- **不会动你的 profile 配置以外的任何东西。** 它只往 profile 的 `package.json` 加一条依赖、往 `dsh.profile.bundles` 加一个名字，以及自己的一份 patch 行。
- **数据在你自己的浏览器里。** 固定片段存在 `localStorage`（键 `dsh-pins/v1`），不上传、不同步、没有账号。清除站点数据即全部删除。
- 装好后左栏底部（Settings 旁边）会出现带条数的「固定片段」入口；也可以在右侧栏页签里打开它。

## 用法

| 操作 | 效果 |
|---|---|
| 划选文字 | 选区上方浮出动作条：**固定 / 标签 / 固定并引用 / 引用 / 复制** |
| `Alt` + `P` | 固定或取消固定当前选区 |
| 鼠标停在卡片上 | 卡片原地展开（上限 `min(60cqh, 420px)`），可在卡片内滚动看全文 |
| 点卡片正文 | **永远 = 跳回原文**，落到选中的那段文字并居中 |
| 卡片上的 `#` / `❞` / `⧉` / `✕` | 编辑标签 / 引用到输入框 / 复制原文 / 取消固定 |
| 输入框里打 `@` | 菜单第一行就是「固定片段」；进去后**再打字就是搜索**（正文、标签都比对），选中即插入一个**引用芯片** |
| 点输入框里的引用芯片 | 打开右侧栏，并让那条卡片脉冲高亮 |
| 面板顶部 | 两个视图（本对话 / 全部）、四种排序、搜索、多选标签筛选、标签管理、markdown 提纲导出 |
| 两个视图的筛选 | **各留一份**：在「全部」里选的标签和搜索词不会跟着你去「本对话」，切回来时它们还在原处。排序是全局偏好，两边共用并会被记住 |

引用有两种形态，**都自带内容、都不是指针**：一是直接把带出处的引用块放进输入框；二是插入一个**引用芯片**，发送前由插件把它换成完整引用。两种形态的原文都真的进消息——模型看得到内容，发送后也永不过期。

## 它不做什么

- **不解析 markdown、不存 HTML 快照。** 固定的是你选中的文本、它所在的轮次与偏移，可读、可迁移。
- **不自动切换你的对话。** 在「全部」里点别的对话的卡片只会说明情况，不会把你正在读的会话换掉。
- **不注入上下文。** 没有任何"把固定片段偷偷塞进模型上下文"的行为；要么你引用，要么模型显式来读（后者尚未实现）。
- **不写任何隐性状态。** 固定是显式动作，删除是显式动作。

## 已知限制

- **只支持 Web（`platform: web`）。** TUI / Desktop 没有这一层界面。
- **锚点依赖宿主的 DOM 契约**（`data-chat-flow-key`、`data-chat-turn`、`[data-conversation-scroll]`）。宿主若整批改名，持久标记与精确跳转会一起失效——**数据本身不会丢**（存的仍是文本、轮次、偏移），并且跳转有按位置的降级回退。这是这个插件唯一无法自证的风险，如实写在这里。
- **超过 600 字的选区只保留前 600 字**（卡片上会标「已截断」），引用与芯片吃同一个上限。
- **同一段文字在一条消息里出现多次**时，定位会挑离记录偏移最近且文本校验通过的那个；都不通过就退回整条消息并标「原文未找到」。

## 兼容性

在本机验证过的组合：**DSH `0.2.0-rc.2` · Node `24.14.1` · pnpm `12.6.0`**。

包内**没有声明 `peerDependencies`，也没有声明 `engines.dsh`**——这是有意的：它不 import 任何 Harness 包（客户端半边只 `require('react')`，宿主半边是一个空的 `apply`），所有宿主交互都做了存在性检查并在缺失时降级或明确报错。声明一个我没法验证的版本范围，只会让安装被挡住。

## 开发

```
dsh-pins/
├── package.json         bundle 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml     往 profile 里插一行
├── index.js             宿主半边（预留的 pinsHost 服务，目前为空）
├── client.js            浏览器半边：整个插件都在这一个文件里
├── locale/{zh,en}.json  显示名与描述（插件市场读的就是这个 meta.title）
├── icon.svg             图标（≤ 256 KiB）
└── docs/                安装与排错
```

本地开发用 `dsh plugin --profile web add <绝对路径>` 装成 link 依赖，改 `client.js` 后刷新页面即可；`plugin_manager` 工具与 Web 的 Plugins 页面管理的是同一份 profile 状态。

## License

[MIT](LICENSE)
