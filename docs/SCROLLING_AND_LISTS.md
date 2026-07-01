# Scrolling, visibility & long / virtualized lists

Three related problems and how the platform handles them.

## 1. Elements that only appear (or render) after you scroll

**Shipped — automatic.** When a step needs to click, hover, type into, or scroll
to an element, the runtime now *reveals* it first:

- If the element isn't in the DOM yet, the page is scrolled down ~one viewport
  at a time (between short polls) to trigger lazy-rendered / below-the-fold
  content, until the element appears or the step times out.
- Once found, the element is scrolled to the **centre of the viewport** and the
  runtime waits until its position is **stable** (no movement across two frames)
  before acting — so clicks don't miss a still-animating target.

This means you rarely need a manual *Scroll To Element* + *Wait* combo anymore.
It applies to Click / Hover / Type / Scroll-to-element. Pure **Wait for
Selector** steps deliberately do **not** scroll (a wait should observe, not move
the page).

Implementation: `waitForAny(..., { reveal })` + `scrollIntoViewSafe` in the
generated script.

## 2. Long lists that load more as you scroll — including virtualized/recycling lists

**Shipped — the "Collect List" step.**

Some lists lazy-load items as you scroll (infinite scroll). The harder case:
**virtualized** lists that also *remove* items from the DOM once they scroll out
of view (to keep memory low) — very common on URL-paginated result pages. A
normal *Extract List* only sees whatever is on screen at that instant, so it
would miss most rows.

**Collect List (infinite / virtual scroll)** (Extraction category) solves this
by harvesting *while* scrolling:

1. Extract the currently-rendered items.
2. Scroll ~one viewport (the window, or an inner scroll container you name).
3. Wait, extract again, and repeat.
4. **De-duplicate** by a key you choose (e.g. `link` or `id`; falls back to the
   whole row) so overlapping windows don't double-count.
5. Stop after N consecutive scrolls with **no new unique items** (or a safety
   cap on total scroll steps).

Because it collects continuously and de-dupes, it captures every item even when
the DOM only ever holds a small moving window. Memory is bounded by the number
of **unique** items, not the DOM.

Fields are configured exactly like *Extract List* (same editor, same AI
auto-detect, same per-field transforms/splits).

**Tips**
- Pick a **de-dupe key** that's stable and unique per item — a detail link or id
  is ideal. Without one, two genuinely-identical rows would collapse into one.
- If the list scrolls inside a `<div>` rather than the whole page, set the
  **scroll container selector**.
- Combine with **Pagination — URL Pages**: put *Collect List* in the pagination
  body; the de-dupe key spans pages, so overlaps between pages are removed too.

Implementation: `harvestWhileScrolling(...)` in the generated script.

## 3. Learning scroll/click intent from a recording — (proposed, not yet built)

The recorder already tracks scroll position and clicks (`UserActionsTracker`).
A proposed enhancement would make it *understand* those actions:

- Attach a `MutationObserver` to the list container during recording so we can
  tell whether a scroll **produced new items** (→ suggest *Collect List* /
  pagination) or just moved the viewport (→ rely on auto-reveal from §1).
- Capture clicks with robust selectors (via the existing selector generator)
  rather than raw XPath, and fold repeated "scroll → more items" gestures into a
  single suggested step.

This one is design-only for now — it touches the live recording UI. Ask to have
it implemented if it'd be useful.
