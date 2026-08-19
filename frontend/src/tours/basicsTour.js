/* =====================================================================
   The first-run walkthrough.

   It is one job from start to finish, the job people actually turn up
   with: "collect every product from this shop — all of them, across all
   the pages — and give me the table." The practice shop is bundled
   (backend/public/demo/shop.html) so it behaves identically every time,
   and the AI step is answered from a fixture rather than a live model, so
   the columns it produces are known in advance — which is what lets the
   next step ask the user to add the one column it deliberately left out.

   Nothing here blocks the app. Every step points at exactly one control
   and waits; the user can click anywhere else, hide the guide, wander off
   and come back. See components/GuidedTour.jsx for the step contract.

   Two things a step can do beyond "wait for this to be true":

     hint(state)  — notice a wrong turn and offer the one click that fixes
                    it. The single most common way to get lost here is
                    grabbing a product's NAME instead of the product, and
                    the fix is one call, so the tour offers it rather than
                    letting someone stall.
     undo(api)    — reverse what the step did, so Back is a real rollback
                    and "Redo this step" can un-stick a mis-click.

   `state` (assembled in main.jsx): { mode, onDemoBase, onDemoAudio,
     onDemoSite, selIsCard, selInsideCard, selMultiCards, hasExtractList,
     hasPaginate, hasStockField, listFieldPickActive, paginationSuggested,
     paginationDetecting, activeTab, execDone, execRows }
   `api`: { prefillUrl, goStream, showWorkflow, showData, openInspector,
     closePagination, pinStart, goDemoStart, selectParent, clearSelection,
     setMode, removeStepsOfType, openListEditor }
   ===================================================================== */

const LIST_TYPES = ["EXTRACT_LIST", "COLLECT_LIST"];

