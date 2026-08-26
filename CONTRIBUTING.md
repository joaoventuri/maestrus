# Contributing

Thanks for considering it. A few things that make review fast:

## Running it

```bash
npm install
npm run dev      # desktop app with hot reload
npm test         # unit tests + i18n key check
```

## House rules

- **Trilingual UI.** Every user-facing string lives in
  `renderer/src/i18n/{en,pt,es}.json`. `npm test` fails if a `t()` key is
  missing in any of the three — that check exists because untranslated keys
  once shipped and showed raw identifiers to users.
- **No emojis in the app UI.** Use `lucide-react` icons.
- **One accent color:** neon orange `#ff8a3d`.
- **Add a test when you fix a bug.** Several tests here exist because a
  regression shipped once. Verify the test fails before your fix and passes
  after — a test that never failed proves nothing.

## Commits

Conventional-ish prefixes (`fix:`, `feat:`, `perf:`, `docs:`) and a body that
explains *why*, not what. The diff already says what.
