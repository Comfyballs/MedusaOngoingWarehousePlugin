import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260623211927 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_order_sync" drop constraint if exists "ongoing_order_sync_ongoing_order_number_unique";`);
    this.addSql(`alter table if exists "ongoing_integration" drop constraint if exists "ongoing_integration_stock_location_id_unique";`);
    this.addSql(`alter table if exists "ongoing_integration" drop constraint if exists "ongoing_integration_credential_key_unique";`);
    this.addSql(`create table if not exists "ongoing_integration" ("id" text not null, "credential_key" text not null, "enabled" boolean not null default true, "stock_location_id" text not null, "stock_sync_enabled" boolean not null default true, "stock_sync_interval" text null, "status_poll_interval" text null, "stock_reconcile_mode" text check ("stock_reconcile_mode" in ('sellable_plus_reserved', 'precise', 'onhand')) not null default 'sellable_plus_reserved', "edit_sync_rules" jsonb null, "shipped_status_codes" jsonb null, "cancellable_status_codes" jsonb null, "last_stock_sync_at" timestamptz null, "last_status_poll_at" timestamptz null, "sync_lock_until" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "ongoing_integration_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ongoing_integration_credential_key_unique" ON "ongoing_integration" ("credential_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ongoing_integration_stock_location_id_unique" ON "ongoing_integration" ("stock_location_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ongoing_integration_deleted_at" ON "ongoing_integration" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "ongoing_order_sync" ("id" text not null, "integration_id" text not null, "medusa_order_id" text not null, "medusa_fulfillment_id" text null, "ongoing_order_number" text not null, "ongoing_order_id" integer null, "latest_status_code" integer null, "latest_status_text" text null, "sync_state" text check ("sync_state" in ('pending', 'sent', 'shipped', 'cancelled', 'error')) not null default 'pending', "error_class" text check ("error_class" in ('retryable', 'terminal')) null, "last_synced_at" timestamptz null, "last_error" text null, "retry_count" integer not null default 0, "shipped_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "ongoing_order_sync_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ongoing_order_sync_medusa_order_id" ON "ongoing_order_sync" ("medusa_order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ongoing_order_sync_medusa_fulfillment_id" ON "ongoing_order_sync" ("medusa_fulfillment_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ongoing_order_sync_ongoing_order_number_unique" ON "ongoing_order_sync" ("ongoing_order_number") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ongoing_order_sync_deleted_at" ON "ongoing_order_sync" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "ongoing_integration" cascade;`);

    this.addSql(`drop table if exists "ongoing_order_sync" cascade;`);
  }

}
