// T15 导出状态层单测 —— 真实内核文档 + 注入下载/注入假检查 Worker。
// 覆盖:范围解析(可见/选中展开/隐藏排除,边界 3/4)、闸门三分支(新鲜复用 / 过期自动检查 /
// 错误级确认)、CHK-08 确认放行(C4)、逐对象 zip、导出不入栈(C1)、取消令牌。

import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CheckIssue, CheckReply, CheckRunMsg } from '../src/check/check-core';
import { CheckRunner, type CheckWorkerLike } from '../src/check/check-runner';
import { _injectRunner, useCheck } from '../src/check/check-state';
import type { Asset } from '../src/kernel/types';
import { dispatch, doc, geometryRegistry, useUi } from '../src/state/store';
import {
  DEFAULT_BASE_NAME,
  _injectSave,
  beginExport,
  cancelGate,
  confirmProceed,
  exportableVisible,
  resolveSelectedScope,
  useExport,
} from '../src/export/export-state';

// ---------- 夹具 ----------

const assetSpec = (name: string, state: Asset['state'] = 'ready'): Omit<Asset, 'id'> => ({
  name,
  source: 'import',
  state,
  meta: {
    faces: 12,
    bbox: { min: [-5, -5, -5], max: [5, 5, 5] },
    unitChoice: 'mm',
    watertight: true,
    degenerate: false,
  },
});

const astA = dispatch((d) => d.addAsset(assetSpec('立方体')));
const astB = dispatch((d) => d.addAsset(assetSpec('组件')));
const astP = dispatch((d) => d.addAsset(assetSpec('解析中件', 'parsing')));
geometryRegistry.set(astA.id, new THREE.BoxGeometry(10, 10, 10));
geometryRegistry.set(astB.id, new THREE.BoxGeometry(4, 4, 4));

const i1 = dispatch((d) => d.placeInstance(astA.id, '导入', 'place', [0, 0, 5]));
const i2 = dispatch((d) => d.placeInstance(astA.id, '导入', 'place', [30, 0, 5]));
const iHidden = dispatch((d) => d.placeInstance(astA.id, '导入', 'place', [60, 0, 5]));
const iG1 = dispatch((d) => d.placeInstance(astB.id, '导入', 'place', [0, 30, 2]));
const iG2 = dispatch((d) => d.placeInstance(astB.id, '导入', 'place', [10, 30, 2]));
const iP = dispatch((d) => d.placeInstance(astP.id));
const grp = dispatch((d) => d.group([iG1.id, iG2.id], '子装配'));
dispatch((d) => d.setVisible([iHidden.id, iG2.id], false));

// ---------- 注入 ----------

let saved: { filename: string; blob: Blob }[] = [];
_injectSave((blob, filename) => saved.push({ filename, blob }));

/** 新鲜干净报告:runMeta 对齐当前 editVersion + 床 → reportIsStale() = false */
function freshReport(over: Partial<{ issues: CheckIssue[]; unfinished: { id: string; name: string }[] }> = {}) {
  useCheck.setState({
    phase: 'done',
    issues: over.issues ?? [],
    unfinished: over.unfinished ?? [],
    timedOut: false,
    runMeta: { editVersion: doc.editVersion, bed: { ...useUi.getState().bed } },
  });
}

function errorOn(node: { id: string; name: string; assetId: string }): CheckIssue {
  return {
    key: `non_watertight:${node.id}`,
    level: 'error',
    code: 'non_watertight',
    instanceId: node.id,
    instanceName: node.name,
    assetId: node.assetId,
    message: '非水密:4 条边界边',
  };
}

