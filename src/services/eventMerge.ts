import type {
  BusinessScenario,
  DownstreamDependency,
  EventDefinition,
  EventMerge,
  EventProperty,
  GovernanceState,
  MergeBlocker,
  MergeCheckpointStep,
  MergeFieldMapping,
  MergeReferenceBackup,
  MergeStatus,
} from '@/models/domain'
import { createId } from '@/services/repository'

export class MergeConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MergeConflictError'
  }
}

const ACTIVE_MERGE_STATUSES: MergeStatus[] = ['draft', 'pending', 'confirming', 'confirmed']

/** 同一对事件无论主备顺序如何，都生成同一份记录 */
export const mergePairKey = (eventAId: string, eventBId: string): string =>
  [eventAId, eventBId].sort().join('::')

export const findMergeByPair = (
  state: GovernanceState,
  eventAId: string,
  eventBId: string,
): EventMerge | undefined =>
  state.merges.find((merge) => merge.pairKey === mergePairKey(eventAId, eventBId))

const normalizeAlias = (value: string): string => value.trim().toLowerCase()

const aliasSet = (property: EventProperty): Set<string> =>
  new Set([property.name, ...property.synonyms].map(normalizeAlias).filter(Boolean))

/** 按同名、同义词、跨事件血缘依次为待合并属性寻找主事件属性 */
const matchTarget = (
  source: EventProperty,
  master: EventDefinition,
): { target: EventProperty | null; basis: MergeFieldMapping['matchBasis'] } => {
  const lineage = master.properties.find(
    (property) => property.id === source.lineageSourceId,
  )
  if (lineage) return { target: lineage, basis: 'lineage' }

  const byName = master.properties.find(
    (property) => normalizeAlias(property.name) === normalizeAlias(source.name),
  )
  if (byName) return { target: byName, basis: 'name' }

  const sourceAliases = aliasSet(source)
  const bySynonym = master.properties.find((property) => {
    const targetAliases = aliasSet(property)
    return [...sourceAliases].some((alias) => alias && targetAliases.has(alias))
  })
  if (bySynonym) return { target: bySynonym, basis: 'synonym' }

  return { target: null, basis: 'none' }
}

export const buildFieldMappings = (
  master: EventDefinition,
  source: EventDefinition,
): MergeFieldMapping[] =>
  source.properties
    .filter((property) => !property.deletedAt)
    .map((property) => {
      const matched = matchTarget(property, master)
      const typeConflict =
        Boolean(matched.target) && matched.target!.type !== property.type
      return {
        id: createId('map'),
        sourcePropertyId: property.id,
        sourceName: property.name,
        sourceType: property.type,
        targetPropertyId: matched.target?.id ?? null,
        targetName: matched.target?.name ?? null,
        targetType: matched.target?.type ?? null,
        matchBasis: matched.basis,
        status: typeConflict
          ? 'type_conflict'
          : matched.target
            ? 'auto'
            : 'dropped',
        resolution: '',
        valueMapping: [],
        castNote: '',
        note: matched.target
          ? typeConflict
            ? `${property.type} 与主事件 ${matched.target.type} 类型不一致，需要转换或丢弃`
            : `按${matched.basis === 'name' ? '同名' : matched.basis === 'synonym' ? '同义词' : '血缘'}自动匹配`
          : '主事件无对应字段，待确认丢弃或手动指定',
      } satisfies MergeFieldMapping
    })

