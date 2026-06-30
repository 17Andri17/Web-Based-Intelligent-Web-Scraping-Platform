# Iterating into detail pages: the "Enrich" pattern

A very common scraping shape is **list → detail**:

1. A listing page shows many items (products, jobs, articles…) with a few basic
   fields and a **link** to each item's own page.
2. The interesting data lives on those individual detail pages.
3. You want **one table** where each row is a list item *plus* the details
   scraped from its page — not two tables you have to join by hand.

The **Run Subflow → Enrich** mode does exactly this.

## How to set it up

1. **Extract the list.** Add an *Extract List* step and name it (e.g.
   `products`). Give it the basic fields, and add one field that captures the
   **link** to each item's detail page — usually an *attribute* field reading
   `href` off the item's `<a>`. Call that field `link`.

   ```
   products = [
     { title: "Widget A", link: "/p/a" },
     { title: "Widget B", link: "/p/b" },
   ]
   ```

2. **Build the detail subflow.** Save a second workflow that scrapes a single
   detail page (e.g. a *Product Detail* workflow that extracts `Brand`, `Stock`,
   and maybe an *Extract List* of `Reviews`). Its first `Navigate` step is
   ignored when run as a subflow — the parent supplies the URL.

3. **Add Run Subflow in your main workflow** after the Extract List:
   - **Subflow:** the detail workflow.
   - **Run on:** *Enrich a table's rows*.
   - **Source table:** `{{products}}` (or just `products`).
   - **Link field:** `link` — the column on each row that holds the URL.
   - **Base URL for relative links** *(optional)*: e.g. `https://example.com`,
     used to turn `/p/a` into an absolute URL.
   - **Save results under:** e.g. `products_detailed`.

The subflow opens each row's link, runs on that page, and merges the captured
fields back into that row. The output is a single enriched table.

## Merging: what happens to the detail data

The detail page might return a **single value/object** (easy) or a **list**
(e.g. several reviews per product). The **merge strategy** controls how that
folds into the row:

| Strategy   | Single-object details            | List details (e.g. reviews)                                  |
|------------|----------------------------------|-------------------------------------------------------------|
| **Flat** (default) | Each detail field becomes a new column on the row. | The list stays as a **nested array** in one column.         |
| **Prefix** | Same as Flat, but new columns are prefixed (`detail_…`) to avoid clashing with existing column names. | Nested array, prefixed column.                              |
| **Nest**   | The whole detail object goes under one column (`detail`). | The list lives inside that nested object.                    |
| **Explode**| Detail fields ride along on every output row. | **One output row per list item** — the row is duplicated for each item and the item's fields are merged in (denormalised). |

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

- **Single URL** — run a subflow once against one page.
- **List of URLs** — iterate a column of links and get back a *separate* array
  of per-page result objects (each tagged with `_sourceUrl`). Use this when you
  *don't* want the results folded back into the source table.
