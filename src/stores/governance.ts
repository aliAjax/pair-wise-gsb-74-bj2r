import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  BusinessScenario,
  DeprecationPlan,
  EventDefinition,
  EventMergeRecord,
  EventProperty,
  GovernanceState,
  MergeCheckpoint,
  MergeCheckpointPhase,
  MergeFieldMapping,
  PlatformRule,
  ReleaseApproval,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import {
  createId,
  loadState,
  onExternalStateChange,
  resetState,
  saveState,
} from '@/services/repository'
import {
  buildReferences,
  canConfirm,
  evaluateMappingSelection,
  mergePairKey,
  prepareMerge,
  reconcileDiffs,
} from '@/services/merges'
import {
  affectedDependencies,
  contractDifferences,
  releaseReadiness,
  validateGovernance,
} from '@/services/selectors'

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())

  /**
   * 演示用：在某检查点阶段前模拟写入中断（仅内存，不落盘）。
   * 再次确认时已完成阶段跳过，从中断点继续。
   */
  const crashBeforePhase = new Map<string, MergeCheckpointPhase>()

  const issues = computed(() => validateGovernance(data.value))

  const persist = (): void => {
    saveState(data.value)
    lastSavedAt.value = new Date().toISOString()
  }

  const audit = (
    entityType: string,
    entityId: string,
    action: string,
    detail: string,
  ): void => {
    data.value.audit.unshift({
      id: createId('aud'),
      entityType,
      entityId,
      action,
      actor: '当前用户',
      detail,
      createdAt: new Date().toISOString(),
    })
  }

  const saveEvent = (event: EventDefinition): void => {
    const index = data.value.events.findIndex((item) => item.id === event.id)
    const saved = { ...event, updatedAt: new Date().toISOString() }
    if (index >= 0) {
      data.value.events[index] = saved
    } else {
      data.value.events.unshift(saved)
    }
    audit('event', event.id, index >= 0 ? '更新事件' : '创建事件', `${event.key} 契约已保存`)
    persist()
  }

  const saveProperty = (eventId: string, property: EventProperty): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.properties.findIndex((item) => item.id === property.id)
    if (index >= 0) {
      event.properties[index] = property
    } else {
      event.properties.push(property)
    }
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, index >= 0 ? '更新属性' : '新增属性', `${event.key}.${property.name}`)
    persist()
  }

  const deleteProperty = (eventId: string, propertyId: string): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    const property = event?.properties.find((item) => item.id === propertyId)
    if (!event || !property) return
    property.deletedAt = new Date().toISOString()
    event.updatedAt = new Date().toISOString()
    audit('property', property.id, '标记删除', `${event.key}.${property.name} 进入删除兼容期`)
    persist()
  }

  const savePlatformRule = (eventId: string, rule: PlatformRule): void => {
    const event = data.value.events.find((item) => item.id === eventId)
    if (!event) return
    const index = event.platformRules.findIndex((item) => item.id === rule.id)
    if (index >= 0) {
      event.platformRules[index] = rule
    } else {
      event.platformRules.push(rule)
    }
    event.updatedAt = new Date().toISOString()
    audit('platform_rule', rule.id, index >= 0 ? '更新平台规则' : '新增平台规则', `${event.key}/${rule.platform}`)
    persist()
  }

  const createRelease = (version: string, title: string, eventIds: string[]): ReleaseCandidate => {
    const differences = contractDifferences(data.value, eventIds)
    const affected = affectedDependencies(data.value, differences)
    const release: ReleaseCandidate = {
      id: createId('rel'),
      version,
      title,
      status: 'reviewing',
      eventIds,
      affectedDependencyIds: affected,
      differences,
      migrationConfirmations: affected.map((dependencyId) => ({
        id: createId('mig'),
        dependencyId,
        version,
        status: 'pending',
        reviewer:
          data.value.dependencies.find((dependency) => dependency.id === dependencyId)?.owner ?? '',
        note: '',
      })),
      approvals: [
        { id: createId('appr'), role: 'data', actor: '顾清', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'product', actor: '丁禾', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'client', actor: '江驰', status: 'pending', comment: '' },
        { id: createId('appr'), role: 'qa', actor: '余安', status: 'pending', comment: '' },
      ],
      createdAt: new Date().toISOString(),
    }
    data.value.releases.unshift(release)
    data.value.currentVersion = version
    audit(
      'release',
      release.id,
      '创建发布候选',
      `${version} 包含 ${eventIds.length} 个事件，影响 ${affected.length} 个下游依赖`,
    )
    persist()
    return release
  }

  const confirmMigration = (
    releaseId: string,
    confirmationId: string,
    reviewer: string,
    note: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const confirmation = release?.migrationConfirmations.find((item) => item.id === confirmationId)
    if (!confirmation) return
    confirmation.status = 'confirmed'
    confirmation.reviewer = reviewer
    confirmation.note = note
    confirmation.confirmedAt = new Date().toISOString()
    const dependency = data.value.dependencies.find((item) => item.id === confirmation.dependencyId)
    if (dependency) dependency.status = 'migrated'
    audit('dependency', confirmation.dependencyId, '确认迁移', `${reviewer}：${note}`)
    persist()
  }

  const updateApproval = (
    releaseId: string,
    role: ReleaseApproval['role'],
    status: ReleaseApproval['status'],
    actor: string,
    comment: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    const approval = release?.approvals.find((item) => item.role === role)
    if (!approval) return
    approval.status = status
    approval.actor = actor
    approval.comment = comment
    approval.createdAt = new Date().toISOString()
    audit('release', releaseId, status === 'approved' ? '审批通过' : '审批驳回', `${role}：${comment}`)
    persist()
  }

  const publishRelease = (releaseId: string): boolean => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return false
    const readiness = releaseReadiness(release, issues.value)
    const migrationsReady = release.migrationConfirmations.every((item) => item.status === 'confirmed')
    const approvalsReady = release.approvals.every((item) => item.status === 'approved')
    if (!migrationsReady || !approvalsReady || readiness < 90) return false
    release.status = 'published'
    release.publishedAt = new Date().toISOString()
    release.eventIds.forEach((eventId) => {
      const event = data.value.events.find((item) => item.id === eventId)
      if (event) {
        event.status = 'published'
        data.value.baselines.unshift({
          id: createId('base'),
          eventId,
          version: event.version,
          properties: structuredClone(event.properties),
          createdAt: new Date().toISOString(),
          status: 'published',
        })
      }
    })
    audit('release', release.id, '发布契约', `${release.version} 已发布`)
    persist()
    return true
  }

  const saveDeprecation = (plan: DeprecationPlan): void => {
    const index = data.value.deprecations.findIndex((item) => item.id === plan.id)
    if (index >= 0) {
      data.value.deprecations[index] = plan
    } else {
      data.value.deprecations.unshift(plan)
    }
    const event = data.value.events.find((item) => item.id === plan.eventId)
    if (event && plan.status === 'stopped') event.status = 'deprecated'
    if (event && plan.status === 'retired') event.status = 'retired'
    audit('deprecation', plan.id, '更新废弃计划', `${event?.key ?? plan.eventId}：${plan.status}`)
    persist()
  }

  const executeRollback = (
    releaseId: string,
    reason: string,
    scope: string,
    evidence: string,
  ): void => {
    const release = data.value.releases.find((item) => item.id === releaseId)
    if (!release) return
    const record: RollbackRecord = {
      id: createId('rollback'),
      releaseId,
      version: release.version,
      reason,
      operator: '当前用户',
      scope,
      createdAt: new Date().toISOString(),
      status: 'executed',
      evidence,
    }
    data.value.rollbacks.unshift(record)
    release.status = 'rolled_back'
    audit('rollback', record.id, '执行回滚', `${release.version}：${reason}`)
    persist()
  }

  const verifyRollback = (rollbackId: string, evidence: string): void => {
    const record = data.value.rollbacks.find((item) => item.id === rollbackId)
    if (!record) return
    record.status = 'verified'
    record.evidence = evidence
    audit('rollback', record.id, '验证回滚', evidence)
    persist()
  }

  // ============ 事件合并 ============

  const findMerge = (mergeId: string): EventMergeRecord | undefined =>
    data.value.merges.find((item) => item.id === mergeId)

  /** 同一对事件只允许一份活跃（非已撤销）记录 */
  const findActiveMergeByPair = (
    eventA: string,
    eventB: string,
  ): EventMergeRecord | undefined => {
    const pair = mergePairKey(eventA, eventB)
    return data.value.merges.find(
      (item) =>
        item.pairKey === pair &&
        item.status !== 'reverted' &&
        !(item.status === 'merged' && item.revertedAt),
    )
  }

  const prepareEventMerge = (
    primaryEventId: string,
    sourceEventId: string,
    reason: string,
  ): EventMergeRecord => {
    if (findActiveMergeByPair(primaryEventId, sourceEventId)) {
      throw new Error('该事件对已存在合并记录，同一对事件只能生成一份记录')
    }
    const prepared = prepareMerge(data.value, primaryEventId, sourceEventId, reason)
    const now = new Date().toISOString()
    const record: EventMergeRecord = {
      ...prepared.record,
      id: createId('merge'),
      status: prepared.blockingReasons.length > 0 ? 'pending' : 'pending',
      createdAt: now,
      updatedAt: now,
      version: 1,
    }
    data.value.merges.unshift(record)
    audit(
      'merge',
      record.id,
      '创建合并',
      `主事件 ${record.primaryEventId} 吸收待合并事件 ${record.sourceEventId}，${prepared.record.mappings.length} 个字段映射`,
    )
    persist()
    return record
  }

  const updateMergeMappings = (mergeId: string, mappings: MergeFieldMapping[]): void => {
    const record = findMerge(mergeId)
    if (!record) return
    const { cyclicIds, blockingReasons } = evaluateMappingSelection(data.value, {
      primaryEventId: record.primaryEventId,
      sourceEventId: record.sourceEventId,
      mappings,
    })
    mappings.forEach((mapping) => {
      mapping.cycle = cyclicIds.has(mapping.sourcePropertyId)
      if (mapping.cycle) mapping.selected = false
    })
    record.mappings = mappings
    record.references = buildReferences(
      data.value,
      record.primaryEventId,
      record.sourceEventId,
      mappings,
    )
    record.status = record.status === 'conflict' ? 'conflict' : 'pending'
    record.blockingReasons = blockingReasons
    record.updatedAt = new Date().toISOString()
    persist()
  }

  /** 人工解决类型冲突：cast 接受字符串到枚举转换并纳入切换；drop 放弃该字段 */
  const resolveMergeConflict = (
    mergeId: string,
    mappingId: string,
    resolution: 'cast' | 'drop',
  ): void => {
    const record = findMerge(mergeId)
    if (!record) return
    const mapping = record.mappings.find((item) => item.id === mappingId)
    if (!mapping) return
    if (resolution === 'cast') {
      mapping.conflict = false
      mapping.conflictReason = undefined
      mapping.selected = true
      mapping.valueTransform =
        mapping.sourceType === 'enum' && mapping.targetType === 'string'
          ? '${value}'
          : 'lowercase(${value})'
    } else {
      mapping.conflict = false
      mapping.conflictReason = undefined
      mapping.selected = false
      mapping.targetPropertyId = ''
      mapping.targetName = ''
    }
    updateMergeMappings(mergeId, structuredClone(record.mappings))
    audit(
      'merge',
      mergeId,
      '处理字段冲突',
      `${mapping.sourceName}：${resolution === 'cast' ? '接受类型转换并纳入切换' : '放弃该字段切换'}`,
    )
    persist()
  }

  /** 乐观并发：后到方（提交或撤销）看到版本冲突 */
  const guardVersion = (record: EventMergeRecord, expectedVersion: number): boolean =>
    record.version === expectedVersion

  const touchCheckpoint = (
    record: EventMergeRecord,
    phase: MergeCheckpointPhase,
    note: string,
  ): void => {
    const checkpoint: MergeCheckpoint = { phase, updatedAt: new Date().toISOString(), note }
    record.checkpoint = checkpoint
    persist()
  }

  /** 按检查点执行切换；中断后再次调用会跳过已完成阶段继续 */
  const confirmEventMerge = (mergeId: string, expectedVersion: number): boolean => {
    const record = findMerge(mergeId)
    if (!record) throw new Error('合并记录不存在')
    if (!guardVersion(record, expectedVersion)) {
      record.status = 'conflict'
      record.blockingReasons = ['另一个窗口已提交或撤销该合并，请刷新后查看最新状态']
      record.updatedAt = new Date().toISOString()
      audit('merge', record.id, '合并冲突', '后到提交方检测到版本不一致，写入中断')
      persist()
      return false
    }
    if (!canConfirm(record)) {
      record.status = 'pending'
      persist()
      return false
    }

    record.status = 'switching'
    record.updatedAt = new Date().toISOString()
    persist()

    const primary = data.value.events.find((event) => event.id === record.primaryEventId)
    const source = data.value.events.find((event) => event.id === record.sourceEventId)
    if (!primary || !source) throw new Error('主事件或待合并事件已不存在')

    const phaseOrder: MergeCheckpointPhase[] = [
      'prepared',
      'alias_written',
      'dependencies_rewritten',
      'scenarios_rewritten',
      'releases_rewritten',
      'event_retired',
      'completed',
    ]
    const reachedIndex = record.checkpoint
      ? phaseOrder.indexOf(record.checkpoint.phase)
      : -1
    const already = (phase: MergeCheckpointPhase): boolean => phaseOrder.indexOf(phase) <= reachedIndex
    const guardCrash = (phase: MergeCheckpointPhase): void => {
      if (crashBeforePhase.get(record.id) === phase) {
        crashBeforePhase.delete(record.id)
        throw new Error(
          `写入中断：${phase} 阶段未完成。检查点停留在 ${record.checkpoint?.phase ?? '未开始'}，可从检查点继续。`,
        )
      }
    }

    // prepared：固化合并前引用快照
    guardCrash('prepared')
    if (!already('prepared')) {
      record.preMergeSnapshot = {
        primaryEvent: structuredClone(primary),
        sourceEvent: structuredClone(source),
        dependencies: structuredClone(
          data.value.dependencies.filter((dependency) =>
            dependency.eventIds.includes(record.sourceEventId),
          ),
        ),
        scenarios: structuredClone(
          data.value.scenarios.filter((scenario) => scenario.eventIds.includes(record.sourceEventId)),
        ),
        releases: structuredClone(
          data.value.releases.filter((release) => release.eventIds.includes(record.sourceEventId)),
        ),
      }
      touchCheckpoint(record, 'prepared', '已保存合并前引用快照')
    }

    const selectedMappings = record.mappings.filter((mapping) => mapping.selected)

    // alias_written：主事件并入字段、保留旧键别名
    guardCrash('alias_written')
    if (!already('alias_written')) {
      selectedMappings.forEach((mapping) => {
        if (mapping.targetPropertyId) {
          const target = primary.properties.find((item) => item.id === mapping.targetPropertyId)
          if (target && !target.mergeAliases?.includes(mapping.sourceName)) {
            target.mergeAliases = [...(target.mergeAliases ?? []), mapping.sourceName]
          }
        } else {
          // 未匹配字段：连同旧字段 id 迁入主事件，旧名即别名
          const moved = source.properties.find((item) => item.id === mapping.sourcePropertyId)
          if (moved && !primary.properties.some((item) => item.id === moved.id)) {
            primary.properties.push({
              ...structuredClone(moved),
              eventId: primary.id,
              mergeAliases: [moved.name],
            })
          }
        }
      })
      primary.mergedKeyAliases = [
        ...(primary.mergedKeyAliases ?? []),
        {
          aliasKey: source.key,
          sourceEventId: source.id,
          mergedAt: new Date().toISOString(),
        },
      ]
      primary.updatedAt = new Date().toISOString()
      touchCheckpoint(record, 'alias_written', '主事件字段已并入，旧键保留为别名')
    }

    // dependencies_rewritten：看板和查询改读主事件
    guardCrash('dependencies_rewritten')
    if (!already('dependencies_rewritten')) {
      data.value.dependencies
        .filter((dependency) => dependency.eventIds.includes(source.id))
        .forEach((dependency) => {
          dependency.eventIds = Array.from(
            new Set(
              dependency.eventIds.map((eventId) =>
                eventId === source.id ? primary.id : eventId,
              ),
            ),
          )
          dependency.propertyRefs = dependency.propertyRefs
            .map((reference) => {
              if (reference.eventId !== source.id) return reference
              const mapping = selectedMappings.find(
                (item) => item.sourcePropertyId === reference.propertyId,
              )
              if (!mapping) return null // 冲突未切换或放弃的字段：移除悬挂引用
              return {
                eventId: primary.id,
                propertyId: mapping.targetPropertyId || reference.propertyId,
              }
            })
            .filter((reference): reference is { eventId: string; propertyId: string } =>
              Boolean(reference),
            )
          if (dependency.status === 'active') dependency.status = 'migration_required'
        })
      if (!primary.downstreamDependencyIds.includes(source.id)) {
        const sourceDeps = source.downstreamDependencyIds
        primary.downstreamDependencyIds = Array.from(
          new Set([...primary.downstreamDependencyIds, ...sourceDeps]),
        )
      }
      touchCheckpoint(record, 'dependencies_rewritten', '看板与查询已改读主事件')
    }

    // scenarios_rewritten：业务场景事件引用
    guardCrash('scenarios_rewritten')
    if (!already('scenarios_rewritten')) {
      data.value.scenarios.forEach((scenario) => {
        if (!scenario.eventIds.includes(source.id)) return
        scenario.eventIds = Array.from(
          new Set(
            scenario.eventIds.map((eventId) => (eventId === source.id ? primary.id : eventId)),
          ),
        )
      })
      touchCheckpoint(record, 'scenarios_rewritten', '业务场景引用已切换')
    }

    // releases_rewritten：发布候选事件引用
    guardCrash('releases_rewritten')
    if (!already('releases_rewritten')) {
      data.value.releases.forEach((release) => {
        if (!release.eventIds.includes(source.id)) return
        release.eventIds = Array.from(
          new Set(
            release.eventIds.map((eventId) => (eventId === source.id ? primary.id : eventId)),
          ),
        )
      })
      touchCheckpoint(record, 'releases_rewritten', '发布候选引用已切换')
    }

    // event_retired：旧事件停采并留别名指针
    guardCrash('event_retired')
    if (!already('event_retired')) {
      source.mergedIntoId = primary.id
      source.status = 'retired'
      source.updatedAt = new Date().toISOString()
      source.platformRules.forEach((rule) => {
        rule.enabled = false
        rule.note = rule.note ? `${rule.note}（已合并至 ${primary.key}）` : `已合并至 ${primary.key}`
      })
      // 未匹配字段已迁入主事件，源事件字段保留作只读历史
      touchCheckpoint(record, 'event_retired', '旧事件已停采，指向主事件')
    }

    guardCrash('completed')
    if (!already('completed')) {
      record.status = 'merged'
      record.confirmedAt = new Date().toISOString()
      record.updatedAt = record.confirmedAt
      record.version += 1
      touchCheckpoint(record, 'completed', '合并切换完成')
      audit(
        'merge',
        record.id,
        '确认合并',
        `${source.key} 的看板、查询与字段引用已切换至 ${primary.key}，旧键保留别名`,
      )
      persist()
    }
    return true
  }

  /** 撤销待处理的合并（尚未切换或停在检查点前） */
  const cancelEventMerge = (mergeId: string, expectedVersion: number): boolean => {
    const record = findMerge(mergeId)
    if (!record) throw new Error('合并记录不存在')
    if (!guardVersion(record, expectedVersion)) {
      record.status = 'conflict'
      record.blockingReasons = ['另一个窗口已提交或撤销该合并，请刷新后查看最新状态']
      audit('merge', record.id, '合并冲突', '后到撤销方检测到版本不一致')
      persist()
      return false
    }
    if (record.status === 'merged') return false
    record.status = 'reverted'
    record.revertedAt = new Date().toISOString()
    record.revertReason = '合并确认前撤销，未产生引用切换'
    record.version += 1
    record.updatedAt = new Date().toISOString()
    audit('merge', record.id, '撤销合并', '待处理合并已撤销，事件引用未改动')
    persist()
    return true
  }

  /** 对账：检查切换完整性，返回是否平衡 */
  const reconcileEventMerge = (mergeId: string): boolean => {
    const record = findMerge(mergeId)
    if (!record || record.status !== 'merged') return false
    const diffs = reconcileDiffs(data.value, record)
    record.reconcile = {
      checkedAt: new Date().toISOString(),
      balanced: diffs.length === 0,
      diffs,
      historicalMappings: structuredClone(record.mappings),
    }
    record.updatedAt = new Date().toISOString()
    audit(
      'merge',
      record.id,
      diffs.length === 0 ? '对账平衡' : '对账不平',
      diffs.length === 0 ? '看板、查询与别名引用全部一致' : `发现 ${diffs.length} 项差异`,
    )
    persist()
    return diffs.length === 0
  }

  /** 对账不平：按合并前快照恢复引用，差异与历史映射留档 */
  const restorePreMerge = (mergeId: string, reason: string): void => {
    const record = findMerge(mergeId)
    if (!record?.preMergeSnapshot) return
    record.status = 'reverting'
    record.updatedAt = new Date().toISOString()
    persist()

    const snapshot = record.preMergeSnapshot

    const restoreEvent = (snapshotEvent: EventDefinition): void => {
      const index = data.value.events.findIndex((event) => event.id === snapshotEvent.id)
      if (index >= 0) data.value.events[index] = structuredClone(snapshotEvent)
    }
    restoreEvent(snapshot.primaryEvent)
    restoreEvent(snapshot.sourceEvent)

    const restoreCollection = <T extends { id: string }>(
      collection: T[],
      snapshotItems: T[],
    ): void => {
      snapshotItems.forEach((snapshotItem) => {
        const index = collection.findIndex((item) => item.id === snapshotItem.id)
        if (index >= 0) collection[index] = structuredClone(snapshotItem)
      })
    }
    restoreCollection(data.value.dependencies, snapshot.dependencies)
    restoreCollection(data.value.scenarios, snapshot.scenarios as BusinessScenario[])
    restoreCollection(data.value.releases, snapshot.releases)

    record.status = 'reverted'
    record.revertedAt = new Date().toISOString()
    record.revertReason = reason
    record.version += 1
    record.updatedAt = record.revertedAt
    // 差异与历史映射保留在 reconcile 中留档，不清除
    if (record.reconcile) {
      record.reconcile.balanced = false
      record.reconcile.diffs = [
        ...record.reconcile.diffs,
        {
          id: createId('diff'),
          kind: 'reference_lost' as const,
          detail: `已按合并前快照恢复引用：${reason}`,
        },
      ]
    }
    audit('merge', record.id, '恢复合并前引用', `${reason}，差异与历史映射已留档`)
    persist()
  }

  /**
   * 模拟另一个窗口已提交/撤销：仅推进版本号。
   * 本窗口持有的基线版本随后提交/撤销时会被判定为后到方冲突。
   * 真实环境中由其它标签页的 storage 事件自动触发。
   */
  const simulateSiblingWindowWrite = (mergeId: string): void => {
    const record = findMerge(mergeId)
    if (!record) return
    record.version += 1
    record.updatedAt = new Date().toISOString()
    persist()
  }

  /** 后到方冲突后，调用方刷新到最新版本基线（模拟重新拉取记录） */
  const refreshMergeAfterConflict = (mergeId: string): EventMergeRecord | undefined => {
    const record = findMerge(mergeId)
    if (!record) return undefined
    if (record.status === 'conflict') {
      record.status = record.checkpoint?.phase === 'completed' ? 'merged' : 'pending'
      record.blockingReasons = []
      record.updatedAt = new Date().toISOString()
      audit('merge', mergeId, '同步最新版本', '后到方已刷新合并记录')
      persist()
    }
    return record
  }

  /** 下次确认时在指定阶段前模拟写入中断 */
  const simulateCrashBefore = (mergeId: string, phase: MergeCheckpointPhase): void => {
    crashBeforePhase.set(mergeId, phase)
  }

  /** 订阅其它标签页写入，跨窗口状态保持一致 */
  const subscribeExternalChanges = (): (() => void) =>
    onExternalStateChange((state) => {
      data.value = state
      lastSavedAt.value = new Date().toISOString()
    })

  const resetDemo = (): void => {
    data.value = resetState()
    lastSavedAt.value = new Date().toISOString()
  }

  const exportContract = (eventIds?: string[]): string => {
    const selectedEvents = eventIds
      ? data.value.events.filter((event) => eventIds.includes(event.id))
      : data.value.events
    return JSON.stringify(
      {
        version: data.value.currentVersion,
        generatedAt: new Date().toISOString(),
        events: selectedEvents.map((event) => ({
          key: event.key,
          displayName: event.displayName,
          version: event.version,
          trigger: event.trigger,
          platforms: event.platformRules.map((rule) => ({
            platform: rule.platform,
            enabled: rule.enabled,
            trigger: rule.trigger,
          })),
          properties: event.properties
            .filter((property) => !property.deletedAt)
            .map(({ name, type, required, enumValues, description }) => ({
              name,
              type,
              required,
              enumValues,
              description,
            })),
        })),
      },
      null,
      2,
    )
  }

  return {
    data,
    lastSavedAt,
    issues,
    saveEvent,
    saveProperty,
    deleteProperty,
    savePlatformRule,
    createRelease,
    confirmMigration,
    updateApproval,
    publishRelease,
    saveDeprecation,
    executeRollback,
    verifyRollback,
    prepareEventMerge,
    updateMergeMappings,
    resolveMergeConflict,
    confirmEventMerge,
    cancelEventMerge,
    refreshMergeAfterConflict,
    reconcileEventMerge,
    restorePreMerge,
    simulateSiblingWindowWrite,
    simulateCrashBefore,
    subscribeExternalChanges,
    resetDemo,
    exportContract,
  }
})
