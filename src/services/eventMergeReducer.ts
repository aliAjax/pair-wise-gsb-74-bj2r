import type {
  EventMerge,
  GovernanceState,
  MergeFieldMapping,
} from '@/models/domain'
import { createId } from '@/services/repository'
import {
  CHECKPOINT_STEPS,
  MergeConflictError,
  createMergeDraft,
  findMergeByPair,
  mergeReady,
  recomputeBlockers,
  snapshotReferences,
} from '@/services/eventMerge'

const ACTIVE_STATUSES = ['draft', 'pending', 'confirming', 'confirmed']

export class StaleMergeVersionError extends Error {
  constructor() {
    super('合并记录已被其他窗口更新，请刷新看板后重试')
    this.name = 'StaleMergeVersionError'
  }
}

export interface ConfirmOptions {
  failAtStep?: (typeof CHECKPOINT_STEPS)[number]
}

const findMerge = (state: GovernanceState, mergeId: string): EventMerge | undefined =>
  state.merges.find((item) => item.id === mergeId)

const touch = (merge: EventMerge): void => {
  merge.version += 1
  merge.updatedAt = new Date(0).toISOString()
}

export const assertVersion = (
  state: GovernanceState,
  mergeId: string,
  expectedVersion: number,
): EventMerge => {
  const merge = findMerge(state, mergeId)
  if (!merge) throw new MergeConflictError('合并记录不存在或已被清理')
  if (merge.version !== expectedVersion) throw new StaleMergeVersionError()
  return merge
}

const assertPairUnique = (state: GovernanceState, merge: EventMerge): void => {
  const duplicate = state.merges.find(
    (item) =>
      item.id !== merge.id &&
      item.pairKey === merge.pairKey &&
      ACTIVE_STATUSES.includes(item.status),
  )
  if (duplicate) throw new MergeConflictError('同一对事件已存在进行中的合并记录，后到提交已中断')
}

export const startMerge = (
  state: GovernanceState,
  masterEventId: string,
  sourceEventId: string,
  reason: string,
  now: string,
): EventMerge => {
  const existing = findMergeByPair(state, masterEventId, sourceEventId)
  if (existing && ACTIVE_STATUSES.includes(existing.status)) {
    throw new MergeConflictError('这对事件已存在进行中的合并记录，同一对事件只生成一份')
  }
  const merge = createMergeDraft(state, masterEventId, sourceEventId, reason)
  merge.createdAt = now
  merge.updatedAt = now
  state.merges.unshift(merge)
  return merge
}

export const updateMergeMapping = (
  state: GovernanceState,
  mergeId: string,
  expectedVersion: number,
  mappingId: string,
  patch: Partial<
    Pick<MergeFieldMapping, 'targetPropertyId' | 'resolution' | 'valueMapping' | 'castNote' | 'note'>
  >,
): EventMerge => {
  const merge = assertVersion(state, mergeId, expectedVersion)
  if (!['draft', 'pending'].includes(merge.status)) {
    throw new MergeConflictError('仅待处理合并允许调整字段映射')
  }
  const mapping = merge.mappings.find((item) => item.id === mappingId)
  if (!mapping) throw new MergeConflictError('字段映射不存在')

  if (patch.targetPropertyId !== undefined) {
    const master = state.events.find((event) => event.id === merge.masterEventId)
    const target = master?.properties.find((property) => property.id === patch.targetPropertyId)
    mapping.targetPropertyId = target?.id ?? null
    mapping.targetName = target?.name ?? null
    mapping.targetType = target?.type ?? null
    mapping.matchBasis = target ? 'manual' : 'none'
    mapping.status = !target
      ? 'dropped'
      : target.type !== mapping.sourceType
        ? 'type_conflict'
        : 'resolved'
  }
  if (patch.resolution !== undefined) {
    mapping.resolution = patch.resolution
    if (patch.resolution === 'drop') mapping.status = 'dropped'
    else if (mapping.targetType && mapping.targetType !== mapping.sourceType) {
      mapping.status = patch.resolution === 'cast' ? 'resolved' : 'type_conflict'
    } else if (mapping.targetPropertyId) {
      mapping.status = 'resolved'
    }
  }
  if (patch.valueMapping !== undefined) mapping.valueMapping = patch.valueMapping
  if (patch.castNote !== undefined) mapping.castNote = patch.castNote
  if (patch.note !== undefined) mapping.note = patch.note

  merge.blockers = recomputeBlockers(state, merge)
  touch(merge)
  return merge
}

