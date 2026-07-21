import * as THREE from 'three';
import type { CheckEvidence } from './split-analysis-logic';
import type {
  SplitAnalysisApiInput,
  SplitAnalysisImageEvidence,
  SplitAnalysisViewDescriptor,
  ViewLabel,
} from './split-analysis-api-types';
import type { SplitAnalysisContext } from './split-analysis-types';
import type { SceneDocument } from '../kernel/scene';
import { geometryRegistry } from '../state/store';
import { worldBBoxOfInstance } from '../viewport/gizmo-math';

const VIEW_SIZE = 384;
const VIEW_LABELS: ViewLabel[] = ['front', 'right', 'top', 'iso'];
const D2R = Math.PI / 180;

function clone3(value: readonly number[]): [number, number, number] {
  return [value[0], value[1], value[2]];
}

function requestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `sa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildSplitAnalysisApiInput(
  scene: SceneDocument,
  context: SplitAnalysisContext,
  check: CheckEvidence & {
    runEditVersion: number | null;
    assetMetas: Array<{
      assetId: string;
      watertight: boolean;
      degenerateCount: number;
      boundaryEdges: number;
      nonManifoldEdges: number;
    }>;
  },
  views: SplitAnalysisViewDescriptor[],
): SplitAnalysisApiInput {
  const visibleIds = new Set(context.objects.map((object) => object.id));
  const objects: SplitAnalysisApiInput['objects'] = [];
  for (const node of scene.nodes.values()) {
    if (node.kind !== 'instance' || !visibleIds.has(node.id)) continue;
    const asset = scene.assets.get(node.assetId);
    if (!asset) continue;
    const world = worldBBoxOfInstance(node.transform, asset.meta.bbox);
    const size = world.getSize(new THREE.Vector3());
    objects.push({
      objectId: node.id,
      assetId: node.assetId,
      name: node.name.slice(0, 200),
      source: asset.source,
      visible: true,
      locked: scene.effectiveLocked(node.id),
      transform: {
        positionMm: clone3(node.transform.position),
        rotationDeg: clone3(node.transform.rotation),
        scale: clone3(node.transform.scale),
      },
      localBoundsMm: { min: clone3(asset.meta.bbox.min), max: clone3(asset.meta.bbox.max) },
      worldBoundsMm: { min: world.min.toArray() as [number, number, number], max: world.max.toArray() as [number, number, number] },
      dimensionsMm: size.toArray() as [number, number, number],
      faces: asset.meta.faces,
      vertices: asset.meta.vertices ?? null,
    });
  }

  const visibleAssetIds = new Set(objects.map((object) => object.assetId));
  const summary = check.summary;
  return {
    schemaVersion: 'split-analysis-input.v1',
    requestId: requestId(),
    locale: 'zh-CN',
    goal: { description: context.goal, priorities: [...context.priorities] },
    printing: {
      process: context.process,
      bedMm: { ...context.bed },
      material: null,
      nozzleMm: context.process === 'fdm' ? 0.4 : null,
      layerHeightMm: context.process === 'fdm' ? 0.2 : null,
      assemblyClearanceMm: context.process === 'fdm' ? 0.2 : null,
    },
    scene: {
      editVersion: scene.editVersion,
      selectionScope: 'visible',
      objectCount: objects.length,
      selectedObjectIds: [...scene.selection].filter((id) => visibleIds.has(id)),
      currentPartCount: context.currentPartCount,
      splitState: [...scene.nodes.values()].some((node) => node.kind === 'group') ? 'grouped_only' : 'untouched',
    },
    objects,
    diagnostics: {
      status: context.checkStatus,
      reportEditVersion: check.runEditVersion,
      summary: summary ? {
        instances: summary.instances,
        errors: summary.errors,
        warnings: summary.warnings,
        totalFaces: summary.totalFaces,
        timedOut: check.timedOut,
      } : null,
      topology: check.assetMetas.filter((meta) => visibleAssetIds.has(meta.assetId)).map((meta) => ({
        assetId: meta.assetId,
        watertight: meta.watertight,
        degenerateFaces: meta.degenerateCount,
        boundaryEdges: meta.boundaryEdges,
        nonManifoldEdges: meta.nonManifoldEdges,
      })),
      issues: check.issues.filter((issue) => visibleIds.has(issue.instanceId)).map((issue) => ({
        issueId: issue.key,
        objectId: issue.instanceId,
        code: issue.code,
        level: issue.level,
        message: issue.message,
        worldBoundsMm: issue.world ? { min: clone3(issue.world.min), max: clone3(issue.world.max) } : null,
      })),
      thinWall: { status: 'unavailable', threshold: null, regions: [] },
      surfaceOverhang: { status: 'unavailable', threshold: null, regions: [] },
    },
    currentParts: objects.map((object) => ({
      partId: object.objectId,
      name: object.name,
      kind: 'original',
      sourceObjectIds: [object.objectId],
      parentPartId: null,
      operationId: null,
      state: 'current',
    })),
    views,
    capabilities: {
      topology: context.capabilities.topology,
      thinWall: 'unavailable',
      surfaceOverhang: 'unavailable',
      cutCandidates: 'unavailable',
      multiviewCapture: views.length ? 'available' : 'not_run',
      assemblyValidation: 'unavailable',
    },
  };
}

function cameraPosition(label: ViewLabel, center: THREE.Vector3, distance: number): THREE.Vector3 {
  if (label === 'front') return center.clone().add(new THREE.Vector3(0, -distance, 0));
  if (label === 'right') return center.clone().add(new THREE.Vector3(distance, 0, 0));
  if (label === 'top') return center.clone().add(new THREE.Vector3(0, 0, distance));
  return center.clone().add(new THREE.Vector3(distance * 0.72, -distance * 0.82, distance * 0.58));
}

/** Render four bounded evidence frames without touching the live R3F camera or scene. */
export function captureSplitAnalysisViews(scene: SceneDocument): {
  descriptors: SplitAnalysisViewDescriptor[];
  images: SplitAnalysisImageEvidence[];
} {
  if (typeof document === 'undefined') return { descriptors: [], images: [] };
  let renderer: THREE.WebGLRenderer | null = null;
  const palette = ['#47a98a', '#5f8fc7', '#a66ec3', '#d59a43', '#8090a2'];
  const materials: THREE.MeshStandardMaterial[] = [];
  try {
    const canvas = document.createElement('canvas');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setSize(VIEW_SIZE, VIEW_SIZE, false);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor('#141417', 1);

    const renderScene = new THREE.Scene();
    renderScene.add(new THREE.HemisphereLight('#ffffff', '#24242c', 1.55));
    const key = new THREE.DirectionalLight('#ffffff', 2.2);
    key.position.set(2, -3, 4);
    renderScene.add(key);
    const fill = new THREE.DirectionalLight('#9bc7ff', 0.65);
    fill.position.set(-3, 2, 1.5);
    renderScene.add(fill);

    const meshes: THREE.Mesh[] = [];
    for (const node of scene.nodes.values()) {
      if (node.kind !== 'instance' || !scene.effectiveVisible(node.id)) continue;
      if (scene.assets.get(node.assetId)?.state !== 'ready') continue;
      const geometry = geometryRegistry.get(node.assetId);
      if (!geometry) continue;
      const material = new THREE.MeshStandardMaterial({
        color: palette[meshes.length % palette.length],
        roughness: 0.58,
        metalness: 0.04,
      });
      materials.push(material);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...node.transform.position);
      mesh.rotation.set(node.transform.rotation[0] * D2R, node.transform.rotation[1] * D2R, node.transform.rotation[2] * D2R, 'XYZ');
      mesh.scale.set(...node.transform.scale);
      renderScene.add(mesh);
      meshes.push(mesh);
    }
    if (!meshes.length) return { descriptors: [], images: [] };

    renderScene.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    for (const mesh of meshes) bounds.expandByObject(mesh, true);
    if (bounds.isEmpty()) return { descriptors: [], images: [] };
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() / 2, 1);
    const distance = radius * 3.05;
    const camera = new THREE.PerspectiveCamera(32, 1, Math.max(radius / 100, 0.01), radius * 20);

    const descriptors: SplitAnalysisViewDescriptor[] = [];
    const images: SplitAnalysisImageEvidence[] = [];
    for (const label of VIEW_LABELS) {
      const viewId = `view-${label}`;
      camera.position.copy(cameraPosition(label, center, distance));
      camera.up.set(0, label === 'top' ? 1 : 0, label === 'top' ? 0 : 1);
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      renderer.render(renderScene, camera);
      images.push({ viewId, imageUrl: canvas.toDataURL('image/jpeg', 0.76) });
      descriptors.push({
        viewId,
        fieldName: `view_${label}`,
        label,
        scope: 'visible',
        width: VIEW_SIZE,
        height: VIEW_SIZE,
        mime: 'image/jpeg',
        detailHint: 'low',
      });
    }
    return { descriptors, images };
  } catch {
    return { descriptors: [], images: [] };
  } finally {
    for (const material of materials) material.dispose();
    renderer?.dispose();
  }
}
