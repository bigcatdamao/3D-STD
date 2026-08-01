import type { GenerateType, ImageView } from '../../worker/api-types';

export interface AgentGenerationHandoff {
  id: string;
  type: Extract<GenerateType, 'image' | 'multiview'>;
  prompt: string;
  images: Array<{ view: ImageView; file: File }>;
  source: 'agent_concept' | 'agent_turntable';
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('生成图无法解码。'));
    image.src = url;
  });
}

export async function base64PngToFile(base64: string, name: string): Promise<File> {
  const response = await fetch(`data:image/png;base64,${base64}`);
  return new File([await response.blob()], name, { type: 'image/png' });
}

export async function splitTurntableSheet(base64: string, stem: string): Promise<Array<{ view: ImageView; file: File }>> {
  const dataUrl = `data:image/png;base64,${base64}`;
  const image = await loadImage(dataUrl);
  const views: ImageView[] = ['front', 'left', 'right'];
  const panelWidth = Math.floor(image.naturalWidth / 3);
  if (panelWidth < 64 || image.naturalHeight < 64) throw new Error('三视图画布尺寸异常。');
  const files: Array<{ view: ImageView; file: File }> = [];
  for (let index = 0; index < views.length; index += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = panelWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建三视图画布。');
    context.drawImage(image, panelWidth * index, 0, panelWidth, image.naturalHeight, 0, 0, panelWidth, image.naturalHeight);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('三视图切分失败。');
    files.push({ view: views[index], file: new File([blob], `${stem}-${views[index]}.png`, { type: 'image/png' }) });
  }
  return files;
}

export async function compressReferenceImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法处理参考图。');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}
