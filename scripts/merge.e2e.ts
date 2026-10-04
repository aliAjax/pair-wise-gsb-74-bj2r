import assert from 'node:assert/strict'
import { createSeedState } from '@/models/seed'
import {
  startMerge,
  updateMergeMapping,
  submitMerge,
  confirmMerge,
  cancelMerge,
  reconcileMerge,
  undoMerge,
  StaleMergeVersionError,
} from '@/services/eventMergeReducer'

// 内存 localStorage 桩（repository 模块在导入时不会读取，仅在调用时读取）
const memory = new Map()
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => void memory.set(key, String(value)),
  removeItem: (key) => void memory.delete(key),
}

const MASTER = 'evt-004' // coupon_apply_result (apply_result enum)
const SOURCE = 'evt-005' // coupon_receive_result (result string)

const fresh = () => {
  const state = structuredClone(createSeedState())
  state.merges = []
  return state
}

let passed = 0
const ok = (name) => {
  passed += 1
  console.log(`  ✓ ${name}`)
}

// 1. 创建合并：同名字段自动映射，result(string) -> apply_result(enum) 类型冲突
{
  const state = fresh()
  const merge = startMerge(state, MASTER, SOURCE, '新旧领券事件统一口径', '2026-10-04T10:00:00Z')
  assert.equal(merge.status, 'draft')
  assert.equal(merge.mappings.length, 3)
  const coupon = merge.mappings.find((m) => m.sourceName === 'coupon_id')
  const resultMap = merge.mappings.find((m) => m.sourceName === 'result')
  const sourcePage = merge.mappings.find((m) => m.sourceName === 'source_page')
  assert.equal(coupon.status, 'auto')
  assert.equal(resultMap.status, 'type_conflict')
  assert.equal(resultMap.targetName, 'apply_result')
  assert.equal(resultMap.targetType, 'enum')
  assert.ok(merge.blockers.some((b) => b.kind === 'type_conflict'), '应有类型冲突阻塞')
  assert.equal(sourcePage.status, 'auto')
  ok('按血缘/同名生成映射，枚举 vs 字符串类型冲突被列出')

  // 2. 冲突未处置不能提交
  assert.throws(() => submitMerge(state, merge.id, merge.version), /阻塞/)
  ok('类型冲突未处置时提交被拦截，停在待处理前')

  // 3. 处置：cast + 枚举映射
  const v1 = merge.version
  updateMergeMapping(state, merge.id, v1, resultMap.id, {
    resolution: 'cast',
    valueMapping: [
      { from: '成功', to: 'success' },
      { from: '已领完', to: 'sold_out' },
      { from: '不符合', to: 'not_eligible' },
      { from: '失败', to: 'error' },
    ],
    castNote: '旧字符串口径映射到标准枚举',
  })
  assert.equal(merge.blockers.length, 0, '处置后应无阻塞')
  submitMerge(state, merge.id, merge.version)
  assert.equal(merge.status, 'pending')
  ok('处置类型冲突后可提交到待处理')

  // 4. 同一对事件只能一份记录（反向选主也不行）
  assert.throws(() => startMerge(state, SOURCE, MASTER, '再来一次', '2026-10-04T10:01:00Z'), /一份/)
  ok('同一对事件（含主备颠倒）只生成一份记录')

  // 5. 确认：别名 + 引用改写 + 旧事件停采
  confirmMerge(state, merge.id, merge.version, '2026-10-04T10:02:00Z')
  assert.equal(merge.status, 'confirmed')
  const master = state.events.find((e) => e.id === MASTER)
  const source = state.events.find((e) => e.id === SOURCE)
  assert.deepEqual(master.keyAliases, ['coupon_receive_result'], '旧键应成为主事件别名')
  assert.ok(
    master.properties.find((p) => p.name === 'apply_result').synonyms.includes('result'),
    '旧字段名应成为主字段同义词',
  )
  assert.equal(source.mergedIntoEventId, MASTER)
  assert.equal(source.status, 'deprecated')
  assert.ok(source.platformRules.every((r) => !r.enabled))
  const dep6 = state.dependencies.find((d) => d.id === 'dep-006')
  assert.ok(!dep6.eventIds.includes(SOURCE), '看板 eventIds 应改读主事件')
  assert.ok(dep6.eventIds.includes(MASTER))
  const rewrittenResult = dep6.propertyRefs.find(
    (r) => r.eventId === MASTER && r.propertyId === resultMap.targetPropertyId,
  )
  assert.ok(rewrittenResult, 'result 引用应改写到 apply_result')
  assert.equal(dep6.status, 'migration_required')
  const scenario = state.scenarios.find((s) => s.id === 'scn-002')
  assert.ok(!scenario.eventIds.includes(SOURCE) && scenario.eventIds.includes(MASTER))
  ok('确认后看板与查询改读主事件，旧键留别名，旧事件停采')

  // 6. 对账平衡
  const expected = dep6.propertyRefs.filter(
    (r) => r.eventId === MASTER || r.eventId === SOURCE,
  ).length
  const balanced = reconcileMerge(state, merge.id, merge.version, expected, '看板口径一致', '2026-10-04T10:05:00Z')
  assert.equal(balanced.balanced, true)
  assert.equal(balanced.archivedMapping.length, 3)
  ok('对账平衡且历史映射已留档')
}