/** 映射图（含其他进行中/已确认合并）成环检测 */
const detectMappingCycle = (
  state: GovernanceState,
  draft: EventMerge,
): MergeBlocker[] => {
  const graph = new Map<string, string[]>()
  const addEdge = (from: string, to: string): void => {
    graph.set(from, [...(graph.get(from) ?? []), to])
  }
  state.merges
    .filter(
      (merge) =>
        merge.id !== draft.id && ACTIVE_MERGE_STATUSES.includes(merge.status),
    )
    .forEach((merge) =>
      merge.mappings
        .filter((mapping) => mapping.targetPropertyId && mapping.resolution !== 'drop')
        .forEach((mapping) => addEdge(mapping.sourcePropertyId, mapping.targetPropertyId!)),
    )
  draft.mappings
    .filter((mapping) => mapping.targetPropertyId && mapping.resolution !== 'drop')
    .forEach((mapping) => addEdge(mapping.sourcePropertyId, mapping.targetPropertyId!))

  const blockers: MergeBlocker[] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []
  const dfs = (node: string): boolean => {
    if (visiting.has(node)) {
      blockers.push({
        kind: 'mapping_cycle',
        message: `字段映射成环：${[...stack.slice(stack.indexOf(node)), node]
          .map((id) => id)
          .join(' → ')}，请调整或丢弃部分映射`,
      })
      return true
    }
    if (visited.has(node)) return false
    visiting.add(node)
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      if (dfs(next)) return true
    }
    stack.pop()
    visiting.delete(node)
    visited.add(node)
    return false
  }
  for (const node of graph.keys()) {
    if (!visited.has(node) && dfs(node)) break
  }
  return blockers
}

/** 重新计算待处理阻塞：类型冲突未处置、成环、来源字段悬空 */
export const recomputeBlockers = (
  state: GovernanceState,
  merge: EventMerge,
): MergeBlocker[] => {
  const blockers: MergeBlocker[] = []
  merge.mappings.forEach((mapping) => {
    if (mapping.status === 'type_conflict' && mapping.resolution === '') {
      blockers.push({
        kind: 'type_conflict',
        mappingId: mapping.id,
        message: `${mapping.sourceName}（${mapping.sourceType}）→ ${mapping.targetName}（${mapping.targetType}）类型冲突，需选择类型转换或丢弃`,
      })
    }
    if (!mapping.targetPropertyId && mapping.resolution !== 'drop') {
      blockers.push({
        kind: 'unmapped_source',
        mappingId: mapping.id,
        message: `旧事件字段 ${mapping.sourceName} 在主事件中无对应字段，需手动指定或确认丢弃`,
      })
    }
    if (
      mapping.resolution === 'cast' &&
      mapping.valueMapping.some((row) => row.from.trim() && !row.to.trim())
    ) {
      blockers.push({
        kind: 'type_conflict',
        mappingId: mapping.id,
        message: `${mapping.sourceName} 的取值映射存在未填写的目标枚举`,
      })
    }
  })
  blockers.push(...detectMappingCycle(state, merge))
  return blockers
}

export const createMergeDraft = (
  state: GovernanceState,
  masterEventId: string,
  sourceEventId: string,
  reason: string,
): EventMerge => {
  if (masterEventId === sourceEventId) {
    throw new MergeConflictError('主事件与待合并事件不能相同')
  }
  const master = state.events.find((event) => event.id === masterEventId)
  const source = state.events.find((event) => event.id === sourceEventId)
  if (!master || !source) throw new MergeConflictError('选择的事件不存在')

  const existing = findMergeByPair(state, masterEventId, sourceEventId)
  if (existing && ACTIVE_MERGE_STATUSES.includes(existing.status)) {
    throw new MergeConflictError(
      `这对事件已存在${existing.status === 'confirmed' ? '已确认' : '待处理'}合并记录，同一对事件只允许一份`,
    )
  }

  const now = new Date().toISOString()
  const draft: EventMerge = {
    id: createId('merge'),
    pairKey: mergePairKey(masterEventId, sourceEventId),
    masterEventId,
    sourceEventId,
    status: 'draft',
    reason,
    operator: '当前用户',
    version: 0,
    mappings: buildFieldMappings(master, source),
    blockers: [],
    affectedDependencyIds: state.dependencies
      .filter((dependency) => dependency.eventIds.includes(sourceEventId))
      .map((dependency) => dependency.id),
    createdAt: now,
    updatedAt: now,
  }
  draft.blockers = recomputeBlockers(state, draft)
  return draft
}

export const mergeReady = (merge: EventMerge): boolean => merge.blockers.length === 0

/** 检查点步骤顺序，每步幂等，中断后可从首个未完成步骤继续 */
export const CHECKPOINT_STEPS: MergeCheckpointStep[] = [
  'backup',
  'aliases',
  'rewrite_refs',
  'scenarios',
  'source_retire',
  'finalize',
]

