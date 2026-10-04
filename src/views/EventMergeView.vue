<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  CheckCircleIcon,
  GitMergeIcon,
  RefreshIcon,
  RollbackIcon,
  TimeIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import type { EventMergeRecord, MergeCheckpointPhase } from '@/models/domain'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()

const createVisible = ref(false)
const form = reactive({ primaryEventId: '', sourceEventId: '', reason: '' })

const selectableEvents = computed(() =>
  store.data.events.filter((event) => !event.mergedIntoId && event.status !== 'retired'),
)

const eventById = (id: string) => store.data.events.find((event) => event.id === id)

const records = computed(() => store.data.merges)

/**
 * 本窗口持有的记录基线版本（乐观锁）。
 * 另一窗口提交/撤销后 record.version 推进，本窗口仍持旧值，提交即冲突。
 */
const baselineVersion = reactive<Record<string, number>>({})
const expectedVersion = (record: EventMergeRecord): number => {
  if (baselineVersion[record.id] === undefined) baselineVersion[record.id] = record.version
  return baselineVersion[record.id]!
}
const refreshBaseline = (record: EventMergeRecord): void => {
  baselineVersion[record.id] = store.data.merges.find((item) => item.id === record.id)?.version
    ?? record.version
}

const phaseOptions: { label: string; value: MergeCheckpointPhase }[] = [
  { label: '快照前', value: 'prepared' },
  { label: '写别名前', value: 'alias_written' },
  { label: '切换看板前', value: 'dependencies_rewritten' },
  { label: '切换场景前', value: 'scenarios_rewritten' },
  { label: '切换发布前', value: 'releases_rewritten' },
  { label: '旧事件停采前', value: 'event_retired' },
  { label: '完成前', value: 'completed' },
]
const crashPhase = ref<MergeCheckpointPhase>('dependencies_rewritten')

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries()
}

const openCreate = (): void => {
  const candidates = selectableEvents.value
  form.primaryEventId = candidates.find((event) => event.key === 'coupon_apply_result')?.id ?? candidates[0]?.id ?? ''
  form.sourceEventId = candidates.find((event) => event.key === 'coupon_receive_result')?.id ?? ''
  form.reason = '新旧领券事件双报，同名属性一个枚举一个字符串，需统一口径。'
  createVisible.value = true
}

const createMerge = async (): Promise<void> => {
  if (!form.primaryEventId || !form.sourceEventId) {
    await MessagePlugin.error('请选择主事件和待合并事件')
    return
  }
  if (form.primaryEventId === form.sourceEventId) {
    await MessagePlugin.error('主事件与待合并事件不能相同')
    return
  }
  if (!form.reason.trim()) {
    await MessagePlugin.error('请填写合并原因')
    return
  }
  try {
    const record = store.prepareEventMerge(form.primaryEventId, form.sourceEventId, form.reason)
    createVisible.value = false
    await invalidate()
    await MessagePlugin.success(
      record.blockingReasons.length > 0
        ? `映射已生成，但存在阻塞：${record.blockingReasons.join('；')}`
        : '字段映射已按血缘生成，可核对后确认',
    )
  } catch (error) {
    await MessagePlugin.error((error as Error).message)
  }
}

const applyMappingChange = (record: EventMergeRecord): void => {
  store.updateMergeMappings(record.id, structuredClone(record.mappings))
}

const confirmMerge = async (record: EventMergeRecord): Promise<void> => {
  try {
    const ok = store.confirmEventMerge(record.id, expectedVersion(record))
    await invalidate()
    if (ok) {
      refreshBaseline(record)
      await MessagePlugin.success('合并已确认：看板和查询改读主事件，旧键保留为别名')
    } else {
      const fresh = store.data.merges.find((item) => item.id === record.id)
      await MessagePlugin.error(fresh?.blockingReasons[0] ?? '存在阻塞，无法确认')
    }
  } catch (error) {
    await invalidate()
    await MessagePlugin.warning((error as Error).message + ' 可再次确认从检查点继续')
  }
}

