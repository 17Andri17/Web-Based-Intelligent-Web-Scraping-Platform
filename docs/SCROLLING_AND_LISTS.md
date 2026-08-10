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
5. Stop only once the end is confirmed — see **Accuracy mode** below.

Because it collects continuously and de-dupes, it captures every item even when
the DOM only ever holds a small moving window. Memory is bounded by the number
of **unique** items, not the DOM.

Fields are configured exactly like *Extract List* (same editor, same AI
auto-detect, same per-field transforms/splits).

**Tips**
- Pick a **de-dupe key** that's stable and unique per item — a detail link or id
  is ideal. Without one the step falls back to an id/`data-*`/`href` found on the
  row, and only then to whole-row contents (which *would* merge two identical
  rows — the run warns you when that actually happens).
- If the list scrolls inside a `<div>` rather than the whole page, set the
  **scroll container selector**.
- Combine with **Pagination — URL Pages**: put *Collect List* in the pagination
  body; the de-dupe key spans pages, so overlaps between pages are removed too.

Implementation: `harvestWhileScrolling(...)` in the generated script.

### Accuracy mode — why a run used to return a different number every time

Three things silently lose records on real infinite-scroll pages. Accuracy mode
(**on by default**, both here and in *Pagination — Infinite Scroll*, which now
shares the same engine) addresses each one:

| Failure | What went wrong | What accuracy mode does |
|---|---|---|
| **Skipped load trigger** | Most sites load more via an `IntersectionObserver` on a sentinel near the list end. The browser only fires those callbacks when intersection state changes *between frames*, so a single jump of `scrollTop` over the sentinel can be missed entirely — and the next batch never loads. | **Traverses** every scroll distance in ~250px steps with a `requestAnimationFrame` yield between them, so every sentinel gets an intersecting frame. |
| **Guessed wait** | Waiting a fixed number of ms means that whenever the site's fetch is slower than the guess, the harvest sees nothing new and starts counting toward "done". The record count then tracks network latency — **which is why the same page returned a different number on every run.** | **Settles on real signals**: zero in-flight network requests *and* no DOM mutations, each for a quiet window (default 500ms), capped at 30s. |
| **Impatience at the end** | Three fixed retries (~3.6s total) is not enough for a slow last batch. | **Escalating patience** — 1s → 2s → 4s → 8s → 15s — and it **jiggles** between tries (scroll up, then back down) because a loader that already fired at this position won't fire again without a fresh crossing. |

Then it **verifies**: return to the top and sweep the whole list again. A pass
that adds nothing proves the previous pass saw everything reachable; a pass that
adds something proves it didn't, so it sweeps again (up to *Verification passes*,
default 3).

**Cost.** The bottom patience ladder is ~30s, paid **once per run** (only the
final "am I really done?" check runs all its rungs — earlier ones break out as
soon as the page grows). Everything else is roughly as fast as before. On a
60-record fixture: ~7s of work + the 30s certainty check.

Untick **Accuracy mode** to get the old fast-but-approximate behaviour; the same
engine reproduces it from the legacy *Delay after each scroll* / *Stop after N*
settings, which are otherwise unused.

### "How do I know I got them ALL?"

After the run it logs one of:

- `✓ Collect List: collected N item(s) (reason, verified over P pass(es))`
- `⚠ Collect List may be INCOMPLETE — collected N … (reason)` — couldn't confirm.
- `✗ Collect List: the scroll container never moved …` — misconfiguration.

The stop **reason** (strongest → weakest):

1. **`reached-expected-total`** — you set an **Expected-total selector** (an
   element like "340 results"); it collected at least that many. *Verified.*
   If it stops short, you get the ⚠ warning with `N of 340`.
2. **`end-marker`** — you set an **End-of-list selector** (e.g. a "No more
   results" element) and it appeared. *Definitive.*
3. **`bottom-stable`** — reached the bottom, the full patience ladder elapsed
   with no new items *and* no growth in scroll height, and a verification pass
   then found nothing new.
4. **`no-scroll-needed`** — the list already fitted on one screen. Nothing to
   scroll, so nothing can be missed.
5. **`settle-timeout`** — the page never went quiet within *Max wait for one
   batch* → reported **incomplete** rather than silently truncated.
6. **`safety-cap`** — hit *Max scroll steps* first → **incomplete**; raise the
   cap or add one of the selectors above.
7. **`scroll-container-stuck` / `scroll-container-missing`** — the **Scroll
   container** selector matched nothing, or matched an element whose content
   overflows but which does not scroll. Previously this was mistaken for
   reaching the end and reported as a clean success; it is now a loud failure.

**De-duplication.** Rows are keyed by, in order: the **Key field** you set → an
intrinsic row identity found in the DOM (`id`, `data-id`, `data-testid`, or the
row's first link `href`) → the whole row's contents. The intrinsic identity
survives virtualization *and* distinguishes two rows whose visible text happens
to match. If it falls all the way through to whole-row hashing and two rows on
screen at the same time collide, that proves distinct records are being merged,
and the run warns you to set a Key field rather than losing them silently.

Practical recipe for "be sure": point the **Expected-total selector** at the
page's own result count. Then completeness is *verified against the site's own
number* rather than inferred.

Implementation: `harvestWhileScrolling(...)` / `exhaustScroll(...)` in the
generated script. Tested against fixtures that reproduce each failure above —
`backend/test/scroll-harvest.test.js`.

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
