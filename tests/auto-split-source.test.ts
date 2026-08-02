import { describe, expect, it } from 'vitest';
import { hunyuanSplitTaskIdOf } from '../src/split/auto-split-state';

describe('auto split source routing', () => {
  it('keeps a Hunyuan generation task as the FBX split source', () => {
    expect(hunyuanSplitTaskIdOf({
      genParams: { engine: 'hunyuan', taskId: 'hy3d_123456' },
    })).toBe('hy3d_123456');
  });

  it('does not silently route imported or legacy assets to Hi3D', () => {
    expect(hunyuanSplitTaskIdOf({})).toBeNull();
    expect(hunyuanSplitTaskIdOf({ genParams: { engine: 'hi3d', taskId: 'job_123' } })).toBeNull();
    expect(hunyuanSplitTaskIdOf({ genParams: { engine: 'hunyuan', taskId: 'job_123' } })).toBeNull();
  });
});
