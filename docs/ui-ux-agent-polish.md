# UI/UX 升级：现代 agent 手感

> 范围：`web/` 前端。目标是在**不改业务语义、不动后端契约**的前提下，把界面从
> 「能用的后台管理页」拉到「现代 AI 工作台」的观感与操作手感。
> 基线：`882a095`（2026-08-30）。

## 结论速览

| 检查项 | 结果 |
|---|---|
| `npm run typecheck -w web` | 通过 |
| `npm run lint -w web` | 0 error / 8 warning（5 条为改造前既有） |
| `npm test -w web` | 17 passed（3 files） |
| `npm run build -w web` | 通过（2.7s） |

## 一、修掉的真实缺陷

这几条不是「美化」，是功能本就不对：

1. **深色模式从未生效**。`next-themes` 是依赖，但 `main.tsx` 里没有 `ThemeProvider`——
   `useTheme()` 永远返回默认 `"system"`，`sonner` 的 `theme` 也一直是空转。
   现在补上 `ThemeProvider attribute="class"`（对应 `index.css` 的
   `@custom-variant dark (&:is(.dark *))`），并新增亮/暗/跟随系统三态切换。
2. **`PostView` 手搓了 `<button>`**，把 `Button` 组件的类名复制了一份。hover、
   disabled、focus 三态与全站组件逐渐分叉。已全部换回 `Button`。
3. **用户气泡手搓 `div`**，没走 ai-elements 的 `Message`/`MessageContent`，
   与 assistant 气泡是两套样式体系。已统一。
4. **编辑页返回箭头是文本 `←`**，其余页面用的是 Lucide 图标。已统一为图标。
5. **设置页返回指向「工作间列表」**，但从编辑页进来后，语义上更近的一层是
   「这个工作间（单集列表）」。已改。

## 二、设计系统

`index.css`：

- 新增 **brand 靛蓝** token（`--brand` / `--brand-soft` / `--brand-border`）。
  底色保持中性灰克制，品牌色只服务 AI 相关元素：写稿大师、流式指示、聚焦环、
  主操作、当前选中项——不整站染色。
- `--ring` 染品牌色，键盘走查时焦点落点更清楚。
- 新增动效：`stream-caret`、`shimmer`、`rise`（入场）、`breathe`（活动脉冲）。
- 新增 `scrollbar-slim` 工具类与 `::selection` 品牌色。
- 深色模式的 `--card` / `--background` 加了极轻的冷调（chroma 0.012），
  纯灰在暗色下会发闷。

## 三、新增能力

### 命令面板（⌘K / Ctrl+K）

`src/components/command-palette.tsx`。**没有引入 cmdk**——命令量级只有十几条，
自实现模糊匹配（子序列 + 连续命中/词首加成）与键盘导航更轻，也更好控制分组。
命令由各页面自己组装（页面才知道当前单集/视图/暂存状态）。

编辑页命令：切换视图、收起/展开写稿大师、聚焦输入框、提交/撤销暂存、发起合成、
返回工作间、工作间设置。首页/工作间页另有导航与主题命令。

### 快捷键

`src/lib/hotkeys.ts` + `src/hooks/use-hotkey.ts`。组合键语法 `mod+k`
（`mod` 在 macOS 渲染成 ⌘，其它平台渲染成 Ctrl，**不写死 ⌘**）。带 `mod`
的组合默认允许在输入框内触发，裸键默认避让输入框。

| 键位 | 动作 |
|---|---|
| `⌘K` | 命令面板 |
| `⌘1` / `⌘2` | 写稿 / 后期视图 |
| `⌘/` | 收起、展开写稿大师 |
| `⌘I` | 聚焦输入框 |
| `⌘↵` | 提交暂存改动 |

### 可拖拽侧栏

写稿大师面板宽度可拖（320–760px，左栏至少留 420px），宽度与开合状态持久化到
localStorage（`usePersistentState`），双击分隔条复位。

## 四、手感改造（逐处）

