# EventRail 多端埋点事件治理与发布评审平台

基于 Vue 3、TDesign、Pinia、Vue Router、TanStack Query、Axios、Vite 与 TypeScript 的独立前端工程。项目使用 Axios 自定义本地适配器模拟契约 API，查询缓存由 TanStack Query 管理，业务编辑状态由 Pinia 持久化到浏览器 `localStorage`。

## 功能

- 按业务域维护事件树、多端触发规则、属性和负责人
- 属性类型、枚举、必填条件、同义字段和跨事件血缘
- 重复事件、同义属性、命名越界、类型变化与删除字段引用检查
- 可撤销事件合并：血缘字段映射、类型冲突/成环阻塞、检查点续跑、跨窗口乐观锁与对账恢复
- JSON 示例的类型、枚举和必填规则校验
- 发布候选契约比较、受影响下游依赖和迁移确认
- 数据、产品、客户端和测试四角色批量审批与发布门禁
- 事件废弃计划、替代事件和迁移说明
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

## 数据层

- `src/services/api.ts`：Axios 实例与本地 API 适配器
- `src/services/merges.ts`：事件合并的血缘映射、类型冲突与映射成环检测、对账
- `src/composables/useGovernanceQueries.ts`：TanStack Query 查询组合
- `src/stores/governance.ts`：Pinia 编辑、审批、废弃、合并和回滚状态
- `src/services/selectors.ts`：契约比较、影响分析、合并读解析和校验规则

## 事件合并

在「事件合并」页选择主事件与待合并事件后：

1. 系统按跨事件血缘、同名/同义词生成字段映射，同名但类型不同（如旧领券的 `result` 字符串 vs 主事件 `apply_result` 枚举）会停待处理，可选择「接受转换」或「放弃字段」；映射双向回填成环时同样阻塞。
2. 同一对事件（无序）只生成一份记录；确认前可撤销。
3. 确认按检查点分阶段写入（快照 → 别名 → 看板/查询 → 场景 → 发布 → 旧事件停采），中断后再次确认从检查点继续。
4. 确认后看板与查询改读主事件，旧事件键和旧字段名保留为别名（`GET /events/{旧id或旧键}` 自动解析到主事件）。
5. 两个窗口同时提交或撤销时，后到方持旧版本号写入会收到冲突，需同步最新版本后重试；其它标签页的写入通过 `storage` 事件自动同步。
6. 对账不平时可按合并前快照恢复全部引用，差异清单与历史字段映射留档。
