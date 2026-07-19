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

3. **Add Run Subflow in your main workflow** after the Extract List:
   - **Which saved workflow to run on each page:** the detail workflow.
   - **What should it run on?** → *Each row of a list — open its link & add
     details* (marked ★ most common).
   - **1. Which list do you want to add details to?** — pick your list from the
     dropdown (it lists every named Extract List, with its column count).
   - **2. Which column holds the link to open?** — pick the link column from the
     dropdown of that list's columns.
   - **Base URL for relative links** *(optional)*: e.g. `https://example.com`,
     used to turn `/p/a` into an absolute URL.
   - **3. How should the details be combined with each row?** — see the merge
     table below (*Add the details as new columns* is the recommended default).
   - **Save results under** *(optional)*: e.g. `products_detailed`.

As you fill these in, the **live summary** reads back the plan, e.g.
*"For each row in **Products**, open the link in the **link** column, run the
**Product Detail** workflow on that page, then add its results as new columns on
the row."*

The subflow opens each row's link, runs on that page, and merges the captured
fields back into that row. The output is a single enriched table.

> The dropdowns are the easy path. If you need something they can't express
> (an iteration variable, a hand-built array, a renamed list), each dropdown has
> an **✎ Enter a reference manually…** option that reveals the full text box with
> the `$` variable picker.

## Merging: what happens to the detail data

The detail page might return a **single value/object** (easy) or a **list**
(e.g. several reviews per product). The **merge strategy** controls how that
folds into the row:

The plain-language option labels map to these behaviours:

| Option (in the dropdown)                    | Single-object details            | List details (e.g. reviews)                                  |
|---------------------------------------------|----------------------------------|-------------------------------------------------------------|
| **Add the details as new columns** (default, *Flat*) | Each detail field becomes a new column on the row. | The list stays as a **nested array** in one column.         |
| **Add as new columns, but prefix their names** (*Prefix*) | Same as above, but new columns are prefixed (`detail_…`) to avoid clashing with existing column names. | Nested array, prefixed column.                              |
| **Keep the details together under one column** (*Nest*)   | The whole detail object goes under one column (`detail`). | The list lives inside that nested object.                    |
| **Make one row per item** (*Explode*)| Detail fields ride along on every output row. | **One output row per list item** — the row is duplicated for each item and the item's fields are merged in (denormalised). |

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

## When to use the other modes

- **One single page** — run a subflow once against one page.
- **A list of links (run once per link, no merge)** — iterate a column of links
  and get back a *separate* array of per-page result objects (each tagged with
  `_sourceUrl`). Use this when you *don't* want the results folded back into the
  source table.

## Inline enrich without a subflow: "For Each Row"

You don't need a saved subflow to enrich a table. The **For Each Row (Enrich a
List)** control (under *Control Flow*) does the same thing with steps you build
inline, and uses the same point-and-click dropdowns + live summary:

- **1. Which list do you want to add details to?** — pick the list from the
  dropdown.
- **2. Open a link from this column?** *(optional)* — pick a column to open each
  row's detail page on a fresh tab; leave it as *none* to run the steps on the
  **current page** (handy for "type each row's value into a search box, click,
  extract").
- **Name for the current row** — defaults to `row`; reference columns in your
  steps as `{{row.link}}`, `{{row.title}}`, etc. (spaced columns work too:
  `{{row.unit price}}`).
- **3. How should the results be combined with each row?** — identical to the
  subflow version (the same four options as the table above).

Name your extraction steps inside the loop — those names become the columns
merged back into each row. The enriched table is also exposed as a variable
(from the *Save enriched table under* name / step label) so you can chain
another loop off it.

Use **Run Subflow → Enrich** when the detail-page logic is a reusable workflow
you want to share across projects; use **For Each Row** when the steps are
specific to this workflow and you'd rather keep them inline.
