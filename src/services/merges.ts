import type {
  EventDefinition,
  EventMergeRecord,
  EventProperty,
  GovernanceState,
  MergeFieldMapping,
  MergeReconcileDiff,
  MergeReference,
} from '@/models/domain'
import { createId } from '@/services/repository'

/** 同一对事件（无序）只生成一份记录 */
export const mergePairKey = (eventA: string, eventB: string): string =>
  [eventA, eventB].sort().join('::')

const active = (property: EventProperty): boolean => !property.deletedAt

/** 按跨事件血缘与同名词典匹配源字段到主事件字段 */
const matchTarget = (
  source: EventProperty,
  primary: EventDefinition,
  existingMappings: MergeFieldMapping[],
): { property: EventProperty; reason: string } | undefined => {
  const occupiedTargetIds = new Set(existingMappings.map((mapping) => mapping.targetPropertyId))
  const candidates = primary.properties.filter(
    (property) => active(property) && !occupiedTargetIds.has(property.id),
  )

  const lineageMatch = candidates.find(
    (property) =>
      property.lineageSourceId === source.id || source.lineageSourceId === property.id,
  )
  if (lineageMatch) {
    return { property: lineageMatch, reason: '跨事件血缘直接关联' }
  }

  const sourceAliases = new Set([source.name, ...source.synonyms])
  const aliasMatch = candidates.find((property) =>
    [property.name, ...property.synonyms].some((alias) => sourceAliases.has(alias)),
  )
  if (aliasMatch) {
    return { property: aliasMatch, reason: '同名或同义词命中' }
  }

  return undefined
}

/**
 * 在「候选映射 + 已有合并历史映射」构成的有向图上检测成环。
 * 每条映射建立 旧字段 -> 主字段 的边；开启 backfill 时额外建立反向边。
 * 若从主字段能沿图回到旧字段，则该映射位于环上。
 */
export const detectMappingCycle = (
  sourceEventId: string,
  targetEventId: string,
  proposed: MergeFieldMapping[],
  history: MergeFieldMapping[],
): Set<string> => {
  const nodeKey = (event: string, property: string): string => `${event}::${property}`
  const edges = new Map<string, Set<string>>()
  const addEdge = (from: string, to: string): void => {
    const list = edges.get(from) ?? new Set<string>()
    list.add(to)
    edges.set(from, list)
  }

  const ingest = (mappings: MergeFieldMapping[], onlySelected: boolean): void => {
    mappings
      .filter((mapping) => mapping.targetPropertyId && (!onlySelected || mapping.selected))
      .forEach((mapping) => {
        const from = nodeKey(mapping.sourceEventId, mapping.sourcePropertyId)
        const to = nodeKey(mapping.targetEventId, mapping.targetPropertyId)
        addEdge(from, to)
        if (mapping.backfill) addEdge(to, from)
      })
  }
  ingest(history, true)
  ingest(proposed, true)

  const reaches = (start: string, goal: string): boolean => {
    const stack = [start]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const node = stack.pop()!
      if (node === goal && seen.size > 0) return true
      if (seen.has(node)) continue
      seen.add(node)
      ;(edges.get(node) ?? []).forEach((next) => stack.push(next))
    }
    return false
  }

  const cyclic = new Set<string>()
  proposed
    .filter((mapping) => mapping.targetPropertyId && mapping.selected)
    .forEach((mapping) => {
      const from = nodeKey(sourceEventId, mapping.sourcePropertyId)
      const to = nodeKey(targetEventId, mapping.targetPropertyId)
      if (reaches(to, from)) cyclic.add(mapping.sourcePropertyId)
    })
  return cyclic
}

/** 重新评估一组候选映射的成环情况，返回成环字段与阻塞原因 */
export const evaluateMappingSelection = (
  state: GovernanceState,
  record: Pick<EventMergeRecord, 'primaryEventId' | 'sourceEventId' | 'mappings'>,
): { cyclicIds: Set<string>; blockingReasons: string[] } => {
  const history = state.merges
    .filter((item) => item.id !== undefined)
    .flatMap((item) =>
      item.status === 'merged' ? item.mappings.filter((mapping) => mapping.selected) : [],
    )
  const cyclicIds = detectMappingCycle(
    record.sourceEventId,
    record.primaryEventId,
    record.mappings,
    history,
  )
  const blockingReasons: string[] = []
  const selectedConflicts = record.mappings.filter(
    (mapping) => mapping.selected && mapping.conflict,
  )
  if (selectedConflicts.length > 0) {
    blockingReasons.push(
      `存在 ${selectedConflicts.length} 个同名属性类型冲突：${selectedConflicts
        .map((mapping) => mapping.sourceName)
        .join('、')}`,
    )
  }
  if (cyclicIds.size > 0) {
    blockingReasons.push(
      `字段映射成环：${record.mappings
        .filter((mapping) => cyclicIds.has(mapping.sourcePropertyId))
        .map((mapping) => mapping.sourceName)
        .join('、')}`,
    )
  }
  return { cyclicIds, blockingReasons }
}

