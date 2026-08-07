import fs from "fs"
import path from "path"

// Regression guard for MedusaOngoingWarehousePlugin-cb3.
//
// Medusa records EVERY module's migrations in one shared `mikro_orm_migrations`
// table, keyed by the bare migration name — there is no per-module namespace. A
// name this plugin ships that another module in the consuming app already
// executed is therefore treated as "already run" and SILENTLY SKIPPED, so the
// schema change never lands and only surfaces later as a missing column at
// write time.
//
// That is exactly what happened with the hand-authored `Migration20260715120000`
// (round timestamp, 12:00:00), which collided with a row another module had
// written three weeks before this plugin was installed: `ongoing_integration`
// ended up without `last_stock_delta_cursor` and creating an integration failed.
//
// Round timestamps are the collision-prone ones — they are what a human picks
// when writing a migration by hand, so several modules pick the same. Names
// produced by `medusa plugin:db:generate` come from the real clock at
// second precision and do not collide in practice. Hence: generate migrations,
// never hand-stamp them.
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations")

const MIGRATION_FILE = /^Migration(\d{14})\.ts$/

function migrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => MIGRATION_FILE.test(file))
    .sort()
}

describe("ongoing module migrations", () => {
  it("ships at least one migration (guards against a bad path in this test)", () => {
    expect(migrationFiles().length).toBeGreaterThan(0)
  })

  it("uses no round timestamp, which is what collides with other modules", () => {
    const offenders = migrationFiles().filter((file) => {
      const stamp = file.match(MIGRATION_FILE)![1]
      const time = stamp.slice(8) // HHMMSS
      // A generated stamp lands on an arbitrary second. Anything ending in a
      // whole or half hour was typed by a person.
      return time.endsWith("0000") || time.endsWith("3000")
    })

    if (offenders.length > 0) {
      throw new Error(
        `Round-timestamp migration name(s) found: ${offenders.join(", ")}. ` +
          `Migrations are recorded in one mikro_orm_migrations table shared by ` +
          `every module in the consuming app, keyed by bare name — a round ` +
          `HH:00:00/HH:30:00 stamp is exactly the kind another module is likely ` +
          `to have already used, and MikroORM silently SKIPS a name it has ` +
          `already seen (see MedusaOngoingWarehousePlugin-cb3). Do not hand-stamp ` +
          `migration timestamps — run \`npx medusa plugin:db:generate\` instead.`
      )
    }
  })

  it("declares a class whose name matches its filename", () => {
    for (const file of migrationFiles()) {
      const name = file.replace(/\.ts$/, "")
      const source = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
      expect(source).toContain(`export class ${name} extends Migration`)
    }
  })

  it("has no duplicate migration names", () => {
    const names = migrationFiles()
    if (new Set(names).size !== names.length) {
      throw new Error(
        `Duplicate migration name(s) found among: ${names.join(", ")}. ` +
          `The mikro_orm_migrations ledger is shared app-wide and keyed by bare ` +
          `name (see MedusaOngoingWarehousePlugin-cb3) — a duplicate here means ` +
          `one of the two migrations will be silently skipped. Use ` +
          `\`npx medusa plugin:db:generate\` to produce unique, real-clock names ` +
          `instead of hand-authoring timestamps.`
      )
    }
  })
})
