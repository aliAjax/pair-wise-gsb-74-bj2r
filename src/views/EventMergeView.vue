<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  CheckCircleIcon,
  ErrorCircleIcon,
  GitMergeIcon,
  InfoCircleIcon,
  PlayCircleIcon,
  RefreshIcon,
  RollbackIcon,
} from 'tdesign-icons-vue-next'
import { DialogPlugin, MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import type {
  EventDefinition,
  EventMerge,
  MergeFieldMapping,
  MergeStatus,
  PropertyType,
} from '@/models/domain'
import { CHECKPOINT_STEPS, checkpointLabel } from '@/services/eventMerge'
import { StaleMergeVersionError, useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()

const startVisible = ref(false)
const startForm = reactive({ masterEventId: '', sourceEventId: '', reason: '' })

const detailId = ref<string | null>(null)
const observedRefs = ref<number>(0)
const reconcileNote = ref('')
const interruptStep = ref<string>('')

const eventsById = computed(() => new Map(store.data.events.map((event) => [event.id, event])))
const eventLabel = (event?: EventDefinition): string =>
  event ? `${event.key}（${event.displayName}）` : '未知事件'

const merges = computed(() => store.data.merges)

const columns = computed(() => [
  {
    key: 'draft' as MergeStatus,
    title: '字段映射中',
    description: '按血缘生成映射，处置类型冲突',
    items: merges.value.filter((merge) => merge.status === 'draft'),
  },
  {
    key: 'pending' as MergeStatus,
    title: '待处理（等待确认）',
    description: '冲突与成环已清零，等待确认生效',
    items: merges.value.filter((merge) => merge.status === 'pending'),
  },
  {
    key: 'confirming' as MergeStatus,
    title: '确认中断',
    description: '写入已到检查点，可继续',
    items: merges.value.filter((merge) => merge.status === 'confirming'),
  },
  {
    key: 'confirmed' as MergeStatus,
    title: '已确认 · 看板改读主事件',
    description: '旧键作为别名保留，可对账与恢复',
    items: merges.value.filter((merge) => merge.status === 'confirmed'),
  },
])

const undoneMerges = computed(() => merges.value.filter((merge) => merge.status === 'undone'))

const detailMerge = computed(() =>
  detailId.value ? merges.value.find((merge) => merge.id === detailId.value) ?? null : null,
)

const selectableEvents = computed(() =>
  store.data.events
    .filter((event) => event.status !== 'retired' && !event.mergedIntoEventId)
    .map((event) => ({
      label: `${event.key}（${event.displayName} · ${event.status}）`,
      value: event.id,
    })),
)

const sourceEventOptions = computed(() =>
  selectableEvents.value.filter((option) => option.value !== startForm.masterEventId),
)

const handleError = (error: unknown): void => {
  if (error instanceof StaleMergeVersionError) {
    void MessagePlugin.error('冲突：另一个窗口已提交或撤销，看板已刷新，请以最新记录重试')
  } else if (error instanceof Error) {
    void MessagePlugin.error(error.message)
  }
  detailId.value = null
}

const openStart = (masterEventId = '', sourceEventId = ''): void => {
  startForm.masterEventId = masterEventId
  startForm.sourceEventId = sourceEventId
  startForm.reason = ''
  startVisible.value = true
}

const quickSuggestion = (masterEventId: string, sourceEventId: string): void => {
  openStart(masterEventId, sourceEventId)
}

const createMerge = (): void => {
  if (!startForm.masterEventId || !startForm.sourceEventId) {
    void MessagePlugin.error('请先选择主事件和待合并事件')
    return
  }
  try {
    const merge = store.startMerge(
      startForm.masterEventId,
      startForm.sourceEventId,
      startForm.reason,
    )
    startVisible.value = false
    detailId.value = merge.id
    void MessagePlugin.success('已按血缘生成字段映射，阻塞项已列出')
  } catch (error) {
    handleError(error)
  }
}

const targetPropertyOptions = (merge: EventMerge) => {
  const master = eventsById.value.get(merge.masterEventId)
  return (master?.properties ?? [])
    .filter((property) => !property.deletedAt)
    .map((property) => ({
      label: `${property.name}（${property.type}）`,
      value: property.id,
    }))
}

const mappingVersion = (merge: EventMerge): number => merge.version

const changeTarget = (merge: EventMerge | null, mapping: MergeFieldMapping, value: unknown): void => {
  if (!merge) return
  try {
    store.updateMergeMapping(merge.id, mappingVersion(merge), mapping.id, {
      targetPropertyId: String(value),
    })
  } catch (error) {
    handleError(error)
  }
}

const changeResolution = (merge: EventMerge | null, mapping: MergeFieldMapping, value: unknown): void => {
  if (!merge) return
  try {
    const resolution = String(value) as MergeFieldMapping['resolution']
    if (resolution === 'cast' && mapping.sourceType === 'string' && mapping.targetType === 'enum') {
      const master = eventsById.value.get(merge.masterEventId)
      const target = master?.properties.find((property) => property.id === mapping.targetPropertyId)
      if (target && mapping.valueMapping.length === 0) {
        mapping.valueMapping = target.enumValues.map((enumValue) => ({ from: '', to: enumValue }))
      }
    }
    store.updateMergeMapping(merge.id, mappingVersion(merge), mapping.id, {
      resolution,
      valueMapping: structuredClone(mapping.valueMapping),
    })
  } catch (error) {
    handleError(error)
  }
}

const updateValueMapping = (merge: EventMerge, mapping: MergeFieldMapping): void => {
  try {
    store.updateMergeMapping(merge.id, mappingVersion(merge), mapping.id, {
      valueMapping: structuredClone(mapping.valueMapping),
      castNote: mapping.castNote,
    })
  } catch (error) {
    handleError(error)
  }
}

const submitMerge = (merge: EventMerge): void => {
  try {
    store.submitMerge(merge.id, merge.version)
    void MessagePlugin.success('合并已提交到待处理列')
  } catch (error) {
    handleError(error)
  }
}

const cancelMerge = (merge: EventMerge): void => {
  const dialog = DialogPlugin.confirm({
    header: '撤销合并申请',
    body: '该合并尚未生效，撤销后字段映射记录仍会留档。确认撤销？',
    confirmBtn: '撤销申请',
    cancelBtn: '取消',
    onConfirm: () => {
      try {
        store.cancelMerge(merge.id, merge.version)
        dialog.destroy()
        detailId.value = null
        void MessagePlugin.success('合并申请已撤销，历史记录保留')
      } catch (error) {
        dialog.destroy()
        handleError(error)
      }
    },
  })
}

const ensureSubmitted = (merge: EventMerge): void => {
  if (merge.status === 'draft') {
    store.submitMerge(merge.id, merge.version)
  }
}

const confirmMerge = (merge: EventMerge, injectFailure = false): void => {
  try {
    ensureSubmitted(merge)
    store.confirmMerge(merge.id, merge.version, {
      failAtStep: injectFailure
        ? (interruptStep.value as (typeof CHECKPOINT_STEPS)[number]) || 'rewrite_refs'
        : undefined,
    })
    if (injectFailure) {
      void MessagePlugin.warning('已模拟写入中断，刷新看板后可从检查点继续')
    } else {
      void MessagePlugin.success('确认完成：看板与查询已改读主事件，旧键保留为别名')
    }
  } catch (error) {
    handleError(error)
  }
}

const openDetail = (merge: EventMerge): void => {
  detailId.value = merge.id
  observedRefs.value = merge.reconciliation?.observedRefs ?? 0
  reconcileNote.value = merge.reconciliation?.note ?? ''
  interruptStep.value = ''
}

const runReconcile = (merge: EventMerge): void => {
  try {
    const result = store.reconcileMerge(merge.id, merge.version, observedRefs.value, reconcileNote.value)
    void MessagePlugin[result.balanced ? 'success' : 'warning'](
      result.balanced ? '对账平衡' : `对账不平：${result.differences.length} 项差异已留档`,
    )
  } catch (error) {
    handleError(error)
  }
}

const restoreBeforeMerge = (merge: EventMerge): void => {
  const dialog = DialogPlugin.confirm({
    header: '恢复合并前引用',
    body: '将用合并前备份还原事件、看板与场景引用，差异和历史映射会保留在记录中。确认恢复？',
    confirmBtn: '恢复引用',
    cancelBtn: '取消',
    onConfirm: () => {
      try {
        store.undoMerge(merge.id, merge.version, reconcileNote.value || '看板对账不平')
        dialog.destroy()
        void MessagePlugin.success('合并前引用已恢复，差异与映射已留档')
      } catch (error) {
        dialog.destroy()
        handleError(error)
      }
    },
  })
}

const typeLabel: Record<PropertyType, string> = {
  string: '字符串',
  number: '数值',
  boolean: '布尔',
  array: '数组',
  object: '对象',
  enum: '枚举',
}

const checkpointCurrentIndex = (merge: EventMerge): number => {
  if (merge.status === 'confirmed') return CHECKPOINT_STEPS.length
  if (!merge.checkpoint) return 0
  const index = CHECKPOINT_STEPS.indexOf(merge.checkpoint.step)
  return merge.checkpoint.done ? index + 1 : index
}

const suggestionList = computed(() => {
  const existingPairs = new Set(merges.value.map((merge) => merge.pairKey))
  const candidates = store.data.events.filter(
    (event) => event.status !== 'retired' && !event.mergedIntoEventId,
  )
  const result: Array<{
    masterEventId: string
    sourceEventId: string
    sharedProperties: number
    conflicts: number
  }> = []
  for (let index = 0; index < candidates.length; index += 1) {
    for (let cursor = index + 1; cursor < candidates.length; cursor += 1) {
      const left = candidates[index]!
      const right = candidates[cursor]!
      if (left.category !== right.category) continue
      const pairKey = [left.id, right.id].sort().join('::')
      if (existingPairs.has(pairKey)) continue
      let shared = 0
      let conflicts = 0
      right.properties
        .filter((property) => !property.deletedAt)
        .forEach((property) => {
          const matched = left.properties.find(
            (target) =>
              target.name === property.name ||
              target.synonyms.some((alias) =>
                [property.name, ...property.synonyms].includes(alias),
              ) ||
              (property.lineageSourceId && target.id === property.lineageSourceId),
          )
          if (matched) {
            shared += 1
            if (matched.type !== property.type) conflicts += 1
          }
        })
      if (shared > 0) result.push({ masterEventId: left.id, sourceEventId: right.id, sharedProperties: shared, conflicts })
    }
  }
  return result.sort(
    (a, b) => b.sharedProperties - a.sharedProperties || b.conflicts - a.conflicts,
  )
})
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="重复治理"
      title="事件合并看板"
      description="选择主事件与待合并事件，按血缘生成字段映射；类型冲突或映射成环停在待处理，确认后看板与查询改读主事件，旧键留作别名且全程可撤销。"
    />

    <section class="panel suggestion-panel">
      <div class="suggestion-head">
        <div>
          <strong>重复事件候选</strong>
          <p>同业务域且存在同名字段或同义字段的事件对，点击可直接发起合并。</p>
        </div>
        <t-button theme="primary" @click="openStart()">
          <template #icon><GitMergeIcon /></template>
          发起事件合并
        </t-button>
      </div>
      <div v-if="suggestionList.length" class="suggestion-list">
        <button
          v-for="item in suggestionList"
          :key="`${item.masterEventId}-${item.sourceEventId}`"
          class="suggestion-chip"
          type="button"
          @click="quickSuggestion(item.masterEventId, item.sourceEventId)"
        >
          <GitMergeIcon />
          <span>
            {{ eventLabel(eventsById.get(item.masterEventId)) }}
            <em>⇐</em>
            {{ eventLabel(eventsById.get(item.sourceEventId)) }}
          </span>
          <t-tag size="small" theme="primary" variant="light">{{ item.sharedProperties }} 个同名字段</t-tag>
          <t-tag v-if="item.conflicts" size="small" theme="danger" variant="light">{{ item.conflicts }} 个类型冲突</t-tag>
        </button>
      </div>
      <p v-else class="empty-hint">暂无可合并候选（已存在记录的事件对不再重复推荐）。</p>
    </section>

    <div class="board">
      <section v-for="column in columns" :key="column.key" class="board-column">
        <header class="column-head">
          <div>
            <strong>{{ column.title }}</strong>
            <p>{{ column.description }}</p>
          </div>
          <span class="column-count">{{ column.items.length }}</span>
        </header>
        <div class="column-body">
          <article
            v-for="merge in column.items"
            :key="merge.id"
            class="panel merge-card"
            :class="{ blocked: merge.blockers.length > 0 && merge.status !== 'confirmed' }"
          >
            <div class="merge-pair">
              <StatusTag :value="merge.status" />
              <code>v{{ merge.version }}</code>
            </div>
            <h3>{{ eventLabel(eventsById.get(merge.masterEventId)) }}</h3>
            <p class="merge-source">
              待合并：{{ eventLabel(eventsById.get(merge.sourceEventId)) }}
            </p>
            <p v-if="merge.reason" class="merge-reason">{{ merge.reason }}</p>

            <ul class="mapping-summary">
              <li>
                <InfoCircleIcon /> {{ merge.mappings.length }} 条字段映射
              </li>
              <li v-if="merge.mappings.some((item) => item.status === 'resolved')" class="ok">
                <CheckCircleIcon />
                {{ merge.mappings.filter((item) => item.status === 'resolved').length }} 条已处置
              </li>
              <li v-if="merge.blockers.length" class="bad">
                <ErrorCircleIcon /> {{ merge.blockers.length }} 项阻塞
              </li>
            </ul>

            <div v-if="merge.status === 'confirming' && merge.checkpoint" class="checkpoint-strip">
              <PlayCircleIcon />
              中断于「{{ checkpointLabel[merge.checkpoint.step] }}」，检查点已保存
            </div>

            <div v-if="merge.status === 'confirmed'" class="confirmed-strip">
              <CheckCircleIcon />
              看板改读主事件 ·
              旧键 <code>{{ eventsById.get(merge.sourceEventId)?.key }}</code> 已作别名
              <span v-if="merge.reconciliation">
                ·
                <t-tag
                  size="small"
                  :theme="merge.reconciliation.balanced ? 'success' : 'danger'"
                  variant="light"
                >
                  对账{{ merge.reconciliation.balanced ? '平衡' : '不平' }}
                </t-tag>
              </span>
            </div>

            <div class="card-actions">
              <t-button variant="outline" size="small" @click="openDetail(merge)">
                查看看板
              </t-button>
              <t-button
                v-if="['draft', 'pending'].includes(merge.status)"
                theme="primary"
                size="small"
                :disabled="merge.blockers.length > 0"
                @click="submitMerge(merge)"
              >
                {{ merge.status === 'draft' ? '提交' : '重新提交' }}
              </t-button>
              <t-button
                v-if="merge.status === 'confirming'"
                theme="primary"
                size="small"
                @click="confirmMerge(merge)"
              >
                从检查点继续
              </t-button>
            </div>
          </article>
          <p v-if="!column.items.length" class="column-empty">暂无记录</p>
        </div>
      </section>
    </div>

    <section v-if="undoneMerges.length" class="panel archive-panel">
      <strong>历史留档（{{ undoneMerges.length }}）</strong>
      <p>撤销或恢复引用后的合并记录，字段映射与对账差异仍可追溯。</p>
      <ul>
        <li v-for="merge in undoneMerges" :key="merge.id">
          <button type="button" class="link-button" @click="openDetail(merge)">
            {{ eventLabel(eventsById.get(merge.masterEventId)) }} ⇐
            {{ eventLabel(eventsById.get(merge.sourceEventId)) }}
          </button>
          <t-tag
            size="small"
            :theme="merge.reconciliation?.restored ? 'warning' : 'default'"
            variant="light"
          >
            {{ merge.reconciliation?.restored ? '已恢复合并前引用' : '已撤销' }}
          </t-tag>
        </li>
      </ul>
    </section>

    <!-- 发起合并 -->
    <t-dialog v-model:visible="startVisible" header="发起事件合并" width="640px" :footer="false">
      <div class="editor-form">
        <div class="field field-wide">
          <label>主事件（合并后看板与查询读取该事件）</label>
          <t-select
            v-model="startForm.masterEventId"
            :options="selectableEvents"
            filterable
            placeholder="选择保留的主事件"
          />
        </div>
        <div class="field field-wide">
          <label>待合并事件（旧事件，旧键将留作别名）</label>
          <t-select
            v-model="startForm.sourceEventId"
            :options="sourceEventOptions"
            filterable
            placeholder="选择并入主事件的旧事件"
          />
        </div>
        <div class="field field-wide">
          <label>合并原因</label>
          <t-textarea
            v-model="startForm.reason"
            :autosize="{ minRows: 3, maxRows: 5 }"
            placeholder="如：新旧领券事件同时在报，需要统一口径"
          />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="startVisible = false">取消</t-button>
        <t-button theme="primary" @click="createMerge">按血缘生成字段映射</t-button>
      </div>
    </t-dialog>

    <!-- 合并详情看板 -->
    <t-dialog
      v-model:visible="detailId"
      :header="detailMerge ? '事件合并看板' : '事件合并看板'"
      width="980px"
      :footer="false"
    >
      <div v-if="detailMerge" class="detail">
        <div class="detail-head">
          <div>
            <StatusTag :value="detailMerge.status" />
            <code class="version-code">版本 v{{ detailMerge.version }} · 同对事件唯一记录 {{ detailMerge.pairKey }}</code>
          </div>
        </div>

        <div class="pair-box">
          <div class="pair-event master">
            <small>主事件</small>
            <strong>{{ eventLabel(eventsById.get(detailMerge.masterEventId)) }}</strong>
          </div>
          <GitMergeIcon class="pair-icon" />
          <div class="pair-event source">
            <small>待合并事件</small>
            <strong>{{ eventLabel(eventsById.get(detailMerge.sourceEventId)) }}</strong>
          </div>
        </div>

        <!-- 阻塞看板 -->
        <section v-if="['draft', 'pending', 'confirming'].includes(detailMerge.status)" class="detail-section">
          <h4>阻塞看板</h4>
          <div v-if="detailMerge.blockers.length" class="blocker-list">
            <div v-for="(blocker, index) in detailMerge.blockers" :key="index" class="blocker-item">
              <ErrorCircleIcon />
              <span>{{ blocker.message }}</span>
            </div>
          </div>
          <div v-else class="all-clear">
            <CheckCircleIcon /> 无类型冲突、无成环、无悬空字段，可以提交确认。
          </div>
        </section>

        <!-- 字段映射 -->
        <section class="detail-section">
          <h4>字段映射（按同名 / 同义词 / 血缘生成）</h4>
          <table class="mapping-table">
            <thead>
              <tr>
                <th>旧事件字段</th>
                <th>主事件字段</th>
                <th>匹配依据</th>
                <th>处置</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="mapping in detailMerge.mappings" :key="mapping.id">
                <td>
                  <strong>{{ mapping.sourceName }}</strong>
                  <t-tag size="small" variant="light">{{ typeLabel[mapping.sourceType] }}</t-tag>
                </td>
                <td>
                  <div class="target-cell">
                    <t-select
                      :value="mapping.targetPropertyId"
                      :options="targetPropertyOptions(detailMerge)"
                      size="small"
                      clearable
                      :disabled="!['draft', 'pending'].includes(detailMerge.status)"
                      @change="(value: unknown) => changeTarget(detailMerge, mapping, value)"
                    />
                    <t-tag
                      v-if="mapping.targetType"
                      size="small"
                      :theme="mapping.targetType === mapping.sourceType ? 'success' : 'danger'"
                      variant="light"
                    >
                      {{ typeLabel[mapping.targetType] }}
                    </t-tag>
                  </div>
                </td>
                <td>
                  {{ { name: '同名', synonym: '同义词', lineage: '血缘', manual: '手动', none: '未匹配' }[mapping.matchBasis] }}
                </td>
                <td>
                  <div class="resolution-cell">
                    <StatusTag :value="mapping.status" />
                    <t-select
                      :value="mapping.resolution"
                      size="small"
                      :disabled="!['draft', 'pending'].includes(detailMerge.status)"
                      placeholder="处置方式"
                      :options="[
                        { label: '保持类型直接映射', value: '' },
                        { label: '类型转换（枚举映射）', value: 'cast' },
                        { label: '丢弃字段', value: 'drop' },
                      ]"
                      @change="(value: unknown) => changeResolution(detailMerge, mapping, value)"
                    />
                  </div>
                  <div
                    v-if="mapping.resolution === 'cast' && mapping.targetType === 'enum'"
                    class="enum-map"
                  >
                    <p>字符串取值 → 枚举值</p>
                    <div v-for="(row, rowIndex) in mapping.valueMapping" :key="rowIndex" class="enum-row">
                      <t-input
                        v-model="row.from"
                        size="small"
                        placeholder="旧字符串，如 success / 成功"
                        :disabled="!['draft', 'pending'].includes(detailMerge.status)"
                      />
                      <span>→</span>
                      <t-tag size="small" theme="primary" variant="light">{{ row.to }}</t-tag>
                    </div>
                    <t-input
                      v-model="mapping.castNote"
                      size="small"
                      placeholder="转换说明"
                      :disabled="!['draft', 'pending'].includes(detailMerge.status)"
                      @blur="updateValueMapping(detailMerge, mapping)"
                    />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 检查点 -->
        <section v-if="detailMerge.checkpoint || detailMerge.status === 'confirmed'" class="detail-section">
          <h4>写入检查点</h4>
          <div class="steps">
            <div
              v-for="(step, index) in CHECKPOINT_STEPS"
              :key="step"
              class="step"
              :class="{
                done: index < checkpointCurrentIndex(detailMerge),
                running: index === checkpointCurrentIndex(detailMerge) && detailMerge.status === 'confirming',
              }"
            >
              <span>{{ index + 1 }}</span>
              <small>{{ checkpointLabel[step] }}</small>
            </div>
          </div>
        </section>

        <!-- 操作区 -->
        <section v-if="['draft', 'pending', 'confirming'].includes(detailMerge.status)" class="detail-section">
          <h4>确认与中断演练</h4>
          <div class="action-row">
            <t-button
              theme="primary"
              :disabled="detailMerge.blockers.length > 0"
              @click="confirmMerge(detailMerge)"
            >
              {{
                detailMerge.status === 'confirming'
                  ? '从检查点继续执行'
                  : detailMerge.status === 'draft'
                    ? '提交并确认合并'
                    : '确认合并并改读主事件'
              }}
            </t-button>
            <t-select
              v-model="interruptStep"
              size="small"
              style="width: 220px"
              placeholder="（可选）模拟写入中断于"
              :options="CHECKPOINT_STEPS.map((step) => ({ label: checkpointLabel[step], value: step }))"
              clearable
            />
            <t-button variant="outline" @click="confirmMerge(detailMerge, true)">
              <template #icon><RefreshIcon /></template>
              模拟中断后提交
            </t-button>
            <t-button theme="danger" variant="outline" @click="cancelMerge(detailMerge)">撤销申请</t-button>
          </div>
        </section>

        <!-- 对账与恢复 -->
        <section v-if="detailMerge.status === 'confirmed' || detailMerge.status === 'undone'" class="detail-section">
          <h4>对账与恢复</h4>
          <div v-if="detailMerge.status === 'confirmed'" class="reconcile-box">
            <div class="reconcile-form">
              <t-input-number
                v-model="observedRefs"
                size="small"
                :min="0"
                placeholder="看板实际引用数"
              />
              <t-input
                v-model="reconcileNote"
                size="small"
                style="flex: 1"
                placeholder="对账说明，如：旧看板仍读 result 字符串口径"
              />
              <t-button theme="primary" size="small" @click="runReconcile(detailMerge)">执行对账</t-button>
              <t-button theme="danger" variant="outline" size="small" @click="restoreBeforeMerge(detailMerge)">
                <template #icon><RollbackIcon /></template>
                不平，恢复合并前引用
              </t-button>
            </div>
          </div>

          <div v-if="detailMerge.reconciliation" class="recon-result">
            <div class="recon-head">
              <t-tag :theme="detailMerge.reconciliation.balanced ? 'success' : 'danger'" variant="light">
                {{ detailMerge.reconciliation.balanced ? '对账平衡' : '对账不平' }}
              </t-tag>
              <span>
                期望引用 {{ detailMerge.reconciliation.expectedRefs }} ·
                看板实际 {{ detailMerge.reconciliation.observedRefs }}
              </span>
              <t-tag v-if="detailMerge.reconciliation.restored" theme="warning" variant="light">
                合并前引用已恢复
              </t-tag>
            </div>
            <ul v-if="detailMerge.reconciliation.differences.length">
              <li v-for="(difference, index) in detailMerge.reconciliation.differences" :key="index">
                {{ difference }}
              </li>
            </ul>
            <p v-else class="empty-hint">无差异。</p>
            <p v-if="detailMerge.reconciliation.note" class="recon-note">
              说明：{{ detailMerge.reconciliation.note }}
            </p>
            <details>
              <summary>查看留档的历史字段映射（{{ detailMerge.reconciliation.archivedMapping.length }}）</summary>
              <ul class="archived-maps">
                <li v-for="mapping in detailMerge.reconciliation.archivedMapping" :key="mapping.id">
                  {{ mapping.sourceName }}（{{ typeLabel[mapping.sourceType] }}）→
                  {{ mapping.targetName ?? '—' }}（{{ mapping.targetType ? typeLabel[mapping.targetType] : '—' }}）
                  · {{ mapping.resolution || '直接映射' }}
                </li>
              </ul>
            </details>
          </div>
        </section>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.suggestion-panel {
  display: grid;
  gap: 12px;
  padding: 16px 18px;
}

