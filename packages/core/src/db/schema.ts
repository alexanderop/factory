import type { SqlClient } from '@effect/sql/SqlClient';
import { Effect } from 'effect';

// One DB per run; swap for `SqliteMigrator` when the schema needs to evolve.
const STATEMENTS: ReadonlyArray<string> = [
	`PRAGMA foreign_keys = ON`,
	`CREATE TABLE run (
    id              TEXT PRIMARY KEY,
    pipeline        TEXT NOT NULL,
    default_harness TEXT,
    cwd             TEXT NOT NULL,
    prd_source      TEXT,
    factory_file    TEXT,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER,
    status          TEXT NOT NULL CHECK (status IN ('running','ok','error')),
    error_tag       TEXT,
    error_message   TEXT
  )`,
	`CREATE TABLE step (
    run_id      TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    ord         INTEGER NOT NULL,
    step_id     TEXT NOT NULL,
    source      TEXT NOT NULL,
    harness     TEXT NOT NULL,
    until_pred  TEXT,
    max_iters   INTEGER NOT NULL,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    status      TEXT NOT NULL CHECK (status IN ('running','ok','failed')),
    PRIMARY KEY (run_id, ord)
  )`,
	`CREATE TABLE iter (
    run_id        TEXT NOT NULL,
    step_ord      INTEGER NOT NULL,
    n             INTEGER NOT NULL,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    exit_code     INTEGER,
    until_passed  INTEGER,
    until_output  TEXT,
    files_changed INTEGER,
    PRIMARY KEY (run_id, step_ord, n),
    FOREIGN KEY (run_id, step_ord) REFERENCES step(run_id, ord) ON DELETE CASCADE
  )`,
	`CREATE TABLE event (
    seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id   TEXT NOT NULL,
    ts       INTEGER NOT NULL,
    type     TEXT NOT NULL,
    step_id  TEXT,
    iter     INTEGER,
    payload  TEXT NOT NULL
  )`,
	`CREATE INDEX event_by_run ON event(run_id, seq)`,
	`CREATE TABLE state (
    run_id     TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, key)
  )`,
	`CREATE TABLE slice (
    run_id TEXT NOT NULL,
    id     TEXT NOT NULL,
    title  TEXT,
    done   INTEGER NOT NULL DEFAULT 0,
    notes  TEXT,
    PRIMARY KEY (run_id, id)
  )`,
];

export const installSchema = (sql: SqlClient) =>
	Effect.forEach(STATEMENTS, (stmt) => sql.unsafe(stmt), { discard: true });
