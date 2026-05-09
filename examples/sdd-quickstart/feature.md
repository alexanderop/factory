# Feature: dark mode

Add dark mode to the to-do app at `./app`.

The app is a Vue 3 + Vite project using Nuxt UI v4. Wire up Nuxt UI's
color-mode support, expose a toggle in the header, persist the user's
choice across reloads, and respect the OS preference for first-time
visitors.

## Acceptance

- A toggle in the app header switches between light and dark immediately,
  with no flash of the wrong theme on first paint.
- Refreshing the page preserves the chosen theme.
- A new visitor sees their system preference (`prefers-color-scheme`) applied.
- All existing to-do interactions (add, toggle, delete, filter, clear
  completed) keep working in both themes with readable contrast.
