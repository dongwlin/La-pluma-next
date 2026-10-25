# 开发文档

> [← 返回 README](../README.md)

项目使用 React + TypeScript + Node.js 技术栈，代码结构围绕“前端页面、Agent API、后端服务”展开。

## 主要技术点

- **前端**: React Hooks 与原生语义组件实现页面壳层和响应式 chrome，Tailwind CSS v4（`@tailwindcss/vite`）/语义 token 负责业务布局，Framer Motion 负责物理动效，Zustand 管理跨页面状态
- **API**: 前端通过 `client/src/shared/api/` 的传输层底座（`API_BASE_URL`、`fetchWithAuth`、`parseJsonResponse`、`getErrorMessage`）访问 `/api/agent/*`；业务端点按语义归各 `features/<domain>/api/`，跨域共用的命令执行与用户配置端点在 `features/task-execution/`、`features/user-config/` 两个微域
- **后端**: `server/server.js` 挂载 Agent API，并用 Socket.IO 推送运行状态
- **MAA 集成**: 通过 Node.js 子进程调用 `maa` CLI 命令
- **定时任务**: 使用 node-cron 实现任务调度
- **通知服务**: Telegram Bot API + 任务完成通知

前端 UI 的具体规则见根目录 [设计规范](../DESIGN.md)，组件 API 见 [通用组件库](component-library.md)。

## 样式治理

### 全局样式冻结

`client/src/styles/index.css` 与 `client/src/styles/ios-theme.css` 已完成分层，不再接受页面级选择器：页面样式由各功能域自持，写在 `features/<domain>/styles/<domain>.css` 并由该域 `index.ts` 导入，统一收进 `@layer page`；新样式按组件目录或功能域目录新增。完整规则见 [设计规范](../DESIGN.md) 的「层序与 token 单源」「配置即规范」两节。

### stylelint 预算制（ratchet）

存量违规数冻结在 `client/stylelint-baseline.json`（按文件粒度记录，文件移动/改名时比单一总数更稳）。存量违规一律 warning，不阻塞本地开发；拦净新增靠脚本：

```bash
pnpm --filter la-pluma-next-client stylelint           # 本地查看违规（全部 warning）
pnpm --filter la-pluma-next-client stylelint:ratchet   # 预算校验（CI 同款，超出基线即失败）
pnpm --filter la-pluma-next-client stylelint:baseline  # 违规数下降或有意的迁移/重构后重新生成基线
```

CI 中 `stylelint:ratchet` 随 `pnpm verify` 一起执行（见 `.github/workflows/ci.yml`）。

### 视觉基线（8 tab + 3 弹层 + 启动壳 × 深/浅主题 × 3 视口 = 72 张）

视觉基线是样式轨道 S2/S3/S4 每一步“保留视觉”的验收手段，harness 在 `client/tests/visual/`，基线截图入库于 `client/tests/visual/__screenshots__/`。

- **环境钉死**：截图生成与比对统一跑在 `mcr.microsoft.com/playwright` 官方镜像内（tag 自动取 client 实际安装的 `@playwright/test` 版本，如 `v1.64.1-noble`），字体与浏览器由此与 CI 完全一致。基线截图是 **Linux/Chromium 专属**：更换镜像、Playwright 版本或操作系统后，必须用 `pnpm visual:update` 重新生成并逐项评审 diff，不要试图跨环境复用。
- **确定性**：`/api` 请求全部由 `client/tests/visual/fixtures.ts` 的固定数据应答（不依赖真实后端与 MAA 运行状态）；`page.clock` 固定到 2026-10-24 04:00（UTC+8），日期敏感内容（今日开放关卡、资源更新时间等）不随运行当天变化；`reducedMotion: 'reduce'` 加文档级样式禁用 CSS 动画/过渡；主题通过 zustand persist 的 `ui-storage` localStorage 预置，首帧即目标主题。公共部分集中在 `harness.ts`。
- **三个视口**：桌面 1440×900、平板 820×1180、移动 390×844，deviceScaleFactor 1。tab 基线（`app.pw.ts`）整页截图；弹层基线（`overlays.pw.ts`）为视口截图。820 落在 640（`sm`）与 900（页面自持的 stepper 断点）之间，与桌面一起把 `min-[900px]` 两侧夹住，同时也是「无侧栏 + 内联页头」这个 390 与 1440 都覆盖不到的组合；1024 / 1200 两档只在桌面侧出现，改动时注意同步核对。
- **弹层基线守 portal**：Modal、统计筛选菜单、PWA 安装提示都由 `createPortal` 渲染到 `document.body`，位于 `.la-pluma-app` 作用域之外，材质、遮罩与定位只由 portal 处的选择器决定。它们 `position: fixed` 按视口定位，`fullPage` 会把 fixed 元素拉到整页顶部，所以单独取视口。
- **启动壳基线守首帧**：启动壳（`boot.pw.ts`）在 `installDeterministicEnvironment` 之后 abort `assets/index-*.js`，让 React 模块不执行、页面停在 `index.html` 的内联启动壳上；按视口截图验收 safe-area / dvh / standalone 的真实渲染。