const cancelMerge = async (record: EventMergeRecord): Promise<void> => {
  const ok = store.cancelEventMerge(record.id, expectedVersion(record))
  await invalidate()
  if (ok) refreshBaseline(record)
  await MessagePlugin[ok ? 'success' : 'error'](
    ok ? '合并已撤销，事件引用未改动' : '撤销失败：版本冲突或合并已完成',
  )
}

const simulateCrash = async (record: EventMergeRecord): Promise<void> => {
  store.simulateCrashBefore(record.id, crashPhase.value)
  await MessagePlugin.info(`下次确认将在「${crashPhase.value}」阶段前中断`)
}

const simulateConcurrent = async (record: EventMergeRecord): Promise<void> => {
  store.simulateSiblingWindowWrite(record.id)
  await invalidate()
  await MessagePlugin.warning('已模拟另一窗口抢先提交/撤销，请再点确认或撤销查看后到方冲突')
}

/** 后到方冲突后，重新以最新版本为基线 */
const refreshConflictRecord = async (record: EventMergeRecord): Promise<void> => {
  const fresh = store.refreshMergeAfterConflict(record.id)
  if (fresh) {
    refreshBaseline(fresh)
    await invalidate()
    await MessagePlugin.info('已同步到最新版本，可继续操作')
  }
}

const runReconcile = async (record: EventMergeRecord): Promise<void> => {
  const balanced = store.reconcileEventMerge(record.id)
  await invalidate()
  await MessagePlugin[balanced ? 'success' : 'error'](
    balanced ? '对账平衡：引用与别名全部一致' : '对账不平，可恢复合并前引用',
  )
}

const restore = async (record: EventMergeRecord): Promise<void> => {
  store.restorePreMerge(record.id, '对账不平，按快照恢复合并前看板与查询引用')
  await invalidate()
  await MessagePlugin.warning('已恢复合并前引用，差异和历史映射已留档')
}

const dependencyLabel: Record<string, string> = {
  dashboard: '看板',
  alert: '告警',
  model: '模型',
  dataset: '数据集',
  experiment: '实验',
}

