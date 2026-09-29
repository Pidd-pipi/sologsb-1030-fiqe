export type WorkflowStatus = 'draft' | 'review' | 'frozen';
export type IssueLevel = 'error' | 'warning' | 'info';
export type IssueType = 'duplicate' | 'missing-response' | 'unreachable-precondition' | 'stage-order' | 'orphan-stage';

// === Batch computation types ===

export type BlockingReason = 'cycle' | 'self-reference' | 'missing-reference' | 'reverse-order';

export interface BlockingIssue {
  id: string;
  type: BlockingReason;
  itemId: string;
  stageId: string;
  relatedItemId?: string;
  title: string;
  detail: string;
}

export type DeferralKind = 'depends-on-same-stage' | 'depends-on-deferred';

export interface DeferralReason {
  itemId: string;
  stageId: string;
  kind: DeferralKind;
  dependsOn: string[];
  detail: string;
}

export interface BatchItem {
  itemId: string;
  stageId: string;
  stageOrder: number;
  naturalBatch: number;
  actualBatch: number;
  deferred: boolean;
  deferralDetail?: string;
}

export interface Batch {
  index: number;
  items: BatchItem[];
}

export interface BatchPlan {
  batches: Batch[];
  blocking: BlockingIssue[];
  deferrals: DeferralReason[];
  invalidated: string[];
  computedAt: string;
  generation: number;
}

export interface BatchSnapshot {
  batches: { index: number; itemIds: string[] }[];
  blocking: BlockingIssue[];
  computedAt: string;
}

export interface FlightStage {
  id: string;
  name: string;
  order: number;
  description: string;
}

export interface ChecklistItem {
  id: string;
  stageId: string;
  order: number;
  challenge: string;
  response: string;
  critical: boolean;
  preconditionIds: string[];
  abnormalProcedure: string;
  updatedAt: string;
}

export interface ChecklistRevision {
  id: string;
  revision: number;
  status: WorkflowStatus;
  createdAt: string;
  note: string;
  stages: FlightStage[];
  items: ChecklistItem[];
  batchSnapshot?: BatchSnapshot;
}

export interface ChecklistProject {
  id: string;
  name: string;
  aircraft: string;
  revision: number;
  status: WorkflowStatus;
  updatedAt: string;
  reviewNote: string;
  stages: FlightStage[];
  items: ChecklistItem[];
  revisions: ChecklistRevision[];
}

export interface WorkspaceState {
  schemaVersion: 2;
  selectedProjectId: string;
  projects: ChecklistProject[];
}

export interface ValidationIssue {
  id: string;
  type: IssueType;
  level: IssueLevel;
  stageId?: string;
  itemId?: string;
  title: string;
  detail: string;
}

export interface VersionOption {
  id: string;
  label: string;
}

export interface DiffEntry {
  type: 'added' | 'removed' | 'changed' | 'stage';
  key: string;
  stage: string;
  before: string;
  after: string;
}
