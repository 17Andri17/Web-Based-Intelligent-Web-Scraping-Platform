# Iterating into detail pages: the "Enrich" pattern

A very common scraping shape is **list → detail**:

1. A listing page shows many items (products, jobs, articles…) with a few basic
   fields and a **link** to each item's own page.
2. The interesting data lives on those individual detail pages.
3. You want **one table** where each row is a list item *plus* the details
   scraped from its page — not two tables you have to join by hand.

The **Run Subflow → Enrich** mode does exactly this. The whole step is
point-and-click: you pick the list from a dropdown, pick the link column from a
dropdown, and a live one-line summary spells out what will happen — no need to
type `{{references}}` or remember exact column names.

## How to set it up

1. **Extract the list.** Add an *Extract List* step and name it (e.g.
   `Products`, or anything readable — **names may contain spaces**, like
   `Escape Room Listings`). Give it the basic fields, and add one field that
   captures the **link** to each item's detail page — usually an *attribute*
   field reading `href` off the item's `<a>`. Call that field `link`.

   ```
   Products = [
     { title: "Widget A", link: "/p/a" },
     { title: "Widget B", link: "/p/b" },
   ]
   ```

2. **Build the detail subflow.** Save a second workflow that scrapes a single
   detail page (e.g. a *Product Detail* workflow that extracts `Brand`, `Stock`,
   and maybe an *Extract List* of `Reviews`). Its first `Navigate` step is
   ignored when run as a subflow — the parent supplies the URL.

3. **Add Run Subflow in your main workflow** after the Extract List. It defaults
   to the *Each row of a list* mode, then it's four short fields:
   - **Detail workflow** — the workflow to run on each page.
   - **List** — pick the list to enrich (dropdown of your named Extract Lists).
   - **Link column** — pick the column holding each row's URL (dropdown of that
     list's columns).
   - **Add details as** — how to combine each detail page's results (see below;
     *New columns on each row* is the default).
   - **Base URL** *(optional)* — turns `/p/a` into an absolute URL.

A one-line **summary** at the bottom reads the plan back, e.g. *"Each row of
**Products** → open **link**, run **Product Detail**, add new columns."*

The subflow opens each row's link, runs on that page, and merges the captured
fields back into that row. The output is a single enriched table.

> The **List** and **Link column** dropdowns each have an **✎ Enter manually**
> option that reveals a text box with the `$` variable picker, for references
> the dropdowns can't express (an iteration variable, a hand-built array).

> **Paginate first, enrich after.** If your list is built across several pages
> (a Pagination step), put the Extract List *inside* the pagination loop and the
> Run Subflow → Enrich *after* it. Enrich reads the full accumulated list, so all
> pages' rows are enriched — not just the last page's.

## Merging: what happens to the detail data

The detail page might return **single values** (easy) or a **list** (e.g.
several reviews per product). The **Add details as** option controls how that
folds into the row:

| Option (in the dropdown)              | Single-value details             | List details (e.g. reviews)                                  |
|---------------------------------------|----------------------------------|-------------------------------------------------------------|
| **New columns on each row** (default, *Flat*) | Each detail field becomes a new column on the row. | The list stays as a **nested array** in one column.         |
| **One row per item** (*Explode*)      | Detail fields ride along on every output row. | **One output row per list item** — the row is duplicated for each item and the item's fields become columns (denormalised). |
| **One grouped column** (*Nest*)       | The whole detail object goes under one column (`detail`). | The list lives inside that nested object.                    |
| **New columns with a name prefix** (*Prefix*) | Like *New columns*, but prefixed (`detail_…`) to avoid clashing with existing column names. | Nested array, prefixed column.                              |

> **If your detail page scrapes a LIST (like reviews), pick *One row per
> item*.** *New columns* (the default) keeps that list as a nested array in a
> single cell — fine for JSON, but it reads as "empty" in a flat table/CSV.
> *One row per item* turns each review into its own row with the parent
> item's columns carried along — usually what you actually want.

### Example

Source row: `{ title: "Widget A", link: "/p/a" }`
Detail page returns: `{ Brand: "Acme", Reviews: [{author:"X"}, {author:"Y"}] }`

- **Flat** → `{ title, link, Brand: "Acme", Reviews: [ {author:"X"}, {author:"Y"} ] }`
- **Nest** → `{ title, link, detail: { Brand, Reviews } }`
- **Explode** (on `Reviews`) → two rows:
  - `{ title, link, Brand: "Acme", author: "X" }`
  - `{ title, link, Brand: "Acme", author: "Y" }`

For **Explode**, leave *List field to explode* blank to auto-pick the first
list the detail page produced, or name it explicitly (e.g. `Reviews`).

## Notes

- A row whose link field is empty is kept untouched (its data is never dropped).
- Each enriched row also carries a `_sourceUrl` so you can trace it back.
- Relative links are resolved against **Base URL** when set.
- The merge runs identically in the platform and in **downloaded** scripts —
  the helper that does it (`__enrichRows`) is included automatically.

## When to use the other modes (Run on)

- **One page** — run a subflow once against a single page.
- **A list of links (no merge)** — iterate a column of links and get back a
  *separate* array of per-page result objects (each tagged with `_sourceUrl`).
  Use this when you *don't* want the results folded back into the source table.

## Inline enrich without a subflow: "For Each Row"

You don't need a saved subflow to enrich a list. The **For Each Row (Enrich a
List)** control (under *Control Flow*) does the same thing with steps you build
inline, and uses the same dropdowns + one-line summary:

- **List** — pick the list to enrich.
- **Open link column** *(optional)* — pick a column to open each row's detail
  page on a fresh tab; leave blank to run the steps on the **current page**
  (handy for "type each row's value into a search box, click, extract").
- **Add results as** — identical to the subflow version (same four options as
  the table above; pick *One row per item* when your steps scrape a list).
- **Row variable** — defaults to `row`; reference columns in your steps as
  `{{row.link}}`, `{{row.title}}`, etc. (spaced columns work too:
  `{{row.unit price}}`).

Name your extraction steps inside the loop — those names become the columns
merged back into each row. The enriched list is also exposed as a variable
(from the *Save as* name / step label) so you can chain another loop off it.

Use **Run Subflow → Enrich** when the detail-page logic is a reusable workflow
you want to share across projects; use **For Each Row** when the steps are
specific to this workflow and you'd rather keep them inline.
