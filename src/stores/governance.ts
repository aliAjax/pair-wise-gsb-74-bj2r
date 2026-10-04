import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  DeprecationPlan,
  EventDefinition,
  EventMerge,
  EventProperty,
  GovernanceState,
  PlatformRule,
  ReleaseApproval,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import { createId, loadState, onExternalStateChange, resetState, saveState } from '@/services/repository'
import {
  affectedDependencies,
  contractDifferences,
  releaseReadiness,
  validateGovernance,
} from '@/services/selectors'
import * as reducer from '@/services/eventMergeReducer'
import { StaleMergeVersionError } from '@/services/eventMergeReducer'
import { queryClient } from '@/services/queryClient'

const invalidateMergeQueries = (): void => {
  void queryClient.invalidateQueries({ queryKey: ['merges'] })
  void queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  void queryClient.invalidateQueries({ queryKey: ['lineage'] })
  void queryClient.invalidateQueries({ queryKey: ['events'] })
}

export { StaleMergeVersionError }

export const useGovernanceStore = defineStore('governance', () => {
  const data = ref<GovernanceState>(loadState())
  const lastSavedAt = ref(new Date().toISOString())

  // 另一窗口提交/撤销后，本窗口重新装载状态，后到方提交时按版本号判冲突
  onExternalStateChange(() => {
    const latest = loadState()
    if (JSON.stringify(latest.merges) !== JSON.stringify(data.value.merges)) {
      data.value = latest
      lastSavedAt.value = new Date().toISOString()
    }
  })

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

  // ============ 可撤销的事件合并（状态迁移委托给框架无关 reducer） ============

  const startMerge = (
    masterEventId: string,
    sourceEventId: string,
    reason: string,
  ): EventMerge => {
    const merge = reducer.startMerge(
      data.value,
      masterEventId,
      sourceEventId,
      reason,
      new Date().toISOString(),
    )
    audit(
      'event_merge',
      merge.id,
      '创建事件合并',
      `主事件 ${masterEventId} 合并 ${sourceEventId}，生成 ${merge.mappings.length} 条字段映射`,
    )
    persist()
    invalidateMergeQueries()
    return merge
  }

  const updateMergeMapping = (
    mergeId: string,
    expectedVersion: number,
    mappingId: string,
    patch: Parameters<typeof reducer.updateMergeMapping>[4],
  ): void => {
    const merge = reducer.updateMergeMapping(
      data.value,
      mergeId,
      expectedVersion,
      mappingId,
      patch,
    )
    audit('event_merge', merge.id, '调整字段映射', mappingId)
    persist()
    invalidateMergeQueries()
  }

  const submitMerge = (mergeId: string, expectedVersion: number): void => {
    const merge = reducer.submitMerge(data.value, mergeId, expectedVersion)
    audit(
      'event_merge',
      merge.id,
      '提交合并评审',
      `合并进入待处理看板，共 ${merge.mappings.length} 条映射`,
    )
    persist()
    invalidateMergeQueries()
  }

  const confirmMerge = (
    mergeId: string,
    expectedVersion: number,
    options?: Parameters<typeof reducer.confirmMerge>[4],
  ): void => {
    const merge = reducer.confirmMerge(
      data.value,
      mergeId,
      expectedVersion,
      new Date().toISOString(),
      options,
    )
    if (merge.status === 'confirmed') {
      audit('event_merge', merge.id, '确认事件合并', '看板与查询已改读主事件，旧键保留为别名')
    }
    persist()
    invalidateMergeQueries()
  }

  const cancelMerge = (mergeId: string, expectedVersion: number): void => {
    const merge = reducer.cancelMerge(
      data.value,
      mergeId,
      expectedVersion,
      new Date().toISOString(),
    )
    audit('event_merge', merge.id, '撤销合并申请', '合并未生效，字段映射留档')
    persist()
    invalidateMergeQueries()
  }

  /** 对账不平后恢复合并前引用，差异与历史映射保留在记录中 */
  const undoMerge = (mergeId: string, expectedVersion: number, reason: string): void => {
    const merge = reducer.undoMerge(
      data.value,
      mergeId,
      expectedVersion,
      reason,
      new Date().toISOString(),
    )
    audit(
      'event_merge',
      merge.id,
      '恢复合并前引用',
      `对账不平已回滚：${reason}；历史字段映射保留 ${merge.mappings.length} 条`,
    )
    persist()
    invalidateMergeQueries()
  }

  const reconcileMerge = (
    mergeId: string,
    expectedVersion: number,
    observedRefs: number,
    note: string,
  ): NonNullable<EventMerge['reconciliation']> => {
    const result = reducer.reconcileMerge(
      data.value,
      mergeId,
      expectedVersion,
      observedRefs,
      note,
      new Date().toISOString(),
    )
    audit(
      'event_merge',
      mergeId,
      '合并对账',
      `期望引用 ${result.expectedRefs} / 看板实际 ${observedRefs}：${result.balanced ? '平衡' : '不平，差异已留档'}`,
    )
    persist()
    invalidateMergeQueries()
    return result
  }

  const resetDemo = (): void => {
    data.value = resetState()
    lastSavedAt.value = new Date().toISOString()
    invalidateMergeQueries()
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
    startMerge,
    updateMergeMapping,
    submitMerge,
    confirmMerge,
    cancelMerge,
    undoMerge,
    reconcileMerge,
    resetDemo,
    exportContract,
  }
})
