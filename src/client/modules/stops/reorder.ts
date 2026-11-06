export function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

export interface Row {
  top: number;
  height: number;
}

/** Where a dragged row would land: past every row whose middle it has crossed. */
export function landingIndex(rows: readonly Row[], from: number, centre: number): number {
  let to = from;
  rows.forEach((row, i) => {
    const middle = row.top + row.height / 2;
    if (i < from && centre < middle) to = Math.min(to, i);
    if (i > from && centre > middle) to = Math.max(to, i);
  });
  return to;
}

/** How far a row slides to make room for the one being dragged. */
export function slide(index: number, from: number, to: number, height: number): number {
  if (index > from && index <= to) return -height;
  if (index < from && index >= to) return height;
  return 0;
}
