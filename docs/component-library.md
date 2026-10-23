# 通用组件库

> [← 返回 README](../README.md)
>
> 视觉与交互规则以根目录 [设计规范](../DESIGN.md) 为唯一来源；本文件只记录组件 API、用法与页面落地清单。

## 概述

为了减少重复代码、统一视觉风格、提升开发效率，项目维护一套通用 UI 组件。组件位于 `client/src/components/common/*.tsx`，通过 `client/src/components/common/index.ts` 统一导出，页面中优先从 `@/components/common` 或相邻路径的 `./common` 引入。

新增或调整组件时，在本文件补充 API 与用法；颜色、字号、间距、圆角、交互状态等规则不要在组件文档里另写一份。

---

## 组件列表

### PageHeader - 页面标题组件

**文件位置**：`client/src/components/common/PageHeader.tsx`

**适用场景**：所有页面的顶部标题区域。

```typescript
{
  icon?: ReactNode
  title: string
  subtitle?: string
  actions?: ReactNode
  mobileLayout?: 'stack' | 'inline'
}
```

```tsx
import { PageHeader } from '@/components/common'
import FloatingStatusIndicator from '@/components/FloatingStatusIndicator'

<PageHeader
  title="自动战斗"
  subtitle="配置自动刷关卡任务"
  mobileLayout="inline"
  actions={<FloatingStatusIndicator />}
/>
```

页面标题统一使用全局品牌色，不再支持页面单独传入渐变色。一级工作区标题不使用 `icon-well`，只有确有身份识别需要的独立页面才传入 `icon`。手机端默认使用 `stack` 保护长标题和多操作；控制台及同级 `ios-workspace-page` 使用 `mobileLayout="inline"`，由右侧状态浮条主动收缩。

---

### Card - 卡片组件系列

**文件位置**：`client/src/components/common/Card.tsx`

**适用场景**：主要面板、信息卡片、带标题的内容区域。

```tsx
import { Card, CardHeader, CardContent } from '@/components/common'

<Card smoothCorners>
  <CardHeader
    icon={<Icons.Package />}
    title="材料掉落统计"
  />
  <CardContent>
    <p>卡片内容区域</p>
  </CardContent>
</Card>

<div className="app-info-card status-warning">
  <p>需要用户注意的信息。</p>
</div>
```

`Card` 支持 `className` 和显式的 `smoothCorners`。静态内容直接渲染，不提供整卡进场动画。`smoothCorners` 使用 Lisse 的 `20px / 80%` 连续曲率，外层仍负责布局和阴影，内部表面负责裁切与材质；只在已经验证内部包裹不会破坏直接子元素布局语义的卡片上启用。非 `Card` 面板使用 `SmoothPanel`，大面板为 `20px / 80%`，紧凑信息卡通过 `cornerSize="compact"` 使用 `16px / 80%`。不要直接给带外阴影的根元素调用 `useSmoothCorners`，也不要对需要保留原生结构的交互控件使用 `SmoothCorners asChild`。`CardHeader` 可传入 `actions`，`CardContent` 支持 `className`；紧凑提示容器使用语义类 `app-info-card` 配合对应状态类。

控制台同类功能页在根节点添加 `ios-workspace-page`，并显式给 `PageHeader` 传 `mobileLayout="inline"`。手机端只有 `Card smoothCorners` 和 `SmoothPanel` 会获得无外描边的柔和阴影；不要给卡内 `surface-soft`、菜单、输入或列表项添加该页面级材质。

---

### Button / IconButton

**文件位置**：`client/src/components/common/Button.tsx`

**适用场景**：文本按钮、主要操作、危险操作、图标按钮。

```tsx
import { Button, IconButton } from '@/components/common'
import { RefreshCw, Save } from 'lucide-react'

<Button variant="primary" icon={<Save />}>保存</Button>
<Button variant="danger" loading={deleting}>删除</Button>
<IconButton icon={<RefreshCw />} title="刷新" />
```

`Button` 支持 `primary`、`secondary`、`outline`、`success`、`danger`、`ghost`。`IconButton` 仅支持 `primary`、`secondary`、`danger`、`ghost`。新增按钮优先走 `variant`，不要在页面里手写一套按钮颜色、阴影和圆角。

`Button` 的 loading 状态会显示紧凑的 iOS 活动指示器并保留 `loadingText`；页面不要再给同一操作叠加第二个旋转图标。

---

### Input / Select / Checkbox / Switch

**文件位置**：`client/src/components/common/Input.tsx`、`client/src/components/common/Switch.tsx`

**适用场景**：表单输入、选择、错误提示、说明文字与二元设置。

```tsx
import { Input, Select, Checkbox, Switch } from '@/components/common'

<Input
  label="ADB 路径"
  value={adbPath}
  onChange={setAdbPath}
  error={adbPathError}
/>

<Select
  label="队列策略"
  value={strategy}
  onChange={setStrategy}
  options={strategyOptions}
/>

<Checkbox
  label="失败后继续下一个"
  checked={continueOnFailure}
  onChange={setContinueOnFailure}
/>

<Switch
  label="启用定时执行"
  checked={scheduleEnabled}
  onChange={setScheduleEnabled}
/>
```

