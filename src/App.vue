<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()
let unsubscribe: (() => void) | undefined

const refreshQueries = (): void => {
  void queryClient.invalidateQueries()
}

onMounted(() => {
  // 另一标签页提交/撤销合并后，本窗口同步 Pinia 状态并刷新本地 API 查询缓存
  unsubscribe = store.subscribeExternalChanges()
  window.addEventListener('storage', refreshQueries)
})

onUnmounted(() => {
  unsubscribe?.()
  window.removeEventListener('storage', refreshQueries)
})
</script>

<template>
  <RouterView />
</template>