.suggestion-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.suggestion-head p {
  margin: 4px 0 0;
  color: #778294;
  font-size: 12px;
}

.suggestion-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.suggestion-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid #d6deea;
  border-radius: 6px;
  background: #f7f9fc;
  cursor: pointer;
  font-size: 12px;
}

.suggestion-chip:hover {
  border-color: #1264c5;
  background: #eef5ff;
}

.suggestion-chip em {
  margin: 0 4px;
  color: #1264c5;
  font-style: normal;
}

.empty-hint {
  color: #97a1b2;
  font-size: 12px;
}

.board {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
  margin-top: 16px;
  align-items: start;
}

.board-column {
  display: grid;
  gap: 10px;
}

.column-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 0 2px;
}

.column-head strong {
  font-size: 13px;
}

.column-head p {
  margin: 3px 0 0;
  color: #97a1b2;
  font-size: 11px;
}

.column-count {
  display: grid;
  place-items: center;
  min-width: 22px;
  height: 22px;
  border-radius: 11px;
  background: #e6edf7;
  color: #2f4b75;
  font-size: 12px;
}

.column-body {
  display: grid;
  gap: 10px;
  min-height: 60px;
}

.column-empty {
  padding: 18px 0;
  text-align: center;
  color: #aeb8c6;
  font-size: 12px;
}

