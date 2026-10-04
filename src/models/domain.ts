export type Platform = 'web' | 'ios' | 'android' | 'server' | 'miniprogram'
export type EventStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'deprecated' | 'retired'
export type PropertyType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum'
export type ReleaseStatus = 'draft' | 'reviewing' | 'approved' | 'published' | 'rolled_back'
export type Severity = 'critical' | 'high' | 'medium' | 'low'

export interface EventProperty {
  id: string
  eventId: string
  name: string
  displayName: string
  type: PropertyType
  required: boolean
  description: string
  enumValues: string[]
  owner: string
  synonyms: string[]
  platforms: Platform[]
  lineageSourceId?: string
  deletedAt?: string
  /** 合并后由旧字段名转来的读时别名 */
  mergeAliases?: string[]
}

export interface PlatformRule {
  id: string
  eventId: string
  platform: Platform
  enabled: boolean
  trigger: string
  owner: string
  requiredPropertyIds: string[]
  note: string
}

export interface EventDefinition {
  id: string
  key: string
  displayName: string
  category: string
  description: string
  trigger: string
  status: EventStatus
  version: string
  owner: string
  properties: EventProperty[]
  platformRules: PlatformRule[]
  scenarioIds: string[]
  downstreamDependencyIds: string[]
  updatedAt: string
  /** 合并后指向主事件 id；看板与查询经此改读主事件 */
  mergedIntoId?: string
  /** 合并后保留的旧事件 key 别名（按时间顺序保留历史合并来源） */
  mergedKeyAliases?: MergeKeyAlias[]
}

export interface BusinessScenario {
  id: string
  name: string
  domain: string
  owner: string
  platform: Platform
  eventIds: string[]
  status: 'active' | 'migrating' | 'retired'
}

export interface DownstreamDependency {
  id: string
  name: string
  type: 'dashboard' | 'alert' | 'model' | 'dataset' | 'experiment'
  owner: string
  environment: 'production' | 'staging' | 'analysis'
  eventIds: string[]
  propertyRefs: Array<{ eventId: string; propertyId: string }>
  status: 'active' | 'migration_required' | 'migrated' | 'disabled'
}

export interface EventVersionSnapshot {
  id: string
  eventId: string
  version: string
  properties: EventProperty[]
  createdAt: string
  status: 'published' | 'superseded'
}

export interface ContractDifference {
  eventId: string
  eventKey: string
  addedProperties: string[]
  removedProperties: string[]
  requiredChanges: string[]
  typeChanges: string[]
  enumChanges: string[]
}

export interface MigrationConfirmation {
  id: string
  dependencyId: string
  version: string
  status: 'pending' | 'confirmed' | 'rejected'
  reviewer: string
  note: string
  confirmedAt?: string
}

export interface ReleaseApproval {
  id: string
  role: 'data' | 'product' | 'client' | 'qa'
  actor: string
  status: 'pending' | 'approved' | 'rejected'
  comment: string
  createdAt?: string
}

export interface ReleaseCandidate {
  id: string
  version: string
  title: string
  status: ReleaseStatus
  eventIds: string[]
  affectedDependencyIds: string[]
  differences: ContractDifference[]
  migrationConfirmations: MigrationConfirmation[]
  approvals: ReleaseApproval[]
  createdAt: string
  publishedAt?: string
}

export interface DeprecationPlan {
  id: string
  eventId: string
  replacementEventId?: string
  reason: string
  owner: string
  stopCollectAt: string
  retireAt: string
  status: 'planned' | 'announced' | 'stopped' | 'retired' | 'cancelled'
  migrationNote: string
}

export interface RollbackRecord {
  id: string
  releaseId: string
  version: string
  reason: string
  operator: string
  scope: string
  createdAt: string
  status: 'executed' | 'verified'
  evidence: string
}

export interface AuditEvent {
  id: string
  entityType: string
  entityId: string
  action: string
  actor: string
  detail: string
  createdAt: string
}

