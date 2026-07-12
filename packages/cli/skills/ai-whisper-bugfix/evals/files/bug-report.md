# Bug report: pagination returns page 0 on empty result sets

Symptoms: the list endpoint returns `page: 0, pages: 0` when a filter matches
nothing; the frontend then requests page 0 and renders a spinner forever.

Reproduction: GET /api/items?filter=nonexistent — observe `pages: 0` in the
response body, then the follow-up GET /api/items?page=0 hangs the UI.

Expected: `pages` is at least 1 and page 0 is never requested; empty result
sets render the empty state.
