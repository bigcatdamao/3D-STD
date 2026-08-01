import { describe, expect, it } from 'vitest';
import type { CreationAgentQuestion } from '../src/agent/creation-agent-api-types';
import {
  applyQuestionAnswers,
  buildLocalCreationTurn,
  emptyCreationBrief,
} from '../src/agent/creation-agent-logic';

describe('M1.16b 创作 Agent 本地降级逻辑', () => {
  it('面对模糊需求每轮只追问一个关键问题', () => {
    const output = buildLocalCreationTurn(emptyCreationBrief(), '我想做一个模型');
    expect(output.nextAction).toBe('ask_questions');
    expect(output.questions).toHaveLength(1);
    expect(output.questions[0]).toMatchObject({ questionId: 'project_type', targetField: 'project_type' });
    expect(output.assumptions[0]).toContain('不会自动触发付费服务');
  });

  it('已知对象、风格和用途后直接允许进入视觉方案', () => {
    const output = buildLocalCreationTurn(emptyCreationBrief(), '我想做一个18厘米高的可爱卡通蘑菇角色手办，用树脂打印');
    expect(output.nextAction).toBe('ready_for_concept');
    expect(output.questions).toEqual([]);
    expect(output.brief).toMatchObject({ projectType: 'character', purpose: 'resin_print', targetHeightMm: 180 });
    expect(output.readiness.score).toBe(1);
  });

  it('已知字段的快捷回答可以直接回填 Brief', () => {
    const applied = applyQuestionAnswers(emptyCreationBrief(), {
      project_type: 'mecha',
      style: '科幻机甲',
      purpose: 'fdm_print',
      target_height: '300',
    });
    expect(applied.brief).toMatchObject({ projectType: 'mecha', purpose: 'fdm_print', style: '科幻机甲', targetHeightMm: 300 });
    expect(applied.summary).toContain('机甲模型');
  });

  it('模型生成的动态 questionId 通过 targetField 回填且不会产生空消息', () => {
    const question: CreationAgentQuestion = {
      questionId: 'visual_direction_2026',
      targetField: 'style',
      question: '你更偏好哪种视觉方向？',
      allowFreeText: true,
      options: [
        { value: 'anime_clean', label: '日式二次元', description: '轮廓清晰', recommended: true },
        { value: 'realistic', label: '写实', description: '真实比例', recommended: false },
      ],
    };
    const applied = applyQuestionAnswers(emptyCreationBrief(), { visual_direction_2026: 'anime_clean' }, [question]);
    expect(applied.brief.style).toBe('日式二次元');
    expect(applied.summary).toBe('你更偏好哪种视觉方向？：日式二次元');
  });
});
