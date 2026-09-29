export type WorkflowStatus = 'draft' | 'review' | 'frozen';
export type IssueLevel = 'error' | 'warning' | 'info';
export type IssueType =
  | 'duplicate'
  | 'missing-response'
  | 'unreachable-precondition'
  | 'dependency-cycle'
  | 'stage-order'
  | 'orphan-stage';

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

/** 阻断原因：自引用 / 缺失引用 / 循环 / 倒序依赖 / 被阻断项间接污染 */
export type BlockerType = 'self' | 'missing' | 'cycle' | 'reverse';

export interface DependencyBlocker {
  itemId: string;
  type: BlockerType;
  /** root：直接违规；cascade：沿依赖链被上游阻断项污染 */
  kind: 'root' | 'cascade';
  detail: string;
  /** 违规所涉及的对方（缺失的 id、循环成员等） */
  refId?: string;
}

export interface BatchDeferral {
  itemId: string;
  preconditionId: string;
  reason: string;
}

export interface BatchGroup {
  /** 全局批次序号，从 1 开始；跨阶段不共享批次 */
  batch: number;
  stageId: string;
  itemIds: string[];
}

export interface BatchPlan {
  /** 冻结或核对时的时间戳，草稿计划不含该字段 */
  computedAt: string;
  batches: BatchGroup[];
  itemBatch: Record<string, number>;
  blocked: DependencyBlocker[];
  deferrals: BatchDeferral[];
  /** 阶段内按依赖分层的层级（用于“同批可并行”的解释） */
  itemLayer: Record<string, number>;
  blockersCount: number;
  batchesCount: number;
}

export interface ChecklistRevision {
  id: string;
  revision: number;
  status: WorkflowStatus;
  createdAt: string;
  note: string;
  stages: FlightStage[];
  items: ChecklistItem[];
  /** 冻结当时保存的批次，之后草稿修改不会回写旧版本 */
  batchPlan?: BatchPlan;
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

/** v1 本地存档形状，升级时使用 */
export interface WorkspaceStateV1 {
  schemaVersion: 1;
  selectedProjectId: string;
  projects: Array<Omit<ChecklistProject, 'revisions'> & { revisions: Array<Omit<ChecklistRevision, 'batchPlan'>> }>;
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
