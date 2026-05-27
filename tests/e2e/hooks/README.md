# Hooks e2e smoke tests

One smoke per real CLI. Each test:

1. Spawns the factory `HookRunner` HTTP server.
2. Builds the harness-native hooks config via its adapter, pointing every
   event at the server's unix socket.
3. Runs a one-iter step against the real CLI with a single `sessionStart`
   handler that writes a sentinel file.
4. Asserts the file exists after the run.

If the sentinel is missing, the factory ↔ harness hook round-trip is broken.

## Running

```sh
pnpm test:e2e
```

Tests auto-skip when the corresponding CLI is missing from `PATH` or required
API-key env vars are unset. CI runs them only on the `e2e` lane.
