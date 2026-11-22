/**
 * Scroll a list container just enough to show one row below its sticky header.
 *
 * Change only the container's own scroll position, so no ancestor moves. Read
 * offsets rather than client rectangles: the Larger text setting zooms the
 * app, which scales rectangles but not scroll positions. The container must be
 * the row's offset parent.
 *
 * @param container - The list's positioned scroll container.
 * @param header - The sticky header over the list's top edge, if any.
 */
export function keepRowInView(
  container: HTMLElement,
  row: HTMLElement,
  header: HTMLElement | null,
): void {
  const top = row.offsetTop - (header?.offsetHeight ?? 0)
  const bottom = row.offsetTop + row.offsetHeight - container.clientHeight
  if (container.scrollTop > top) {
    container.scrollTop = top
  } else if (container.scrollTop < bottom) {
    container.scrollTop = bottom
  }
}