// 7. 写入中断后从检查点继续
{
  const state = fresh()
  const merge = startMerge(state, MASTER, SOURCE, '', 't0')
  const resultMap = merge.mappings.find((m) => m.sourceName === 'result')
  updateMergeMapping(state, merge.id, merge.version, resultMap.id, {
    resolution: 'cast',
    valueMapping: [{ from: '成功', to: 'success' }],
  })
  submitMerge(state, merge.id, merge.version)
  const versionAtSubmit = merge.version

  assert.throws(
    () => confirmMerge(state, merge.id, versionAtSubmit, 't1', { failAtStep: 'rewrite_refs' }),
    /中断/,
  )
  assert.equal(merge.status, 'confirming')
  assert.equal(merge.checkpoint.step, 'rewrite_refs')
  assert.equal(merge.checkpoint.done, false)
  // backup 与 aliases 已完成
  const master = state.events.find((e) => e.id === MASTER)
  assert.deepEqual(master.keyAliases, ['coupon_receive_result'])
  // 引用尚未改写
  const dep6 = state.dependencies.find((d) => d.id === 'dep-006')
  assert.ok(dep6.eventIds.includes(SOURCE))
  ok('中断时检查点之前的步骤已落盘，之后的步骤未执行')

  // 从检查点继续
  confirmMerge(state, merge.id, merge.version, 't2')
  assert.equal(merge.status, 'confirmed')
  assert.ok(!dep6.eventIds.includes(SOURCE) && dep6.eventIds.includes(MASTER))
  assert.equal(merge.checkpoint.step, 'finalize')
  ok('从中断点继续后完成全部步骤')
}

// 8. 两个窗口：后到方版本落后
{
  const state = fresh()
  const merge = startMerge(state, MASTER, SOURCE, '', 't0')
  const resultMap = merge.mappings.find((m) => m.sourceName === 'result')
  const staleVersion = merge.version
  // 窗口 A 先处置了冲突并提交
  updateMergeMapping(state, merge.id, staleVersion, resultMap.id, {
    resolution: 'drop',
  })
  // 窗口 B 拿着旧版本提交 -> 冲突
  assert.throws(() => submitMerge(state, merge.id, staleVersion), StaleMergeVersionError)
  ok('后到窗口持旧版本提交时看到版本冲突，写入中断')

  // 撤销后同一对可重新发起
  submitMerge(state, merge.id, merge.version)
  cancelMerge(state, merge.id, merge.version, 't3')
  assert.equal(merge.status, 'undone')
  const again = startMerge(state, MASTER, SOURCE, '重新合并', 't4')
  assert.notEqual(again.id, merge.id)
  assert.equal(state.merges.filter((m) => m.status !== 'undone').length, 1)
  ok('撤销留档后同一对事件可重新生成一份记录')
}