`Input`、`Select` 均支持 `error` 和 `hint`，`Input` 额外支持前置 `icon`。二元启停使用 `Switch`，多选或参数组合使用 `Checkbox`；多行文本使用带 `app-input control-surface` 的原生 `textarea`。表单错误态使用 `error` prop，不要在页面里单独手写红色边框和错误文字。

---

### EmptyState

**文件位置**：`client/src/components/common/EmptyState.tsx`

**适用场景**：流程、列表、统计区或数据面板暂时没有内容。通过 `index.ts` 导入，不要在页面中各自拼装“暂无数据”的图标、文案和间距。

```tsx
import { EmptyState, Button } from '@/components/common'

<EmptyState
  compact
  icon={<Icons.TrendingUp />}
  title="暂无掉落记录"
  description="执行作战并完成材料识别后，会在这里汇总掉落。"
  action={<Button variant="secondary">刷新</Button>}
/>
```

Props：

- `icon` (ReactNode) - 可选图标。
- `title` (ReactNode, required) - 空状态主文案。
- `description` (ReactNode) - 补充说明。
- `action` (ReactNode) - 可选操作，如刷新或新建。
- `compact` (boolean) - 用于卡片内部的紧凑布局，默认 `false`。
- `className` (string) - 仅在页面结构需要额外布局约束时使用。

卡片内部使用 `compact`，页面级空状态保留默认尺寸。已有自动化流程和掉落记录页使用该组件。

---

### ConfirmDialog / Loading

**文件位置**：`client/src/components/common/Modal.tsx`、`client/src/components/common/Loading.tsx`

**适用场景**：需要确认的破坏性操作使用 `ConfirmDialog`；短时局部等待使用 `Loading`。两者都由 common 的 `index.ts` 导出。

```tsx
import { ConfirmDialog, Loading } from '@/components/common'

{loading ? <Loading text="正在读取日志..." /> : content}
<ConfirmDialog
  isOpen={confirmOpen}
  onClose={() => setConfirmOpen(false)}
  onConfirm={handleDelete}
  title="确认删除"
  message="此操作不可撤销。"
/>
```

`ConfirmDialog.onConfirm` 可以返回 Promise：返回 `false` 或抛出错误时弹窗保持打开，并在弹窗内展示失败原因。

`ActivityIndicator` 是供 `Button` 和 `Loading` 内部复用的 iOS 活动指示器，页面不要直接调用或叠加第二个动态指示器。`DashboardSkeleton` 是控制台专用骨架，由 `Dashboard` 直接从 `Loading.tsx` 引入，不属于 common 的公共导出。

---

### useFluidTabIndicator

**文件位置**：`client/src/hooks/useFluidTabIndicator.ts`

**适用场景**：带有 Framer Motion 高亮底层的分段标签。它会在切换、容器尺寸变化、标签内容变化和窗口缩放时，把高亮层对齐到当前按钮。不要在每个页面重复维护 `ResizeObserver`、元素 ref 和坐标计算。

```tsx
const { containerRef, activeRect, setTabRef } = useFluidTabIndicator(activeTab)

<div ref={containerRef} className="relative">
  <motion.div
    className="pointer-events-none absolute"
    animate={{
      x: activeRect.x,
      y: activeRect.y,
      width: activeRect.width,
      height: activeRect.height,
    }}
  />
  {tabs.map((tab) => (
    <button key={tab.id} ref={setTabRef(tab.id)}>{tab.label}</button>
  ))}
</div>
```

标签 ID 需是字符串联合类型，且高亮容器需要 `relative` 定位。作业、养成和肉鸽页面已使用该 Hook。

---

## 页面重构清单

新增页面或改老页面时，按下面顺序处理：

1. 页面外层使用 `app-page`，主内容使用 `app-stack-section`。
2. 页面标题使用 `PageHeader`。
3. 大面板使用 `Card` 或 `app-card surface-panel`。
4. 表单使用 `Input`、`Select`、`Checkbox`、`Switch`；多行文本复用 `app-input control-surface`。
5. 没有内容时使用 `EmptyState`，不要重复手写空状态。
6. 动态分段标签优先使用 `useFluidTabIndicator`，不要复制测量逻辑。
7. 页面全局执行状态使用 `FloatingStatusIndicator`；局部状态使用既有 `status-*` 语义类并紧邻相关操作。
8. 操作用 `Button`、`IconButton`。
9. 如果出现新的颜色、圆角、间距需求，先按根目录 [设计规范](../DESIGN.md) 判断是否应抽成 token 或语义类。

### Tailwind 动态类名

Tailwind CSS 不支持动态拼接类名：

```tsx
// 不要这样写
className={`bg-${color}`}
className={`from-${tone}`}
```

需要按状态切换样式时，使用明确的 class 映射，或优先使用已有语义类。

---

## 维护清单

- [x] 页面级色彩收敛到品牌色与状态语义色。
- [x] 圆角和常用间距接入 Tailwind token。
- [x] 卡片、按钮、输入控件接入 `app-*` 语义类。
- [x] 移动端页面 padding 改由 `app-page` 和 spacing token 控制。
- [ ] 持续把零散手写卡片迁移到 `Card` 或 `app-card`。
- [ ] 为核心通用组件补充单元测试或视觉回归检查。

---

## 参考资料

- [Tailwind CSS 文档](https://tailwindcss.com/docs)
- [Framer Motion 文档](https://www.framer.com/motion/)
- [React 组件设计模式](https://reactpatterns.com/)
