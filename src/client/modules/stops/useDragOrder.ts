import { useRef, useState } from 'preact/hooks';
import { landingIndex, type Row } from './reorder';

/** Holding a row this close to the edge of the panel scrolls it, for lists longer than the screen. */
const EDGE_PX = 56;
const SCROLL_PX = 7;
/** A row picked up near the edge must stay put until the finger really heads that way. */
const HEADING_PX = 10;

export interface DragView {
  from: number;
  to: number;
  dy: number;
  height: number;
}

interface Gesture {
  id: string;
  from: number;
  to: number;
  rows: Row[];
  scroller: HTMLElement;
  startY: number;
  startScroll: number;
  y: number;
  frame: number;
}

function scrollParent(el: HTMLElement): HTMLElement {
  for (let at = el.parentElement; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return at;
  }
  return document.documentElement;
}

/** Pointer events, so one path covers fingers on Android and iPhone and a mouse on a laptop. */
export function useDragOrder(onDrop: (id: string, to: number) => void) {
  const [drag, setDrag] = useState<DragView | null>(null);
  const gesture = useRef<Gesture | null>(null);

  const update = (g: Gesture) => {
    const row = g.rows[g.from] as Row;
    const dy = g.y - g.startY + g.scroller.scrollTop - g.startScroll;
    g.to = landingIndex(g.rows, g.from, row.top + row.height / 2 + dy);
    setDrag({ from: g.from, to: g.to, dy, height: row.height });
  };

  const edgeScroll = () => {
    const g = gesture.current;
    if (!g) return;
    const box = g.scroller.getBoundingClientRect();
    const up = g.y < box.top + EDGE_PX && g.y < g.startY - HEADING_PX;
    const down = g.y > box.bottom - EDGE_PX && g.y > g.startY + HEADING_PX;
    const by = up ? -SCROLL_PX : down ? SCROLL_PX : 0;
    if (by) {
      g.scroller.scrollTop += by;
      update(g);
    }
    g.frame = requestAnimationFrame(edgeScroll);
  };

  const end = (drop: boolean) => {
    const g = gesture.current;
    if (!g) return;
    cancelAnimationFrame(g.frame);
    gesture.current = null;
    setDrag(null);
    if (drop && g.to !== g.from) onDrop(g.id, g.to);
  };

  const grip = (id: string, index: number) => ({
    onPointerDown(e: PointerEvent) {
      const handle = e.currentTarget as HTMLElement;
      const list = handle.closest('.timeline');
      if (e.button !== 0 || !list) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const scroller = scrollParent(handle);
      const rows = [...list.children].map((el) => {
        const { top, height } = el.getBoundingClientRect();
        return { top, height };
      });
      const g: Gesture = { id, from: index, to: index, rows, scroller, startY: e.clientY, startScroll: scroller.scrollTop, y: e.clientY, frame: 0 };
      gesture.current = g;
      update(g);
      g.frame = requestAnimationFrame(edgeScroll);
    },
    onPointerMove(e: PointerEvent) {
      const g = gesture.current;
      if (!g) return;
      g.y = e.clientY;
      update(g);
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    onLostPointerCapture: () => end(false),
  });

  return { drag, grip };
}
