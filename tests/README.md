# LifeOS tests

## What kind of verification is this?

| Layer | Command | What actually runs |
| --- | --- | --- |
| Unit / integration | `npm run test:cognitive` | **Real runtime**: temp SQLite DB, production `src/lib/*` code via TypeScript transpile, Node's built-in test runner (`node:test`) |
| Browser e2e | `npm run test:e2e:brain-map` | **Real browser**: isolated Next dev server + Playwright Chromium against `/insights` Brain Map |
| Legacy verifiers | `npm run verify:cognitive-*` | Same style as unit tests (assert scripts); kept for CI continuity |
| Typecheck | `npx tsc --noEmit` | Compile-only — **not** a substitute for the suites above |

These are **not** “it built so it works” checks. Cognitive unit tests seed pressure-wired vs steady behavioral data and assert metrics, memory promotion, planner bias, and API handlers.

### What “pass” means

- **Unit/integration:** production TypeScript modules run against a fresh SQLite file (migrations applied). Failures throw and fail the suite.
- **e2e:** Chromium loads a live Next dev server bound to that DB. UI assertions use `data-testid` hooks.
- **Not covered here:** live Google OAuth, live Gemini key paths, multi-week real-user history.

### Recheck notes (anti-hallucination)

Claim only what the suite asserts. If you change coach/planner/rewards, re-run:

```bash
npm run test:cognitive:all
```


## Cognitive Self-Map coverage

| Area | File |
| --- | --- |
| B1 traits / PDI / voluntary | `tests/unit/cognitive-traits.test.cjs` |
| B2 confirm/dispute/aspire + mem_facts | `tests/unit/cognitive-stance.test.cjs` |
| B4 experiments + planner | `tests/unit/cognitive-experiments.test.cjs` |
| B5 history / trends / weekly Q | `tests/unit/cognitive-history.test.cjs` |
| B4.5 active coach trust + auto-rewire | `tests/unit/cognitive-active-coach.test.cjs` |
| Self-answer + multi-week trajectory | `tests/unit/cognitive-self-answer.test.cjs` |
| API route handlers | `tests/unit/cognitive-api.test.cjs` |
| Insights Brain Map UI | `tests/e2e/brain-map.spec.cjs` |
| Live dep honesty report | `npm run test:live-gates` |

## Commands

```bash
# All unit/integration cognitive tests
npm run test:cognitive

# Browser Brain Map e2e (starts Next on temp DB)
npm run test:e2e:brain-map

# Full cognitive gate
npm run test:cognitive:all
```
