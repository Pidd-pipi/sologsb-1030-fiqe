import { useEffect, useMemo, useRef, useState } from 'react';
import { affectedClosure, computeBatchPlan } from './engine';
import type { BatchPlan, ChecklistItem, ChecklistProject } from './types';

export type ComputeState = 'queued' | 'computing' | 'fresh' | 'stale' | 'blocked';

export interface ItemExecution {
  itemId: string;
  state: ComputeState;
  batch: number | null;
  layer: number | null;
  result: string;
  computedAt: string | null;
  /** 最近一次成功计算所属的代号；过期代号的异步结果一律丢弃 */
  generation: number;
  staleReason?: string;
}

export interface ExecutionState {
  plan: BatchPlan;
  generation: number;
  running: boolean;
  /** 最近一次编辑直接命中的项 */
  changed: string[];
  /** 直接 + 间接被波及而失效的项 */
  affected: string[];
  items: Record<string, ItemExecution>;
}

const SIGNATURE_FIELDS: Array<keyof ChecklistItem> = ['stageId', 'order', 'challenge', 'response', 'critical', 'preconditionIds', 'abnormalProcedure'];

const signatureOf = (item: ChecklistItem): string =>
  SIGNATURE_FIELDS.map((field) => {
    const value = item[field];
    return Array.isArray(value) ? value.join('>') : String(value);
  }).join('|');

const graphSignature = (project: ChecklistProject): string =>
  JSON.stringify({
    stages: project.stages.map((stage) => [stage.id, stage.order]),
    items: project.items.map((item) => [item.id, signatureOf(item)])
  });

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

interface Entry {
  state: ComputeState;
  result: string;
  computedAt: string | null;
  generation: number;
  staleReason?: string;
}

/**
 * 批次执行编排：
 * - 值变化 → 直接/间接下游全部标记 stale 并按新批次重算；
 * - 每次失效产生新一代号，拖尾到达的旧异步结果一律不得提交；
 * - 阻断项不参与计算，阻断解除（闭包未必能覆盖）时强制重算；
 * - 批次严格顺序推进，同批项并发计算。
 */
