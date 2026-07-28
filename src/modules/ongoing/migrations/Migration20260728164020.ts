import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260728164020 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_order_sync" drop constraint if exists "ongoing_order_sync_sync_state_check";`);

    this.addSql(`alter table if exists "ongoing_integration" add column if not exists "delivered_status_codes" jsonb null;`);

    this.addSql(`alter table if exists "ongoing_order_sync" add column if not exists "delivered_at" timestamptz null;`);
    this.addSql(`alter table if exists "ongoing_order_sync" add constraint "ongoing_order_sync_sync_state_check" check("sync_state" in ('pending', 'sent', 'shipped', 'delivered', 'cancelled', 'error'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_order_sync" drop constraint if exists "ongoing_order_sync_sync_state_check";`);

    this.addSql(`alter table if exists "ongoing_integration" drop column if exists "delivered_status_codes";`);

    this.addSql(`alter table if exists "ongoing_order_sync" drop column if exists "delivered_at";`);

    this.addSql(`alter table if exists "ongoing_order_sync" add constraint "ongoing_order_sync_sync_state_check" check("sync_state" in ('pending', 'sent', 'shipped', 'cancelled', 'error'));`);
  }

}
