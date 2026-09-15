import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

type Drag = { id: string; targetId: string | null; x: number; y: number };

export function useProjectReorder(enabled: boolean, context: string, onSwap: (source: string, target: string) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const swap = useRef(onSwap);
  swap.current = onSwap;
  useEffect(() => { cancel.current?.(); }, [enabled, context]);
  useEffect(() => () => cancel.current?.(), []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    suppressClick.current = false;
    if (!enabled || event.button !== 0 || !event.isPrimary || event.ctrlKey || event.altKey || event.metaKey || cancel.current) return;
    const element = event.target as Element;
    const header = element.closest<HTMLElement>('.panel-header');
    const panel = header?.closest<HTMLElement>('[data-project-id]');
    if (!header || !panel || element.closest('button:not(.panel-name), [role="menu"]')) return;
    const id = panel.dataset.projectId!;
    const area = panel.closest<HTMLElement>('.grid-area')!;
    const pointerId = event.pointerId;
    const origin = { x: event.clientX, y: event.clientY };
    let x = origin.x, y = origin.y, active = false, finished = false, frame = 0;
    const targetAtPointer = () => {
      const target = document.elementsFromPoint(x, y).map(item => item.closest<HTMLElement>('[data-project-id]')).find(item => item && item.dataset.projectId !== id && area.contains(item));
      return target?.dataset.projectId || null;
    };
    const update = () => setDrag({ id, targetId: targetAtPointer(), x, y });
    const scroll = () => {
      if (finished || !active) return;
      const box = area.getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        const direction = y < box.top + 42 ? -1 : y > box.bottom - 42 ? 1 : 0;
        const before = area.scrollTop;
        if (direction) area.scrollTop += direction * 12;
        if (area.scrollTop !== before) update();
      }
      frame = requestAnimationFrame(scroll);
    };
    const activate = () => {
      if (finished || active) return;
      active = true; suppressClick.current = true;
      header.setPointerCapture(pointerId);
      window.getSelection()?.removeAllRanges();
      update(); frame = requestAnimationFrame(scroll);
    };
    const timer = window.setTimeout(activate, 260);
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      x = event.clientX; y = event.clientY;
      if (!active && Math.hypot(x - origin.x, y - origin.y) >= 6) activate();
      if (active) { event.preventDefault(); update(); }
    };
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timer); cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', canceled);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
      header.removeEventListener('lostpointercapture', blur);
      if (header.hasPointerCapture(pointerId)) header.releasePointerCapture(pointerId);
      cancel.current = null; setDrag(null);
      if (active && commit) {
        const target = targetAtPointer();
        if (target) swap.current(id, target);
      }
    };
    const up = (event: globalThis.PointerEvent) => { if (event.pointerId === pointerId) { x = event.clientX; y = event.clientY; finish(true); } };
    const canceled = (event: globalThis.PointerEvent) => { if (event.pointerId === pointerId) finish(false); };
    const blur = () => finish(false);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); } };
    cancel.current = blur;
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', canceled);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    header.addEventListener('lostpointercapture', blur);
  };
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
  };
  return { drag, onPointerDown, onClickCapture };
}
