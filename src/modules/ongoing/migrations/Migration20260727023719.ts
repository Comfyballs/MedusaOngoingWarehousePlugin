import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260727023719 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ongoing_order_sync_integration_id" ON "ongoing_order_sync" ("integration_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ongoing_order_sync_sync_state_error_class" ON "ongoing_order_sync" ("sync_state", "error_class") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_ongoing_order_sync_integration_id";`);
    this.addSql(`drop index if exists "IDX_ongoing_order_sync_sync_state_error_class";`);
  }

}
