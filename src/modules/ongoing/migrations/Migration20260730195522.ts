import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260730195522 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_order_sync" add column if not exists "done_synced_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_order_sync" drop column if exists "done_synced_at";`);
  }

}
