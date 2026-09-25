import { useEffect, useRef, useState } from 'react';
import type { CellState } from '../engine/engine';

interface CellProps {
  state: CellState | undefined;
  selected: boolean;
  onSelect: () => void;
  onCommit: (text: string) => void;
  onMove: (dr: number, dc: number) => void;
  editing: boolean;
  onBeginEdit: () => void;
  onEndEdit: () => void;
}

/** 单元格错误在网格中的标记文字 */
export function errorCode(state: CellState): string {
  switch (state.error!.type) {
    case 'parse':
      return '#ERR!';
    case 'cycle':
      return '#CYCLE!';
    case 'divzero':
      return '#DIV/0!';
  }
}

/** 错误格 <td> 外壳的背景样式（由 Grid 应用） */
export function shellClass(state: CellState | undefined): string {
  if (!state?.error) return '';
  if (state.error.type === 'cycle' && state.error.cycle) return 'cell-cycle';
  return state.error.source === state.key
    ? 'cell-error-source'
    : 'cell-error-downstream';
}

export function Cell({
  state,
  selected,
  onSelect,
  onCommit,
  onMove,
  editing,
  onBeginEdit,
  onEndEdit,
}: CellProps) {
  const [draft, setDraft] = useState(state?.raw ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  /** 本次编辑会话是否已由 Enter/Esc/Tab 终结，防止随后失焦再次提交（取消也不得落格） */
  const settledRef = useRef(false);

  useEffect(() => {
    if (editing) {
      settledRef.current = false;
      setDraft(state?.raw ?? '');
      inputRef.current?.focus();
    }
  }, [editing, state]);

  // 非编辑状态下直接敲入字符：以该字符开启编辑
  useEffect(() => {
    if (!editing) return;
    const handler = (e: Event) => {
      const ch = (e as CustomEvent<string>).detail;
      setDraft(ch);
      const el = inputRef.current;
      if (el) {
        el.setSelectionRange(ch.length, ch.length);
      }
    };
    window.addEventListener('cell-initial-char', handler);
    return () => window.removeEventListener('cell-initial-char', handler);
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="cell-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          // Enter/Esc/Tab 已终结本次会话则忽略失焦；
          // 普通失焦（点击别处）视为确认，内容未变时引擎侧不产生修订
          if (settledRef.current) return;
          settledRef.current = true;
          onCommit(draft);
          onEndEdit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // 先标记终结：可能触发的失焦不再二次提交，一次确认只产生一次修订
            settledRef.current = true;
            onCommit(draft);
            onEndEdit();
            onMove(1, 0);
            e.preventDefault();
          } else if (e.key === 'Escape') {
            // 取消：不提交草稿，标记终结以防失焦把未确认内容写入正式格
            settledRef.current = true;
            onEndEdit();
            e.preventDefault();
          } else if (e.key === 'Tab') {
            settledRef.current = true;
            onCommit(draft);
            onEndEdit();
            onMove(0, e.shiftKey ? -1 : 1);
            e.preventDefault();
          }
          e.stopPropagation();
        }}
      />
    );
  }

  const classes = ['cell'];
  if (state && !state.error) classes.push('number'); // 结果值右对齐
  if (selected) classes.push('selected');

  let content: React.ReactNode = '';
  if (state?.error) {
    content = (
      <span className="err-mark" title={state.error.message}>
        {errorCode(state)}
      </span>
    );
  } else if (state) {
    content = state.value!.toDisplayString();
  }

  return (
    <div
      className={classes.join(' ')}
      onClick={(e) => {
        onSelect();
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        onSelect();
        onBeginEdit();
        e.stopPropagation();
      }}
      title={state?.error ? state.error.message : state?.raw}
    >
      {content}
    </div>
  );
}
