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
  keyAliases?: string[]
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
  mergedIntoEventId?: string
  updatedAt: string
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

export type MergeStatus = 'draft' | 'pending' | 'confirming' | 'confirmed' | 'undone'
export type MappingStatus = 'auto' | 'type_conflict' | 'resolved' | 'dropped'
export type MergeResolution = 'cast' | 'drop' | ''
export type MergeBlockerKind = 'type_conflict' | 'mapping_cycle' | 'unmapped_source'
export type MergeCheckpointStep = 'backup' | 'aliases' | 'rewrite_refs' | 'scenarios' | 'source_retire' | 'finalize'

export interface MergeFieldMapping {
  id: string
  sourcePropertyId: string
  sourceName: string
  sourceType: PropertyType
  targetPropertyId: string | null
  targetName: string | null
  targetType: PropertyType | null
  matchBasis: 'name' | 'synonym' | 'lineage' | 'manual' | 'none'
  status: MappingStatus
  resolution: MergeResolution
  valueMapping: Array<{ from: string; to: string }>
  castNote: string
  note: string
}

export interface MergeBlocker {
  kind: MergeBlockerKind
  mappingId?: string
  message: string
}

export interface MergeCheckpoint {
  step: MergeCheckpointStep
  done: boolean
  startedAt: string
  finishedAt?: string
}

export interface MergeReferenceBackup {
  events: EventDefinition[]
  dependencies: DownstreamDependency[]
  scenarios: BusinessScenario[]
  savedAt: string
}

export interface MergeReconciliation {
  id: string
  checkedAt: string
  operator: string
  expectedRefs: number
  observedRefs: number
  balanced: boolean
  differences: string[]
  archivedMapping: MergeFieldMapping[]
  restored: boolean
  note: string
}

export interface EventMerge {
  id: string
  pairKey: string
  masterEventId: string
  sourceEventId: string
  status: MergeStatus
  reason: string
  operator: string
  version: number
  mappings: MergeFieldMapping[]
  blockers: MergeBlocker[]
  affectedDependencyIds: string[]
  checkpoint?: MergeCheckpoint
  backup?: MergeReferenceBackup
  reconciliation?: MergeReconciliation
  createdAt: string
  updatedAt: string
  confirmedAt?: string
  undoneAt?: string
}

export interface GovernanceState {
  events: EventDefinition[]
  scenarios: BusinessScenario[]
  dependencies: DownstreamDependency[]
  baselines: EventVersionSnapshot[]
  releases: ReleaseCandidate[]
  deprecations: DeprecationPlan[]
  rollbacks: RollbackRecord[]
  merges: EventMerge[]
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
