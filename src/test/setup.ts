/**
 * jsdom 没有真实下载，也不实现 Blob.text / URL.createObjectURL；
 * 这里把“导出 JSON 快照”的产物同步收集到 lastExport，供验收测试读取。
 */
let lastExportValue = '';

export function lastExport(): string {
  return lastExportValue;
}

export function resetExport(): void {
  lastExportValue = '';
}

class BlobTextShim {
  private readonly textValue: string;
  readonly type: string;
  readonly size: number;

  constructor(parts: BlobPart[] = [], options: BlobPropertyBag = {}) {
    this.textValue = parts
      .map((p) => (p instanceof Uint8Array ? new TextDecoder().decode(p) : String(p)))
      .join('');
    this.type = options.type ?? '';
    this.size = this.textValue.length;
  }

  text(): string {
    return this.textValue;
  }
}

if (typeof window !== 'undefined') {
  const hrefStore = new Map<string, BlobTextShim>();
  let seq = 0;

  // 点击导出链接时拦截：同步读取 Blob 内容并阻止 jsdom 的“not implemented”导航
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
    configurable: true,
    value: function click(this: HTMLAnchorElement) {
      const blob = hrefStore.get(this.href);
      if (blob) lastExportValue = blob.text();
    },
  });

  URL.createObjectURL = ((blob: Blob) => {
    const url = `blob:test/${seq++}`;
    hrefStore.set(url, blob as unknown as BlobTextShim);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    hrefStore.delete(url);
  }) as typeof URL.revokeObjectURL;

  // App 使用 new Blob([json])：用可读取 text 的垫片替换
  (globalThis as { Blob: typeof Blob }).Blob =
    BlobTextShim as unknown as typeof Blob;
}