/** 主事件保留的旧键别名 */
export interface MergeKeyAlias {
  aliasKey: string
  sourceEventId: string
  mergedAt: string
}

/** 字段映射：待合并事件字段 -> 主事件字段 */
export interface MergeFieldMapping {
  id: string
  sourceEventId: string
  sourcePropertyId: string
  sourceName: string
  sourceType: PropertyType
  targetEventId: string
  targetPropertyId: string
  targetName: string
  targetType: PropertyType
  matchReason: string
  /** 存在同名但类型不一致等冲突，需人工处理 */
  conflict: boolean
  conflictReason?: string
  /** 映射在图上成环，需人工处理 */
  cycle: boolean
  /** 是否纳入本次切换（冲突字段默认排除） */
  selected: boolean
  /** 双向回填：同时建立 主字段 -> 旧字段 的反向映射，两侧均开启时会构成环 */
  backfill?: boolean
  valueTransform?: string
}

/** 受影响的看板/查询/下游引用 */
export interface MergeReference {
  dependencyId: string
  dependencyName: string
  dependencyType: DownstreamDependency['type']
  sourceEventId: string
  sourcePropertyIds: string[]
  targetEventId: string
  targetPropertyIds: string[]
  /** 因冲突未切换或被放弃、将从引用中移除的旧字段名 */
  droppedPropertyNames: string[]
}

/** 切换写入检查点，支持中断后继续 */
export type MergeCheckpointPhase =
  | 'prepared'
  | 'alias_written'
  | 'dependencies_rewritten'
  | 'scenarios_rewritten'
  | 'releases_rewritten'
  | 'event_retired'
  | 'completed'

export interface MergeCheckpoint {
  phase: MergeCheckpointPhase
  updatedAt: string
  note: string
}

/** 合并对账差异 */
export interface MergeReconcileDiff {
  id: string
  kind: 'reference_lost' | 'reference_count' | 'alias_missing' | 'event_missing'
  detail: string
}

export type MergeStatus = 'pending' | 'switching' | 'merged' | 'reverting' | 'reverted' | 'conflict'

export interface EventMergeRecord {
  id: string
  /** 规范化事件对标识，同一对事件只生成一份记录 */
  pairKey: string
  primaryEventId: string
  sourceEventId: string
  status: MergeStatus
  reason: string
  operator: string
  createdAt: string
  updatedAt: string
  mappings: MergeFieldMapping[]
  references: MergeReference[]
  /** 停待处理原因（类型冲突 / 映射成环） */
  blockingReasons: string[]
  /** 乐观并发版本：提交/撤销冲突时后到方看到 conflict */
  version: number
  checkpoint?: MergeCheckpoint
  confirmedAt?: string
  /** 合并前引用快照，对账不平时用于恢复 */
  preMergeSnapshot?: {
    primaryEvent: EventDefinition
    sourceEvent: EventDefinition
    dependencies: DownstreamDependency[]
    scenarios: BusinessScenario[]
    releases: ReleaseCandidate[]
  }
  reconcile?: {
    checkedAt: string
    balanced: boolean
    diffs: MergeReconcileDiff[]
    historicalMappings: MergeFieldMapping[]
  }
  revertedAt?: string
  revertReason?: string
}

export interface GovernanceState {
  events: EventDefinition[]
  scenarios: BusinessScenario[]
  dependencies: DownstreamDependency[]
  baselines: EventVersionSnapshot[]
  releases: ReleaseCandidate[]
  deprecations: DeprecationPlan[]
  rollbacks: RollbackRecord[]
  merges: EventMergeRecord[]
  audit: AuditEvent[]
  currentVersion: string
}

export interface ValidationIssue {
  id: string
  kind:
    | 'duplicate_event'
    | 'synonym_property'
    | 'naming_violation'
    | 'type_change'
    | 'deleted_property_referenced'
    | 'required_mismatch'
  severity: Severity
  title: string
  detail: string
  entityId: string
  suggestion: string
}

export interface SampleValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}
