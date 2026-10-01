import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("fork migration boundary", (it) => {
  it.effect("rejects v2 state before changing schema or migration records", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 40 });
      yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES ('preserved-thread')`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (41, 'OrchestrationV2')`;
      const before = yield* sql`SELECT * FROM sqlite_master ORDER BY name`;
      const outcome = yield* runMigrations().pipe(
        Effect.match({ onFailure: (error) => String(error), onSuccess: () => "accepted" }),
      );
      assert.include(outcome, "Orchestration V2");
      assert.deepEqual(yield* sql`SELECT * FROM sqlite_master ORDER BY name`, before);
      assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_projection_threads`, [
        { thread_id: "preserved-thread" },
      ]);
      const migrations =
        yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 41`;
      assert.deepEqual(migrations, [{ migration_id: 41, name: "OrchestrationV2" }]);
    }),
  );
});