| 位置 | 原来 | 现在 |
|---|---|---|
| 编辑页头部 | 标题 + 一堆图标按钮 | 面包屑（工作间 / 单集）+ 命令入口 + 主题切换 + 面板开合，四处导航收敛成一条 |
| 视图切换 | 两个裸按钮 | 分段控件（当前态一眼可辨）+ 待合成行数角标 |
| 工具栏右端 | 无 | 「写稿大师正在写…」「合成中…」活动指示 |
| 聊天空状态 | 一行灰字 | 品牌标识 + 说明 + 4 张可直接点的建议卡（"写一段 30 秒的开场白"…） |
| 运行状态条 | 纯文本堆砌 | 品牌色底 + 工具图标与状态 + **已用秒数与累计步数**（长 run 没推进指示会让人以为卡死） |
| 工具步骤块 | `读脚本：xxx` | 读/写/改 各有图标，转圈/对勾/叉号表示状态，时间轴细线 |
| 输入框 | 固定 2 行 textarea | 胶囊容器（聚焦整块亮边）+ 自增高 + 发送/停止同一按钮、位置不变 |
| 脚本行 | 5 个图标挤在 hover 区 | 左侧色条表达「待提交 / 需重新合成」（扫列边缘就能挑出异常行）；删除键前有分隔线并染红；台词自增高 |
| 行内联试听 | 浏览器原生 `<audio controls>` | 自研紧凑播放器（播放/暂停 + 可点选进度 + 时长）。原生控件在 32px 高的行里会压成看不清的灰条 |
| 暂存条 | 静态胶囊 | 呼吸琥珀圆点 + 入场动画 + `⌘↵` 键位提示 |
| 合成进度 | 单条进度条 | 阶段指示（合成语音 → 拼接归一 → 编码 → 校验）+ 进度条 + 行级计数 |
| 产物播放器 | 原生 audio + 列表 | 当前行左侧品牌色条 + 每行起始时刻（找某一句不用从头听）；长音频仍保留原生控件（seek/倍速的肌肉记忆不值得自研） |
| 空状态 | 各处一行灰字 | 统一 `EmptyState`（图标→标题→说明→行动），四处共用 |
| 加载态 | 无 | 首页骨架卡、设置页骨架、单集列表骨架 |

## 五、结构变化

新增文件：

```
src/components/command-palette.tsx        命令面板 + ⌘K hook
src/components/theme-toggle.tsx           主题切换
src/components/ui/kbd.tsx                 键帽
src/components/ui/segmented.tsx           分段控件
src/components/ui/empty-state.tsx         统一空状态
src/components/script/LineAudioPlayer.tsx 行内联播放器
src/hooks/use-hotkey.ts                   全局快捷键注册
src/hooks/use-persistent-state.ts         localStorage 持久化 state
src/hooks/use-auto-grow.ts                textarea 自增高
src/lib/hotkeys.ts                        组合键解析/匹配/格式化
src/lib/format.ts                         时长与字节格式化
src/features/audio-workspace/use-start-synthesis.ts  发起合成（含 useIsSynthesizing）
src/features/script-panel/use-commit-staged.ts       提交暂存
```

上浮的两处逻辑（原先埋在组件里，现在命令面板/快捷键要走同一条路径）：

- `useStartSynthesis`：`PostView` 与命令面板共用。**轮询仍由 `useSynthesisJob`
  独占**——本 hook 只写 `['synthesis-job-id', ep]` 缓存、不订阅任务查询，
  避免多处挂载导致重复轮询（两个轮询者会各收场一次，toast 出现两遍）。
- `useCommitStaged`：`StagingBar` 与 `⌘↵` 共用。

## 六、没做的事

- **没引入任何新依赖**（命令面板、模糊匹配、键位解析全部自实现）。
- 没做拖拽排序（脚本行仍是上移/下移按钮）——拖拽要引入 dnd 库并重写行身份管理，
  收益与风险不成比例。
- 产物播放器保留原生 `<audio controls>`：长音频的 seek / 倍速 / 音量用户已有
  肌肉记忆，自研控件不划算。
- 没碰后端契约、没碰 `staging.ts` / `synthesis.ts` / `transcript.ts` 三个纯函数
  模块（17 个单测全绿）。

## 七、遗留

- Lint 8 条 warning 中 3 条是 `only-export-components`（`RunStatusBar.toolLabel`、
  `Composer.loadThinkingPreference`、`command-palette.usePaletteHotkey`）：
  从组件文件里导出非组件函数会影响 fast refresh。项目里本就有这个写法
  （`RunStatusBar.toolLabel`），保持一致；要彻底清掉得再拆三个文件。
- 主 chunk 1.2MB（gzip 376KB），主要来自 streamdown/shiki 的语言包分片，
  改造前即如此，未做代码分割。