.merge-card {
  display: grid;
  gap: 8px;
  padding: 14px;
  border-left: 3px solid #c3cede;
}

.merge-card.blocked {
  border-left-color: #e04a4a;
}

.merge-pair {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.merge-pair code {
  color: #97a1b2;
  font-size: 11px;
}

.merge-card h3 {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
}

.merge-source {
  margin: 0;
  color: #5c687a;
  font-size: 12px;
}

.merge-reason {
  margin: 0;
  color: #7b869a;
  font-size: 11px;
}

.mapping-summary {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 11px;
  color: #687386;
}

.mapping-summary li {
  display: flex;
  align-items: center;
  gap: 5px;
}

.mapping-summary .ok {
  color: #1a7f4b;
}

.mapping-summary .bad {
  color: #c42d2d;
  font-weight: 600;
}

.checkpoint-strip,
.confirmed-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  padding: 8px 10px;
  border-radius: 5px;
  font-size: 11px;
}

.checkpoint-strip {
  background: #fff6e8;
  color: #b26a18;
}

.confirmed-strip {
  background: #edf8f1;
  color: #207c4e;
}

.confirmed-strip code {
  padding: 1px 5px;
  border-radius: 3px;
  background: #dcefe4;
}

.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
}

.archive-panel {
  margin-top: 16px;
  padding: 16px 18px;
}

