import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260715120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_integration" add column if not exists "last_stock_delta_cursor" text null, add column if not exists "last_full_stock_sync_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_integration" drop column if exists "last_stock_delta_cursor", drop column if exists "last_full_stock_sync_at";`);
  }

}
