// @vitest-environment jsdom
import '../test/setup-dom';
import { describe, expect, it, beforeEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
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

/* --------------------- 受控文件读取：精确控制完成/拒绝顺序 --------------------- */

interface ControlledFile {
  file: File;
  /** 手动让 file.text() 成功返回给定文本 */
  resolve: (text: string) => void;
  /** 手动让 file.text() 拒绝（模拟读取失败） */
  reject: (err: unknown) => void;
}

/** 构造一个 File，其 text() 返回由测试手动 settle 的 Promise */
function controlledFile(name: string): ControlledFile {
  let resolveFn: ((text: string) => void) | null = null;
  let rejectFn: ((err: unknown) => void) | null = null;
  const file = new File(['（内容由测试接管）'], name, {
    type: 'application/json',
  });
  file.text = () =>
    new Promise<string>((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
  return {
    file,
    // 委托到 text() 被调用时才捕获的 settle 函数（调用前 resolve/reject 尚不存在）
    resolve: (text) => resolveFn!(text),
    reject: (err) => rejectFn!(err),
  };
}

/** 构造一份合法的导出快照 JSON（当前文件格式：format/version/cells） */
function snapshotJson(cells: Record<string, string>): string {
  return JSON.stringify({
    format: 'onsite-sheet',
    version: 1,
    exportedAt: '2026-09-25T00:00:00.000Z',
    revision: 1,
    cells: Object.entries(cells).map(([addr, raw]) => ({
      addr,
      raw,
      value: null,
      display: null,
      error: null,
    })),
  });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

/** 选择文件：同步触发 onChange，导入流程运行到 await file.text() 处挂起 */
async function uploadFile(container: HTMLElement, file: File): Promise<void> {
  await act(async () => {
    fireEvent.change(fileInput(container), { target: { files: [file] } });
  });
}

/** 手动完成（或拒绝）一次读取，并等待导入后续（校验/落表/setState）全部落地 */
async function settleRead(settle: () => void): Promise<void> {
  await act(async () => {
    settle();
    // 让 await file.text() 的微任务续体在 act 作用域内执行完毕
    await Promise.resolve();
  });
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

describe('预算导入的先后顺序：迟到的旧结果不得覆盖当前工作簿', () => {
  beforeEach(() => {
    resetExport();
  });

  it('双文件：较晚导入先完成即生效；较早的大文件迟到后被丢弃，表格/依赖/修订号不变', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);

    // 先选大文件（读取慢、挂起），再选小文件
    const big = controlledFile('big-budget.json');
    const small = controlledFile('small-budget.json');
    await uploadFile(container, big.file);
    await uploadFile(container, small.file);

    // 小文件先读完成 → 生效：K1=5，K2=K1*3=15，修订 r1
    await settleRead(() =>
      small.resolve(snapshotJson({ K1: '5', K2: '=K1*3' })),
    );
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'K1').textContent).toBe('5');
    expect(await exactOf(user, container, 'K2')).toBe('15');

    // 大文件迟到 → 整体丢弃：不得覆盖表格、公式依赖结果与修订号，也不弹错误
    await settleRead(() =>
      big.resolve(snapshotJson({ A1: '1', B1: '=A1+1', C1: '=B1*2' })),
    );
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'K1').textContent).toBe('5');
    expect(await exactOf(user, container, 'K2')).toBe('15');
    // 大文件的内容一律未落格
    expect(cellDiv(container, 'A1').textContent).toBe('');
    expect(cellDiv(container, 'B1').textContent).toBe('');
    expect(container.querySelector('.import-error')).toBeNull();
    // 导出也只反映当前（小文件）网格
    await user.click(screen.getByRole('button', { name: '导出 JSON 快照' }));
    const exported = JSON.parse(lastExport()) as {
      revision: number;
      cells: { addr: string; raw: string }[];
    };
    expect(exported.revision).toBe(1);
    expect(exported.cells.map((c) => c.addr).sort()).toEqual(['K1', 'K2']);
  }, 60_000);

  it('导入读取期间改格子：迟到的导入结果被丢弃，手工编辑与下游重算保留', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);

    const late = controlledFile('late-budget.json');
    await uploadFile(container, late.file); // 读取挂起中

    // 读取期间手工改 A1：8 -> 40（r2），下游 B1 = 40+3*2 = 46
    await user.click(cellDiv(container, 'A1'));
    await user.click(barInput(container));
    await user.clear(barInput(container));
    await user.type(barInput(container), '40');
    await user.keyboard('{Enter}');
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'A1').textContent).toBe('40');

    // 旧导入迟到 → 丢弃：编辑、下游与演示数据的错误标记都保持
    await settleRead(() =>
      late.resolve(snapshotJson({ A1: '999', B1: '=A1' })),
    );
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'A1').textContent).toBe('40');
    expect(await exactOf(user, container, 'B1')).toBe('46');
    expect(await exactOf(user, container, 'C1')).toBe('98/3');
    expect(cellDiv(container, 'H2').textContent).toBe('#DIV/0!');
    expect(cellDiv(container, 'F1').textContent).toBe('#CYCLE!');
    expect(container.querySelector('.import-error')).toBeNull();
  }, 60_000);

  it('导入读取期间载入演示：迟到的导入不得撤销演示数据', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);

    const late = controlledFile('late-budget.json');
    await uploadFile(container, late.file); // 空表 r0 时发起导入，读取挂起

    // 读取期间载入演示（r1）
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('8');

    // 旧导入迟到 → 丢弃：演示网格与修订号原样保留
    await settleRead(() => late.resolve(snapshotJson({ A1: '7' })));
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('8');
    expect(await exactOf(user, container, 'B1')).toBe('14');
    expect(cellDiv(container, 'F1').textContent).toBe('#CYCLE!');
    expect(cellDiv(container, 'H2').textContent).toBe('#DIV/0!');
    expect(container.querySelector('.import-error')).toBeNull();
  }, 60_000);

  it('导入读取期间清空表格：迟到的导入不得把清空撤销', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);

    const late = controlledFile('late-budget.json');
    await uploadFile(container, late.file); // 读取挂起中

    // 读取期间清空（r2）
    await user.click(screen.getByRole('button', { name: '清空' }));
    expect(revisionOf(container)).toBe(2);
    expect(container.textContent).toContain('0 个非空格');

    // 旧导入迟到 → 丢弃：空表与修订号保持
    await settleRead(() => late.resolve(snapshotJson({ A1: '7' })));
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'A1').textContent).toBe('');
    expect(container.textContent).toContain('0 个非空格');
    expect(container.querySelector('.import-error')).toBeNull();
  }, 60_000);

  it('旧文件非法、新文件已生效：迟到的校验错误不弹出；当前最新导入非法时错误提示照常', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);

    // 先选（非法的）旧文件，再选（合法的）新文件
    const oldBad = controlledFile('old-bad.json');
    const newGood = controlledFile('new-good.json');
    await uploadFile(container, oldBad.file);
    await uploadFile(container, newGood.file);

    // 新文件先完成 → 生效：M1=2，M2=M1*10=20，修订 r1
    await settleRead(() =>
      newGood.resolve(snapshotJson({ M1: '2', M2: '=M1*10' })),
    );
    expect(revisionOf(container)).toBe(1);
    expect(await exactOf(user, container, 'M2')).toBe('20');

    // 旧文件迟到且内容非法 → 不得弹出指向当前正常表格的错误提示
    await settleRead(() =>
      oldBad.resolve(
        JSON.stringify({
          format: 'onsite-sheet',
          version: 1,
          cells: [{ addr: 'A1', raw: '=SUM(1)' }],
        }),
      ),
    );
    expect(container.querySelector('.import-error')).toBeNull();
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'M1').textContent).toBe('2');
    expect(await exactOf(user, container, 'M2')).toBe('20');

    // 对照：当前最新的一次导入若非法，错误提示照常出现且保留当前表（单次导入语义不变）
    const latestBad = controlledFile('latest-bad.json');
    await uploadFile(container, latestBad.file);
    await settleRead(() => latestBad.resolve('这不是 JSON'));
    expect(container.querySelector('.import-error')).not.toBeNull();
    expect(container.textContent).toContain('不是合法的 JSON 文件');
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'M1').textContent).toBe('2');
    expect(await exactOf(user, container, 'M2')).toBe('20');
    // 关闭提示后当前表仍正常
    await user.click(screen.getByRole('button', { name: '知道了' }));
    expect(container.querySelector('.import-error')).toBeNull();
  }, 60_000);

  it('读取失败：给出稳定失败提示，表格/修订号不变，有效预演不被连累', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);

    // 基于 r1 建立一个有效预演：A1 8 -> 80
    await previewOne(user, 'A1', '80');
    expect(adoptButton()).not.toBeDisabled();
    expect(container.querySelector('.hyp-stale')).toBeNull();

    // 发起导入后读取本身失败
    const broken = controlledFile('broken-budget.json');
    await uploadFile(container, broken.file);
    await settleRead(() => broken.reject(new Error('读取失败')));

    // 稳定的失败结果：明确告知导入未完成、当前表格未受影响
    expect(container.querySelector('.import-error')).not.toBeNull();
    expect(container.textContent).toContain('broken-budget.json');
    expect(container.textContent).toContain('导入未完成');
    // 表格、下游与修订号不变
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('8');
    expect(await exactOf(user, container, 'B1')).toBe('14');
    // 有效预演不被失败的导入连累：不过期、可采纳
    expect(adoptButton()).not.toBeDisabled();
    expect(container.querySelector('.hyp-stale')).toBeNull();
    await user.click(adoptButton());
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'A1').textContent).toBe('80');
    expect(await exactOf(user, container, 'B1')).toBe('86');
    // 失败提示可关闭
    await user.click(screen.getByRole('button', { name: '知道了' }));
    expect(container.querySelector('.import-error')).toBeNull();
  }, 60_000);

  it('合法单次导入保持原有语义：整份替换、公式重算、修订号 +1、非法文件整份拒绝', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);

    // 合法文件顺序完成 → 整份替换并全量重算（含环与除零标记）
    const good = controlledFile('budget.json');
    await uploadFile(container, good.file);
    await settleRead(() =>
      good.resolve(
        snapshotJson({
          P1: '10',
          P2: '=P1/4',
          Q1: '=Q2+1',
          Q2: '=Q1-1',
          R1: '0',
          R2: '=5/R1',
        }),
      ),
    );
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'P1').textContent).toBe('10');
    expect(await exactOf(user, container, 'P2')).toBe('5/2');
    expect(cellDiv(container, 'Q1').textContent).toBe('#CYCLE!');
    expect(cellDiv(container, 'R2').textContent).toBe('#DIV/0!');
    // 演示数据已被整份替换
    expect(cellDiv(container, 'A1').textContent).toBe('');
    expect(cellDiv(container, 'H2').textContent).toBe('');

    // 紧接一次非法导入 → 整份拒绝、保留上次有效表
    const bad = controlledFile('bad.json');
    await uploadFile(container, bad.file);
    await settleRead(() =>
      bad.resolve(
        JSON.stringify({
          format: 'onsite-sheet',
          version: 1,
          cells: [
            { addr: 'A1', raw: '1' },
            { addr: 'A1', raw: '2' },
          ],
        }),
      ),
    );
    expect(container.querySelector('.import-error')).not.toBeNull();
    expect(container.textContent).toContain('重复');
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'P1').textContent).toBe('10');
    expect(await exactOf(user, container, 'P2')).toBe('5/2');
  }, 60_000);
});
