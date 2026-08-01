import type {
  CreationAgentApiOutput,
  CreationAgentBrief,
  CreationAgentQuestion,
  CreationProjectType,
  CreationPurpose,
} from './creation-agent-api-types';

export const CREATION_AGENT_SESSION_KEY = '3dstd:creation-agent-session:v1';

export const emptyCreationBrief = (): CreationAgentBrief => ({
  subject: null,
  projectType: 'unknown',
  purpose: 'unknown',
  style: null,
  targetHeightMm: null,
  pose: null,
  preferredPartCount: null,
  notes: [],
});

const PROJECT_LABELS: Record<Exclude<CreationProjectType, 'unknown'>, string> = {
  character: '角色手办',
  mecha: '机甲模型',
  prop: '道具或摆件',
  product: '产品原型',
  scene: '场景模型',
  other: '其他模型',
};

const PURPOSE_LABELS: Record<Exclude<CreationPurpose, 'unknown'>, string> = {
  resin_print: '树脂打印',
  fdm_print: 'FDM 打印',
  display: '数字展示',
  prototype: '产品验证',
};

export function projectTypeLabel(value: CreationProjectType): string {
  return value === 'unknown' ? '尚未确定' : PROJECT_LABELS[value];
}

export function purposeLabel(value: CreationPurpose): string {
  return value === 'unknown' ? '尚未确定' : PURPOSE_LABELS[value];
}

function includesAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

function inferProjectType(text: string): CreationProjectType | null {
  if (includesAny(text, ['机甲', '机器人', '高达', '机械角色'])) return 'mecha';
  if (includesAny(text, ['手办', '角色', '人物', '人偶', '动物', '怪兽'])) return 'character';
  if (includesAny(text, ['道具', '摆件', '武器', '头盔', '徽章'])) return 'prop';
  if (includesAny(text, ['产品', '外壳', '原型', '工业设计'])) return 'product';
  if (includesAny(text, ['场景', '建筑', '地台', '环境'])) return 'scene';
  return null;
}

function inferPurpose(text: string): CreationPurpose | null {
  if (includesAny(text, ['树脂', '光固化', 'sla'])) return 'resin_print';
  if (includesAny(text, ['fdm', '耗材', '熔融'])) return 'fdm_print';
  if (includesAny(text, ['展示', '渲染', '动画', '游戏'])) return 'display';
  if (includesAny(text, ['打样', '验证', '产品原型'])) return 'prototype';
  return null;
}

function inferStyle(text: string): string | null {
  const styles = ['卡通', 'Q版', '写实', '科幻', '赛博朋克', '机甲', '极简', '国风', '奇幻', '可爱'];
  const hits = styles.filter((style) => text.toLowerCase().includes(style.toLowerCase()));
  return hits.length ? hits.join('、') : null;
}

function inferHeight(text: string): number | null {
  const mm = /(\d{2,4}(?:\.\d+)?)\s*(?:mm|毫米)/i.exec(text);
  if (mm) return Number(mm[1]);
  const cm = /(\d{1,3}(?:\.\d+)?)\s*(?:cm|厘米|公分)/i.exec(text);
  return cm ? Number(cm[1]) * 10 : null;
}

function inferPartCount(text: string): CreationAgentBrief['preferredPartCount'] {
  const range = /(\d{1,2})\s*(?:-|到|至|~|～)\s*(\d{1,2})\s*(?:个|件|部分|零件)/.exec(text);
  if (range) {
    const minimum = Math.max(1, Number(range[1]));
    const maximum = Math.max(minimum, Number(range[2]));
    return { minimum, preferred: Math.round((minimum + maximum) / 2), maximum };
  }
  const single = /(?:拆成|分成|拆分为|分为)\s*(\d{1,2})\s*(?:个|件|部分|零件)/.exec(text);
  if (!single) return null;
  const preferred = Math.max(1, Number(single[1]));
  return { minimum: preferred, preferred, maximum: preferred };
}

function meaningfulSubject(text: string): string | null {
  const normalized = text.trim().replace(/[。！!？?]+$/g, '');
  if (!normalized || normalized.length > 120) return null;
  if (/^(?:我想|想要|帮我)?(?:做|制作|生成|设计)?(?:一个|个)?(?:3d)?模型$/i.test(normalized.replace(/\s/g, ''))) return null;
  return normalized;
}

export function inferCreationBrief(current: CreationAgentBrief, message: string): CreationAgentBrief {
  const projectType = inferProjectType(message) ?? current.projectType;
  const purpose = inferPurpose(message) ?? current.purpose;
  const style = inferStyle(message) ?? current.style;
  const targetHeightMm = inferHeight(message) ?? current.targetHeightMm;
  const preferredPartCount = inferPartCount(message) ?? current.preferredPartCount;
  let subject = current.subject ?? meaningfulSubject(message);
  if (!subject && projectType !== 'unknown') subject = projectTypeLabel(projectType);
  return { ...current, subject, projectType, purpose, style, targetHeightMm, preferredPartCount };
}