```bash
pnpm visual          # 比对模式：与入库基线比对，diff 非零即失败（CI 同款）
pnpm visual:update   # 有意的视觉改动后重新生成基线截图
pnpm visual -- --grep "dashboard"   # 透传 playwright 过滤参数，只跑部分用例
```

### Tailwind v4 与 S3 分层

样式轨道 S2 把 Tailwind CSS 从 v3 升级到 v4，S3 完成 token 单一化、cascade layer 与 CSS-first 配置迁移。当前约定：

- **构建链路**：依赖为 `tailwindcss@^4` + `@tailwindcss/vite`，由 Vite 插件处理样式；`autoprefixer`、`postcss` 与 `client/postcss.config.js` 已退役。PostCSS 链路不再参与前端构建。
- **入口与层序**：`client/src/styles/index.css` 在最前声明完整层序：
  ```css
  @layer theme, base, components, page, utilities;
  @import "tailwindcss";
  ```
  `@import "tailwindcss";` 必须是字符串形式（stylelint 的 `import-notation` 在该行就地豁免）。`@custom-variant dark (&:is(.dark *));` 保持 class 深色模式；不再有 `@config` 指令，也没有 `client/tailwind.config.js`。
- **配置迁移**：`rounded-*` 由 `@theme` 的 `--radius-*` 映射到 `--app-radius-*`；`gap-*` / `space-*` 由 `@utility` 定向映射到 `--app-space-*`（v4 的 gap/space/p/m 共用 `--spacing`，不能直接改 `--spacing-3/4/5/6`，否则 `p-*` / `m-*` 会被连带改变）。gap 定向工具带 `!important`，用于压过 Tailwind 同名类生成的默认声明；p/m 仍为默认 4px 节奏。映射表见 [设计规范](../DESIGN.md)。
- **content 检测**：v4 自动扫描 `index.html` 与 `src/**`，取代原 `content` glob。
- **token 单源**：语义 token 只在 `index.css` 的 `:root`、`html.dark, #app-root.dark` 与对比度/透明度媒体查询中定义；`ios-theme.css` 只保留 chrome/材质独有 token，不再重定义同名语义 token。
- **cascade layer**：`page` 位于 `components` 之后、`utilities` 之前——utilities 永远赢，页面 CSS 覆盖 base/preflight 与 components。页面/组件规则若确实要压过 utilities，使用带注释的 `!important`；不要再依赖未分层 CSS 或深选择器抢优先级。S2 期间为深色预览标题添加的 `dark:text-white!` 仍然有效。
- **gap 覆盖限制**：`@utility` 的 `gap-3/4/5/6` 带 `!important`，同一元素不要再用 `gap-[...]` 或其他 gap 档位覆盖；需要任意值时改用组件类或显式样式。
- **S3 验收记录**：32 张视觉基线比对通过、rect 0 diff；token 在 light/dark 与对比度/透明度媒体查询下的 computed 值等价。已知并接受：dashboard 运行态按钮与 combat 深色任务图标恢复 S1 基线色；约 28 个元素的 transition 属性/时序因层优先级变化（utilities 胜出或 page 覆盖 components）而变化；`background-position` 的 `0%`/`0px` 为等价序列化。`!important` 声明级 138→216（+83/-5），新增均用于压过工具类以保持既有视觉；stylelint 基线 890→856，其中 index 413→427（`no-descending-specificity` +22 为分层重排产物，已重生成基线），ios 397→349。S3 恢复 6 个页面 `@keyframes` 并修复深色 `html/body` 背景渐变。
- **v3 视觉基线**：S2 已按断代点迁移类名（`shadow-sm→shadow-xs`、`backdrop-blur-sm→backdrop-blur-xs`、`outline-none→outline-hidden`、`!` 前缀改后缀、`flex-shrink-0→shrink-0`）。**`shadow-md` 及以上档位在 v4 中数值与 v3 相同，不要按 "shadow-lg→shadow-md" 的通用口诀改名**。`ring`、裸 `border`/`divide` 已显式给色；`space-x/y` 使用 `:not(:last-child)` 的 end margin 语义。
- **默认色板**：v4 默认色板保留 OKLCH 校准值；项目语义 token 使用 `index.css` 中显式定义的颜色，不依赖默认色板。
- **preflight 对齐**：v4 移除了按钮 `cursor: pointer` 与 `:disabled` 的 default cursor，并把 placeholder 改为 currentColor/50%、默认 border-color 改为 currentColor。`index.css` 的 base 层保留了 v3 等价规则（按钮 pointer、disabled default、placeholder gray-400、border gray-200），避免 cursor 这类截图捕获不到的行为回归。
- **浏览器下限**：Tailwind v4 依赖原生 cascade layers、`color-mix()`、OKLCH 与 `@property`，前端最低支持 **Safari 16.4+ / Chrome 111+ / Firefox 128+**。低于该下限的浏览器不再保证样式正确。

