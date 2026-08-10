'use strict';

/* ===========================================================================
   Template gallery
   ---------------------------------------------------------------------------
   Ready-made workflows a user can start from instead of facing an empty
   editor. A template IS a portable export envelope (the same format
   workflowPortable produces), so "use this template" is just an import — no
   second code path, no second format.

   These are deliberately SITE-AGNOSTIC. A template that scraped a named real
   website would break the first time that site changed its markup, and would
   ship this project with an opinion about which sites to scrape. What a
   beginner actually can't assemble alone is the STRUCTURE — the pagination
   container wrapped around an extraction, the list-then-enrich pairing, the
   parameterised search URL. So each template ships that skeleton with empty
   selectors and a `setup` checklist telling the user the two or three things
   to point at their own page.

   Steps are built fresh (new ids) on every use — see build().
   ========================================================================= */

const crypto = require('crypto');

const uid = () => crypto.randomUUID();

/* ── Step builders ──────────────────────────────────────────────────────────
   Mirror the shapes the frontend's stepFactory produces (kind/type/params/
   advanced/outputVar, control branches, pagination meta). Kept minimal and
   explicit: the backend can't import the frontend's ESM definition files, so
   these spell out the params rather than inheriting defaults. Anything omitted
   simply renders empty in the editor, which is what we want for the fields the
   user is meant to fill in. */

function navigate(url, { label = 'Open the page' } = {}) {
  return {
    id: uid(), kind: 'action', type: 'NAVIGATE', label,
    // The first NAVIGATE is the workflow's start URL.
    pinned: true,
    params: { url: url || '' },
    advanced: {
      waitUntil: 'load', timeout: 30000, retryCount: 1, onError: 'fail',
      consent: 'accept', captcha: 'auto', skipOnRun: false,
    },
    outputVar: 'pageurl_start',
  };
}

// `label` is what names the output table — the codegen keys __results__ by it.
function extractList(label, fields, { containerSelector = '' } = {}) {
  return {
    id: uid(), kind: 'action', type: 'EXTRACT_LIST', label,
    params: { containerSelector, fields: fields || {} },
    advanced: {},
    outputVar: `extractlist_${label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) || 'rows'}`,
  };
}

function collectList(label, fields, { containerSelector = '', keyField = '' } = {}) {
  return {
    id: uid(), kind: 'action', type: 'COLLECT_LIST', label,
    params: { containerSelector, fields: fields || {}, keyField, scrollContainer: '' },
    advanced: {},
    outputVar: `collectlist_${label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) || 'rows'}`,
  };
}

function extractTable(label, { selector = '', hasHeader = true } = {}) {
  return {
    id: uid(), kind: 'action', type: 'EXTRACT_TABLE', label,
    params: { selector, hasHeader },
    advanced: { trimWhitespace: true },
    outputVar: `extracttable_${label.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8) || 'table'}`,
  };
}

// A text field spec inside an EXTRACT_LIST/COLLECT_LIST `fields` map. Empty
// selectors are intentional — the user picks them on their own page (or lets
// "Extract with AI" fill them in from one sample item).
const textField = (selector = '') => ({ selector, kind: 'text', attribute: null });
const attrField = (attribute, selector = '') => ({ selector, kind: 'attr', attribute });

function paginateButton(body, { selector = '' } = {}) {
  return {
    id: uid(), kind: 'control', type: 'PAGINATE_BUTTON',
    params: { selector, fallbackSelectors: [], delay: 2000, maxIterations: 200 },
    body: body || [],
    meta: { kind: 'pagination', strategy: 'next_button', engine: 'native' },
  };
}

function paginateScroll(body) {
  return {
    id: uid(), kind: 'control', type: 'PAGINATE_SCROLL',
    params: { scrollContainer: '', scrollDelay: 1500, maxNoChange: 3, maxIterations: 100 },
    body: body || [],
    meta: { kind: 'pagination', strategy: 'infinite_scroll', engine: 'native' },
  };
}

function paginateUrl(body, { urlPattern = '', contentSelector = '' } = {}) {
  return {
    id: uid(), kind: 'control', type: 'PAGINATE_URL',
    params: { urlPattern, contentSelector, startPage: 1, step: 1, delay: 1500, maxIterations: 500 },
    body: body || [],
    meta: { kind: 'pagination', strategy: 'url_param', engine: 'native' },
  };
}

function forEachRow(body, { source = '', openUrlField = '', mergeStrategy = 'flat' } = {}) {
  return {
    id: uid(), kind: 'control', type: 'FOR_EACH_ROW',
    params: {
      source, openUrlField, mergeStrategy,
      explodeField: '', detailField: 'detail', detailPrefix: 'detail_',
      baseUrl: '', itemVar: 'row', indexVar: 'index', timeout: 30000, outputVar: '',
    },
    body: body || [],
  };
}

/* ── The gallery ────────────────────────────────────────────────────────── */

