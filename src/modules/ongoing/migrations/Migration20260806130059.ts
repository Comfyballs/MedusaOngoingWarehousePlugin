import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260806130059 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`drop index if exists "IDX_ongoing_integration_credential_key_unique";`);

    this.addSql(`alter table if exists "ongoing_integration" add column if not exists "goods_owner_id" integer not null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_integration" drop column if exists "goods_owner_id";`);

    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ongoing_integration_credential_key_unique" ON "ongoing_integration" ("credential_key") WHERE deleted_at IS NULL;`);
  }

}
