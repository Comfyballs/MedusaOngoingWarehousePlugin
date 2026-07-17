# Medusa Ongoing Warehouse Plugin

A [Medusa v2](https://docs.medusajs.com/) plugin that integrates Medusa with the [Ongoing Warehouse](https://www.ongoingwarehouse.com/) WMS (warehouse management system) — analogous to Medusa's ShipStation integration, but for Ongoing.

It ships a fulfillment provider that pushes orders to Ongoing and cancels them on request, subscribers and scheduled jobs that keep order edits/cancellations, shipment status, and inventory in sync, a webhook receiver for Ongoing status pushes, and an admin UI (ops dashboard, settings, and an order-detail widget).

## Documentation

Full documentation lives in [`docs/wiki/`](docs/wiki/Home.md):

- **Installing and operating the plugin:** start at [`docs/wiki/User-Quickstart.md`](docs/wiki/User-Quickstart.md) and [`docs/wiki/User-Setup-Guide.md`](docs/wiki/User-Setup-Guide.md).
- **Contributing to the plugin itself:** start at [`docs/wiki/Dev-Architecture.md`](docs/wiki/Dev-Architecture.md) and [`docs/wiki/Dev-Contributing.md`](docs/wiki/Dev-Contributing.md).
- **Everything else** (configuration reference, troubleshooting, verification, testing, gotchas): see [`docs/wiki/Home.md`](docs/wiki/Home.md) for the full index.

## Requirements

Pinned to Medusa **2.16.0**; package manager is **yarn 4.6.0**; Node **>= 20**. See [`docs/wiki/Dev-Contributing.md`](docs/wiki/Dev-Contributing.md) for build/test commands.
