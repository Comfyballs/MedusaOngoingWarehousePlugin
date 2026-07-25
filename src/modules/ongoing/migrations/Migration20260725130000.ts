import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260725130000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_order_sync" add column if not exists "sync_kind" text check ("sync_kind" in ('order', 'return')) not null default 'order';`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_order_sync" drop column if exists "sync_kind";`);
  }

}