export interface PrepareMergeResult {
  record: Omit<EventMergeRecord, 'id' | 'createdAt' | 'updatedAt' | 'version'>
  blockingReasons: string[]
}

/** 选主事件与待合并事件，按血缘生成字段映射并做冲突/成环检查 */
export const prepareMerge = (
  state: GovernanceState,
  primaryEventId: string,
  sourceEventId: string,
  reason: string,
): PrepareMergeResult => {
  const primary = state.events.find((event) => event.id === primaryEventId)
  const source = state.events.find((event) => event.id === sourceEventId)
  if (!primary || !source) {
    throw new Error('主事件或待合并事件不存在')
  }
  if (primaryEventId === sourceEventId) {
    throw new Error('主事件与待合并事件不能相同')
  }
  if (primary.mergedIntoId || source.mergedIntoId) {
    throw new Error('事件已被合并，不能重复参与合并')
  }

  const history = state.merges.flatMap((record) =>
    record.status === 'merged' ? record.mappings.filter((mapping) => mapping.selected) : [],
  )

  const mappings: MergeFieldMapping[] = []
  source.properties.filter(active).forEach((sourceProperty) => {
    const matched = matchTarget(sourceProperty, primary, mappings)
    const target = matched?.property
    const typeConflict = Boolean(target && target.type !== sourceProperty.type)
    const mapping: MergeFieldMapping = {
      id: createId('map'),
      sourceEventId,
      sourcePropertyId: sourceProperty.id,
      sourceName: sourceProperty.name,
      sourceType: sourceProperty.type,
      targetEventId: primaryEventId,
      targetPropertyId: target?.id ?? '',
      targetName: target?.name ?? '',
      targetType: target?.type ?? sourceProperty.type,
      matchReason: matched?.reason ?? '未匹配：将作为新字段迁入主事件',
      conflict: false,
      cycle: false,
      selected: Boolean(target),
      valueTransform:
        sourceProperty.type === 'enum' && target?.type === 'string'
          ? '${value}'
          : target?.type === 'enum' && sourceProperty.type === 'string'
            ? 'lowercase(${value})'
            : undefined,
    }
    if (typeConflict && target) {
      mapping.conflict = true
      mapping.selected = false
      mapping.conflictReason = `同名属性类型冲突：${sourceProperty.name} 在待合并事件为 ${sourceProperty.type}，主事件为 ${target.type}`
    }
    mappings.push(mapping)
  })

  const cyclicSourceIds = detectMappingCycle(sourceEventId, primaryEventId, mappings, history)
  const blockingReasons: string[] = []
  mappings.forEach((mapping) => {
    if (cyclicSourceIds.has(mapping.sourcePropertyId)) {
      mapping.cycle = true
      mapping.selected = false
    }
  })

  const conflictMappings = mappings.filter((mapping) => mapping.conflict)
  if (conflictMappings.length > 0) {
    blockingReasons.push(
      `存在 ${conflictMappings.length} 个同名属性类型冲突：${conflictMappings
        .map((mapping) => mapping.sourceName)
        .join('、')}`,
    )
  }
  if (cyclicSourceIds.size > 0) {
    blockingReasons.push(
      `字段映射成环：${mappings
        .filter((mapping) => cyclicSourceIds.has(mapping.sourcePropertyId))
        .map((mapping) => mapping.sourceName)
        .join('、')}`,
    )
  }

  const references = buildReferences(state, primaryEventId, sourceEventId, mappings)

  const record: PrepareMergeResult['record'] = {
    pairKey: mergePairKey(primaryEventId, sourceEventId),
    primaryEventId,
    sourceEventId,
    status: blockingReasons.length > 0 ? 'pending' : 'pending',
    reason,
    operator: '当前用户',
    mappings,
    references,
    blockingReasons,
  }

  return { record, blockingReasons }
}