// 9. 对账不平 -> 恢复合并前引用，差异与映射留档
{
  const state = fresh()
  const merge = startMerge(state, MASTER, SOURCE, '', 't0')
  const resultMap = merge.mappings.find((m) => m.sourceName === 'result')
  updateMergeMapping(state, merge.id, merge.version, resultMap.id, {
    resolution: 'cast',
    valueMapping: [{ from: '成功', to: 'success' }],
  })
  submitMerge(state, merge.id, merge.version)
  confirmMerge(state, merge.id, merge.version, 't1')

  // 模拟一个漏改写的看板（恢复 dep-006 对旧事件的引用）
  const dep6 = state.dependencies.find((d) => d.id === 'dep-006')
  dep6.eventIds.push(SOURCE)
  const expected = dep6.propertyRefs.filter((r) => r.eventId === MASTER).length
  const recon = reconcileMerge(state, merge.id, merge.version, expected + 1, '看板仍有旧口径', 't2')
  assert.equal(recon.balanced, false)
  assert.ok(recon.differences.length >= 1)
  ok('对账不平检测出未改读主事件的看板引用并留档差异')

  const sourceBefore = state.events.find((e) => e.id === SOURCE)
  assert.equal(sourceBefore.status, 'deprecated')
  undoMerge(state, merge.id, merge.version, '旧看板仍依赖字符串 result', 't3')
  assert.equal(merge.status, 'undone')
  assert.equal(merge.reconciliation.restored, true)
  const sourceAfter = state.events.find((e) => e.id === SOURCE)
  const masterAfter = state.events.find((e) => e.id === MASTER)
  assert.equal(sourceAfter.status, 'deprecated', '恢复到合并前旧事件状态（种子中即 deprecated）')
  assert.equal(sourceAfter.mergedIntoEventId, undefined)
  assert.deepEqual(masterAfter.keyAliases ?? [], [])
  const dep6Restored = state.dependencies.find((d) => d.id === 'dep-006')
  assert.ok(dep6Restored.eventIds.includes(SOURCE))
  assert.ok(merge.mappings.length === 3, '历史映射仍保留在记录中')
  ok('恢复合并前引用，事件/看板/场景回到合并前，差异与历史映射留档')
}

// 10. 映射成环检测（构造跨不同事件对的环）
{
  const state = fresh()
  // 构造三个事件 A/B/C，属性 a/b/c；已确认合并 B→A（b→a）、C→B（c→b），再造 A→C（a→c）闭环
  const mkProp = (id, eventId, name) => ({
    id, eventId, name, displayName: name, type: 'string', required: true,
    description: '', enumValues: [], owner: 't', synonyms: [], platforms: ['server'],
  })
  const mkEvent = (id, key, properties) => ({
    id, key, displayName: key, category: '合成', description: '', trigger: '',
    status: 'published', version: '1.0.0', owner: 't', properties,
    platformRules: [], scenarioIds: [], downstreamDependencyIds: [], updatedAt: 't0',
  })
  const a = mkEvent('evt-A', 'ring_a', [mkProp('pa', 'evt-A', 'fa')])
  const b = mkEvent('evt-B', 'ring_b', [mkProp('pb', 'evt-B', 'fb')])
  const c = mkEvent('evt-C', 'ring_c', [mkProp('pc', 'evt-C', 'fc')])
  state.events.push(a, b, c)

  const m1 = startMerge(state, 'evt-A', 'evt-B', 'b 并入 a', 't0')
  updateMergeMapping(state, m1.id, m1.version, m1.mappings[0].id, { targetPropertyId: 'pa' })
  submitMerge(state, m1.id, m1.version)
  confirmMerge(state, m1.id, m1.version, 't1')

  const m2 = startMerge(state, 'evt-B', 'evt-C', 'c 并入 b', 't0')
  updateMergeMapping(state, m2.id, m2.version, m2.mappings[0].id, { targetPropertyId: 'pb' })
  submitMerge(state, m2.id, m2.version)
  confirmMerge(state, m2.id, m2.version, 't1')

  // a → c：与既有 c→b→a 构成 a→c→b→a 环
  const m3 = startMerge(state, 'evt-C', 'evt-A', 'a 并入 c 制造环', 't2')
  updateMergeMapping(state, m3.id, m3.version, m3.mappings[0].id, { targetPropertyId: 'pc' })
  assert.ok(m3.blockers.some((bl) => bl.kind === 'mapping_cycle'), '应检测出映射环')
  assert.throws(() => submitMerge(state, m3.id, m3.version), /阻塞/)
  ok('跨事件对字段映射成环时停在待处理并列出阻塞')
}

console.log(`\n全部通过：${passed} 项断言场景`)
