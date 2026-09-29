import type {
  Batch,
  BatchItem,
  BatchPlan,
  BatchSnapshot,
  BlockingIssue,
  ChecklistItem,
  ChecklistProject,
  DeferralReason,
  WorkspaceState
} from './types';

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Compute the executable batch plan for a checklist project.
 *
 * Batches are produced by a level-based topological sort that respects both
 * stage order and explicit preconditions:
 *
 *   level(item) = max(stageOrder(item), 1 + max(level(pre) for pre in valid preconditions))
 *
 * Items that share a level can execute in the same batch. Items whose level
 * exceeds their natural stage order are deferred (with a recorded reason).
 *
 * Blocking issues (cycles, self-references, missing references, reverse-order
 * dependencies) prevent batch computation entirely.
 */
export function computeBatchPlan(
  project: ChecklistProject,
  invalidated: Set<string> = new Set(),
  generation = 0
): BatchPlan {
  const itemById = new Map(project.items.map((item) => [item.id, item]));
  const stageById = new Map(project.stages.map((stage) => [stage.id, stage]));

  const blocking: BlockingIssue[] = [];
  const deferrals: DeferralReason[] = [];

  // 1. Validate preconditions and build the valid dependency graph.
  const validPreconditions = new Map<string, string[]>();
  for (const item of project.items) {
    const valid: string[] = [];
    for (const preId of item.preconditionIds) {
      if (preId === item.id) {
        blocking.push({
          id: `${item.id}-self`,
          type: 'self-reference',
          itemId: item.id,
          stageId: item.stageId,
          title: '自引用前置条件',
          detail: `「${item.challenge || '未命名检查项'}」不能依赖自身。`
        });
        continue;
      }
      const pre = itemById.get(preId);
      if (!pre) {
        blocking.push({
          id: `${item.id}-${preId}-missing`,
          type: 'missing-reference',
          itemId: item.id,
          stageId: item.stageId,
          relatedItemId: preId,
          title: '前置条件已删除',
          detail: `「${item.challenge || '未命名检查项'}」引用了不存在的检查项。`
        });
        continue;
      }
      const itemStage = stageById.get(item.stageId);
      const preStage = stageById.get(pre.stageId);
      if (!itemStage || !preStage) continue;
      const isReverse =
        preStage.order > itemStage.order ||
        (preStage.order === itemStage.order && pre.order > item.order);
      if (isReverse) {
        blocking.push({
          id: `${item.id}-${preId}-reverse`,
          type: 'reverse-order',
          itemId: item.id,
          stageId: item.stageId,
          relatedItemId: preId,
          title: '倒序依赖',
          detail: `「${item.challenge || '未命名检查项'}」依赖的「${pre.challenge || '未命名'}」排在其后，无法先满足。`
        });
        continue;
      }
      valid.push(preId);
    }
    validPreconditions.set(item.id, valid);
  }

  // 2. Detect cycles among valid preconditions.
  const cycleItemIds = detectCycleItems(project.items, validPreconditions);
  for (const itemId of cycleItemIds) {
    const item = itemById.get(itemId);
    blocking.push({
      id: `${itemId}-cycle`,
      type: 'cycle',
      itemId,
      stageId: item?.stageId ?? '',
      title: '循环依赖',
      detail: `「${item?.challenge ?? itemId}」处于循环依赖中，无法确定执行顺序。`
    });
  }

  // 3. Compute batches via level-based topological sort.
  let batches: Batch[] = [];
  if (blocking.length === 0) {
    const levels = new Map<string, number>();
    const computeLevel = (itemId: string, stack: Set<string>): number => {
      if (levels.has(itemId)) return levels.get(itemId)!;
      if (stack.has(itemId)) return 0; // cycle guard (shouldn't trigger after cycle check)
      stack.add(itemId);
      const item = itemById.get(itemId)!;
      const stage = stageById.get(item.stageId)!;
      let level = stage.order;
      for (const preId of validPreconditions.get(itemId) ?? []) {
        const preLevel = computeLevel(preId, stack);
        level = Math.max(level, preLevel + 1);
      }
      stack.delete(itemId);
      levels.set(itemId, level);
      return level;
    };
    for (const item of project.items) computeLevel(item.id, new Set());

    const byLevel = new Map<number, BatchItem[]>();
    for (const item of project.items) {
      const level = levels.get(item.id)!;
      const stage = stageById.get(item.stageId)!;
      const batchItem: BatchItem = {
        itemId: item.id,
        stageId: item.stageId,
        stageOrder: stage.order,
        naturalBatch: stage.order,
        actualBatch: level,
        deferred: level > stage.order
      };
      if (level > stage.order) {
        const pres = validPreconditions.get(item.id) ?? [];
        const sameStagePres = pres.filter((preId) => itemById.get(preId)?.stageId === item.stageId);
        const kind: DeferralReason['kind'] =
          sameStagePres.length > 0 ? 'depends-on-same-stage' : 'depends-on-deferred';
        const preNames = pres.map((preId) => itemById.get(preId)?.challenge || '未命名').join('、');
        batchItem.deferralDetail = `依赖 ${preNames}，推迟到第 ${level + 1} 批`;
        deferrals.push({
          itemId: item.id,
          stageId: item.stageId,
          kind,
          dependsOn: pres,
          detail: `「${item.challenge || '未命名检查项'}」因依赖 ${preNames} 推迟到第 ${level + 1} 批。`
        });
      }
      byLevel.set(level, [...(byLevel.get(level) ?? []), batchItem]);
    }

    const sortedLevels = [...byLevel.keys()].sort((a, b) => a - b);
    batches = sortedLevels.map((level, index) => ({
      index,
      items: (byLevel.get(level) ?? []).sort((a, b) => {
        const sa = stageById.get(a.stageId)?.order ?? 0;
        const sb = stageById.get(b.stageId)?.order ?? 0;
        return sa - sb || a.itemId.localeCompare(b.itemId);
      })
    }));
  }

  return {
    batches,
    blocking,
    deferrals,
    invalidated: [...invalidated],
    computedAt: new Date().toISOString(),
    generation
  };
}

