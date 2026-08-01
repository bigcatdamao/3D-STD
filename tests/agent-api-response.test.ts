import { describe, expect, it } from 'vitest';
import { isJsonApiResponse, serviceVersionMismatchMessage } from '../src/agent/api-response';

describe('Agent API response guard', () => {
  it('accepts normal JSON response content types', () => {
    expect(isJsonApiResponse(new Response('{}', {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }))).toBe(true);
    expect(isJsonApiResponse(new Response('{}', {
      headers: { 'content-type': 'application/problem+json' },
    }))).toBe(true);
  });

  it('recognizes an HTML SPA fallback as a service version mismatch', () => {
    const response = new Response('<!doctype html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    expect(isJsonApiResponse(response)).toBe(false);
    expect(serviceVersionMismatchMessage('创作 Agent 服务')).toContain('版本不一致');
    expect(serviceVersionMismatchMessage('创作 Agent 服务')).toContain('部署同版本 Worker');
  });
});