export const submitMerge = (
  state: GovernanceState,
  mergeId: string,
  expectedVersion: number,
): EventMerge => {
  const merge = assertVersion(state, mergeId, expectedVersion)
  assertPairUnique(state, merge)
  merge.blockers = recomputeBlockers(state, merge)
  if (!mergeReady(merge)) {
    throw new MergeConflictError(`仍有 ${merge.blockers.length} 项阻塞未处置`)
  }
  merge.status = 'pending'
  touch(merge)
  return merge
}

const runStep = (
  state: GovernanceState,
  merge: EventMerge,
  step: (typeof CHECKPOINT_STEPS)[number],
  now: string,
): void => {
  const master = state.events.find((event) => event.id === merge.masterEventId)
  const source = state.events.find((event) => event.id === merge.sourceEventId)
  if (!master || !source) throw new MergeConflictError('主事件或待合并事件已不存在')

  if (step === 'backup') {
    const backup = snapshotReferences(state, merge)
    backup.savedAt = now
    merge.backup = backup
    return
  }
  if (step === 'aliases') {
    master.keyAliases = [...new Set([...(master.keyAliases ?? []), source.key])]
    merge.mappings
      .filter((mapping) => mapping.targetName && mapping.resolution !== 'drop')
      .forEach((mapping) => {
        const target = master.properties.find((property) => property.id === mapping.targetPropertyId)
        if (target && !target.synonyms.includes(mapping.sourceName)) {
          target.synonyms = [...target.synonyms, mapping.sourceName]
        }
      })
    master.updatedAt = now
    return
  }
  if (step === 'rewrite_refs') {
    state.dependencies
      .filter((dependency) => merge.affectedDependencyIds.includes(dependency.id))
      .forEach((dependency) => {
        let touched = false
        dependency.eventIds = [
          ...new Set(
            dependency.eventIds.map((eventId) =>
              eventId === merge.sourceEventId ? merge.masterEventId : eventId,
            ),
          ),
        ]
        dependency.propertyRefs = dependency.propertyRefs.map((reference) => {
          if (reference.eventId !== merge.sourceEventId) return reference
          touched = true
          const mapping = merge.mappings.find(
            (item) => item.sourcePropertyId === reference.propertyId,
          )
          if (mapping?.targetPropertyId && mapping.resolution !== 'drop') {
            return { eventId: merge.masterEventId, propertyId: mapping.targetPropertyId }
          }
          return reference
        })
        if (touched) dependency.status = 'migration_required'
      })
    merge.affectedDependencyIds.forEach((dependencyId) => {
      if (!master.downstreamDependencyIds.includes(dependencyId)) {
        master.downstreamDependencyIds = [...master.downstreamDependencyIds, dependencyId]
      }
    })
    return
  }
  if (step === 'scenarios') {
    state.scenarios.forEach((scenario) => {
      if (scenario.eventIds.includes(merge.sourceEventId)) {
        scenario.eventIds = [
          ...new Set(
            scenario.eventIds.map((eventId) =>
              eventId === merge.sourceEventId ? merge.masterEventId : eventId,
            ),
          ),
        ]
        scenario.status = 'migrating'
      }
    })
    return
  }
  if (step === 'source_retire') {
    source.mergedIntoEventId = master.id
    source.status = 'deprecated'
    source.platformRules.forEach((rule) => {
      rule.enabled = false
      if (!rule.note.includes('合并停采')) rule.note = `合并停采：${rule.note}`
    })
    source.updatedAt = now
    const plan = state.deprecations.find(
      (item) =>
        item.eventId === source.id && item.status !== 'cancelled' && item.status !== 'retired',
    )
    if (plan) {
      plan.replacementEventId = master.id
      plan.status = 'stopped'
    }
    return
  }
  if (step === 'finalize') {
    merge.status = 'confirmed'
    merge.confirmedAt = now
  }
}

export const confirmMerge = (
  state: GovernanceState,
  mergeId: string,
  expectedVersion: number,
  now: string,
  options: ConfirmOptions = {},
): EventMerge => {
  const merge = assertVersion(state, mergeId, expectedVersion)
  if (!['pending', 'confirming'].includes(merge.status)) {
    throw new MergeConflictError('仅待处理合并可以确认')
  }
  merge.blockers = recomputeBlockers(state, merge)
  if (!mergeReady(merge)) throw new MergeConflictError('阻塞未全部处置，无法确认合并')

  if (!merge.checkpoint) {
    merge.status = 'confirming'
    merge.checkpoint = { step: CHECKPOINT_STEPS[0]!, done: false, startedAt: now }
    touch(merge)
  }

  let index = CHECKPOINT_STEPS.indexOf(merge.checkpoint.step)
  while (index < CHECKPOINT_STEPS.length) {
    const step = CHECKPOINT_STEPS[index]!
    if (!merge.checkpoint.done) {
      if (options.failAtStep === step) {
        throw new MergeConflictError(`写入在「${step}」中断，可从检查点继续`)
      }
      runStep(state, merge, step, now)
      merge.checkpoint.done = true
      merge.checkpoint.finishedAt = now
      touch(merge)
    }
    if (step === 'finalize') return merge
    merge.checkpoint = { step: CHECKPOINT_STEPS[index + 1]!, done: false, startedAt: now }
    touch(merge)
    index += 1
  }
  return merge
}

