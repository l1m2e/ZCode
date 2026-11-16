# Git 需求设计

Git 提供独立右侧独立源代码管理标签页与右侧审查面板。当前首版范围和验收以 [源代码管理规格](source-control-panel.md) 为准；diff 布局以 [审查布局规格](../git-review-split-layout.md) 为准。

- 右侧新标签页 launcher 打开源代码管理标签，使用当前 workspace 或活动任务 cwd，保留当前会话。
- 提交输入支持手动编辑和 AI 生成，默认提交当前范围 index；没有暂存更改时确认暂存当前范围后提交。
- 提供已暂存、更改、冲突分组。已暂存只支持取消暂存；更改支持暂存与经过确切路径确认的丢弃。保留范围外 index 和工作树。
- 提供提交、提交并推送和推送失败后的独立重试，不重复提交。
- 右侧 GitPane 共享现有槽位，提供 unstaged/staged/branch/last-turn 来源与 split/unified/editor 展示。SCM 点击文件传递 source/path 选择意图。
- App 的 useGitRepository 为 header、SCM、GitPane 提供唯一仓库快照。远端沿既有服务路由；不可回落本地。
- 保持桌面、手机 Web、国际化及主题兼容。

不新增 pull/fetch/amend/stash/rebase/merge editor/提交图或远端协作视图。顶部已有轻量提交与分支入口继续可用，与 SCM 共用目标写锁。

## 审查与展示要求

- 顶部 Git 入口在面板关闭时仍显示改动统计，点击切换右侧 GitPane，选中状态明确。
- 来源切换同步文件列表、过滤和 diff；上一轮更改取真实会话快照，分支比较与上一轮均只读。
- 文件列表展示 workspace 相对路径、增删统计和状态，支持路径过滤、树与列表显隐。具体 split/unified/editor 布局由审查布局规格约束。
- 二进制、空文件、超大 diff 和不可预览内容给出明确降级提示；降级不移除真实状态条目或写操作入口。
- 使用真实 Git status、分支比较、单文件 diff、身份读取；不使用 mock 仓库数据。
- 顶部既有提交弹窗支持包含未暂存选项、当前会话摘要过滤、分支选择、消息生成及 Command 动作快捷键。SCM 的默认范围与确认规则独立见源代码管理规格。