export function useExecutionPlan(project: ChecklistProject, options: { stepMs?: number } = {}): ExecutionState {
  const stepMs = options.stepMs ?? 70;
  const plan = useMemo(
    () => computeBatchPlan({ stages: project.stages, items: project.items }),
    [project.stages, project.items]
  );

  const [, forceRender] = useState(0);
  const entriesRef = useRef<Map<string, Entry>>(new Map());
  const generationRef = useRef(0);
  const runningRef = useRef(false);
  const changedRef = useRef<string[]>([]);
  const affectedRef = useRef<string[]>([]);
  const prevSignature = useRef<string>('');
  const prevBlocked = useRef<Set<string>>(new Set());

  useEffect(() => {
    const nextSignature = graphSignature(project);
    const prevItems = new Map(prevSignature.current ? parsePrevItems(prevSignature.current) : []);
    const currentIds = new Set(project.items.map((item) => item.id));

    // 1) 值发生变化的项（含新增、删除）
    const changedIds = project.items
      .filter((item) => {
        const previous = prevItems.get(item.id);
        return previous === undefined || previous !== signatureOf(item);
      })
      .map((item) => item.id);
    const removedIds = [...prevItems.keys()].filter((id) => !currentIds.has(id));

    // 2) 沿依赖边求直接+间接影响闭包
    const closure = new Set(affectedClosure({ stages: project.stages, items: project.items }, changedIds));

    // 3) 阻断集合变化：解除阻断的项必须重算，新阻断的项立即作废
    const nextBlocked = new Set(plan.blocked.map((blocker) => blocker.itemId));
    const unblocked = [...prevBlocked.current].filter((id) => !nextBlocked.has(id) && currentIds.has(id));
    const newlyBlocked = plan.blocked.filter((blocker) => !prevBlocked.current.has(blocker.itemId));

    const invalidated = new Set<string>([...changedIds, ...closure, ...unblocked]);
    const entries = entriesRef.current;

    // 删除项清理
    removedIds.forEach((id) => entries.delete(id));

    // 新项先建条目
    project.items.forEach((item) => {
      if (!entries.has(item.id)) entries.set(item.id, { state: 'queued', result: '', computedAt: null, generation: generationRef.current });
    });

    // 阻断项：作废旧结果（旧结果不得继续显示为有效）
    plan.blocked.forEach((blocker) => {
      const entry = entries.get(blocker.itemId);
      if (entry) {
        entry.state = 'blocked';
        entry.staleReason = blocker.detail;
        entry.result = '';
        entry.computedAt = null;
      }
    });

    // 失效项：保留旧值但标记 stale，直到新批次结果把它替换
    invalidated.forEach((id) => {
      const entry = entries.get(id);
      if (!entry || nextBlocked.has(id)) return;
      entry.state = entry.computedAt ? 'stale' : 'queued';
      entry.staleReason = closure.has(id) && !changedIds.includes(id)
        ? '上游前置项的值已变化，旧结果失效，等待按批次重新核对。'
        : '该项已修改，等待重新计算。';
    });
    newlyBlocked.forEach((blocker) => {
      const entry = entries.get(blocker.itemId);
      if (entry) entry.staleReason = blocker.detail;
    });

    changedRef.current = changedIds;
    affectedRef.current = [...closure].filter((id) => !changedIds.includes(id));
    prevBlocked.current = nextBlocked;
    prevSignature.current = nextSignature;

    // 4) 新一代计算：旧代号拖尾结果在提交点被丢弃
    const generation = ++generationRef.current;
    forceRender((value) => value + 1);

    const run = async () => {
      runningRef.current = true;
      for (const batch of plan.batches) {
        if (generation !== generationRef.current) return; // 已被更新的编辑取代
        const targets = batch.itemIds.filter((id) => {
          const entry = entries.get(id);
          return entry && (entry.state === 'queued' || entry.state === 'stale');
        });
        if (!targets.length) continue;
        targets.forEach((id) => { const entry = entries.get(id)!; entry.state = 'computing'; });
        forceRender((value) => value + 1);

        await Promise.all(targets.map(async (id) => {
          const item = project.items.find((candidate) => candidate.id === id);
          await delay(stepMs); // 模拟核对耗时，用于暴露竞态
          // 提交点：代号过期则丢弃，较早的计算结果绝不允许盖住新状态
          if (generation !== generationRef.current || !item) return { id: null };
          return {
            id,
            result: item.response.trim() ? `批次 ${batch.batch} · 已核对「${item.response.trim()}」` : `批次 ${batch.batch} · 缺少预期回应，无法完成核对`,
            computedAt: new Date().toISOString()
          };
        })).then((outcomes) => {
          if (generation !== generationRef.current) return;
          outcomes.forEach((outcome) => {
            if (!outcome.id) return;
            const entry = entries.get(outcome.id);
            if (!entry || entry.state !== 'computing') return;
            entry.state = 'fresh';
            entry.result = outcome.result;
            entry.computedAt = outcome.computedAt;
            entry.generation = generation;
            entry.staleReason = undefined;
          });
        });
        forceRender((value) => value + 1);
      }
      if (generation === generationRef.current) {
        runningRef.current = false;
        forceRender((value) => value + 1);
      }
    };

    void run();
    return () => { /* generation bump 使在途批次自然失效，无需额外取消 */ };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphSignature(project)]);

  const items: Record<string, ItemExecution> = {};
  project.items.forEach((item) => {
    const entry = entriesRef.current.get(item.id);
    items[item.id] = {
      itemId: item.id,
      state: entry?.state ?? 'queued',
      batch: plan.itemBatch[item.id] ?? null,
      layer: plan.itemLayer[item.id] ?? null,
      result: entry?.result ?? '',
      computedAt: entry?.computedAt ?? null,
      generation: entry?.generation ?? 0,
      staleReason: entry?.staleReason
    };
  });

  return {
    plan,
    generation: generationRef.current,
    running: runningRef.current,
    changed: changedRef.current,
    affected: affectedRef.current,
    items
  };
}

/** 从上一轮签名字符串还原 id -> signature，用于变化检测 */
function parsePrevItems(signature: string): Array<[string, string]> {
  try {
    const parsed = JSON.parse(signature) as { items: Array<[string, string]> };
    return parsed.items;
  } catch {
    return [];
  }
}
