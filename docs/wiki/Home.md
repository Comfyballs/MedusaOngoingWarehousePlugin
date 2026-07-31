Medusa Ongoing Warehouse Plugin — a [Medusa v2](https://docs.medusajs.com/) plugin that fulfills orders through the [Ongoing WMS](https://www.ongoingwarehouse.com/) warehouse management system and syncs inventory, shipments, and tracking back into Medusa. Orders are pushed when a fulfillment is created, Ongoing reports shipments back via webhooks, and scheduled jobs reconcile stock and retry failures.

## Using the plugin

Install and operate the integration in your Medusa app:

- [[User Quickstart]] — from install to your first synced order
- [[User Setup Guide]] — full recommended setup, including Ongoing-side webhook configuration
- [[User Configuration Reference]] — every plugin option, default, and validation rule
- [[User How It Works]] — what happens automatically: order push, shipments, inventory, edits, cancellations, retries
- [[User Sync Reference]] — trigger-to-action map, how status codes are interpreted, how tracking is stored
- [[User Daily Operation]] — the admin dashboard and order sync widget
- [[User Troubleshooting]] — sync states, common failures, and fixes
- [[User Verification]] — confirm the integration works end to end
- [[User Ongoing Concepts]] — goods owners, articles, ways of delivery, order statuses

## Contributing and internals

Work on the plugin itself:

- [[Dev Architecture]] — modules, client stack, workflows, webhook flow, lifecycle narratives
- [[Dev Contributing]] — environment, commands, branch/commit/PR conventions, required review
- [[Dev Gotchas]] — Node 26, packaging, migrations, rate limits, and other traps
- [[Dev Testing]] — the unit, Medusa integration, and live Ongoing suites
- [[Dev Local App Testing]] — install into a local Medusa app and exercise it by hand, without publishing
- [[Dev Beads]] — the bd issue tracker this project uses instead of GitHub Issues
- [[Dev Medusa Rules]] — Medusa-specific rules every contributor must follow
- [[Dev Documentation Maintenance]] — how this wiki is sourced and published

All documentation follows the [[Documentation Guidelines]].