export function makeBasicsTour({ demoUrl }) {
  const baseUrl = demoUrl; // …/demo/shop.html

  return [
    {
      id: "welcome",
      soft: true,
      target: null,
      title: "Let's collect a whole catalogue",
      body: "In the next few minutes you'll build a scraper that reads every product from a shop — name, price, rating — follows the pagination to the last page, and hands you the table. Nothing is locked while we do it: click anywhere, tuck this panel away with −, and use Back to undo a step and try it again.",
    },

    /* ── Open the page ──────────────────────────────────────────────── */
    {
      id: "open-page",
      target: '[data-tour="go"]',
      title: "Open the shop",
      body: "A scraper always starts on a page. The practice shop's address is already in the bar — press the blue arrow to load it.",
      waiting: "Press the blue arrow…",
      onEnter: (api) => { api.goStream?.(); api.prefillUrl?.(baseUrl); },
      gate: (s) => !!s.onDemoBase,
      hint: (s) => (s.onDemoSite && !s.onDemoBase
        ? { text: "You've landed somewhere else in the shop. Let's start from the front page.",
            action: { label: "Go to the front page", run: (api) => api.goDemoStart?.() } }
        : null),
    },

    /* ── It's a real browser ────────────────────────────────────────── */
    {
      id: "browse",
      target: { canvas: 'nav.categories a[data-cat="audio"]' },
      title: "It's a real browser",
      body: "You're in Navigate mode, so the page works exactly as it would in any other tab — links, menus, forms. Open the shop's Audio section to see.",
      waiting: "Click the Audio menu on the page…",
      onEnter: (api) => { api.pinStart?.(baseUrl); },
      gate: (s) => !!s.onDemoAudio,
    },
    {
      id: "back-to-start",
      target: '[data-tour="url-back"]',
      title: "Back to where the scraper starts",
      body: "Notice the address changed. Your scraper always begins at the page you opened first — press the orange arrow to return there instead of retyping the address.",
      waiting: "Press the orange back arrow…",
      gate: (s) => !!s.onDemoBase,
      hint: (s) => (!s.onDemoSite
        ? { text: "We've drifted off the practice shop entirely.",
            action: { label: "Take me back", run: (api) => api.goDemoStart?.() } }
        : null),
    },

    /* ── Point at the data ──────────────────────────────────────────── */
    {
      id: "select-mode",
      target: '[data-tour="mode-select"]',
      title: "Now point at what you want",
      body: "Switch to Select. From here a click no longer follows links — it picks out the thing under your cursor as data to collect.",
      waiting: "Click Select…",
      gate: (s) => s.mode === "selection",
      undo: (api) => api.setMode?.("navigation"),
    },
    {
      id: "pick-product",
      target: { canvas: ".product-card" },
      title: "Click the highlighted product",
      body: "Aim for the product's picture or the space around its text — that selects the whole product rather than one line of it.",
      waiting: "Click the highlighted product…",
      onEnter: (api) => api.openInspector?.(),
      gate: (s) => !!(s.selIsCard || s.selMultiCards),
      hint: (s) => (s.selInsideCard && !s.selIsCard && !s.selMultiCards
        ? { text: "That's one detail inside the product — the name or the price. You want the product itself, so every column comes along with it.",
            action: { label: "Select the whole product", run: (api) => api.selectParent?.() } }
        : null),
    },
    {
      id: "pick-second",
      target: { canvas: ".product-card:nth-of-type(2)" },
      title: "Now click a second one",
      body: "Two examples are all it needs. Watch what happens on the page — it works out the pattern and grabs every product at once. That's your list.",
      waiting: "Click a second product…",
      gate: (s) => !!s.selMultiCards,
      hint: (s) => (!s.selIsCard && !s.selMultiCards && !s.selInsideCard
        ? { text: "The selection was cleared. Click one product, then a second." }
        : null),
    },

    /* ── Columns ────────────────────────────────────────────────────── */
    {
      id: "use-ai",
      target: '[data-tour="use-ai"]',
      title: "Let it name the columns",
      body: "You could pick each column by hand — but it can read the products and work them out for you. Press Use AI.",
      waiting: "Press ✨ Use AI…",
      domGate: '[data-tour="add-ai"]',
    },
    {
      id: "add-ai",
      target: '[data-tour="add-ai"]',
      title: "Add the list to your scraper",
      body: "Press Add with AI. It reads two of the products, works out which bit is the name, which is the price and which is the rating, and writes the columns for you.",
      waiting: "Press ✨ Add with AI…",
      gate: (s) => !!s.hasExtractList,
      undo: (api) => api.removeStepsOfType?.(LIST_TYPES),
    },
    {
      id: "add-field",
      target: '[data-tour="pick-field"]',
      optional: true,
      title: "Add the column it missed",
      body: "Name, price, rating and link — but not the stock count. Press 🎯 Pick from page, click the \"in stock\" line on any product, and it becomes a column on every row. Then press \"Done picking\" — otherwise every further click keeps adding columns.",
      waiting: "Pick the \"in stock\" line, then finish picking…",
      onEnter: (api) => api.openListEditor?.(),
      // Deliberately also waits for picking to be switched OFF. Leaving someone
      // in a mode the tour turned on, while the next step tells them to go and
      // click something else, is how you end up with six accidental columns.
      gate: (s) => !!s.hasStockField && !s.listFieldPickActive,
      hint: (s) => {
        if (s.hasStockField && s.listFieldPickActive) {
          return { text: "That's the stock column in. Press \"Done picking\" to switch picking off — otherwise your next click on the page adds another column." };
        }
        if (s.listFieldPickActive) {
          return { text: "Picking is on — now click the \"14 in stock\" line on any product on the page." };
        }
        return null;
      },
    },

    {
      id: "clean-rating",
      target: '[data-tour="clean-field-rating"]',
      optional: true,
      title: "Tidy up a messy column",
      body: "The rating comes off the page as “★ 3.0 out of 5” — a number wearing decoration. Press ✨ Clean on the rating row, add a “Substring (slice)” step with Start 2 and End 5, and every row becomes just “3.0”. The rule runs on every row, on every future run.",
      waiting: "Add a clean-up step to the rating column…",
      onEnter: (api) => api.openListEditor?.(),
      gate: (s) => !!s.ratingCleaned,
      undo: (api) => api.clearFieldTransforms?.("rating"),
    },

    /* ── Every page, not just this one ──────────────────────────────── */
    {
      id: "pagination",
      target: '[data-tour="pagination"]',
      title: "There are three pages of these",
      body: "Right now you'd collect page one and stop. Press Pagination and it will look for the link that leads to the rest.",
      waiting: "Press Pagination and give it a second…",
      gate: (s) => !!s.paginationSuggested,
      hint: (s) => (s.paginationDetecting
        ? { text: "Looking for the next-page link — this takes a moment." }
        : null),
    },
    {
      id: "pagination-add",
      target: '[data-tour="pagination-add"]',
      title: "Follow it to the last page",
      body: "It found the shop's \"Next page\" link. Press Add to Workflow — then say yes when it offers to move your product list inside the loop, so it runs on every page and brings back all 24 products instead of the 8 in front of you.",
      waiting: "Press Add to Workflow…",
      gate: (s) => !!s.hasPaginate,
      undo: (api) => api.removeStepsOfType?.([/^PAGINATE_/]),
    },

    /* ── Check it, run it ───────────────────────────────────────────── */
    {
      id: "review",
      soft: true,
      target: ".workflow-designer",
      title: "That's the whole scraper",
      body: "Open the shop, then keep turning pages — with your product list nested inside the loop, so it runs once per page. Open any step to change it: this is a real workflow, not a recording of your clicks.",
      onEnter: (api) => { api.closePagination?.(); api.showWorkflow?.(); },
    },
    {
      id: "preview-data",
      target: '[data-tour="tab-data"]',
      title: "See the shape before you run",
      body: "The Data tab previews the table your scraper will produce, so you can fix a column before spending a run on it.",
      waiting: "Open the Data tab…",
      gate: (s) => s.activeTab === "data",
    },
    {
      id: "run",
      target: '[data-tour="run"]',
      title: "Run it for real",
      body: "Press Run. It opens the shop, collects the products, follows the pagination to the last page and brings back the rows — the same thing it would do on a schedule at 3am.",
      waiting: "Press Run…",
      gate: (s) => !!s.execDone,
    },
    {
      id: "finish",
      soft: true,
      target: null,
      title: "🎉 That's a working scraper",
      body: "Everything up top works on real sites too: put it on a schedule, get an email when the data changes, send rows straight to Google Sheets, call it from your own code, or download it as a standalone script. Your practice scraper is thrown away when you finish — build your next one on a site you actually care about.",
    },
  ];
}