.archive-panel p {
  margin: 5px 0 10px;
  color: #778294;
  font-size: 12px;
}

.archive-panel ul {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.archive-panel li {
  display: flex;
  align-items: center;
  gap: 10px;
}

.link-button {
  border: 0;
  background: none;
  color: #1264c5;
  cursor: pointer;
  font-size: 12px;
}

.editor-form {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}

.field {
  display: grid;
  gap: 6px;
}

.field-wide {
  width: 100%;
}

.field label {
  color: #55607a;
  font-size: 12px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid #e8ebef;
}

.detail {
  display: grid;
  gap: 18px;
}

.version-code {
  margin-left: 8px;
  color: #97a1b2;
  font-size: 11px;
}

.pair-box {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 14px;
}

.pair-event {
  display: grid;
  gap: 5px;
  padding: 12px 14px;
  border-radius: 6px;
}

.pair-event.master {
  background: #edf4ff;
  border: 1px solid #b9d2f5;
}

.pair-event.source {
  background: #fbf3f3;
  border: 1px solid #efc9c9;
}

.pair-event small {
  color: #8a95a8;
}

.pair-icon {
  color: #1264c5;
  font-size: 22px;
}

.detail-section {
  display: grid;
  gap: 10px;
}

.detail-section h4 {
  margin: 0;
  font-size: 13px;
}

.blocker-list {
  display: grid;
  gap: 6px;
}

.blocker-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 5px;
  background: #fdf0f0;
  color: #b3261e;
  font-size: 12px;
}

