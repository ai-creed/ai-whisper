# CSV parser: quoted fields

## Task
`src/parse.ts` exports `parseCsv(text: string): string[][]`, a minimal CSV parser that currently splits on commas and newlines only. Add RFC 4180 quoted-field support so fields wrapped in double quotes may contain commas, newlines, and escaped quotes.

## Scope
- `src/parse.ts`
- `test/parse.test.ts`

## Acceptance criteria
- A field wrapped in double quotes may contain commas: `a,"b,c",d` → `[["a", "b,c", "d"]]`.
- A quoted field may contain CRLF or LF newlines, which are preserved inside the field.
- Two consecutive double quotes inside a quoted field decode to one literal quote: `"say ""hi"""` → `say "hi"`.
- Unquoted fields are unchanged; an empty quoted field `""` is an empty string; a trailing newline does not add an empty row.
- An unterminated quoted field throws an `Error` whose message contains `unterminated quoted field`.
- A quote character inside an unquoted field is kept literally (`a"b` stays `a"b`).
- `npm run typecheck`, `npm run lint`, and `npm test` pass; the existing tests keep passing unchanged.
