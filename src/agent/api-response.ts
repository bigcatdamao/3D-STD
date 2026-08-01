export function isJsonApiResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('application/json') || contentType.includes('+json');
}

export function serviceVersionMismatchMessage(serviceLabel: string): string {
  return `当前页面与 ${serviceLabel} 版本不一致。请刷新页面；本地测试需先部署同版本 Worker。`;
}
