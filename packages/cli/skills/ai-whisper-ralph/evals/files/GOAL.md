# Goal: dependency hygiene

- [ ] Every direct dependency pinned to an exact version
- [ ] No dependency with a known critical advisory remains
- [ ] Unused dependencies removed from package.json

Per-chunk procedure: run the full test suite before each commit; one
dependency change per commit.
