/* =====================================================================
   Basics tour — the beginner walkthrough on the bundled DemoMart shop.

   Two kinds of steps:
     • forced  — a light guard lets you click ONLY the highlighted control
                 (the rest of the platform stays visible, just dimmed a
                 little); the step advances when you do that exact thing and
                 it checks the right thing happened.
     • soft    — a gentle amber highlight + a tip; nothing is blocked, so you
                 can look around and click freely. Advances with Next
                 (`soft: true`).

   Consumed by GuidedTour:
     target : app CSS selector | { canvas: "<demo selector>" } | null
     gate(state) / domGate : advance conditions (forced steps)
     soft : show a Next button instead of a gate
     onEnter(api) : side-effect when the step opens

   `state` (main.jsx): { mode, onDemoBase, onDemoAudio, selHasSingle,
     selIsCard, selIsHeading, selMultiCards, hasExtractText, hasExtractList,
     hasPaginate, paginationSuggested, activeTab, execDone }
   `api`: { prefillUrl, goStream, showWorkflow, closePagination,
     openInspector, pinStart }
   ===================================================================== */

export function makeBasicsTour({ demoUrl }) {
  const baseUrl = demoUrl; // …/demo/shop.html

  return [
    {
      id: "welcome",
      soft: true,
      target: null,
      title: "Let’s build your first scraper",
      body: "We’ll collect data from a practice shop together. Blue steps ask you to do one thing; amber “tips” just point something out — on those you can click around freely. Ready?",
    },
    {
      id: "go",
      target: '[data-tour="go"]',
      title: "Open the practice shop",
      body: "A scraper always starts on a web page. We’ve typed in our practice shop for you — click the highlighted arrow to open it.",
      waiting: "Click the blue arrow to open the page…",
      onEnter: (api) => { api.goStream?.(); api.prefillUrl?.(baseUrl); },
      gate: (s) => s.onDemoBase,
    },
    {
      id: "modes",
      soft: true,
      target: null,
      place: "below",
      highlights: [
        { target: '[data-tour="mode-navigate"]', label: "Navigate — move around the page like normal" },
        { target: '[data-tour="mode-select"]',   label: "Select — point at data to collect" },
      ],
      title: "Two ways to use the page",
      body: "These two buttons change what a click does. You’re in Navigate right now — feel free to click around the shop, then hit Next.",
    },
    {
      id: "navigate",
      target: { canvas: 'nav.categories a[data-cat="audio"]' },
      title: "Move around the page",
      body: "In Navigate, clicks work like a normal browser. Click the highlighted “Audio” menu to open that section.",
      waiting: "Click the “Audio” menu…",
      onEnter: (api) => { api.pinStart?.(baseUrl); },
      gate: (s) => s.onDemoAudio,
    },
    {
      id: "return",
      target: '[data-tour="url-back"]',
      title: "Go back to the start",
      body: "See how the web address at the top changed to the Audio page? To return to where your scraper begins, click the orange back arrow — don’t retype the address.",
      waiting: "Click the orange back arrow…",
      gate: (s) => s.onDemoBase,
    },
    {
      id: "select-mode",
      target: '[data-tour="mode"]',
      title: "Switch to Select",
      body: "Now click “Select”. From here, clicking the page points at data to collect instead of opening links.",
      waiting: "Click “Select”…",
      gate: (s) => s.mode === "selection",
    },
    {
      id: "pick-heading",
      target: { canvas: "#heading" },
      title: "Point at something",
      body: "Let’s start small. Click the page’s title (“Featured products”). The panel on the right will show what you picked.",
      waiting: "Click the page title…",
      onEnter: (api) => api.openInspector?.(),
      gate: (s) => s.selHasSingle || s.selMultiCards,
    },
    {
      id: "sidebar",
      soft: true,
      target: null,
      place: "left",
      highlights: [
        { target: '[data-tour="side-inspector"]', label: "Inspector — choose what to collect" },
        { target: '[data-tour="side-workflow"]',  label: "Workflow — the steps you build" },
        { target: '[data-tour="side-html"]',      label: "HTML — peek at the page’s code" },
      ],
      title: "The panel on the right",
      body: "This is where you work with what you pick. It has three tabs (pointed out here). Inspector is open now — have a look, then Next.",
      onEnter: (api) => api.openInspector?.(),
    },

    // ── single-element capture (Extraction tab → Extract Text → Add) ───────
    {
      id: "open-extraction",
      target: '[data-tour="cat-extraction"]',
      title: "Choose what to collect",
      body: "In the panel, click the “Extraction” tab. It lists the things you can grab from what you clicked.",
      waiting: "Click the “Extraction” tab…",
      domGate: '[data-tour="capture-text"]',
    },
    {
      id: "select-text",
      target: '[data-tour="capture-text"]',
      title: "Choose “Extract Text”",
      body: "Click the “Extract Text” card. It grabs the words from what you clicked.",
      waiting: "Click “Extract Text”…",
      domGate: '[data-tour="add-step"]',
    },
    {
      id: "add-text",
      target: '[data-tour="add-step"]',
      title: "Add it to your scraper",
      body: "Click “Add to workflow”. That captures the page title — handy for a title, a total, or any single value.",
      waiting: "Click “Add to workflow”…",
      gate: (s) => s.hasExtractText,
    },

    // ── the list (the main event) ─────────────────────────────────────────
    {
      id: "pick-product",
      target: { canvas: ".product-card" },
      title: "Now point at a product",
      body: "Click any of the products in the highlighted box.",
      waiting: "Click the highlighted product…",
      // Advance once a PRODUCT is selected — not while the heading is still selected.
      gate: (s) => s.selMultiCards || s.selIsCard || (s.selHasSingle && !s.selIsHeading),
    },
    {
      id: "page-structure",
      target: '[data-tour="page-structure"]',
      title: "Pick the whole product",
      body: "You may have grabbed just a part of it (like the name). Open “Page structure” on the right and choose the whole product box — so we collect every product, not one detail.",
      waiting: "Open “Page structure” and pick the whole product box…",
      gate: (s) => s.selIsCard || s.selMultiCards,
    },
    {
      id: "pick-many",
      target: { canvas: ".product-card:nth-of-type(2)" },
      title: "Grab the whole list",
      body: "Now click a second product. Watch — the scraper selects every product on the page at once. That’s your list.",
      waiting: "Click a second product…",
      gate: (s) => s.selMultiCards,
    },
    {
      id: "use-ai",
      target: '[data-tour="use-ai"]',
      title: "Let it find the columns",
      body: "Click “Use AI”. The scraper looks at your products and works out the columns for you.",
      waiting: "Click “Use AI”…",
      domGate: '[data-tour="add-ai"]',
    },
    {
      id: "add-ai",
      target: '[data-tour="add-ai"]',
      title: "Add the list",
      body: "Click “Add with AI”. Your columns — name, price, rating and link — are filled in automatically.",
      waiting: "Click “Add with AI”…",
      gate: (s) => s.hasExtractList,
    },
    {
      id: "edit-fields",
      soft: true,
      target: ".elfe-fields",
      title: "Tweak the columns (optional)",
      body: "These are the columns the AI found. You can rename or remove any of them — or add your own: click “🎯 Pick from page”, then click something on a product (try the “in stock” number). Give it a go, then Next.",
    },

    // ── pagination ────────────────────────────────────────────────────────
    {
      id: "pagination-open",
      target: '[data-tour="pagination"]',
      title: "Check for more pages",
      body: "This shop has several pages. Click “Pagination” and the scraper will check whether the list continues.",
      waiting: "Click “Pagination” and wait a moment…",
      gate: (s) => s.paginationSuggested,
    },
    {
      id: "pagination-add",
      target: '[data-tour="pagination-add"]',
      title: "Collect every page",
      body: "It found the “Next page” link. Click “Add to Workflow” so your scraper walks through all the pages.",
      waiting: "Click “Add to Workflow”…",
      gate: (s) => s.hasPaginate,
    },

    // ── review + run ──────────────────────────────────────────────────────
    {
      id: "explain-steps",
      soft: true,
      target: ".workflow-designer",
      title: "Here’s what you built",
      body: "These are your steps, in order: open the page, capture the title, grab the product list, and go through every page. Click any step to open it — you’ll see options you can change. Then Next.",
      onEnter: (api) => { api.closePagination?.(); api.showWorkflow?.(); },
    },
    {
      id: "data-tab",
      target: '[data-tour="tab-data"]',
      title: "Preview the data",
      body: "Open the “Data” tab to see a preview of what you’ll get — a tidy table.",
      waiting: "Open the “Data” tab…",
      gate: (s) => s.activeTab === "data",
    },
    {
      id: "run",
      target: '[data-tour="run"]',
      title: "Run your scraper",
      body: "Press “Run” to collect the products for real. It only takes a moment.",
      waiting: "Click “Run”…",
      gate: (s) => s.execDone,
    },
    {
      id: "more-features",
      soft: true,
      target: null,
      title: "There’s a lot more up top",
      body: "From the buttons and menu at the top you can download your scraper as code, run it on a schedule, watch for changes, and send results to Google Sheets — whenever you’re ready.",
    },
    {
      id: "free-play",
      soft: true,
      target: null,
      title: "🎉 You did it — now explore!",
      body: "You built and ran a real scraper. Have a play with the shop and your workflow — nothing’s locked. When you want to go deeper, take the “Power Features” tour. Click Finish when you’re done.",
    },
  ];
}
