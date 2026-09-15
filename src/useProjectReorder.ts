import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

type Drag = { id: string; targetId: string | null };
type Rect = { left: number; top: number };

export function useProjectReorder(enabled: boolean, context: string, ids: string[], onReorder: (ids: string[]) => Promise<unknown>) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const commit = useRef(onReorder); commit.current = onReorder;
  const gridRef = useRef<HTMLElement | null>(null);
  const before = useRef(new Map<string, Rect>());
  const animations = useRef<Animation[]>([]);
  const idsKey = [...ids].sort().join('\0');
  useEffect(() => { cancel.current?.(); }, [enabled, context, idsKey]);
  useEffect(() => () => { cancel.current?.(); animations.current.forEach(animation => animation.cancel()); }, []);

  // Animate the existing slots to their new layout. Terminals keep their nodes,
  // buffers and dimensions; only the surrounding slots move.
  useLayoutEffect(() => {
    animations.current.forEach(animation => animation.cancel()); animations.current = [];
    const grid = gridRef.current;
    if (!grid || matchMedia('(prefers-reduced-motion: reduce)').matches) { before.current.clear(); return; }
    for (const slot of grid.querySelectorAll<HTMLElement>(':scope > [data-project-slot]')) {
      const previous = before.current.get(slot.dataset.projectSlot!);
      if (!previous || slot.dataset.projectSlot === drag?.id || !slot.getClientRects().length) continue;
      const next = slot.getBoundingClientRect();
      const dx = previous.left - next.left, dy = previous.top - next.top;
      if (Math.abs(dx) + Math.abs(dy) < 1) continue;
      animations.current.push(slot.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 250, easing: 'cubic-bezier(.2,.85,.25,1)' }));
    }
    before.current.clear();
  }, [order]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (cancel.current) return;
    suppressClick.current = false;
    if (!enabled || event.button !== 0 || !event.isPrimary || event.ctrlKey || event.altKey || event.metaKey) return;
    const element = event.target as Element;
    const header = element.closest<HTMLElement>('.panel-header');
    const panel = header?.closest<HTMLElement>('[data-project-id]');
    if (!header || !panel || element.closest('button:not(.panel-name), [role="menu"]')) return;
    const grid = event.currentTarget; gridRef.current = grid;
    const area = grid.closest<HTMLElement>('.grid-area')!;
    const sourceId = panel.dataset.projectId!;
    const pointerId = event.pointerId;
    const origin = panel.getBoundingClientRect();
    const startX = event.clientX, startY = event.clientY;
    let x = startX, y = startY, active = false, ended = false, settling = false, frame = 0;
    let draft = [...ids]; let landing: Animation | undefined; let lastIndex = ids.indexOf(sourceId);
    const slots = () => [...grid.querySelectorAll<HTMLElement>(':scope > [data-project-slot]')];
    const snapshot = () => { before.current = new Map(slots().filter(slot => slot.getClientRects().length).map(slot => [slot.dataset.projectSlot!, slot.getBoundingClientRect()])); };
    const hit = () => {
      const viewport = area.getBoundingClientRect();
      if (x < viewport.left || x > viewport.right || y < viewport.top || y > viewport.bottom) return null;
      const bounds = grid.getBoundingClientRect();
      // Offset coordinates ignore in-flight FLIP transforms, avoiding reorder
      // oscillation when a neighboring card animates underneath the pointer.
      return slots().find(slot => slot.getClientRects().length && x >= bounds.left + slot.offsetLeft && x <= bounds.left + slot.offsetLeft + slot.offsetWidth && y >= bounds.top + slot.offsetTop && y <= bounds.top + slot.offsetTop + slot.offsetHeight)?.dataset.projectSlot || null;
    };
    const update = () => {
      panel.style.setProperty('--drag-x', `${x - startX}px`);
      panel.style.setProperty('--drag-y', `${y - startY}px`);
      const targetId = hit();
      if (!targetId) { lastIndex = -1; return; }
      const index = slots().findIndex(slot => slot.dataset.projectSlot === targetId);
      if (index === lastIndex) return;
      lastIndex = index;
      if (targetId === sourceId) return;
      const from = draft.indexOf(sourceId), to = draft.indexOf(targetId);
      if (from < 0 || to < 0 || from === to) return;
      const next = [...draft]; next.splice(from, 1); next.splice(to, 0, sourceId);
      snapshot(); draft = next; setOrder(next); setDrag({ id: sourceId, targetId });
    };
    const scroll = () => {
      if (ended || !active || settling) return;
      const box = area.getBoundingClientRect();
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
        const direction = y < box.top + 42 ? -1 : y > box.bottom - 42 ? 1 : 0;
        const old = area.scrollTop;
        if (direction) area.scrollTop += direction * 12;
        if (old !== area.scrollTop) update();
      }
      frame = requestAnimationFrame(scroll);
    };
    const activate = () => {
      if (ended || active) return;
      active = true; suppressClick.current = true;
      // Capture on the stable grid: moving a card's DOM node must not cancel
      // the pointer gesture or leave its terminal in a selection operation.
      grid.setPointerCapture(pointerId);
      for (const [name, value] of Object.entries({ left: origin.left, top: origin.top, width: origin.width, height: origin.height })) panel.style.setProperty(`--drag-${name}`, `${value}px`);
      panel.style.setProperty('--drag-x', `${x - startX}px`); panel.style.setProperty('--drag-y', `${y - startY}px`);
      setOrder(draft); setDrag({ id: sourceId, targetId: null });
      window.getSelection()?.removeAllRanges(); frame = requestAnimationFrame(scroll);
    };
    const timer = window.setTimeout(activate, 260);
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId || settling) return;
      x = event.clientX; y = event.clientY;
      if (!active && Math.hypot(x - startX, y - startY) >= 6) activate();
      if (active) { event.preventDefault(); update(); }
    };
    const detach = () => {
      window.clearTimeout(timer); cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', canceled);
      document.removeEventListener('keydown', key, true); window.removeEventListener('blur', abort); grid.removeEventListener('lostpointercapture', abort);
      if (grid.hasPointerCapture(pointerId)) grid.releasePointerCapture(pointerId);
    };
    const clear = () => { ended = true; landing?.cancel(); cancel.current = null; setDrag(null); setOrder(null); };
    const finish = (save: boolean) => {
      if (ended || settling) return;
      detach();
      if (!active) { clear(); return; }
      settling = true;
      const changed = draft.some((id, index) => id !== ids[index]);
      const persist = save && !!hit() && changed;
      if (!persist) { snapshot(); draft = [...ids]; setOrder(draft); }
      requestAnimationFrame(() => {
        if (ended) return;
        const slot = slots().find(slot => slot.dataset.projectSlot === sourceId);
        if (!slot) { clear(); return; }
        const target = slot.getBoundingClientRect();
        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
        landing = panel.animate([{ transform: getComputedStyle(panel).transform }, { transform: `translate3d(${target.left - origin.left}px, ${target.top - origin.top}px, 0) scale(1)` }], { duration: reduced ? 0 : 170, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'forwards' });
        Promise.all([landing.finished.catch(() => {}), persist ? commit.current(draft) : Promise.resolve()]).finally(() => { if (!ended) clear(); });
      });
    };
    const up = (event: globalThis.PointerEvent) => { if (event.pointerId === pointerId) { x = event.clientX; y = event.clientY; finish(true); } };
    const canceled = (event: globalThis.PointerEvent) => { if (event.pointerId === pointerId) finish(false); };
    const abort = () => { detach(); clear(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); } };
    cancel.current = abort;
    document.addEventListener('pointermove', move, { passive: false }); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', canceled);
    document.addEventListener('keydown', key, true); window.addEventListener('blur', abort); grid.addEventListener('lostpointercapture', abort);
  };
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); }
  };
  return { drag, order, onPointerDown, onClickCapture };
}