const checkpointPhases: MergeCheckpointPhase[] = [
  'prepared',
  'alias_written',
  'dependencies_rewritten',
  'scenarios_rewritten',
  'releases_rewritten',
  'event_retired',
  'completed',
]
const checkpointIndex = (record: EventMergeRecord): number =>
  record.checkpoint ? checkpointPhases.indexOf(record.checkpoint.phase) : -1
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="事件治理"
      title="事件合并"
      description="选择主事件与待合并事件，按血缘生成字段映射；类型冲突或映射成环时停待处理。确认后看板和查询改读主事件、旧键留作别名，全程可撤销、可断点续跑、可对账恢复。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div>
          <strong>{{ records.length }} 份合并记录</strong>
          <p class="page-description">同一对事件只生成一份记录；跨窗口并发提交以后到方冲突为准。</p>
        </div>
        <div class="filter-actions">
          <t-button theme="primary" @click="openCreate">
            <template #icon><GitMergeIcon /></template>
            新建事件合并
          </t-button>
        </div>
      </div>
    </section>

    <div v-if="records.length === 0" class="panel empty-state">
      暂无合并记录。种子数据已包含新旧领券事件 coupon_apply_result / coupon_receive_result，可直接创建。
    </div>

    <article v-for="record in records" :key="record.id" class="panel merge-card">
      <header class="merge-head">
        <div class="merge-pair">
          <div class="pair-event">
            <span class="pair-tag primary">主事件</span>
            <code>{{ eventById(record.primaryEventId)?.key }}</code>
            <strong>{{ eventById(record.primaryEventId)?.displayName }}</strong>
          </div>
          <GitMergeIcon class="pair-arrow" />
          <div class="pair-event">
            <span class="pair-tag source">待合并</span>
            <code>{{ eventById(record.sourceEventId)?.key }}</code>
            <strong>{{ eventById(record.sourceEventId)?.displayName }}</strong>
          </div>
        </div>
        <div class="merge-meta">
          <StatusTag :value="record.status" />
          <span class="mono">
            当前 v{{ record.version }}
            <template v-if="baselineVersion[record.id] !== undefined && baselineVersion[record.id] !== record.version">
              · 本窗口基线 v{{ baselineVersion[record.id] }}
            </template>
          </span>
          <span class="muted">{{ new Date(record.updatedAt).toLocaleString('zh-CN') }}</span>
        </div>
      </header>

      <p class="merge-reason">{{ record.reason }}</p>

      <t-alert
        v-if="record.blockingReasons.length"
        theme="warning"
        message="停待处理"
        :description="record.blockingReasons.join('；')"
        class="block-alert"
      />

      <div v-if="record.checkpoint" class="checkpoint-bar">
        <div
          v-for="(phase, index) in checkpointPhases"
          :key="phase"
          class="checkpoint-step"
          :class="{ done: index <= checkpointIndex(record), active: index === checkpointIndex(record) }"
        >
          <StatusTag :value="phase" />
        </div>
        <p class="checkpoint-note">当前检查点：{{ record.checkpoint.note }}</p>
      </div>

      <section class="mapping-section">
        <h3>字段映射（按血缘生成）</h3>
        <t-table
          row-key="id"
          :data="record.mappings"
          size="small"
          bordered
          :columns="[
            { colKey: 'sourceName', title: '旧字段', width: 130 },
            { colKey: 'sourceType', title: '旧类型', width: 90 },
            { colKey: 'targetName', title: '主事件字段', width: 160 },
            { colKey: 'targetType', title: '目标类型', width: 90 },
            { colKey: 'matchReason', title: '匹配依据' },
            { colKey: 'state', title: '状态', width: 150 },
            { colKey: 'controls', title: '设置', width: 220 },
          ]"
        >
          <template #sourceName="{ row }">
            <code>{{ row.sourceName }}</code>
          </template>
          <template #targetName="{ row }">
            <code>{{ row.targetName || '— 迁入为新字段' }}</code>
          </template>
          <template #state="{ row }">
            <t-space size="small" direction="vertical">
              <t-space size="small">
                <t-tag v-if="row.conflict" theme="danger" variant="light">类型冲突</t-tag>
                <t-tag v-if="row.cycle" theme="danger" variant="light">映射成环</t-tag>
                <t-tag v-if="!row.conflict && !row.cycle" theme="success" variant="light">就绪</t-tag>
              </t-space>
              <t-space v-if="row.conflict" size="small">
                <t-button
                  size="extra-small"
                  variant="outline"
                  theme="primary"
                  @click="store.resolveMergeConflict(record.id, row.id, 'cast')"
                >
                  接受转换
                </t-button>
                <t-button
                  size="extra-small"
                  variant="outline"
                  theme="danger"
                  @click="store.resolveMergeConflict(record.id, row.id, 'drop')"
                >
                  放弃字段
                </t-button>
              </t-space>
              <span v-if="row.valueTransform" class="mono transform-hint">{{ row.valueTransform }}</span>
            </t-space>
          </template>
          <template #controls="{ row }">
            <div class="mapping-controls">
              <t-checkbox
                :checked="row.selected"
                :disabled="row.conflict || row.cycle"
                @change="(value: boolean) => { row.selected = value; applyMappingChange(record) }"
              >
                纳入切换
              </t-checkbox>
              <t-checkbox
                :checked="Boolean(row.backfill)"
                @change="(value: boolean) => { row.backfill = value; applyMappingChange(record) }"
              >
                双向回填
              </t-checkbox>
            </div>
          </template>
        </t-table>
        <p class="mapping-hint">
          冲突字段默认排除并停待处理；对同一字段同时勾选「纳入切换」与「双向回填」会构造出 旧字段 ⇄ 主字段 的环，可用于复现成环阻塞。
        </p>
      </section>

      <section class="reference-section">
        <h3>待改读主事件的看板与查询（{{ record.references.length }}）</h3>
        <div v-if="record.references.length === 0" class="muted">没有引用待合并事件的下游。</div>
        <ul v-else class="reference-list">
          <li v-for="reference in record.references" :key="reference.dependencyId">
            <t-tag variant="light">{{ dependencyLabel[reference.dependencyType] }}</t-tag>
            <strong>{{ reference.dependencyName }}</strong>
            <span class="muted">
              {{ eventById(record.sourceEventId)?.key }} → {{ eventById(record.primaryEventId)?.key }}
              · {{ reference.sourcePropertyIds.length }} 个字段引用
            </span>
            <t-tag
              v-for="dropped in reference.droppedPropertyNames"
              :key="dropped"
              size="small"
              theme="danger"
              variant="light"
            >
              将移除引用：{{ dropped }}
            </t-tag>
          </li>
        </ul>
      </section>

      <section v-if="record.reconcile" class="reconcile-section">
        <h3>
          对账结果
          <StatusTag :value="record.reconcile.balanced ? 'verified' : 'conflict'" />
        </h3>
        <p class="muted">对账时间：{{ new Date(record.reconcile.checkedAt).toLocaleString('zh-CN') }}</p>
        <ul v-if="record.reconcile.diffs.length" class="diff-list">
          <li v-for="diff in record.reconcile.diffs" :key="diff.id">
            <t-tag size="small" theme="warning" variant="light">{{ diff.kind }}</t-tag>
            {{ diff.detail }}
          </li>
        </ul>
        <p v-else class="balanced-text">
          <CheckCircleIcon /> 看板、查询与别名引用全部一致。
        </p>
        <details class="history-mappings">
          <summary>留档：历史字段映射（{{ record.reconcile.historicalMappings.length }}）</summary>
          <ul>
            <li v-for="mapping in record.reconcile.historicalMappings" :key="mapping.id">
              <code>{{ mapping.sourceName }}</code> ({{ mapping.sourceType }}) →
              <code>{{ mapping.targetName }}</code> ({{ mapping.targetType }})
              · {{ mapping.matchReason }}
              <span v-if="mapping.valueTransform">· 转换 {{ mapping.valueTransform }}</span>
            </li>
          </ul>
        </details>
      </section>

      <footer class="merge-actions">
        <template v-if="record.status === 'pending' || record.status === 'switching'">
          <t-button
            theme="primary"
            :disabled="record.blockingReasons.length > 0"
            @click="confirmMerge(record)"
          >
            <template #icon><CheckCircleIcon /></template>
            {{ record.checkpoint ? '从检查点继续' : '确认合并' }}
          </t-button>
          <t-button variant="outline" @click="cancelMerge(record)">撤销</t-button>
          <t-select v-model="crashPhase" :options="phaseOptions" size="small" class="phase-select" />
          <t-button variant="outline" size="small" @click="simulateCrash(record)">
            <template #icon><TimeIcon /></template>
            模拟写入中断
          </t-button>
          <t-button variant="outline" size="small" @click="simulateConcurrent(record)">
            模拟另一窗口提交
          </t-button>
        </template>
        <template v-else-if="record.status === 'merged'">
          <t-button variant="outline" @click="runReconcile(record)">
            <template #icon><RefreshIcon /></template>
            执行对账
          </t-button>
          <t-button
            theme="danger"
            variant="outline"
            :disabled="!record.reconcile || record.reconcile.balanced"
            @click="restore(record)"
          >
            <template #icon><RollbackIcon /></template>
            对账不平：恢复合并前引用
          </t-button>
        </template>
        <template v-else-if="record.status === 'conflict'">
          <t-alert
            theme="error"
            message="并发冲突"
            description="另一窗口已提交或撤销该合并，本窗口持有的基线版本已过期。"
            class="conflict-inline"
          />
          <t-button theme="primary" @click="refreshConflictRecord(record)">同步最新版本</t-button>
        </template>
        <span v-else class="muted">
          {{ record.revertReason ? `撤销原因：${record.revertReason}` : '该合并已结束' }}
          · {{ record.revertedAt ? new Date(record.revertedAt).toLocaleString('zh-CN') : '' }}
        </span>
      </footer>
    </article>

    <t-dialog
      v-model:visible="createVisible"
      header="新建事件合并"
      width="620px"
      :footer="false"
    >
      <div class="editor-form single-column">
        <div class="field">
          <label>主事件（保留并承接引用）</label>
          <t-select
            v-model="form.primaryEventId"
            filterable
            :options="selectableEvents.map((event) => ({
              label: `${event.displayName} (${event.key}) · ${event.status}`,
              value: event.id,
            }))"
          />
        </div>
        <div class="field">
          <label>待合并事件（旧事件，确认后停采）</label>
          <t-select
            v-model="form.sourceEventId"
            filterable
            :options="selectableEvents
              .filter((event) => event.id !== form.primaryEventId)
              .map((event) => ({
                label: `${event.displayName} (${event.key}) · ${event.status}`,
                value: event.id,
              }))"
          />
        </div>
        <div class="field">
          <label>合并原因</label>
          <t-textarea v-model="form.reason" :autosize="{ minRows: 3, maxRows: 5 }" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="createVisible = false">取消</t-button>
        <t-button theme="primary" @click="createMerge">按血缘生成映射</t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.merge-card {
  display: grid;
  gap: 18px;
  padding: 20px;
}

