// @vitest-environment jsdom
import '../test/setup-dom';
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { lastExport, resetExport } from '../test/setup';

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

function barInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('.formula-bar input') as HTMLInputElement;
}

function adoptButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '一次性采纳全部' });
}

/** 打开假设工作区，预演一格候选 */
async function previewOne(
  user: ReturnType<typeof userEvent.setup>,
  addr: string,
  raw: string,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: '假设修改' }));
  const addrInput = screen.getByPlaceholderText('A1');
  const rawInput = screen.getByPlaceholderText('例如 =B1+1，留空表示清空该格');
  await user.clear(addrInput);
  await user.type(addrInput, addr);
  await user.clear(rawInput);
  await user.type(rawInput, raw);
  await user.click(screen.getByRole('button', { name: '预演整组修改' }));
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

describe('质检员复核工作流：空编辑 / 确认 / 取消 / 预演采纳 / 导出', () => {
  beforeEach(() => {
    resetExport();
  });

  it('两种空编辑不落修订；Enter 仅一次提交；Esc 取消保留原格与下游；预演只认真实版本；导出与修订号对应', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);

    // 演示网格含下游公式（B1/C1...）与错误传播（F1/F2 环 + F3 下游，H2 除零 + H3 下游）
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('8');
    expect(cellDiv(container, 'H2').textContent).toBe('#DIV/0!');
    expect(cellDiv(container, 'H3').textContent).toBe('#DIV/0!');
    expect(cellDiv(container, 'F1').textContent).toBe('#CYCLE!');
    expect(cellDiv(container, 'F3').textContent).toBe('#CYCLE!');

    // —— 基于 r1 建立一个有效预演：A1 8 -> 80 ——
    await previewOne(user, 'A1', '80');
    expect(adoptButton()).not.toBeDisabled();
    expect(container.querySelector('.hyp-stale')).toBeNull();

    // —— 空编辑①：公式栏聚焦、一字未改即点到别处 ——
    await user.click(cellDiv(container, 'A1'));
    expect(barInput(container).value).toBe('8');
    await user.click(barInput(container)); // 聚焦公式栏
    await user.click(cellDiv(container, 'B1')); // 原样失焦
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('8');
    expect(await exactOf(user, container, 'B1')).toBe('14');

    // 空编辑不使有效预演失效
    expect(adoptButton()).not.toBeDisabled();
    expect(container.querySelector('.hyp-stale')).toBeNull();

    // —— 空编辑②：双击网格进入编辑、原样离开 ——
    await user.dblClick(cellDiv(container, 'A1'));
    let cellEditor = cellEl(container, 'A1').querySelector(
      'input.cell-input',
    ) as HTMLInputElement;
    expect(cellEditor).not.toBeNull();
    expect(cellEditor.value).toBe('8');
    await user.click(cellDiv(container, 'C1')); // 原样失焦提交
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('8');
    expect(await exactOf(user, container, 'B1')).toBe('14');

    // 两种空编辑之后，预演仍可采纳
    expect(adoptButton()).not.toBeDisabled();
    expect(container.querySelector('.hyp-stale')).toBeNull();

    // —— Enter 确认：一次确认只形成一次提交 ——
    await user.click(cellDiv(container, 'A1'));
    await user.click(barInput(container));
    await user.clear(barInput(container));
    await user.type(barInput(container), '40');
    await user.keyboard('{Enter}');
    expect(revisionOf(container)).toBe(2); // r1 -> r2，只 +1，而非 +2
    expect(barInput(container).value).toBe('40');
    expect(cellDiv(container, 'A1').textContent).toBe('40');
    // 下游只重算一次且精确：B1 = 40+3*2 = 46，C1 = B1 - A1/A2 = 46 - 40/3 = 98/3
    expect(await exactOf(user, container, 'B1')).toBe('46');
    expect(await exactOf(user, container, 'C1')).toBe('98/3');

    // 真实修订使旧预演（依据 r1）过期：采纳禁用、出现过期提示
    expect(adoptButton()).toBeDisabled();
    expect(container.querySelector('.hyp-stale')).not.toBeNull();

    // 基于当前 r2 重新预演
    await user.click(screen.getByRole('button', { name: '预演整组修改' }));
    expect(adoptButton()).not.toBeDisabled();
    expect(container.querySelector('.hyp-stale')).toBeNull();

    // —— Esc 取消：未确认的值绝不写入正式格，不重算下游，不加修订 ——
    await user.click(cellDiv(container, 'A1'));
    await user.click(barInput(container));
    await user.type(barInput(container), '999'); // 草稿 40999，未确认
    await user.keyboard('{Escape}');
    expect(barInput(container).value).toBe('40'); // 公式栏还原原文
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'A1').textContent).toBe('40');
    expect(await exactOf(user, container, 'B1')).toBe('46');
    expect(await exactOf(user, container, 'C1')).toBe('98/3');
    // 取消操作不使有效预演失效
    expect(adoptButton()).not.toBeDisabled();
    expect(container.querySelector('.hyp-stale')).toBeNull();

    // 取消后导出：不得包含本应取消的内容，版本数仍对应 r2
    await user.click(screen.getByRole('button', { name: '导出 JSON 快照' }));
    const canceledExport = JSON.parse(lastExport()) as {
      revision: number;
      cells: { addr: string; raw: string }[];
    };
    expect(canceledExport.revision).toBe(2);
    expect(canceledExport.cells.find((c) => c.addr === 'A1')!.raw).toBe('40');
    expect(JSON.stringify(canceledExport)).not.toContain('999');

    // 旧的、依据 r1 的预演已被证明不可采纳；当前依据 r2 的预演可以采纳
    await user.click(adoptButton());
    expect(revisionOf(container)).toBe(3);
    expect(cellDiv(container, 'A1').textContent).toBe('80');
    // 预演采纳后的下游：B1 = 80+6 = 86，B2 = 80/3，C1 = 86 - 80/3 = 178/3
    expect(await exactOf(user, container, 'B1')).toBe('86');
    expect(await exactOf(user, container, 'B2')).toBe('80/3');
    expect(await exactOf(user, container, 'C1')).toBe('178/3');
    // 与本次修改无关的错误传播保持标记
    expect(cellDiv(container, 'H2').textContent).toBe('#DIV/0!');
    expect(cellDiv(container, 'H3').textContent).toBe('#DIV/0!');
    expect(cellDiv(container, 'F1').textContent).toBe('#CYCLE!');
    expect(cellDiv(container, 'F3').textContent).toBe('#CYCLE!');

    // 采纳后导出：版本 r3、精确值与错误来源都落在导出 JSON 中
    resetExport();
    await user.click(screen.getByRole('button', { name: '导出 JSON 快照' }));
    const adopted = JSON.parse(lastExport()) as {
      revision: number;
      cells: {
        addr: string;
        raw: string;
        value: { n: string; d: string } | null;
        error: { type: string; source: string; path: string[] } | null;
      }[];
    };
    expect(adopted.revision).toBe(3);
    const find = (a: string) => adopted.cells.find((c) => c.addr === a)!;
    expect(find('A1').raw).toBe('80');
    expect(find('B1').value).toEqual({ n: '86', d: '1' });
    expect(find('B2').value).toEqual({ n: '80', d: '3' });
    expect(find('C1').value).toEqual({ n: '178', d: '3' });
    expect(find('H2').error?.type).toBe('divzero');
    expect(find('H2').error?.source).toBe('H2');
    expect(find('H3').error?.path).toEqual(['H2', 'H3']);
    expect(find('F1').error?.type).toBe('cycle');
    expect(JSON.stringify(adopted)).not.toContain('999');
    // 本用例包含数十次用户交互，在高负载 CI/容器上需放宽超时（正常机器约 2s）
  }, 120_000);

  it('网格内双击编辑：Esc 取消不写格、不加修订、不使预演失效；Enter 只提交一次', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);

    await previewOne(user, 'A1', '80');
    expect(adoptButton()).not.toBeDisabled();

    // Esc 取消：草稿 777 必须丢弃（即便 Esc 后发生失焦）
    await user.dblClick(cellDiv(container, 'A1'));
    let editor = cellEl(container, 'A1').querySelector(
      'input.cell-input',
    ) as HTMLInputElement;
    await user.clear(editor);
    await user.type(editor, '777');
    await user.keyboard('{Escape}');
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('8');
    expect(await exactOf(user, container, 'B1')).toBe('14');
    expect(adoptButton()).not.toBeDisabled();

    // 导出不含被取消的草稿
    await user.click(screen.getByRole('button', { name: '导出 JSON 快照' }));
    expect(JSON.parse(lastExport()).revision).toBe(1);
    expect(lastExport()).not.toContain('777');

    // Enter 确认：一次提交、一次修订，下游精确更新，随后预演真实过期
    await user.dblClick(cellDiv(container, 'A1'));
    editor = cellEl(container, 'A1').querySelector('input.cell-input') as HTMLInputElement;
    await user.clear(editor);
    await user.type(editor, '50');
    await user.keyboard('{Enter}');
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'A1').textContent).toBe('50');
    expect(await exactOf(user, container, 'B1')).toBe('56');
    expect(adoptButton()).toBeDisabled();
  }, 60_000);
});