.all-clear {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 5px;
  background: #edf8f1;
  color: #1a7f4b;
  font-size: 12px;
}

.mapping-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.mapping-table th {
  padding: 8px;
  text-align: left;
  color: #778294;
  font-weight: 600;
  background: #f6f8fb;
  border-bottom: 1px solid #e4e9f1;
}

.mapping-table td {
  padding: 8px;
  vertical-align: top;
  border-bottom: 1px solid #eef1f5;
}

.target-cell,
.resolution-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 180px;
}

.enum-map {
  display: grid;
  gap: 6px;
  margin-top: 8px;
  padding: 8px;
  border-radius: 5px;
  background: #f7f9fc;
}

.enum-map p {
  margin: 0;
  color: #778294;
  font-size: 11px;
}

.enum-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 8px;
}

.steps {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
}

.step {
  display: grid;
  justify-items: center;
  gap: 6px;
  text-align: center;
}

.step span {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #e4e9f1;
  color: #7b869a;
  font-size: 12px;
}

.step small {
  color: #97a1b2;
  font-size: 10px;
}

.step.done span {
  background: #2ba471;
  color: #fff;
}

.step.running span {
  background: #e8a23d;
  color: #fff;
}

.action-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.reconcile-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.recon-result {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: 6px;
  background: #f7f9fc;
  font-size: 12px;
}

.recon-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.recon-result ul {
  margin: 0;
  padding-left: 18px;
  color: #b3261e;
}

.recon-note {
  color: #687386;
}

.archived-maps {
  margin-top: 6px;
  padding-left: 18px;
  color: #5c687a;
}
</style>
