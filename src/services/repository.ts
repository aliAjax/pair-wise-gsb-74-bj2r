import type { GovernanceState } from '@/models/domain'
import { createSeedState } from '@/models/seed'

export const STORAGE_KEY = 'eventrail-governance-v1'

/** 旧版本本地状态补齐新增集合，避免合并记录读取为空 */
export const migrateState = (raw: unknown): GovernanceState => {
  const state = raw as GovernanceState
  return {
    ...state,
    merges: Array.isArray(state.merges) ? state.merges : [],
    events: Array.isArray(state.events)
      ? state.events.map((event) => ({ keyAliases: [], ...event }))
      : [],
  }
}

export const loadState = (): GovernanceState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    return migrateState(JSON.parse(raw))
  } catch {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
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

/** 监听其他窗口的写入，用于后到方检测提交/撤销冲突 */
export const onExternalStateChange = (handler: () => void): (() => void) => {
  const listener = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY && event.newValue !== null) handler()
  }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}