## 测试治理

### 断言只看用户能感知的输出

前端测试锁的是**行为**，不是**实现**。允许断言的对象：

- 可访问性契约：`role`、`aria-*`、`disabled`、`tabIndex`、label 的 `htmlFor` 关联
- 用户可见文本与状态：文本内容、加载中/禁用/选中态的实际效果
- 交互结果：回调入参、store 状态、`location.pathname`、请求入参
- 渲染位置：portal 是否落在 `document.body` 且没有被塞回应用根（用 `closest('.la-pluma-app')` 断言）

明确禁止：

- **断言 CSS 类名**（`classList.contains('min-h-11')`、`toHaveClass('surface-soft')`）。Vitest 不做 CSS 处理，样式表根本不参与求值，这类断言只是在核对 JSX 里的字符串字面量：改类名就红，视觉零变化。点按区尺寸、断点显隐、材质层级、层级顺序由 `tests/visual/` 的像素基线守。唯一例外是 `<html>` 上的 `dark` 类——它是 Tailwind `@custom-variant dark` 的契约本体，不是样式细节。
- **断言 DOM 形状**：子元素顺序、包裹层数量、骨架屏占位块数量。这类断言把 JSX 结构写死在测试里，等价重构（换包裹层、拆组件、调列表结构）都会误报。**业务数量**可以断言（8 个导航目的地、3 个 Tab、2 个开关），但要用语义选择器数（`[role="tab"]`、`[data-app-tab]`、`[role="switch"]`），不要数 `.some-class`。
- **枚举式 grep CSS 源文件**（“这几个 `@keyframes` 名字必须存在”）：删掉声明不会报错，但枚举清单会随重构腐烂。选择器是否被应用根作用域包住，只有浏览器能判定，交给弹层基线。唯一保留的是 `client/src/styles/animations.test.ts`：它机械核对「每个 `animation` 引用都能在全部样式表里找到对应 `@keyframes` 声明」，不枚举名字，补的是 stylelint `no-unknown-animations` 只解析单文件的缺口。

### 覆盖分工

| 关注点 | 归属 | 手段 |
| --- | --- | --- |
| 纯逻辑（解析、格式化、store、URL 生成） | 单元测试 | 直接调函数 |
| 竞态、轮询、生命周期、WebRTC 状态机 | jsdom 组件/钩子测试 | 假定时器 + 回调断言 |
| 布局、断点、材质、遮罩层、视觉层级 | 视觉基线 | Playwright 像素比对 |
| 弹层（Modal、筛选菜单、PWA 提示） | 视觉基线 | 打开状态单独截图 |
| CSS 引用完整性（`@keyframes`） | 单测 | `src/styles/animations.test.ts` |

新增样式约束时先问：这条规则能不能被视觉基线捕获？能就补基线，不能才考虑写测试——且只断言结果（元素实际位置、可见性），不复述选择器。

## 文件类型

`client/` 下的应用代码、构建脚本与测试一律使用 TypeScript。`tsc -b` 通过两个 project 覆盖：`tsconfig.app.json` 检查 `src`，`tsconfig.node.json` 检查 `vite.config.ts`、`scripts/**`、`tests/visual/**` 和根级测试。Node 侧脚本直接以 `node xxx.ts` 运行（Node 24 原生类型擦除，脚本只使用可擦除语法：不用 `enum`、`namespace` 与构造器参数属性）。

只有两个 `.js` 文件是有意保留的：

- `client/public/legacy-page-cache-cleanup.js`：`public/` 由 Vite 原样复制，再经 workbox `importScripts` 注入 Service Worker，不经过构建管线，无法写成 TS。
- `client/eslint.config.js`：ESLint 9 加载 TypeScript 配置需要额外的 `jiti` 依赖，且它依赖的 `globals` 包没有类型声明；工具启动配置留在 JS，不进入应用代码。

## 常用检查

```bash
# 前端类型检查和构建（类型检查覆盖 src、vite.config.ts、scripts 与 tests/visual）
# 构建会校验 dist/assets/*.js 全部进入 dist/sw.js 的 precache 清单；
# 新增 chunk 时必须同步 createWorkboxConfig 的 globPatterns，否则构建失败。
pnpm --filter la-pluma-next-client build

# 后端语法检查
pnpm --filter la-pluma-next-server check

# 全仓 lint + 类型 + 测试 + 构建（CI 主链路）
pnpm verify

# 样式预算与视觉基线（配合 pnpm verify 使用）
pnpm --filter la-pluma-next-client stylelint:ratchet
pnpm visual
```