class FakeWorker implements CheckWorkerLike {
  onmessage: ((ev: { data: CheckReply }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  received: CheckRunMsg[] = [];
  /** true = 收到 run 后压住不回(取消令牌测试);手动 flush */
  hold = false;
  private pending: CheckRunMsg[] = [];
  postMessage(msg: unknown) {
    const m = msg as CheckRunMsg;
    this.received.push(m);
    if (this.hold) {
      this.pending.push(m);
      return;
    }
    queueMicrotask(() => this.replyClean(m));
  }
  flush() {
    for (const m of this.pending.splice(0)) this.replyClean(m);
  }
  private replyClean(m: CheckRunMsg) {
    // 真实协议:每实例至少流回一条 dims 信息(运行器以此消 pending;缺了会被记 unfinished)
    for (const inst of m.instances) {
      this.onmessage?.({
        data: {
          t: 'instance',
          runId: m.runId,
          issues: [
            {
              key: `dims:${inst.id}`,
              level: 'info',
              code: 'dims',
              instanceId: inst.id,
              instanceName: inst.name,
              assetId: inst.assetId,
              message: '10 × 10 × 10 mm · 12 面',
            },
          ],
        },
      });
    }
    this.onmessage?.({
      data: {
        t: 'done',
        runId: m.runId,
        summary: {
          instances: m.instances.length,
          errors: 0,
          warnings: 0,
          totalFaces: 12 * m.instances.length,
          assetsAnalyzed: m.assets.filter((a) => a.positions).length,
          assetsCached: 0,
          durationMs: 1,
        },
      },
    });
  }

  terminate() {}
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  saved = [];
  cancelGate();
  useExport.setState({
    open: true,
    stage: 'options',
    scope: 'visible',
    mode: 'merged',
    baseName: DEFAULT_BASE_NAME,
    confirm: null,
    pendingIds: [],
  });
  useCheck.setState({ phase: 'idle', issues: [], unfinished: [], runMeta: null, timedOut: false });
  dispatch((d) => d.select([]));
});

// ---------- 范围解析 ----------

describe('导出范围(CHK-07 / 边界 3·4 / C7)', () => {
  it('全部可见 = 有效可见且资产就绪:隐藏与未就绪不计', () => {
    const ids = exportableVisible().map((n) => n.id);
    expect(ids.sort()).toEqual([i1.id, i2.id, iG1.id].sort());
    expect(ids).not.toContain(iHidden.id);
    expect(ids).not.toContain(iP.id);
  });

  it('仅选中:组展开为后代实例;隐藏成员优先排除并留名单(边界 4)', () => {
    dispatch((d) => d.select([grp.id]));
    const { included, excluded } = resolveSelectedScope();
    expect(included.map((n) => n.id)).toEqual([iG1.id]);
    expect(excluded).toHaveLength(1);
    expect(excluded[0].name).toBe(iG2.name);
    expect(excluded[0].reason).toContain('隐藏');
  });

  it('仅选中:未就绪资产的实例排除并注明', () => {
    dispatch((d) => d.select([iP.id]));
    const { included, excluded } = resolveSelectedScope();
    expect(included).toHaveLength(0);
    expect(excluded[0].reason).toContain('未就绪');
  });
});

// ---------- 闸门与确认 ----------

describe('导出闸门(CHK-02 自动检查 · CHK-08 确认 · C4 放行)', () => {
  it('新鲜干净报告:直接复用,不重跑,立即写出并关闭对话框', () => {
    freshReport();
    beginExport();
    expect(saved).toHaveLength(1);
    expect(saved[0].filename).toBe(`${DEFAULT_BASE_NAME}.stl`);
    expect(useExport.getState().open).toBe(false);
  });

  it('导出集内含错误级 → 确认框列明;「仍要导出」放行(C4 不拦截)', () => {
    freshReport({ issues: [errorOn(i1)] });
    beginExport();
    const st = useExport.getState();
    expect(st.stage).toBe('confirm');
    expect(st.confirm?.errors.map((e) => e.instanceName)).toEqual([i1.name]);
    expect(saved).toHaveLength(0);
    confirmProceed();
    expect(saved).toHaveLength(1);
    expect(useExport.getState().open).toBe(false);
  });

  it('错误只在导出集外(隐藏对象)→ 不触发确认,直接写出', () => {
    freshReport({ issues: [errorOn(iHidden)] });
    beginExport();
    expect(useExport.getState().stage).not.toBe('confirm');
    expect(saved).toHaveLength(1);
  });

  it('仅选中且有排除项 → 即使检查干净也弹确认注明(边界 4)', () => {
    dispatch((d) => d.select([grp.id]));
    freshReport();
    useExport.getState().setScope('selected');
    beginExport();
    const st = useExport.getState();
    expect(st.stage).toBe('confirm');
    expect(st.confirm?.errors).toHaveLength(0);
    expect(st.confirm?.excluded[0].name).toBe(iG2.name);
  });

  it('超时未检对象在导出集内 → 确认框如实列名(不假装成功)', () => {
    freshReport({ unfinished: [{ id: i2.id, name: i2.name }] });
    beginExport();
    expect(useExport.getState().confirm?.unfinished).toEqual([i2.name]);
  });

  it('报告过期 → 自动发起一轮检查,完成后写出(CHK-02 导出前自动分支)', async () => {
    freshReport();
    dispatch((d) => d.nudgeInstances([{ id: i1.id, delta: [1, 0, 0] }], '挪动')); // editVersion+1 → 过期
    const w = new FakeWorker();
    _injectRunner(new CheckRunner(() => w));
    beginExport();
    expect(useExport.getState().stage).toBe('checking');
    expect(saved).toHaveLength(0);
    await tick();
    expect(w.received).toHaveLength(1); // 确实跑了一轮
    expect(useCheck.getState().phase).toBe('done');
    expect(saved).toHaveLength(1);
    expect(useExport.getState().open).toBe(false);
  });

  it('检查中「返回」= 作废闸门:检查照常完成但不再触发写出(令牌)', async () => {
    useCheck.setState({ runMeta: null, phase: 'idle' }); // 无报告 → 必走自动检查
    const w = new FakeWorker();
    w.hold = true;
    _injectRunner(new CheckRunner(() => w));
    beginExport();
    expect(useExport.getState().stage).toBe('checking');
    cancelGate();
    expect(useExport.getState().stage).toBe('options');
    w.flush(); // 检查此刻才完成
    await tick();
    expect(useCheck.getState().phase).toBe('done'); // 结果面板照常收到
    expect(saved).toHaveLength(0); // 但导出不发生
  });
});

// ---------- 写出形态与 C1 ----------

describe('写出形态与宪法约束', () => {
  it('合并模式:单 .stl,三角计数 = 各件之和', async () => {
    freshReport();
    beginExport();
    const buf = await saved[0].blob.arrayBuffer();
    const count = new DataView(buf).getUint32(80, true);
    // BoxGeometry 10³ × 2(i1/i2)+ BoxGeometry 4³ × 1(iG1),各 12 三角
    expect(count).toBe(36);
  });

  it('逐对象模式:.zip,EOCD 条目数 = 导出对象数', async () => {
    freshReport();
    useExport.getState().setMode('perObject');
    beginExport();
    expect(saved[0].filename).toBe(`${DEFAULT_BASE_NAME}.zip`);
    const buf = await saved[0].blob.arrayBuffer();
    const dv = new DataView(buf);
    expect(dv.getUint32(buf.byteLength - 22, true)).toBe(0x06054b50);
    expect(dv.getUint16(buf.byteLength - 22 + 10, true)).toBe(3);
  });

  it('导出不改文档、不入历史栈(C1 第三类)', () => {
    const v = doc.editVersion;
    const hist = doc.history.length;
    freshReport({ issues: [errorOn(i1)] });
    beginExport();
    confirmProceed();
    expect(saved).toHaveLength(1);
    expect(doc.editVersion).toBe(v);
    expect(doc.history.length).toBe(hist);
  });

  it('文件名净化:非法字符置换后落到下载名', () => {
    freshReport();
    useExport.getState().setBaseName('打印/批次:A');
    beginExport();
    expect(saved[0].filename).toBe('打印_批次_A.stl');
  });
});
