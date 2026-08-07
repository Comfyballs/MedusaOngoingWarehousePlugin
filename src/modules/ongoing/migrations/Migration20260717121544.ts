import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260717121544 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_integration" add column if not exists "stock_sync_lock_until" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_integration" drop column if exists "stock_sync_lock_until";`);
  }

}
