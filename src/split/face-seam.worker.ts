import * as THREE from 'three';
import { buildLocalFacePaintTopology } from './face-paint-core';
import { createFaceSeamPreview, createShellGroupPreview } from './face-seam-preview-core';
import { completeFaceSetFromRoughMask } from './face-set-completion-core';
import type { FaceSeamReply, FaceSeamRequest } from './face-seam-protocol';

const post = (reply: FaceSeamReply, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(reply, transfer);

self.onmessage = (event: MessageEvent<FaceSeamRequest>) => {
  const request = event.data;
  if (request.t !== 'analyze') return;
  const startedAt = performance.now();
  const geometry = new THREE.BufferGeometry();
  try {
    post({ t: 'progress', requestId: request.requestId, phase: '扫描面组与连通壳体' });
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(request.positions), 3),
    );
    if (request.index) {
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(request.index), 1));
    }
    const roughLabels = new Uint8Array(request.faceLabels);
    post({ t: 'progress', requestId: request.requestId, phase: '识别独立壳体与桥接壳体' });
    const completion = completeFaceSetFromRoughMask(
      new Float32Array(request.positions),
      request.index ? new Uint32Array(request.index) : null,
      roughLabels,
      undefined,
      request.viewPositionLocal,
      request.worldMatrix,
      request.seamAnchorLocal,
    );
    if (completion.status !== 'ready') {
      post({
        t: 'failed',
        requestId: request.requestId,
        message: completion.message,
      });
      return;
    }
    post({ t: 'progress', requestId: request.requestId, phase: '合并完整壳体并补全桥接范围' });
    const faceLabels = completion.faceLabels;
    const worldMatrix = new THREE.Matrix4().fromArray(request.worldMatrix);
    post({
      t: 'progress',
      requestId: request.requestId,
      phase: completion.summary.splitMode === 'shells' ? '验证独立壳体分组' : '验证桥接壳体闭环',
    });
    const previewLabels = (
      labels: Uint8Array,
      splitMode: typeof completion.summary.splitMode,
      selectedShellCount: number,
    ) => splitMode === 'shells'
      ? createShellGroupPreview(labels, selectedShellCount)
      : createFaceSeamPreview(
        buildLocalFacePaintTopology(geometry, labels),
        labels,
        worldMatrix,
      );
    const result = previewLabels(
      faceLabels,
      completion.summary.splitMode,
      completion.summary.selectedShellCount,
    );
    if (result.status !== 'ready') {
      post({
        t: 'result',
        requestId: request.requestId,
        result,
        durationMs: performance.now() - startedAt,
      }, [result.loopPositions.buffer]);
      return;
    }
    const alternatives = (completion.alternatives ?? [])
      .map((alternative) => ({
        result: previewLabels(
          alternative.faceLabels,
          alternative.summary.splitMode,
          alternative.summary.selectedShellCount,
        ),
        completedFaceLabels: alternative.faceLabels,
        completion: alternative.summary,
      }))
      .filter((alternative) => alternative.result.status === 'ready');
    const optionCount = 1 + alternatives.length;
    completion.summary.optionIndex = 0;
    completion.summary.optionCount = optionCount;
    alternatives.forEach((alternative, index) => {
      alternative.completion.optionIndex = index + 1;
      alternative.completion.optionCount = optionCount;
    });
    const transfer: Transferable[] = [result.loopPositions.buffer, faceLabels.buffer];
    for (const alternative of alternatives) {
      transfer.push(
        alternative.result.loopPositions.buffer,
        alternative.completedFaceLabels.buffer,
      );
    }
    post({
      t: 'result',
      requestId: request.requestId,
      result,
      durationMs: performance.now() - startedAt,
      completedFaceLabels: faceLabels.buffer as ArrayBuffer,
      completion: completion.summary,
      alternatives: alternatives.map((alternative) => ({
        result: alternative.result,
        completedFaceLabels: alternative.completedFaceLabels.buffer as ArrayBuffer,
        completion: alternative.completion,
      })),
    }, transfer);
  } catch (error) {
    post({
      t: 'failed',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : '局部接缝分析失败',
    });
  } finally {
    geometry.dispose();
  }
};
