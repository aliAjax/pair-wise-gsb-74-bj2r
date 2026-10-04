import type { GovernanceState } from '@/models/domain'
import { createSeedState } from '@/models/seed'

const STORAGE_KEY = 'eventrail-governance-v2'
const LEGACY_STORAGE_KEY = 'eventrail-governance-v1'

/** 结构化克隆并补齐新版本字段，兼容旧浏览器数据 */
const upgrade = (raw: unknown): GovernanceState => {
  const state = structuredClone(raw) as GovernanceState
  state.merges ??= []
  state.rollbacks ??= []
  state.deprecations ??= []
  return state
}

export const loadState = (): GovernanceState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      return upgrade(JSON.parse(raw))
    } catch {
      // 落到下面的种子逻辑
    }
  }
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
  if (legacy) {
    try {
      const migrated = upgrade(JSON.parse(legacy))
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated))
      return migrated
    } catch {
      // 旧数据损坏时回退种子
    }
  }
  const seed = createSeedState()
  localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
  return seed
}

export const saveState = (state: GovernanceState): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(structuredClone(state)))
}

export const resetState = (): GovernanceState => {
  const seed = createSeedState()
  saveState(seed)
  return seed
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/**
 * 跨窗口并发：同源其它标签页写入后本窗口收到 storage 事件。
 * 返回取消订阅函数。
 */
export const onExternalStateChange = (listener: (state: GovernanceState) => void): (() => void) => {
  const handler = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    try {
      listener(upgrade(JSON.parse(event.newValue)))
    } catch {
      // 忽略无法解析的外部写入
    }
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}