const TEMPLATES = [
  {
    id: 'list-next-button',
    name: 'List across “Next” pages',
    category: 'Lists',
    icon: '📄',
    summary: 'Collect a repeating list — products, jobs, listings — then keep clicking the site’s “Next” button until the pages run out.',
    setup: [
      'Point the first step at the page you want to collect from.',
      'Pick one item on the page — the platform finds the rest and suggests the columns.',
      'Point the “Next” step at the site’s own Next button.',
    ],
    build: () => [
      navigate(''),
      paginateButton([
        extractList('Items', { Title: textField(), Link: attrField('href'), Price: textField() }),
      ]),
    ],
  },
  {
    id: 'list-numbered-pages',
    name: 'List across numbered pages',
    category: 'Lists',
    icon: '🔢',
    summary: 'For sites whose pages are just a number in the web address (…?page=1, ?page=2). Walks up the numbers and stops on its own when a page comes back empty.',
    setup: [
      'Put your address in the pattern field with {n} where the page number goes.',
      'Pick one item so the platform knows what a row looks like.',
      'That same item’s selector goes in “What should be on every page?”.',
    ],
    build: () => [
      navigate(''),
      paginateUrl([
        extractList('Items', { Title: textField(), Link: attrField('href'), Price: textField() }),
      ]),
    ],
  },
  {
    id: 'list-infinite-scroll',
    name: 'List that loads as you scroll',
    category: 'Lists',
    icon: '↕️',
    summary: 'For feeds and catalogues with no page links, where more items appear as you scroll. Harvests items as it goes, so nothing is lost when the page recycles rows.',
    setup: [
      'Point the first step at the feed you want.',
      'Pick one item so the platform can match the rest.',
      'Set “Key field” to a column that is unique per item (a link or an id) so nothing is counted twice.',
    ],
    build: () => [
      navigate(''),
      collectList('Items', { Title: textField(), Link: attrField('href') }, { keyField: 'Link' }),
    ],
  },
  {
    id: 'list-then-detail',
    name: 'List, then open each item for detail',
    category: 'Lists',
    icon: '🔗',
    summary: 'Collect a list, then visit every row’s own page and bring extra fields back onto that row. The pattern behind most useful scrapes.',
    setup: [
      'Point the first step at the list page.',
      'Pick one item, and make sure one of the columns captures its Link.',
      'Inside “Add extra detail to every row”, choose that Link column, then add the steps that grab the detail-page fields.',
    ],
    build: () => [
      navigate(''),
      extractList('Items', { Title: textField(), Link: attrField('href') }),
      forEachRow([], { source: '{{Items}}', openUrlField: 'Link', mergeStrategy: 'flat' }),
    ],
  },
  {
    id: 'search-results',
    name: 'Search results for a keyword',
    category: 'Parameterised',
    icon: '🔍',
    summary: 'A scraper you can re-run for any search term — or for a whole list of them at once, via “Bulk run from a list”.',
    setup: [
      'Open the site, run a search, and copy the resulting web address into the first step.',
      'Replace the search term in that address with {{query}}.',
      'Pick one result so the platform can match the rest.',
    ],
    // The variable is what makes this re-runnable per keyword; the value here
    // is just the sample used while building.
    variables: [{ name: 'query', value: 'example search' }],
    build: () => [
      navigate(''),
      paginateButton([
        extractList('Results', { Title: textField(), Link: attrField('href'), Summary: textField() }),
      ]),
    ],
  },
  {
    id: 'article-index',
    name: 'Articles or news index',
    category: 'Content',
    icon: '📰',
    summary: 'Headline, link, date and summary from an index or blog listing — the shape you want before setting up change alerts.',
    setup: [
      'Point the first step at the index page.',
      'Pick one article so the platform can match the rest.',
      'Once it runs, turn on “Monitor for changes” to be told when new articles appear.',
    ],
    build: () => [
      navigate(''),
      extractList('Articles', {
        Headline: textField(), Link: attrField('href'), Date: textField(), Summary: textField(),
      }),
    ],
  },
  {
    id: 'directory-contacts',
    name: 'Directory or contact listing',
    category: 'Content',
    icon: '📇',
    summary: 'Name, role, phone, e-mail and address from a directory — across every page of it.',
    setup: [
      'Point the first step at the directory.',
      'Pick one entry, then keep only the columns the site actually shows.',
      'Point the “Next” step at the directory’s own Next link.',
    ],
    build: () => [
      navigate(''),
      paginateButton([
        extractList('Entries', {
          Name: textField(), Role: textField(), Phone: textField(),
          Email: textField(), Address: textField(),
        }),
      ]),
    ],
  },
  {
    id: 'page-table',
    name: 'A table on a page',
    category: 'Content',
    icon: '🧾',
    summary: 'Pull a real HTML table straight out of a page — prices, schedules, statistics — with its own header row as the columns.',
    setup: [
      'Point the first step at the page with the table.',
      'Pick the table itself on the page.',
    ],
    build: () => [
      navigate(''),
      extractTable('Table'),
    ],
  },
];

/* ── Public surface ─────────────────────────────────────────────────────── */

// Catalogue metadata for the gallery — no steps, so the list stays small.
function list() {
  return TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    category: t.category,
    icon: t.icon,
    summary: t.summary,
    setup: t.setup,
    stepCount: countSteps(t.build()),
  }));
}

function countSteps(steps) {
  let n = 0;
  for (const s of steps || []) {
    n += 1;
    for (const key of ['body', 'then', 'else', 'try', 'catch']) {
      if (Array.isArray(s[key])) n += countSteps(s[key]);
    }
  }
  return n;
}

function getById(id) {
  return TEMPLATES.find(t => t.id === id) || null;
}

/* A portable export envelope for `id`, ready to hand to the normal import
   path. Built fresh each call so every use gets its own step ids. */
function buildEnvelope(id) {
  const t = getById(id);
  if (!t) return null;
  return {
    format: 'scraper-workflow',
    version: 1,
    exportedAt: new Date().toISOString(),
    name: t.name,
    steps: t.build(),
    meta: {
      variables: t.variables || [],
      // Provenance: which template this came from, so the editor can show the
      // setup checklist and we can tell a template-derived workflow apart.
      template: { id: t.id, name: t.name, setup: t.setup },
    },
    customActions: [],
  };
}

module.exports = { list, getById, buildEnvelope, countSteps };
