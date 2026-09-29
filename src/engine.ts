import type {
  BatchDeferral,
  BatchGroup,
  BatchPlan,
  ChecklistItem,
  ChecklistProject,
  DependencyBlocker
} from './types';

export interface GraphInput {
  stages: ChecklistProject['stages'];
  items: ChecklistItem[];
}

interface GraphData {
  stageOrder: Map<string, number>;
  /** 正向依赖：item -> 它依赖的前置项 */
  deps: Map<string, string[]>;
  /** 反向引用：item -> 依赖它的后续项 */
  dependents: Map<string, Set<string>>;
  /** (stageId,order) 定位 */
  position: Map<string, { stageOrder: number; order: number }>;
  itemById: Map<string, ChecklistItem>;
}

const buildGraph = (input: GraphInput): GraphData => {
  const stageOrder = new Map(input.stages.map((stage) => [stage.id, stage.order]));
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  const deps = new Map<string, string[]>();
  const dependents = new Map<string, Set<string>>();
  const position = new Map<string, { stageOrder: number; order: number }>();

  input.items.forEach((item) => {
    deps.set(item.id, item.preconditionIds.filter((id, index, all) => all.indexOf(id) === index));
    position.set(item.id, { stageOrder: stageOrder.get(item.stageId) ?? Number.MAX_SAFE_INTEGER, order: item.order });
  });
  deps.forEach((preIds, itemId) => {
    preIds.forEach((preId) => {
      if (!dependents.has(preId)) dependents.set(preId, new Set());
      dependents.get(preId)!.add(itemId);
    });
  });
  return { stageOrder, deps, dependents, position, itemById };
};

/** 判断 a 是否排在 b 之前（先比阶段，再比阶段内顺序） */
const isBefore = (graph: GraphData, aId: string, bId: string): boolean => {
  const a = graph.position.get(aId);
  const b = graph.position.get(bId);
  if (!a || !b) return false;
  return a.stageOrder < b.stageOrder || (a.stageOrder === b.stageOrder && a.order < b.order);
};

/** 找出所有有环依赖：DFS 三色标记，环上成员全部标 root/cycle */
const findCycles = (graph: GraphData): Set<string> => {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const onCycle = new Set<string>();
  graph.deps.forEach((_, id) => color.set(id, WHITE));

  const stack: string[] = [];
  const dfs = (start: string) => {
    // 显式栈 DFS，避免深链递归爆栈
    interface Frame { id: string; nextDep: number }
    const frames: Frame[] = [{ id: start, nextDep: 0 }];
    color.set(start, GRAY);
    stack.push(start);

    while (frames.length) {
      const frame = frames[frames.length - 1];
      const preIds = graph.deps.get(frame.id) ?? [];
      if (frame.nextDep >= preIds.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        frames.pop();
        continue;
      }
      const depId = preIds[frame.nextDep];
      frame.nextDep += 1;
      if (!graph.deps.has(depId)) continue; // 缺失引用另行处理
      if (depId === frame.id) continue; // 自环由 self 规则专门处理
      if (color.get(depId) === GRAY) {
        const cycleStart = stack.indexOf(depId);
        for (let i = cycleStart; i < stack.length; i += 1) onCycle.add(stack[i]);
        continue;
      }
      if (color.get(depId) === WHITE) {
        color.set(depId, GRAY);
        stack.push(depId);
        frames.push({ id: depId, nextDep: 0 });
      }
    }
  };

  graph.deps.forEach((_, id) => { if (color.get(id) === WHITE) dfs(id); });
  return onCycle;
};

/**
 * 计算可执行批次。
 *
 * 规则：
 * - 批次按阶段顺序展开，阶段内再按前置依赖分层；
 * - 同一阶段内互不依赖（且其前置都已完成）的项进入同一批；
 * - 前置在更早阶段时不增加本阶段层级；
 * - 自引用、缺失引用、循环、倒序依赖一律 root 阻断；
 * - 依赖链上任何被阻断的项都会让下游 cascade 阻断；
 * - 显式依赖与阶段顺序冲突时（倒序），该项被阻断并在 deferrals 中标出原因。
 */
