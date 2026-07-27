import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260727014008 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_integration" add column if not exists "created_fulfillment_set_id" text null, add column if not exists "created_service_zone_id" text null, add column if not exists "created_shipping_option_ids" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_integration" drop column if exists "created_fulfillment_set_id", drop column if exists "created_service_zone_id", drop column if exists "created_shipping_option_ids";`);
  }

}
