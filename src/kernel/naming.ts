// 命名规则表(TREE-05)—— 规则以代码 + 单测形式入档,T10 导入 / T12 AI 落入直接复用。
// 规则:导入 = 文件名去后缀;AI = prompt 前 12 字符;实例继承资产名;
//       自动命名遇重复加序号(「名称 2」起);组 =「组 N」;手动重命名允许重名(不强制唯一)。

export const NAME_MAX = 60; // 与项目名同限(PROJ 边界 2 口径)

/** 通用清洗:去首尾空白、折叠换行、按码点截断到 60(中文安全) */
export function sanitizeName(raw: string): string {
  const s = raw.replace(/[\r\n\t]+/g, ' ').trim();
  return Array.from(s).slice(0, NAME_MAX).join('');
}

/** 导入命名:文件名去路径、去最后一个扩展名;空则「未命名」 */
export function nameFromFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base; // dot=0(纯 .gitignore 类)不截
  return sanitizeName(stem) || '未命名';
}

/** AI 命名:prompt 前 12 个字符(按码点计,中文安全);空则「AI 模型」 */
export function nameFromPrompt(prompt: string): string {
  const s = sanitizeName(prompt);
  return Array.from(s).slice(0, 12).join('') || 'AI 模型';
}

/** 重复加序号:base 未占用则原样;否则「base 2」「base 3」… 取最小可用序号 */
export function dedupeName(base: string, taken: Iterable<string>): string {
  const set = taken instanceof Set ? (taken as Set<string>) : new Set(taken);
  const b = sanitizeName(base) || '未命名';
  if (!set.has(b)) return b;
  for (let k = 2; ; k++) {
    const cand = `${b} ${k}`;
    if (!set.has(cand)) return cand;
  }
}

/** 组命名:「组 N」,N 取最小未占用正整数 */
export function nextGroupName(taken: Iterable<string>): string {
  const set = taken instanceof Set ? (taken as Set<string>) : new Set(taken);
  for (let n = 1; ; n++) {
    const cand = `组 ${n}`;
    if (!set.has(cand)) return cand;
  }
}