export function computeBatchPlan(input: GraphInput, computedAt = new Date().toISOString()): BatchPlan {
  const graph = buildGraph(input);
  const blocked: DependencyBlocker[] = [];
  const blockedSet = new Set<string>();
  const rootBlocked = new Set<string>();
  const addBlocker = (itemId: string, blocker: Omit<DependencyBlocker, 'itemId'>) => {
    blocked.push({ itemId, ...blocker });
    blockedSet.add(itemId);
    if (blocker.kind === 'root') rootBlocked.add(itemId);
  };

  const label = (id: string) => graph.itemById.get(id)?.challenge || id;

  // 1) 自引用与缺失引用
  graph.deps.forEach((preIds, itemId) => {
    preIds.forEach((preId) => {
      if (preId === itemId) {
        addBlocker(itemId, { type: 'self', kind: 'root', detail: '检查项不能把自身作为前置条件。', refId: preId });
      } else if (!graph.deps.has(preId)) {
        addBlocker(itemId, { type: 'missing', kind: 'root', detail: `前置条件 “${preId}” 已被删除或不存在，依赖链断裂。`, refId: preId });
      }
    });
  });

  // 2) 循环：先于倒序判定，环成员以循环为根本原因
  const cycleMembers = findCycles(graph);
  cycleMembers.forEach((id) => {
    addBlocker(id, { type: 'cycle', kind: 'root', detail: '前置条件构成循环依赖，无法确定执行先后。' });
  });

  // 3) 倒序依赖：前置排在自身之后（跨阶段或同阶段后置）；环成员不再重复定性
  graph.deps.forEach((preIds, itemId) => {
    if (rootBlocked.has(itemId)) return;
    preIds.forEach((preId) => {
      if (preId === itemId || !graph.deps.has(preId) || rootBlocked.has(preId)) return;
      if (!isBefore(graph, preId, itemId)) {
        const pre = graph.itemById.get(preId);
        const cur = graph.itemById.get(itemId)!;
        const reverseStage = pre && cur && pre.stageId !== cur.stageId;
        addBlocker(itemId, {
          type: 'reverse',
          kind: 'root',
          refId: preId,
          detail: reverseStage
            ? `前置 “${label(preId)}” 位于更晚阶段，阶段顺序下无法先满足，需调整顺序或移除该依赖。`
            : `前置 “${label(preId)}” 排在 “${label(itemId)}” 之后，已按依赖关系推迟失败并阻断。`
        });
      }
    });
  });

  // 4) 级联污染：沿反向边传播阻断（不把环内传播算作 cascade）
  const queue = [...blockedSet];
  while (queue.length) {
    const current = queue.shift()!;
    (graph.dependents.get(current) ?? []).forEach((downId) => {
      if (blockedSet.has(downId)) return;
      addBlocker(downId, {
        type: graph.itemById.get(current) ? 'reverse' : 'missing',
        kind: 'cascade',
        refId: current,
        detail: `前置 “${label(current)}” 已被阻断，“${label(downId)}” 的结果不可信，随之间接失效。`
      });
      queue.push(downId);
    });
  }

  // 5) 分层：仅未阻断项参与。先按阶段顺序、阶段内 order 给稳定序列，
  //    layer(item) = 0（无同阶段有效前置）或 max(layer(同阶段前置)) + 1
  const itemLayer: Record<string, number> = {};
  const sortedItems = input.items
    .filter((it) => !blockedSet.has(it.id))
    .sort((a, b) => {
      const pa = graph.position.get(a.id)!;
      const pb = graph.position.get(b.id)!;
      return pa.stageOrder - pb.stageOrder || pa.order - pb.order || a.id.localeCompare(b.id);
    });

  sortedItems.forEach((item) => {
    let layer = 0;
    (graph.deps.get(item.id) ?? []).forEach((preId) => {
      const pre = graph.itemById.get(preId);
      if (!pre || blockedSet.has(preId)) return; // 阻断前置已在上面处理
      if (pre.stageId === item.stageId) layer = Math.max(layer, (itemLayer[preId] ?? 0) + 1);
      // 跨阶段前置：其所在阶段更早，不增加本阶段内层级
    });
    itemLayer[item.id] = layer;
  });

  // 6) 组批：阶段顺序 × 阶段内层。批次全局连续编号
  const stagesSorted = input.stages.slice().sort((a, b) => a.order - b.order);
  const batches: BatchGroup[] = [];
  const itemBatch: Record<string, number> = {};
  let batchNo = 0;
  stagesSorted.forEach((stage) => {
    const byLayer = new Map<number, string[]>();
    sortedItems
      .filter((item) => item.stageId === stage.id)
      .forEach((item) => {
        const layer = itemLayer[item.id];
        if (!byLayer.has(layer)) byLayer.set(layer, []);
        byLayer.get(layer)!.push(item.id);
      });
    [...byLayer.keys()].sort((a, b) => a - b).forEach((layer) => {
      const ids = byLayer.get(layer)!.sort((a, b) => {
        const oa = graph.itemById.get(a)!.order;
        const ob = graph.itemById.get(b)!.order;
        return oa - ob || a.localeCompare(b);
      });
      batchNo += 1;
      ids.forEach((id) => { itemBatch[id] = batchNo; });
      batches.push({ batch: batchNo, stageId: stage.id, itemIds: ids });
    });
  });

  // 7) 推迟说明：同层分组时跨阶段依赖已天然满足；记录所有有效依赖边供 UI 解释
  const deferrals: BatchDeferral[] = [];
  graph.deps.forEach((preIds, itemId) => {
    if (blockedSet.has(itemId)) return;
    preIds.forEach((preId) => {
      if (!graph.deps.has(preId) || blockedSet.has(preId)) return;
      const pre = graph.itemById.get(preId)!;
      const cur = graph.itemById.get(itemId)!;
      if (pre.stageId === cur.stageId && itemBatch[preId] === itemBatch[itemId]) {
        // 同阶段同层不可能存在依赖边，出现说明分层异常——防御性记录
        deferrals.push({ itemId, preconditionId: preId, reason: '依赖项未按预期提前一层，请检查排序。' });
      }
    });
  });

  return {
    computedAt,
    batches,
    itemBatch,
    blocked,
    deferrals,
    itemLayer,
    blockersCount: blocked.length,
    batchesCount: batches.length
  };
}

/**
 * 传递影响闭包：一个值变化时，返回直接 + 间接依赖它的全部检查项。
 * 阻断项同样向下游传播（其旧结果必须一并失效）。
 */
export function affectedClosure(graph: GraphInput, changedIds: string[]): string[] {
  const data = buildGraph(graph);
  const affected = new Set<string>();
  const queue = changedIds.filter((id) => data.deps.has(id));
  while (queue.length) {
    const current = queue.shift()!;
    (data.dependents.get(current) ?? []).forEach((downId) => {
      if (!affected.has(downId)) {
        affected.add(downId);
        queue.push(downId);
      }
    });
  }
  return [...affected];
}

/** 直接受影响（仅一跳） */
export function directDependents(graph: GraphInput, changedIds: string[]): string[] {
  const data = buildGraph(graph);
  const direct = new Set<string>();
  changedIds.forEach((id) => (data.dependents.get(id) ?? []).forEach((down) => direct.add(down)));
  return [...direct];
}