export const cancelMerge = (
  state: GovernanceState,
  mergeId: string,
  expectedVersion: number,
  now: string,
): EventMerge => {
  const merge = assertVersion(state, mergeId, expectedVersion)
  if (!['draft', 'pending'].includes(merge.status)) {
    throw new MergeConflictError('仅待处理合并可以取消')
  }
  merge.status = 'undone'
  merge.undoneAt = now
  touch(merge)
  return merge
}

export const reconcileMerge = (
  state: GovernanceState,
  mergeId: string,
  expectedVersion: number,
  observedRefs: number,
  note: string,
  now: string,
): NonNullable<EventMerge['reconciliation']> => {
  const merge = assertVersion(state, mergeId, expectedVersion)
  if (merge.status !== 'confirmed') throw new MergeConflictError('仅已确认合并可以对账')

  const expectedRefs = state.dependencies
    .filter((dependency) => merge.affectedDependencyIds.includes(dependency.id))
    .reduce(
      (total, dependency) =>
        total +
        dependency.propertyRefs.filter(
          (reference) =>
            reference.eventId === merge.masterEventId ||
            reference.eventId === merge.sourceEventId,
        ).length,
      0,
    )

  const differences: string[] = []
  const blocking: string[] = []
  state.dependencies
    .filter((dependency) => merge.affectedDependencyIds.includes(dependency.id))
    .forEach((dependency) => {
      dependency.propertyRefs
        .filter((reference) => reference.eventId === merge.sourceEventId)
        .forEach((reference) => {
          const mapping = merge.mappings.find(
            (item) => item.sourcePropertyId === reference.propertyId,
          )
          const message = `${dependency.name}：仍读取旧事件字段 ${mapping?.sourceName ?? reference.propertyId}`
          differences.push(message)
          blocking.push(message)
        })
    })
  merge.mappings
    .filter((mapping) => mapping.resolution === 'cast')
    .forEach((mapping) => {
      differences.push(
        `${mapping.sourceName} → ${mapping.targetName} 类型转换 ${mapping.sourceType} → ${mapping.targetType}，枚举映射 ${mapping.valueMapping.length} 项待核对`,
      )
    })

  merge.reconciliation = {
    id: createId('recon'),
    checkedAt: now,
    operator: 'tester',
    expectedRefs,
    observedRefs,
    balanced: expectedRefs === observedRefs && blocking.length === 0,
    differences,
    archivedMapping: structuredClone(merge.mappings),
    restored: false,
    note,
  }
  touch(merge)
  return merge.reconciliation
}

export const undoMerge = (
  state: GovernanceState,
  mergeId: string,
  expectedVersion: number,
  reason: string,
  now: string,
): EventMerge => {
  const merge = assertVersion(state, mergeId, expectedVersion)
  if (merge.status !== 'confirmed') throw new MergeConflictError('仅已确认合并可以恢复')
  if (!merge.backup) throw new MergeConflictError('缺少合并前备份，无法恢复')

  merge.backup.events.forEach((snapshot) => {
    const index = state.events.findIndex((event) => event.id === snapshot.id)
    if (index >= 0) state.events[index] = structuredClone(snapshot)
  })
  merge.backup.dependencies.forEach((snapshot) => {
    const index = state.dependencies.findIndex((item) => item.id === snapshot.id)
    if (index >= 0) state.dependencies[index] = structuredClone(snapshot)
  })
  merge.backup.scenarios.forEach((snapshot) => {
    const index = state.scenarios.findIndex((item) => item.id === snapshot.id)
    if (index >= 0) state.scenarios[index] = structuredClone(snapshot)
  })

  merge.status = 'undone'
  merge.undoneAt = now
  merge.checkpoint = undefined
  if (merge.reconciliation) {
    merge.reconciliation.restored = true
    merge.reconciliation.note = `${merge.reconciliation.note}｜恢复原因：${reason}`.trim()
  }
  touch(merge)
  return merge
}
