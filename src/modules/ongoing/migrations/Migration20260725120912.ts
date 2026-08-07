import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260725120912 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_order_sync" add column if not exists "cancel_refused_at" timestamptz null;`);
    this.addSql(`alter table if exists "ongoing_order_sync" add column if not exists "cancel_refused_reason" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_order_sync" drop column if exists "cancel_refused_at";`);
    this.addSql(`alter table if exists "ongoing_order_sync" drop column if exists "cancel_refused_reason";`);
  }

}
