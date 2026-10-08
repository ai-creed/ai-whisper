# JSON Schema validator: refs, combinators and pointer paths

## Task
`src/validate.ts` exports `validate(schema: Schema, value: unknown)` returning `{ ok: true }` or `{ ok: false; errors: Array<{ path: string; message: string }> }`. It supports `type`, `properties`, `required`, `items`, `enum`, `minimum`/`maximum` and `minLength`/`maxLength`, and `src/types.ts` holds the `Schema` type. Extend it with local `$ref` resolution, schema combinators, `additionalProperties` and `pattern`, keeping every existing keyword behaving exactly as it does now. The result is a design for a small, self-contained validator; follow the structure below.

**Data model**
- Extend `Schema` in `src/types.ts` with `$ref`, `definitions`, `$defs`, `allOf`, `anyOf`, `oneOf`, `additionalProperties` (`boolean | Schema`) and `pattern`.
- `$ref` strings are local only and take the form `#/definitions/<name>` or `#/$defs/<name>`. They resolve against the root schema passed to `validate`, and a resolved target may itself contain further `$ref`s.
- A `$ref` is evaluated in addition to any sibling keywords on the same schema node. Errors from the referenced schema keep the path of the node that holds the `$ref`.
- Resolution lives in `src/refs.ts`; the combinators live in `src/combinators.ts`; `src/validate.ts` stays the public entry point and orchestrates them.

**Public API**
- `validate(schema, value)` keeps its signature and result shape.
- Error paths are JSON pointers: the root is the empty string `""`, object keys and array indexes are appended as `/key` and `/0`, and `~` and `/` inside a key are escaped as `~0` and `~1`. A nested failure looks like `/items/0/name`.
- `$ref` to a recursive definition (a tree whose nodes reference the same definition) must work for finite values.
- `allOf`: every branch is evaluated against the same value at the same path, and the errors of all branches are collected.
- `anyOf`: no errors if at least one branch has no errors. Otherwise the errors of every branch are reported, each message prefixed `anyOf[<i>]: ` with the branch index, at the original paths.
- `oneOf`: exactly one branch must have no errors. Otherwise a single error `expected exactly one match, got <n>` (n is the number of matching branches, 0 or more than 1) is reported at the node's path, and no branch errors are listed.
- `additionalProperties`: applies to keys of an object that are not named in that schema's `properties`. `false` reports one error per extra key, with the path of that key and message `additional property not allowed`. A `Schema` validates each extra value at the path of its key. `true` or absent allows extras.
- `pattern`: for string values, the pattern is an ECMAScript regular expression tested unanchored. On mismatch the message is `does not match pattern <pattern>`.
- Ordering: errors are collected rather than short-circuited, in document order. Within one schema node the keywords run in this order: `type`, `enum`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `$ref`, `allOf`, `anyOf`, `oneOf`, `required`, `properties`, `additionalProperties`, `items`. `properties` are visited in the schema's declaration order, array items by index, and extra keys in the value's key order.

**Error handling**
- A `$ref` cycle (a reference that, while being expanded for a value at a given path, is reached again for that same path) must not loop. It reports exactly one error with message `circular $ref` at that path and expansion of that reference stops. Recursion that descends into deeper parts of the value is not a cycle.
- A `$ref` that does not resolve (wrong form, or a missing definition) reports `unresolved $ref <ref>` at the node's path instead of throwing.
- An invalid `pattern` reports `invalid pattern <pattern>` at the node's path instead of throwing.
- `validate` itself never throws for any schema or value.

**Non-goals**
- Remote or file `$ref`s, `$id`, `$anchor`, and `format` assertions.
- `patternProperties`, `not`, `if`/`then`/`else`, and type `integer`.
- Changing the existing error messages or paths of the keywords that already work.

Add tests for the new behaviour in `test/refs.test.ts` and `test/combinators.test.ts`.

## Scope
- `src/validate.ts`
- `src/refs.ts`
- `src/combinators.ts`
- `src/types.ts`
- `test/refs.test.ts`
- `test/combinators.test.ts`

## Acceptance criteria
- `$ref` resolves to schemas under both `definitions` and `$defs`.
- Nested refs resolve: a definition may reference another definition, and recursive definitions validate finite values.
- A circular `$ref` reports `circular $ref` with the path where it was detected, and validation does not hang.
- `allOf` collects errors from all branches.
- `anyOf` is ok when any branch is ok; otherwise it reports the errors from every branch prefixed `anyOf[i]`.
- `oneOf` with two matching branches reports the error `expected exactly one match, got 2`.
- `additionalProperties: false` rejects extra keys with the path to each extra key.
- `additionalProperties: Schema` validates the extra values against that schema.
- A `pattern` mismatch error includes the pattern.
- Every error path is a JSON pointer starting with `/`, and the root path is `""`.
- Errors are reported in document order.
- The behaviour of the existing keywords is unchanged and the existing tests keep passing unchanged.
- `npm run typecheck`, `npm run lint`, and `npm test` pass.