/**
 * Detect items that participate in a cycle using DFS.
 * Returns the set of item IDs that are part of (or reachable from) a cycle.
 */
function detectCycleItems(
  items: ChecklistItem[],
  validPreconditions: Map<string, string[]>
): Set<string> {
  const inCycle = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();

  const dfs = (itemId: string, path: string[]): void => {
    const current = state.get(itemId);
    if (current === 'done') return;
    if (current === 'visiting') {
      const cycleStart = path.indexOf(itemId);
      for (let i = cycleStart; i < path.length; i++) inCycle.add(path[i]);
      inCycle.add(itemId);
      return;
    }
    state.set(itemId, 'visiting');
    for (const preId of validPreconditions.get(itemId) ?? []) {
      dfs(preId, [...path, itemId]);
    }
    state.set(itemId, 'done');
  };

  for (const item of items) dfs(item.id, []);
  return inCycle;
}

/**
 * Compute the set of item IDs that are directly or indirectly dependent on
 * the given changed items (i.e., the full impact range).
 */
export function computeInvalidated(
  project: ChecklistProject,
  changedItemIds: Set<string>
): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const item of project.items) {
    for (const preId of item.preconditionIds) {
      if (!dependents.has(preId)) dependents.set(preId, []);
      dependents.get(preId)!.push(item.id);
    }
  }
  const invalidated = new Set<string>();
  const queue = [...changedItemIds];
  while (queue.length) {
    const current = queue.shift()!;
    if (invalidated.has(current)) continue;
    invalidated.add(current);
    for (const depId of dependents.get(current) ?? []) {
      if (!invalidated.has(depId)) queue.push(depId);
    }
  }
  return invalidated;
}

/**
 * Build a frozen snapshot of the current batch plan.
 */
export function buildBatchSnapshot(plan: BatchPlan): BatchSnapshot {
  return {
    batches: plan.batches.map((batch) => ({
      index: batch.index,
      itemIds: batch.items.map((item) => item.itemId)
    })),
    blocking: clone(plan.blocking),
    computedAt: plan.computedAt
  };
}

/**
 * Migrate workspace data to the latest schema version.
 *
 * "已有数据升级后先补齐依赖关系，再做全量核对"
 * - Ensure every stage has a numeric order.
 * - Ensure every item has a valid preconditionIds array and numeric order.
 * - Drop precondition references to items that no longer exist.
 *
 * After migration the caller runs full validation (validateProject).
 */
export function migrateWorkspace(
  state: Omit<WorkspaceState, 'schemaVersion'> & { schemaVersion: number }
): WorkspaceState {
  const next = clone(state) as WorkspaceState;
  if (next.schemaVersion < 2) {
    for (const project of next.projects) {
      project.stages.forEach((stage, index) => {
        if (typeof stage.order !== 'number') stage.order = index;
      });
      for (const item of project.items) {
        if (!Array.isArray(item.preconditionIds)) item.preconditionIds = [];
        if (typeof item.order !== 'number') {
          item.order = project.items.filter((entry) => entry.stageId === item.stageId).length;
        }
      }
      const itemIds = new Set(project.items.map((item) => item.id));
      for (const item of project.items) {
        item.preconditionIds = item.preconditionIds.filter((id) => itemIds.has(id));
      }
    }
    next.schemaVersion = 2;
  }
  return next;
}
