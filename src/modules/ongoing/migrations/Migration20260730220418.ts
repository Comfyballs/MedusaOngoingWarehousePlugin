import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260730220418 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_integration" add column if not exists "last_done_sweep_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ongoing_integration" drop column if exists "last_done_sweep_at";`);
  }

}