export const checkpointLabel: Record<MergeCheckpointStep, string> = {
  backup: '备份合并前引用',
  aliases: '旧键登记为别名',
  rewrite_refs: '看板与查询改写主事件',
  scenarios: '业务场景引用改写',
  source_retire: '旧事件停采归档',
  finalize: '合并归档',
}

export const affectedDependencyRefs = (
  dependencies: DownstreamDependency[],
  merge: EventMerge,
): Array<{ dependency: DownstreamDependency; refCount: number }> =>
  dependencies
    .filter((dependency) => merge.affectedDependencyIds.includes(dependency.id))
    .map((dependency) => ({
      dependency,
      refCount: dependency.propertyRefs.filter(
        (reference) =>
          reference.eventId === merge.sourceEventId ||
          reference.eventId === merge.masterEventId,
      ).length,
    }))

/** 沿 mergedIntoEventId 解析当前生效主事件 */
export const resolveEvent = (
  state: GovernanceState,
  eventId: string,
): EventDefinition | undefined => {
  const event = state.events.find((item) => item.id === eventId)
  if (!event) return undefined
  if (event.mergedIntoEventId) {
    return resolveEvent(state, event.mergedIntoEventId) ?? event
  }
  return event
}

/** 把任意事件/属性引用解析到主事件及其属性（旧键走别名与历史映射） */
export const resolvePropertyRef = (
  state: GovernanceState,
  eventId: string,
  propertyId: string,
): { eventId: string; propertyId: string | null } => {
  const merge = state.merges.find(
    (item) =>
      item.status === 'confirmed' &&
      (item.sourceEventId === eventId || item.masterEventId === eventId),
  )
  if (!merge || eventId !== merge.sourceEventId) return { eventId, propertyId }
  const mapping = merge.mappings.find(
    (item) => item.sourcePropertyId === propertyId && item.targetPropertyId,
  )
  return {
    eventId: merge.masterEventId,
    propertyId: mapping?.targetPropertyId ?? null,
  }
}

export const snapshotReferences = (
  state: GovernanceState,
  merge: EventMerge,
): MergeReferenceBackup => {
  const involved = new Set([merge.masterEventId, merge.sourceEventId])
  return {
    events: structuredClone(
      state.events.filter((event) => involved.has(event.id)),
    ),
    dependencies: structuredClone(
      state.dependencies.filter((dependency) =>
        merge.affectedDependencyIds.includes(dependency.id),
      ),
    ),
    scenarios: structuredClone(
      state.scenarios.filter((scenario) =>
        scenario.eventIds.some((eventId) => involved.has(eventId)),
      ) as BusinessScenario[],
    ),
    savedAt: new Date().toISOString(),
  }
}

export interface MergeSuggestion {
  masterEventId: string
  sourceEventId: string
  sharedProperties: number
  conflicts: number
}

/** 看板上推荐可合并的重复事件对（同类别 + 属性别名重叠） */
export const mergeSuggestions = (state: GovernanceState): MergeSuggestion[] => {
  const candidates = state.events.filter(
    (event) => event.status !== 'retired' && !event.mergedIntoEventId,
  )
  const suggestions: MergeSuggestion[] = []
  for (let index = 0; index < candidates.length; index += 1) {
    for (let cursor = index + 1; cursor < candidates.length; cursor += 1) {
      const left = candidates[index]!
      const right = candidates[cursor]!
      if (left.category !== right.category) continue
      if (findMergeByPair(state, left.id, right.id)) continue
      let shared = 0
      let conflicts = 0
      right.properties
        .filter((property) => !property.deletedAt)
        .forEach((sourceProperty) => {
          const { target } = matchTarget(sourceProperty, left)
          if (!target) return
          shared += 1
          if (target.type !== sourceProperty.type) conflicts += 1
        })
      if (shared > 0) {
        suggestions.push({
          masterEventId: left.id,
          sourceEventId: right.id,
          sharedProperties: shared,
          conflicts,
        })
      }
    }
  }
  return suggestions.sort(
    (a, b) => b.sharedProperties - a.sharedProperties || b.conflicts - a.conflicts,
  )
}
