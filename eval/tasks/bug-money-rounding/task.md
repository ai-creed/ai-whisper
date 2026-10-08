# Money allocation does not sum to the input

## Task
Allocations from `allocate` in `src/money.ts` do not sum to the input amount. `allocate(100, [1, 1, 1])` returns parts summing to 99.99, and `allocate(0.05, [1, 1, 1])` returns parts summing to 0.06. Fix it so the parts always sum exactly to the amount, with the remainder distributed one cent at a time to the earliest parts (largest-remainder order is not required; earliest-first is).

## Scope
- `src/money.ts`
- `test/money.test.ts`

## Acceptance criteria
- `allocate(100, [1, 1, 1])` returns `[33.34, 33.33, 33.33]`.
- `allocate(0.05, [1, 1, 1])` returns `[0.02, 0.02, 0.01]`.
- `allocate(-100, [1, 1, 1])` returns `[-33.34, -33.33, -33.33]`, and no part is ever negative zero.
- For a thousand seeded random amounts and ratio lists, the parts sum exactly to the amount in cents.
- Ratios of zero allocate exactly zero to their parts, even when cents are left over.
- Empty ratios throw.
- All-zero ratios throw.
- Internal arithmetic uses integer minor units (cents); the module does not use `toFixed`.
- The existing tests keep passing unchanged, and `npm run typecheck`, `npm run lint`, and `npm test` pass.
