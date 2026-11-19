import { Loader2, Star } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { cx } from '../lib/format';
import { displayName, setDisplayName } from '../lib/identity';

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={cx('w-8 h-8 animate-spin text-haze-300', className)} />;

export function Rating({ value }: { value?: number }) {
  if (!value) return null;
  return <span className="inline-flex items-center gap-1 text-ember-300"><Star className="w-3.5 h-3.5 fill-current" />{value.toFixed(1)}</span>;
}

export function Modal({ open, onClose, children, wide }: { open: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center p-4 bg-black/70 backdrop-blur-sm animate-fadeIn" onClick={onClose}>
      <div className={cx('glass-strong rounded-3xl w-full shadow-lift animate-fadeUp', wide ? 'max-w-4xl' : 'max-w-md')} onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

/** Ask for a display name once (lightweight identity). Resolves immediately if already set. */
export function NamePrompt({ open, onDone, onCancel, title = 'What should we call you?' }: { open: boolean; onDone: (name: string) => void; onCancel: () => void; title?: string }) {
  const [name, setName] = useState(displayName() ?? '');
  return (
    <Modal open={open} onClose={onCancel}>
      <form className="p-7" onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; setDisplayName(name.trim()); onDone(name.trim()); }}>
        <div className="font-display text-2xl mb-1">{title}</div>
        <p className="text-sm text-haze-400 mb-5">Your name is shown to the people you watch with. No account needed.</p>
        <input autoFocus className="input mb-4" placeholder="Your name" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} data-testid="name-input" />
        <button className="btn-accent w-full" type="submit" disabled={!name.trim()} data-testid="name-submit">Continue</button>
      </form>
    </Modal>
  );
}

export function Pill({ children, tone = 'neutral', className }: { children: ReactNode; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'; className?: string }) {
  const tones = { neutral: 'bg-white/[.07] text-haze-200 border-white/10', ok: 'bg-ok/10 text-ok border-ok/25', warn: 'bg-warn/10 text-warn border-warn/25', bad: 'bg-bad/10 text-bad border-bad/25', accent: 'bg-ember-400/15 text-ember-300 border-ember-400/30' };
  return <span className={cx('inline-flex items-center gap-1 rounded-full border px-2.5 h-6 text-[11px] font-semibold tracking-wide', tones[tone], className)}>{children}</span>;
}

export function SectionTitle({ children, sub, action }: { children: ReactNode; sub?: string; action?: ReactNode }) {
  return (
    <div className="flex items-end gap-4 mb-3 px-4 sm:px-10">
      <div>
        <h2 className="font-display text-xl sm:text-2xl font-semibold tracking-tight">{children}</h2>
        {sub && <div className="text-xs text-haze-400 mt-0.5">{sub}</div>}
      </div>
      <div className="ml-auto">{action}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-center text-haze-400 py-16 px-6">{children}</div>;
}