const projectQuestion = (): CreationAgentQuestion => ({
  questionId: 'project_type',
  question: '你最想制作哪一类模型？',
  allowFreeText: true,
  options: [
    { value: 'character', label: '角色手办', description: '人物、动物或原创角色', recommended: true },
    { value: 'mecha', label: '机甲模型', description: '机器人、装甲或机械角色', recommended: false },
    { value: 'prop', label: '道具摆件', description: '武器、徽章或桌面摆件', recommended: false },
    { value: 'product', label: '产品原型', description: '外壳、结构或工业设计验证', recommended: false },
  ],
});

const styleQuestion = (): CreationAgentQuestion => ({
  questionId: 'style',
  question: '希望整体呈现什么风格？',
  allowFreeText: true,
  options: [
    { value: '可爱卡通', label: '可爱卡通', description: '比例夸张、形体清晰', recommended: true },
    { value: '写实', label: '写实', description: '接近真实比例与材质', recommended: false },
    { value: '科幻机甲', label: '科幻机甲', description: '机械结构和装甲细节', recommended: false },
    { value: '极简', label: '极简', description: '轮廓优先、减少细碎结构', recommended: false },
  ],
});

const purposeQuestion = (): CreationAgentQuestion => ({
  questionId: 'purpose',
  question: '这个模型最终主要用来做什么？',
  allowFreeText: true,
  options: [
    { value: 'resin_print', label: '树脂打印', description: '适合手办与精细细节', recommended: true },
    { value: 'fdm_print', label: 'FDM 打印', description: '适合较大结构和低成本验证', recommended: false },
    { value: 'display', label: '数字展示', description: '用于渲染、动画或线上展示', recommended: false },
    { value: 'unknown', label: '暂不确定', description: '先完成造型，之后再决定', recommended: false },
  ],
});

const sizeQuestion = (): CreationAgentQuestion => ({
  questionId: 'target_height',
  question: '你希望成品大约多高？',
  allowFreeText: true,
  options: [
    { value: '100', label: '约 100 mm', description: '小型桌面摆件', recommended: false },
    { value: '180', label: '约 180 mm', description: '常见手办尺寸', recommended: true },
    { value: '300', label: '约 300 mm', description: '大型展示模型', recommended: false },
    { value: 'unknown', label: '暂不确定', description: '由后续方案建议', recommended: false },
  ],
});

export function questionsForBrief(brief: CreationAgentBrief): CreationAgentQuestion[] {
  const questions: CreationAgentQuestion[] = [];
  if (brief.projectType === 'unknown') questions.push(projectQuestion());
  if (!brief.style) questions.push(styleQuestion());
  if (brief.purpose === 'unknown') questions.push(purposeQuestion());
  if (questions.length < 3 && brief.targetHeightMm === null && brief.purpose !== 'display') questions.push(sizeQuestion());
  return questions.slice(0, 3);
}

export function applyQuestionAnswers(
  brief: CreationAgentBrief,
  answers: Record<string, string>,
): { brief: CreationAgentBrief; summary: string } {
  let next = { ...brief };
  const summary: string[] = [];
  if (answers.project_type) {
    next.projectType = answers.project_type as CreationProjectType;
    next.subject ??= projectTypeLabel(next.projectType);
    summary.push(`模型类型：${projectTypeLabel(next.projectType)}`);
  }
  if (answers.style) {
    next.style = answers.style;
    summary.push(`风格：${answers.style}`);
  }
  if (answers.purpose) {
    next.purpose = answers.purpose as CreationPurpose;
    summary.push(`用途：${purposeLabel(next.purpose)}`);
  }
  if (answers.target_height && answers.target_height !== 'unknown') {
    next.targetHeightMm = Number(answers.target_height);
    summary.push(`成品高度：约 ${answers.target_height} mm`);
  }
  return { brief: next, summary: summary.join('；') };
}

function missingFieldsOf(brief: CreationAgentBrief): string[] {
  const missing: string[] = [];
  if (!brief.subject) missing.push('创作对象');
  if (brief.projectType === 'unknown') missing.push('模型类型');
  if (!brief.style) missing.push('视觉风格');
  if (brief.purpose === 'unknown') missing.push('使用目的');
  return missing;
}

export function buildLocalCreationTurn(current: CreationAgentBrief, message: string): CreationAgentApiOutput {
  const brief = inferCreationBrief(current, message);
  const missingFields = missingFieldsOf(brief);
  const questions = questionsForBrief(brief);
  const complete = missingFields.length === 0;
  return {
    schemaVersion: 'creation-agent-output.v1',
    message: complete
      ? '我已经把目前的想法整理成一份创作需求。请先核对，确认后再进入效果图和多视图阶段。'
      : '这个方向可以继续做。为了避免直接生成出与你预期不一致的模型，我还需要确认下面几个关键问题。',
    brief,
    questions: complete ? [] : questions,
    nextAction: complete ? 'review_brief' : 'ask_questions',
    readiness: { score: Math.max(0, Math.min(1, (4 - missingFields.length) / 4)), missingFields },
    assumptions: complete ? [] : ['尚未确认的信息不会自动提交到付费生成服务。'],
  };
}