/** 列出待改读主事件的看板与查询（下游依赖） */
export const buildReferences = (
  state: GovernanceState,
  primaryEventId: string,
  sourceEventId: string,
  mappings: MergeFieldMapping[],
): MergeReference[] =>
  state.dependencies
    .filter((dependency) => dependency.eventIds.includes(sourceEventId))
    .map((dependency) => {
      const sourcePropertyIds = dependency.propertyRefs
        .filter((reference) => reference.eventId === sourceEventId)
        .map((reference) => reference.propertyId)
      const selected = mappings.filter((mapping) => mapping.selected)
      const targetPropertyIds = Array.from(
        new Set(
          sourcePropertyIds.flatMap((propertyId) => {
            const mapping = selected.find((item) => item.sourcePropertyId === propertyId)
            if (!mapping) return []
            if (mapping.targetPropertyId) return [mapping.targetPropertyId]
            // 未匹配字段随源字段迁入，沿用原属性 id
            return [propertyId]
          }),
        ),
      )
      const droppedPropertyNames = sourcePropertyIds
        .filter((propertyId) => !selected.some((item) => item.sourcePropertyId === propertyId))
        .map(
          (propertyId) =>
            mappings.find((item) => item.sourcePropertyId === propertyId)?.sourceName ?? propertyId,
        )
      return {
        dependencyId: dependency.id,
        dependencyName: dependency.name,
        dependencyType: dependency.type,
        sourceEventId,
        sourcePropertyIds,
        targetEventId: primaryEventId,
        targetPropertyIds,
        droppedPropertyNames,
      }
    })

/** 检查点是否允许向前推进 */
export const canConfirm = (record: EventMergeRecord): boolean =>
  record.blockingReasons.length === 0 &&
  !record.mappings.some((mapping) => (mapping.conflict || mapping.cycle) && mapping.selected)

export const reconcileDiffs = (
  state: GovernanceState,
  record: EventMergeRecord,
): MergeReconcileDiff[] => {
  const diffs: MergeReconcileDiff[] = []
  const primary = state.events.find((event) => event.id === record.primaryEventId)
  const source = state.events.find((event) => event.id === record.sourceEventId)

  if (!primary || !source) {
    diffs.push({
      id: createId('diff'),
      kind: 'event_missing',
      detail: '主事件或待合并事件在当前状态中缺失，无法完成对账。',
    })
    return diffs
  }

  record.mappings
    .filter((mapping) => mapping.selected)
    .forEach((mapping) => {
      const target = primary.properties.find((property) => property.id === mapping.targetPropertyId)
      if (!target) {
        diffs.push({
          id: createId('diff'),
          kind: 'reference_lost',
          detail: `主事件缺少映射目标字段 ${mapping.targetName}（来源 ${mapping.sourceName}）。`,
        })
        return
      }
      const aliasRegistered = (target.mergeAliases ?? []).includes(mapping.sourceName)
      if (!aliasRegistered) {
        diffs.push({
          id: createId('diff'),
          kind: 'alias_missing',
          detail: `字段 ${target.name} 未保留旧键别名 ${mapping.sourceName}。`,
        })
      }
    })

  record.references.forEach((reference) => {
    const dependency = state.dependencies.find((item) => item.id === reference.dependencyId)
    if (!dependency) {
      diffs.push({
        id: createId('diff'),
        kind: 'reference_lost',
        detail: `看板/查询 ${reference.dependencyName} 在当前状态中缺失。`,
      })
      return
    }
    if (dependency.eventIds.includes(reference.sourceEventId)) {
      diffs.push({
        id: createId('diff'),
        kind: 'reference_count',
        detail: `${dependency.name} 仍读取旧事件，未改读主事件。`,
      })
    }
    reference.sourcePropertyIds.forEach((propertyId) => {
      const mapping = record.mappings.find((item) => item.sourcePropertyId === propertyId)
      const stillReferencesOld = dependency.propertyRefs.some(
        (ref) => ref.eventId === reference.sourceEventId && ref.propertyId === propertyId,
      )
      if (stillReferencesOld) {
        diffs.push({
          id: createId('diff'),
          kind: 'reference_count',
          detail: `${dependency.name} 仍引用旧字段 ${mapping?.sourceName ?? propertyId}。`,
        })
      }
    })
  })

  if (!source.mergedIntoId || source.mergedIntoId !== record.primaryEventId) {
    diffs.push({
      id: createId('diff'),
      kind: 'reference_lost',
      detail: '待合并事件未标记 mergedIntoId 主事件指针。',
    })
  }
  if (!primary.mergedKeyAliases?.some((alias) => alias.sourceEventId === record.sourceEventId)) {
    diffs.push({
      id: createId('diff'),
      kind: 'alias_missing',
      detail: `主事件 ${primary.key} 未保留旧事件键别名。`,
    })
  }

  return diffs
}
