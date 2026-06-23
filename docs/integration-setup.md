# Consuming-app setup (Ongoing Warehouse plugin)

Register the plugin and pass per-warehouse credentials from environment variables:

```ts
// medusa-config.ts
module.exports = defineConfig({
  plugins: [
    {
      resolve: "MedusaOngoingWarehousePlugin",
      options: {
        integrations: [
          {
            key: "warehouse-a",
            baseUrl: process.env.ONGOING_A_URL,
            username: process.env.ONGOING_A_USER,
            password: process.env.ONGOING_A_PASS,
            goodsOwnerId: Number(process.env.ONGOING_A_GOODS_OWNER),
            webhookSecret: process.env.ONGOING_A_WEBHOOK_SECRET,
          },
        ],
        rateLimitConcurrency: 2,
      },
    },
  ],
})
```

After installing/updating the plugin, apply migrations in the app:

```bash
npx medusa db:migrate
```

The fulfillment provider registration (under `@medusajs/medusa/fulfillment` → `providers`) is added in Milestone 2.
