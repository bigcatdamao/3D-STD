import { describe, expect, it } from 'vitest';
import {
  applyQuestionAnswers,
  buildLocalCreationTurn,
  emptyCreationBrief,
} from '../src/agent/creation-agent-logic';

describe('M1.14a 创作 Agent 本地降级逻辑', () => {
  it('面对模糊需求只追问最多三个关键问题', () => {
    const output = buildLocalCreationTurn(emptyCreationBrief(), '我想做一个模型');
    expect(output.nextAction).toBe('ask_questions');
    expect(output.questions).toHaveLength(3);
    expect(output.questions.map((question) => question.questionId)).toEqual(['project_type', 'style', 'purpose']);
    expect(output.assumptions[0]).toContain('不会自动提交');
  });

  it('已知对象、风格和用途后直接进入 Brief 复核，不凑问题', () => {
    const output = buildLocalCreationTurn(emptyCreationBrief(), '我想做一个18厘米高的可爱卡通蘑菇角色手办，用树脂打印');
    expect(output.nextAction).toBe('review_brief');
    expect(output.questions).toEqual([]);
    expect(output.brief).toMatchObject({ projectType: 'character', purpose: 'resin_print', targetHeightMm: 180 });
    expect(output.readiness.score).toBe(1);
  });

  it('多选答案可结构化回填 Brief', () => {
    const applied = applyQuestionAnswers(emptyCreationBrief(), {
      project_type: 'mecha',
      style: '科幻机甲',
      purpose: 'fdm_print',
      target_height: '300',
    });
    expect(applied.brief).toMatchObject({ projectType: 'mecha', purpose: 'fdm_print', style: '科幻机甲', targetHeightMm: 300 });
    expect(applied.summary).toContain('机甲模型');
  });
});
