import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260701213600 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_order_sync" add column if not exists "edit_blocked_at" timestamptz null, add column if not exists "edit_blocked_category" text check ("edit_blocked_category" in ('address_contact', 'line_items')) null, add column if not exists "edit_blocked_reason" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_order_sync" drop column if exists "edit_blocked_at", drop column if exists "edit_blocked_category", drop column if exists "edit_blocked_reason";`);
  }

}