.merge-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.merge-pair {
  display: flex;
  align-items: center;
  gap: 14px;
}

.pair-event {
  display: grid;
  gap: 4px;
  padding: 10px 14px;
  border: 1px solid #e3e7ec;
  border-radius: 6px;
  background: #fafbfc;
}

.pair-event code {
  color: #1264c5;
  font-size: 12px;
}

.pair-event strong {
  font-size: 13px;
}

.pair-tag {
  justify-self: start;
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 10px;
}

.pair-tag.primary {
  color: #0f6a4d;
  background: #d9f3e8;
}

.pair-tag.source {
  color: #9a5b00;
  background: #fce8c7;
}

.pair-arrow {
  width: 22px;
  height: 22px;
  color: #1677ff;
}

.merge-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}

.merge-reason {
  margin: 0;
  color: #4e5a6d;
  font-size: 13px;
}

.block-alert {
  margin: 0;
}

.conflict-inline {
  flex: 1 1 260px;
}

.checkpoint-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 12px;
  border: 1px dashed #c5cfdd;
  border-radius: 6px;
  background: #f7f9fc;
}

.checkpoint-step {
  opacity: 0.45;
}

.checkpoint-step.done {
  opacity: 1;
}

.checkpoint-step.active :deep(.t-tag) {
  box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.25);
}

