# Markdown renderer: GFM tables

## Task
`src/md.ts` exports `renderMarkdown(src)`, which converts headings, paragraphs, `**bold**`, `*em*` and inline code to HTML. Add GFM tables: a header row, a delimiter row such as `|---|:--:|--:|`, and body rows. Column alignment comes from the delimiter row and is rendered as `style="text-align:center"` or `style="text-align:right"` on the cells (left alignment adds no style). Cells support the existing inline syntax, and `\|` inside a cell is a literal pipe rather than a cell separator. A block that does not have a valid delimiter row as its second line is rendered as a paragraph, exactly as before. Put the table parsing and rendering in a new `src/table.ts` and call it from `src/md.ts`.

## Scope
- `src/md.ts`
- `src/table.ts`
- `test/md.test.ts`

## Acceptance criteria
- `| a | b |\n|---|---|\n| 1 | 2 |` renders as `<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>`.
- Center and right alignment from the delimiter row (`:-:`, `--:`) appear as `style="text-align:center"` / `style="text-align:right"` on both the `th` and every `td` of that column.
- `\|` inside a cell yields a literal `|` in the output and does not split the cell.
- A body row with fewer cells than the header is padded with empty `<td></td>` cells; a row with more cells is truncated to the header width.
- Inline syntax inside cells renders, for example `**x**` becomes `<strong>x</strong>`.
- A block whose second line is not a valid delimiter row is rendered as a paragraph, as before.
- Output for input that contains no table is byte-identical to what it was before the change.
- `npm run typecheck`, `npm run lint`, and `npm test` pass; the existing tests keep passing unchanged.
