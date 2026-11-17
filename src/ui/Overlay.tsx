import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "./icons";

/** Global flag so the timer ignores keys while a modal/menu is open. */
let openLayers = 0;
export const layersOpen = () => openLayers > 0;
function useLayer() {
  useEffect(() => {
    openLayers++;
    return () => {
      openLayers--;
    };
  }, []);
}

export function Modal({ title, onClose, children, footer, wide, testId }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; testId?: string }) {
  useLayer();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={"sheet" + (wide ? " wide" : "")} role="dialog" data-testid={testId}>
        <div className="sheet-head">
          <h3>{title}</h3>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            <IconClose size={14} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label?: ReactNode;
  meta?: ReactNode;
  onSelect?: () => void;
  sep?: boolean;
  group?: string;
  selected?: boolean;
  danger?: boolean;
  testId?: string;
}

export function Menu({ anchor, items, onClose, minWidth }: { anchor: DOMRect; items: MenuItem[]; onClose: () => void; minWidth?: number }) {
  useLayer();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 6 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = anchor.left;
    let top = anchor.bottom + 6;
    if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, anchor.top - r.height - 6);
    setPos({ left, top });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    setTimeout(() => window.addEventListener("mousedown", down), 0);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  return createPortal(
    <div className="menu" ref={ref} style={{ left: pos.left, top: pos.top, minWidth }} role="menu">
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="sep" />
        ) : it.group ? (
          <div key={i} className="grp">
            {it.group}
          </div>
        ) : (
          <button
            key={i}
            className={"item" + (it.selected ? " sel" : "")}
            style={it.danger ? { color: "var(--bad)" } : undefined}
            data-testid={it.testId}
            onClick={() => {
              onClose();
              it.onSelect?.();
            }}
          >
            <span>{it.label}</span>
            {it.meta != null && <span className="meta">{it.meta}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Hook helper: open a menu anchored to the clicked element. */
export function useMenu() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return {
    anchor,
    open: (e: { currentTarget: Element }) => setAnchor(e.currentTarget.getBoundingClientRect()),
    close: () => setAnchor(null),
  };
}

export function Toggle({ on, onChange, testId }: { on: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return <button className={"toggle" + (on ? " on" : "")} onClick={() => onChange(!on)} role="switch" aria-checked={on} data-testid={testId} />;
}

export function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.v)} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function confirmDialog(text: string): boolean {
  // Synchronous confirm is acceptable for destructive actions; WKWebView shows a native sheet.
  return window.confirm(text);
}
