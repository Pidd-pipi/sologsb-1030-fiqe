import { computeBatchPlan } from './engine';
import type { ChecklistItem, ChecklistProject, DependencyBlocker, ValidationIssue } from './types';

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');

const blockerTitle: Record<DependencyBlocker['type'], string> = {
  self: '前置条件形成自引用',
  missing: '前置条件引用缺失',
  cycle: '前置条件形成循环依赖',
  reverse: '前置条件顺序不可达'
};

const blockerIssueType = (blocker: DependencyBlocker): ValidationIssue['type'] =>
  blocker.type === 'cycle' ? 'dependency-cycle' : 'unreachable-precondition';

export function validateProject(project: ChecklistProject): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const add = (issue: ValidationIssue) => issues.push(issue);

  // 依赖图阻断：自引用、缺失引用、循环、倒序，以及它们沿链波及的下游项
  const plan = computeBatchPlan({ stages: project.stages, items: project.items });
  plan.blocked.forEach((blocker) => {
    const item = project.items.find((candidate) => candidate.id === blocker.itemId);
    add({
      id: `${blocker.itemId}-${blocker.type}-${blocker.kind}-${blocker.refId ?? 'root'}`,
      type: blockerIssueType(blocker),
      level: 'error',
      stageId: item?.stageId,
      itemId: blocker.itemId,
      title: blocker.kind === 'cascade' ? `受阻断项波及：${blockerTitle[blocker.type]}` : blockerTitle[blocker.type],
      detail: blocker.detail
    });
  });

  const challenges = new Map<string, ChecklistItem[]>();
  const responses = new Map<string, ChecklistItem[]>();
  project.items.forEach((item) => {
    if (normalize(item.challenge)) challenges.set(normalize(item.challenge), [...(challenges.get(normalize(item.challenge)) ?? []), item]);
    if (normalize(item.response)) responses.set(normalize(item.response), [...(responses.get(normalize(item.response)) ?? []), item]);
    if (!item.challenge.trim()) {
      add({ id: `${item.id}-empty-challenge`, type: 'missing-response', level: 'error', stageId: item.stageId, itemId: item.id, title: '检查项缺少挑战语', detail: '每项必须有可供机组读取的挑战语。' });
    }
    if (!item.response.trim()) {
      add({ id: `${item.id}-missing-response`, type: 'missing-response', level: 'error', stageId: item.stageId, itemId: item.id, title: '缺少预期回应', detail: `${item.challenge || '未命名检查项'} 没有填写机组应确认的回应。` });
    }
  });

  for (const [challenge, entries] of challenges) {
    if (challenge && entries.length > 1) {
      add({ id: `duplicate-challenge-${challenge}`, type: 'duplicate', level: 'warning', stageId: entries[0].stageId, itemId: entries[0].id, title: '挑战语重复', detail: `“${entries[0].challenge}”在检查单中出现 ${entries.length} 次。` });
    }
  }
  for (const [response, entries] of responses) {
    if (response && entries.length > 4) {
      add({ id: `duplicate-response-${response}`, type: 'duplicate', level: 'info', stageId: entries[0].stageId, itemId: entries[0].id, title: '回应高度重复', detail: `“${entries[0].response}”出现 ${entries.length} 次，请确认是否为通用回应。` });
    }
  }

  const canonical = ['飞行前检查', '发动机启动', '滑行', '起飞', '爬升', '进近', '着陆'];
  const positions = project.stages.map((stage) => ({ stage, canonical: canonical.indexOf(stage.name) })).filter((entry) => entry.canonical >= 0);
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index - 1].canonical > positions[index].canonical) {
      add({
        id: `stage-order-${positions[index - 1].stage.id}`,
        type: 'stage-order',
        level: 'warning',
        stageId: positions[index].stage.id,
        title: '飞行阶段顺序异常',
        detail: `${positions[index - 1].stage.name} 排在 ${positions[index].stage.name} 之后，请确认是否符合该机型流程。`
      });
    }
  }

  project.stages.forEach((stage) => {
    if (!project.items.some((item) => item.stageId === stage.id)) {
      add({ id: `${stage.id}-empty`, type: 'orphan-stage', level: 'info', stageId: stage.id, title: '阶段尚未配置检查项', detail: `${stage.name} 当前为空。` });
    }
  });

  return issues;
}
