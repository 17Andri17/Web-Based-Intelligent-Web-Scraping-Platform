/* =====================================================================
   paginationWrap — deciding what goes inside a new pagination loop.

   A pagination container runs its BODY once per page. Added on its own it
   is a loop that turns pages and collects nothing, appended after the very
   extraction steps it was supposed to wrap — a scraper that looks correct,
   runs clean, and quietly returns page one.

   So when one is added the user is asked which of their existing steps
   should move inside it. The tree surgery for that answer lives here,
   away from the component, because "silently reorganises the user's
   workflow" is not logic that should only ever be exercised by hand.
   ===================================================================== */

const BRANCH_KEYS = ["body", "then", "else", "try", "catch"];

/**
 * Which branch of a control block holds the steps that repeat.
 *
 * Read off the step itself rather than the definitions table: stepFactory
 * seeds one array per declared branch directly on the step (everything else
 * lives under `params`), so the instance already says where its children go.
 * That keeps this module free of the definitions import — and therefore
 * runnable, and testable, on its own.
 */
export function bodyKeyOf(step) {
  for (const k of BRANCH_KEYS) if (Array.isArray(step?.[k])) return k;
  return "body";
}

/**
 * The steps that belong to the page this loop will paginate: everything
 * after the last top-level NAVIGATE.
 *
 * A NAVIGATE opens a different page, so steps before it were written for
 * that page and are not part of this loop — while everything after it was
 * built against the page the user is looking at now, which is the page
 * about to be repeated. With no NAVIGATE at all, every step qualifies.
 *
 * Returned in workflow order, so the last element is the most recent step —
 * the one a "just the last one" answer refers to.
 */
export function stepsForCurrentPage(topSteps) {
  const top = Array.isArray(topSteps) ? topSteps : [];
  let lastNav = -1;
  for (let i = 0; i < top.length; i++) if (top[i]?.type === "NAVIGATE") lastNav = i;
  return top.slice(lastNav + 1);
}

/**
 * Put `paginationStep` at the end of the top level with `move` inside it,
 * and take those steps out of where they were.
 *
 * The candidates are always a tail of the top level, so appending the
 * container keeps everything else in its original order and position.
 *
 * @param {Array}  topSteps        current top-level steps
 * @param {object} paginationStep  the container being added
 * @param {Array}  move            steps to nest inside it (may be empty)
 * @returns {{ steps: Array, bodyLength: number }} the new top level, and how
 *          many steps the body ended up with — the index new steps should be
 *          inserted at, so they land after what was just moved in.
 */
export function wrapStepsInPagination(topSteps, paginationStep, move = []) {
  const key = bodyKeyOf(paginationStep);
  const movedIds = new Set(move.map(s => s.id));
  const body = [...(paginationStep[key] || []), ...move];
  const container = { ...paginationStep, [key]: body };
  const rest = (topSteps || []).filter(s => !movedIds.has(s.id));
  return { steps: [...rest, container], bodyLength: body.length };
}

/**
 * The answers worth offering, given what is on the page.
 *
 * Nothing to move means nothing to ask — a prompt whose only answer is "ok"
 * is just an obstacle. One candidate means one real answer plus declining,
 * not a menu with a middle option that says the same thing as the first.
 *
 * @param {Array} candidates  from stepsForCurrentPage
 * @param {(step:object)=>string} label  how to name a step in prose
 * @returns {Array|null} choice descriptors for confirm({ choices }), or null
 *          when the question shouldn't be asked at all
 */
export function paginationChoices(candidates, label) {
  if (!candidates || candidates.length === 0) return null;
  const last = candidates[candidates.length - 1];
  const choices = [];

  if (candidates.length > 1) {
    choices.push({
      value: "all", primary: true,
      label: `Move all ${candidates.length} steps inside`,
      detail: "Everything you've built for this page runs again on each new page.",
    });
    choices.push({
      value: "last",
      label: `Move only “${label(last)}” inside`,
      detail: "Just that step repeats per page; the rest run once, before paging starts.",
    });
  } else {
    choices.push({
      value: "all", primary: true,
      label: `Move “${label(last)}” inside`,
      detail: "It runs again on every page, so you collect the whole list and not just page one.",
    });
  }

  choices.push({
    value: "none",
    label: "Leave the loop empty",
    detail: "You'll add the steps that run on each page yourself.",
  });
  return choices;
}

/** The steps a given answer selects. Anything unrecognised moves nothing. */
export function stepsForChoice(choice, candidates) {
  if (choice === "all") return candidates;
  if (choice === "last") return candidates.slice(-1);
  return [];
}
