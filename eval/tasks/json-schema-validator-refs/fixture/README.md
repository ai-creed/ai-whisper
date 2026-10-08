Small JSON Schema validator: `validate(schema, value)` in `src/validate.ts`.
Supports type, properties, required, items, enum, minimum/maximum and minLength/maxLength.
Errors carry a JSON-pointer `path` and a `message`.
Run `npm run typecheck`, `npm run lint`, `npm test`.
