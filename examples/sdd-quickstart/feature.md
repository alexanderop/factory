# Feature: dark mode toggle

Add a dark mode toggle to the settings page. Persist the preference to localStorage and
apply it on page load. Default to system preference if nothing is saved.

## Acceptance

- A toggle in `/settings` switches the theme immediately.
- Refreshing the page preserves the chosen theme.
- A new visitor sees their system preference applied.
