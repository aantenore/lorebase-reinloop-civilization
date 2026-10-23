import { useRef, type ReactNode } from 'react';
import { useUi, type PanelId } from '../state/ui';
import { t } from '../i18n';

/** Header with collapse/expand toggle. Collapsed panels render as a slim rail showing just the title. */
export function PanelHead({ id, title, extra, children }: { id: PanelId; title: ReactNode; extra?: ReactNode; children?: ReactNode }) {
  const { prefs, toggle } = useUi();
  const collapsed = prefs.collapsed[id];
  return (
    <header className="panel-head">
      <button className="collapse-btn" onClick={() => toggle(id)} aria-expanded={!collapsed} title={collapsed ? t.layout.expand : t.layout.collapse}>
        <span className="chev" aria-hidden>▾</span>
      </button>
      <h2 onClick={() => collapsed && toggle(id)}>
        {title}
        {extra}
      </h2>
      {!collapsed && children}
    </header>
  );
}

export function panelClass(base: string, collapsed: boolean) {
  return `panel ${base} ${collapsed ? 'collapsed' : ''}`;
}

/** Drag handle that reports pixel deltas along one axis. */
export function ResizeHandle({ axis, onDelta, className }: { axis: 'x' | 'y'; onDelta(d: number): void; className?: string }) {
  const last = useRef<number | null>(null);
  return (
    <div
      className={`resize-handle ${axis} ${className ?? ''}`}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      title={t.layout.resize}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        last.current = axis === 'x' ? e.clientX : e.clientY;
        document.body.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        if (last.current == null) return;
        const cur = axis === 'x' ? e.clientX : e.clientY;
        onDelta(cur - last.current);
        last.current = cur;
      }}
      onPointerUp={() => {
        last.current = null;
        document.body.classList.remove('resizing');
      }}
    />
  );
}
