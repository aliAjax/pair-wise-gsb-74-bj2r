<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  value: string
}>()

const labels: Record<string, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  draft: '草稿',
  reviewing: '评审中',
  approved: '已通过',
  published: '已发布',
  deprecated: '已废弃',
  retired: '已停用',
  active: '启用',
  migrating: '迁移中',
  migration_required: '待迁移',
  migrated: '已迁移',
  disabled: '已禁用',
  pending: '待处理',
  confirmed: '已确认',
  rejected: '已驳回',
  planned: '已计划',
  announced: '已公告',
  stopped: '已停采',
  cancelled: '已取消',
  executing: '执行中',
  executed: '已执行',
  verified: '已验证',
  rolled_back: '已回滚',
  merge_draft: '草稿',
  merge_pending: '待处理',
  merge_confirming: '确认中断',
  merge_confirmed: '已合并',
  merge_undone: '已撤销',
  confirming: '确认中断',
  undone: '已撤销',
  map_auto: '自动匹配',
  map_type_conflict: '类型冲突',
  map_resolved: '已处置',
  map_dropped: '丢弃',
  auto: '自动匹配',
  type_conflict: '类型冲突',
  resolved: '已处置',
  dropped: '丢弃',
  duplicate_event: '重复事件',
  synonym_property: '同义属性',
  naming_violation: '命名问题',
  type_change: '类型变化',
  deleted_property_referenced: '删除字段引用',
  required_mismatch: '必填差异',
}

const theme = computed(() => {
  const themes: Record<string, 'default' | 'primary' | 'success' | 'warning' | 'danger'> = {
    critical: 'danger',
    rejected: 'danger',
    retired: 'danger',
    deleted_property_referenced: 'danger',
    high: 'warning',
    reviewing: 'warning',
    migration_required: 'warning',
    pending: 'warning',
    deprecated: 'warning',
    type_change: 'warning',
    duplicate_event: 'warning',
    medium: 'warning',
    approved: 'success',
    published: 'success',
    active: 'success',
    migrated: 'success',
    confirmed: 'success',
    verified: 'success',
    low: 'success',
    draft: 'default',
    disabled: 'default',
    planned: 'primary',
    announced: 'primary',
    migrating: 'primary',
    executing: 'primary',
    confirm: 'primary',
    confirming: 'warning',
    type_conflict: 'danger',
    resolved: 'success',
    auto: 'primary',
    dropped: 'default',
    undone: 'default',
  }
  return themes[props.value] ?? 'default'
})
</script>

<template>
  <t-tag :theme="theme" variant="light">
    {{ labels[value] ?? value }}
  </t-tag>
</template>
