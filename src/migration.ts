import { computeBatchPlan } from './engine';
import type { ChecklistProject, WorkspaceState, WorkspaceStateV1 } from './types';

const clone = <T>(value: T): T => structuredClone(value);

/**
 * v1 -> v2 升级：
 * 1. 先补齐依赖关系：去重 preconditionIds，悬空/非法引用予以保留（升级后由阻断机制显式报出）；
 * 2. 再做全量核对：为每个冻结版本按其快照计算并固化批次；草稿不固化，由运行时实时计算。
 */
export function migrateV1ToV2(saved: WorkspaceStateV1): WorkspaceState {
  const projects: ChecklistProject[] = saved.projects.map((projectV1) => {
    const project = clone(projectV1) as ChecklistProject;

    const repair = (items: ChecklistProject['items']) => {
      const ids = new Set(items.map((item) => item.id));
      items.forEach((item) => {
        const unique = item.preconditionIds.filter((id, index) => item.preconditionIds.indexOf(id) === index);
        item.preconditionIds = unique;
        // 悬空引用不静默删除：保留后进入“缺失引用”阻断，避免老数据里的依赖被悄悄吞掉
        if (unique.some((id) => !ids.has(id))) {
          item.updatedAt = item.updatedAt || new Date(0).toISOString();
        }
      });
    };

    repair(project.items);
    project.revisions.forEach((revision) => {
      repair(revision.items);
      // 全量核对：按冻结当时的阶段与检查项固化批次，草稿之后再改也不回写
      revision.batchPlan = computeBatchPlan({ stages: revision.stages, items: revision.items }, revision.createdAt);
    });

    return project;
  });

  return {
    schemaVersion: 2,
    selectedProjectId: saved.selectedProjectId,
    projects
  };
}
