# EventRail 多端埋点事件治理与发布评审平台

基于 Vue 3、TDesign、Pinia、Vue Router、TanStack Query、Axios、Vite 与 TypeScript 的独立前端工程。项目使用 Axios 自定义本地适配器模拟契约 API，查询缓存由 TanStack Query 管理，业务编辑状态由 Pinia 持久化到浏览器 `localStorage`。

## 功能

- 按业务域维护事件树、多端触发规则、属性和负责人
- 属性类型、枚举、必填条件、同义字段和跨事件血缘
- 重复事件、同义属性、命名越界、类型变化与删除字段引用检查
- JSON 示例的类型、枚举和必填规则校验
- 发布候选契约比较、受影响下游依赖和迁移确认
- 数据、产品、客户端和测试四角色批量审批与发布门禁
- 事件废弃计划、替代事件和迁移说明
- 可撤销的事件合并：按血缘生成字段映射、类型冲突/成环阻塞看板、检查点续跑、旧键别名、对账与合并前引用恢复
- 发布回滚记录与结果验证
- JSON 契约和 Markdown 契约文档导出

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18474`。

## 构建

```bash
npm run build
```

## 事件合并端到端验证

```bash
npm run test:merge
```

覆盖：同名字段血缘映射、枚举与字符串类型冲突拦截、同对事件唯一记录、确认后看板/查询改读主事件且旧键留别名、写入中断从检查点继续、双窗口版本冲突、撤销留档、对账不平恢复合并前引用、跨事件映射成环检测。

## 数据层

- `src/services/api.ts`：Axios 实例与本地 API 适配器
- `src/services/eventMerge.ts`：合并映射、阻塞（类型冲突/成环）、检查点与引用解析
- `src/services/eventMergeReducer.ts`：框架无关的合并状态迁移（乐观锁版本号、检查点、对账与恢复），store 仅做薄封装
- `src/composables/useGovernanceQueries.ts`：TanStack Query 查询组合
- `src/stores/governance.ts`：Pinia 编辑、审批、废弃、合并和回滚状态
- `src/services/selectors.ts`：契约比较、影响分析和校验规则
