# Implementation plan

- [x] system-preference-default: first-time visitors see their OS `prefers-color-scheme` applied with no flash before mount. — added inline <head> script in index.html that applies the dark class synchronously from localStorage/matchMedia; 3 new tests, all green.
- [x] theme-toggle-and-persistence: header toggle switches light/dark instantly and the choice survives reload via localStorage. — App.vue now applies the stored preference on setup, so a remount honors localStorage; 3 new tests in themePersistence.test.ts, all 14 green.
- [x] todo-interactions-dark-contrast: add/toggle/delete/filter/clear-completed all render with readable contrast in dark mode using Nuxt UI semantic tokens. — todoInteractions.test.ts exercises all 5 interactions in dark mode and asserts no hardcoded gray/zinc/slate/neutral/stone or black/white classes appear in the rendered HTML; App.vue uses only Nuxt UI semantic tokens; 14/14 green.

<!-- ralph: pick the first unchecked item; mark it `- [x]` with a one-line note when complete. -->
