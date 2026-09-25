// @vitest-environment jsdom
import '../test/setup-dom';
import { describe, expect, it, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { resetExport } from '../test/setup';

/** 解析 A1..T20 风格地址为网格 td 元素 */
function cellEl(container: HTMLElement, addr: string): HTMLElement {
  const m = /^([A-T])(\d{1,2})$/.exec(addr)!;
  const col = m[1].charCodeAt(0) - 65;
  const row = Number(m[2]) - 1;
  const tbody = container.querySelector('table.sheet tbody')!;
  const tr = tbody.querySelectorAll('tr')[row];
  // td[0] 是行号表头，A 列从 td[1] 开始
  return tr.querySelectorAll('td')[col + 1] as HTMLElement;
}

/** 非编辑态下格内展示的 div */
function cellDiv(container: HTMLElement, addr: string): HTMLElement {
  const el = cellEl(container, addr);
  return (el.querySelector('.cell') as HTMLElement) ?? el;
}

function revisionOf(container: HTMLElement): number {
  const m = /快照修订 r(\d+)/.exec(container.textContent ?? '')!;
  return Number(m[1]);
}

function importErrorBox(container: HTMLElement): HTMLElement | null {
  return container.querySelector('.import-error');
}

/** 选中某格并读取检查器中的精确分数 */
async function exactOf(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  addr: string,
): Promise<string> {
  await user.click(cellDiv(container, addr));
  const inspector = container.querySelector('.inspector')!;
  return inspector.querySelector('.value-ok')?.textContent ?? '';
}

/* --------------------- 受控文件读取：完成/拒绝顺序由测试决定 --------------------- */

interface ControlledRead {
  promise: Promise<string>;
  resolve: (v: string) => void;
  reject: (e?: unknown) => void;
}

function controlledRead(): ControlledRead {
  let resolve!: (v: string) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 读取耗时完全由测试控制的“文件”：text() 只在 resolve/reject 之后才落定 */
function controlledFile(name: string, read: ControlledRead): File {
  return { name, text: () => read.promise } as unknown as File;
}

/** 通过隐藏的文件输入选中文件：同步触发 onChange，导入自此开始读取 */
function chooseFile(container: HTMLElement, file: File): void {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

/** 让一次受控读取成功完成，并等待 React 应用其后续 */
async function settleRead(read: ControlledRead, text: string): Promise<void> {
  await act(async () => {
    read.resolve(text);
    await read.promise;
  });
}

/** 让一次受控读取失败，并等待 React 应用其后续 */
async function failRead(read: ControlledRead): Promise<void> {
  await act(async () => {
    read.reject(new Error('IO error'));
    await read.promise.catch(() => {});
  });
}

/** 构造一份合法的导出快照文本（导入校验只关心 format/version/cells） */
function snapshotJson(cells: Record<string, string>): string {
  return JSON.stringify({
    format: 'onsite-sheet',
    version: 1,
    exportedAt: '2026-09-25T00:00:00.000Z',
    revision: 0,
    cells: Object.entries(cells).map(([addr, raw]) => ({
      addr,
      raw,
      value: null,
      display: null,
      error: null,
    })),
  });
}

/** 双击网格编辑某格并以 Enter 确认 */
async function editCell(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  addr: string,
  text: string,
): Promise<void> {
  await user.dblClick(cellDiv(container, addr));
  const editor = cellEl(container, addr).querySelector(
    'input.cell-input',
  ) as HTMLInputElement;
  await user.clear(editor);
  await user.type(editor, text);
  await user.keyboard('{Enter}');
}

describe('导入与用户操作的先后顺序：迟到的旧结果不得改变当前工作簿', () => {
  beforeEach(() => {
    resetExport();
  });

  it('双文件：先选的大文件读取慢，后完成也不得覆盖后选的小文件', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);

    const slowRead = controlledRead(); // 先选中的大文件，读取慢
    chooseFile(container, controlledFile('big-budget.json', slowRead));
    const fastRead = controlledRead(); // 后选中的小文件，读取快
    chooseFile(container, controlledFile('small-budget.json', fastRead));

    // 小文件先完成：作为最新操作正常应用，公式依赖照常计算
    await settleRead(
      fastRead,
      snapshotJson({ A1: '5', B1: '=A1*2', C1: '=B1+A1' }),
    );
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('5');
    expect(cellDiv(container, 'B1').textContent).toBe('10');
    expect(cellDiv(container, 'C1').textContent).toBe('15');

    // 大文件随后完成：迟到的旧结果必须整体丢弃——表格、依赖、修订号都不动
    await settleRead(
      slowRead,
      snapshotJson({ A1: '999', B1: '=A1*3', D1: '7' }),
    );
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('5');
    expect(cellDiv(container, 'B1').textContent).toBe('10');
    expect(cellDiv(container, 'C1').textContent).toBe('15');
    expect(cellDiv(container, 'D1').textContent).toBe('');
    expect(container.textContent).toContain('3 个非空格');
    expect(importErrorBox(container)).toBeNull();
    // 检查器中的精确依赖结果仍属于小文件
    expect(await exactOf(user, container, 'C1')).toBe('15');
  });

  it('导入读取期间编辑单元格：迟到的导入不得撤销较新的编辑', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);

    const read = controlledRead();
    chooseFile(container, controlledFile('budget.json', read));

    // 读取期间：用户把 A1 从 8 改为 40（真实修订 r2）
    await editCell(user, container, 'A1', '40');
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'A1').textContent).toBe('40');

    // 导入迟到完成：不得覆盖编辑后的表格、下游依赖与修订号
    await settleRead(read, snapshotJson({ A1: '1', B1: '=A1+1' }));
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'A1').textContent).toBe('40');
    // 下游保持编辑后的精确结果：B1 = 40+3*2 = 46，C1 = 46-40/3 = 98/3
    expect(cellDiv(container, 'B1').textContent).toBe('46');
    expect(await exactOf(user, container, 'B1')).toBe('46');
    expect(await exactOf(user, container, 'C1')).toBe('98/3');
    expect(importErrorBox(container)).toBeNull();
  });

  it('导入读取期间载入演示：迟到的导入不得覆盖演示数据', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);

    const read = controlledRead();
    chooseFile(container, controlledFile('budget.json', read));

    // 读取期间：用户载入演示数据
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);

    // 导入迟到完成：演示数据与其错误标记原样保留
    await settleRead(read, snapshotJson({ A1: '42' }));
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('8');
    expect(cellDiv(container, 'B1').textContent).toBe('14');
    expect(cellDiv(container, 'F1').textContent).toBe('#CYCLE!');
    expect(cellDiv(container, 'H2').textContent).toBe('#DIV/0!');
    expect(importErrorBox(container)).toBeNull();
  });

  it('导入读取期间清空表格：迟到的导入不得把旧数据填回来', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);

    const read = controlledRead();
    chooseFile(container, controlledFile('budget.json', read));

    // 读取期间：用户清空整张表
    await user.click(screen.getByRole('button', { name: '清空' }));
    expect(revisionOf(container)).toBe(2);
    expect(container.textContent).toContain('0 个非空格');

    // 导入迟到完成：空表保持为空，修订号不回退
    await settleRead(read, snapshotJson({ A1: '42', B2: '=A1*2' }));
    expect(revisionOf(container)).toBe(2);
    expect(container.textContent).toContain('0 个非空格');
    expect(cellDiv(container, 'A1').textContent).toBe('');
    expect(cellDiv(container, 'B2').textContent).toBe('');
    expect(importErrorBox(container)).toBeNull();
  });

  it('旧文件非法而较新文件已成功：迟到的错误提示不得指向当前正常表格', async () => {
    const { container } = render(<App />);

    const badRead = controlledRead(); // 先选，内容非法
    chooseFile(container, controlledFile('old-bad.json', badRead));
    const goodRead = controlledRead(); // 后选，内容合法
    chooseFile(container, controlledFile('new-good.json', goodRead));

    // 较新的合法文件先完成并应用
    await settleRead(goodRead, snapshotJson({ A1: '7', B1: '=A1+3' }));
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('7');
    expect(cellDiv(container, 'B1').textContent).toBe('10');

    // 旧的非法文件随后完成：既不覆盖表格，也不弹出与当前表格无关的错误
    await settleRead(badRead, '{ 这不是合法 JSON');
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('7');
    expect(cellDiv(container, 'B1').textContent).toBe('10');
    expect(importErrorBox(container)).toBeNull();
  });

  it('读取失败：当前导入给出稳定失败提示且表格不动；过期的读取失败静默丢弃', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);

    // —— 最新操作的读取失败：必须让用户看到稳定的失败结果 ——
    const failing = controlledRead();
    chooseFile(container, controlledFile('broken.json', failing));
    await failRead(failing);
    const box = importErrorBox(container);
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain('broken.json');
    expect(box!.textContent).toContain('读取失败');
    expect(box!.textContent).toContain('导入未完成');
    // 表格与修订号不受影响
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('8');
    expect(cellDiv(container, 'H2').textContent).toBe('#DIV/0!');

    // 关掉错误条，准备验证过期读取失败不再报告
    await user.click(screen.getByRole('button', { name: '知道了' }));
    expect(importErrorBox(container)).toBeNull();

    // —— 读取期间用户载入演示：该导入已过期，其失败不得再打扰当前表格 ——
    const stale = controlledRead();
    chooseFile(container, controlledFile('stale.json', stale));
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(2);
    await failRead(stale);
    expect(importErrorBox(container)).toBeNull();
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'A1').textContent).toBe('8');
  });

  it('导入读取期间建立的假设预演：迟到的导入不得关闭工作区或使预演过期', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);

    const read = controlledRead();
    chooseFile(container, controlledFile('budget.json', read));

    // 读取期间发生真实编辑（使该导入过期），随后基于新修订建立预演
    await editCell(user, container, 'A1', '40');
    expect(revisionOf(container)).toBe(2);
    await user.click(screen.getByRole('button', { name: '假设修改' }));
    const addrInput = screen.getByPlaceholderText('A1');
    const rawInput = screen.getByPlaceholderText('例如 =B1+1，留空表示清空该格');
    await user.clear(addrInput);
    await user.type(addrInput, 'A1');
    await user.clear(rawInput);
    await user.type(rawInput, '80');
    await user.click(screen.getByRole('button', { name: '预演整组修改' }));
    const adopt = screen.getByRole('button', { name: '一次性采纳全部' });
    expect(adopt).not.toBeDisabled();
    expect(container.querySelector('.hyp-stale')).toBeNull();

    // 导入迟到完成：预演工作区、预演有效性、表格与修订号全部不受影响
    await settleRead(read, snapshotJson({ A1: '1', B1: '=A1+1' }));
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'A1').textContent).toBe('40');
    expect(screen.getByRole('button', { name: '预演整组修改' })).toBeDefined();
    expect(screen.getByRole('button', { name: '一次性采纳全部' })).not.toBeDisabled();
    expect(container.querySelector('.hyp-stale')).toBeNull();
    expect(importErrorBox(container)).toBeNull();

    // 预演仍可正常采纳：A1 -> 80，下游 B1 = 80+6 = 86
    await user.click(screen.getByRole('button', { name: '一次性采纳全部' }));
    expect(revisionOf(container)).toBe(3);
    expect(cellDiv(container, 'A1').textContent).toBe('80');
    expect(await exactOf(user, container, 'B1')).toBe('86');
  });

  it('合法单次导入保持原有行为：应用、计算依赖、关闭预演、清除旧错误；非法导入仍整份拒绝', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);

    // —— 单次非法导入（最新操作）：整份拒绝、列出原因、保留当前表 ——
    const bad = controlledRead();
    chooseFile(container, controlledFile('bad.json', bad));
    await settleRead(bad, '{"format":"onsite-sheet","version":1,"cells":"oops"}');
    const box = importErrorBox(container);
    expect(box).not.toBeNull();
    expect(box!.textContent).toContain('cells 必须是数组');
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('8');

    // 打开预演工作区，验证合法导入后不会沿用
    await user.click(screen.getByRole('button', { name: '假设修改' }));
    expect(screen.getByRole('button', { name: '预演整组修改' })).toBeDefined();

    // —— 单次合法导入（最新操作）：正常应用并清除旧错误条 ——
    const good = controlledRead();
    chooseFile(container, controlledFile('good.json', good));
    await settleRead(
      good,
      snapshotJson({ A1: '2', A2: '4', B1: '=A1*A2', B2: '=A2/A1', C1: '=B1+B2' }),
    );
    expect(revisionOf(container)).toBe(2);
    expect(importErrorBox(container)).toBeNull(); // 旧错误条已清除
    // 导入后选中 A1
    expect(container.querySelector('.formula-bar .addr-label')?.textContent).toBe('A1');
    expect(cellDiv(container, 'A1').textContent).toBe('2');
    expect(cellDiv(container, 'B1').textContent).toBe('8');
    expect(cellDiv(container, 'C1').textContent).toBe('10');
    // 依赖结果精确：B2 = 4/2 = 2，C1 = 8+2 = 10
    expect(await exactOf(user, container, 'B2')).toBe('2');
    expect(await exactOf(user, container, 'C1')).toBe('10');
    // 导入新网格后预演工作区不沿用
    expect(screen.queryByRole('button', { name: '预演整组修改' })).toBeNull();
  });
});