.checkpoint-note {
  flex-basis: 100%;
  margin: 4px 0 0;
  color: #687386;
  font-size: 12px;
}

.mapping-section h3,
.reference-section h3,
.reconcile-section h3 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
  font-size: 15px;
}

.mapping-controls {
  display: grid;
  gap: 4px;
}

.mapping-hint {
  margin: 8px 0 0;
  color: #8a93a3;
  font-size: 12px;
}

.transform-hint {
  color: #1264c5;
  font-size: 11px;
}

.reference-list,
.diff-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.reference-list li,
.diff-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 12px;
  border: 1px solid #e7eaef;
  border-radius: 6px;
  background: #fafbfc;
  font-size: 13px;
}

.diff-list li {
  align-items: flex-start;
}

.reconcile-section {
  padding: 14px;
  border-left: 3px solid #1677ff;
  background: #f6f9ff;
}

.balanced-text {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: #0f8a62;
  font-size: 13px;
}

.history-mappings {
  margin-top: 10px;
  font-size: 12px;
}

.history-mappings summary {
  cursor: pointer;
  color: #596579;
}

.history-mappings ul {
  margin: 8px 0 0;
  padding-left: 18px;
  color: #687386;
  line-height: 1.9;
}

.merge-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-top: 14px;
  border-top: 1px solid #eef1f5;
}

.phase-select {
  width: 170px;
}

.single-column {
  grid-template-columns: minmax(0, 1fr);
}
</style>
