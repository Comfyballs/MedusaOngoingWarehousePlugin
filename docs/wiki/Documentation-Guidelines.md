This page defines the standard every page in this wiki follows. Read it before adding or editing documentation so the wiki stays consistent as it grows.

## Structure and page naming

- One file = one page = one topic. If a page needs its own table of contents to navigate itself, split it.
- Name files `Area-Topic.md` in TitleCase-with-hyphens (`User-Setup-Guide.md`, `Dev-Testing.md`). GitHub renders hyphens as spaces in the page title — never put spaces in the filename.
- Prefix pages by audience: `User-` for people installing and operating the plugin, `Dev-` for people changing this repo. Prefixes substitute for folders — GitHub wikis are a flat namespace and cross-directory links are unreliable, so keep all content pages at the wiki root.
- `Home.md`, `_Sidebar.md`, and `_Footer.md` are special filenames GitHub recognizes (landing page, persistent sidebar, persistent footer). Home is a router, not content — keep it short.
- Organize by reader need, not by feature (the [Diátaxis](https://diataxis.fr/) split): a tutorial gets someone to first success, a how-to accomplishes one task, a reference is for lookup, an explanation builds understanding. Don't mix these in one page — link between them instead.

## Writing style

- Second person, active voice, present tense: "The provider throttles concurrent requests", not "requests will be throttled".
- Sentence case for headings, no trailing punctuation, start body content at H2, nest no deeper than H3.
- Every page opens with a one- or two-sentence statement of what it covers and who it's for.
- Direct and plain — no marketing language ("seamlessly", "powerful") in how-to or reference pages.
- Front-load the important word in headings and sentences so skimming works.

## Code samples

- Fenced blocks with a language tag (```ts, ```bash, ```json) — never plain indentation.
- Introduce a block with a sentence ending in `:` when the block follows immediately.
- Samples must be either literal commands from this repo (`yarn build`, `yarn test:live`) or complete runnable snippets. No pseudo-code presented as runnable.
- Mark placeholders unambiguously (`<your-goods-owner-id>`) — never plausible-looking fake values a reader might copy.
- Show omitted code with a language-native comment (`// ...`), not bare ellipses.

## Admonitions and links

- Four levels, used sparingly: **Note** (non-critical aside), **Tip**, **Caution** (recoverable risk), **Warning** (irreversible/data loss). At most one or two per page — if everything is a callout, nothing is.
- Never put prerequisites or required steps in a Note; they belong in the main flow.
- Page-to-page links use wiki syntax: `[[Page Title]]` or `[[link text|Page-File-Name]]`.
- Links into repo code use full `https://github.com/Comfyballs/MedusaOngoingWarehousePlugin/blob/main/<path>` URLs, so they resolve from any wiki page.
- External links always get descriptive link text — never bare URLs, never "click here".

## Keeping docs current

- Any PR that changes plugin options, provider methods, module models, route paths, workflows/jobs/subscribers behavior, or install/build commands must update the affected wiki page(s) in the same PR. The change isn't done until the doc matches it.
- Prefer one authoritative page plus links over duplicating an explanation; if you repeat yourself across pages, extract and link.
- A stale doc is worse than no doc — trim or delete pages that no longer reflect reality rather than letting them rot.
- Describe current behavior only. Never reference internal milestones ("added in Milestone 2") or future plans in user-facing pages.

## Where the source lives and how to publish

The wiki source of truth is `docs/wiki/` in the main repo — edit it there, through normal PRs, so doc changes are reviewed with the code that motivates them. Publishing copies those files to the wiki repo; see [[Dev Documentation Maintenance]] for the exact steps.

## Related pages

- [[Dev Documentation Maintenance]]
- [[Dev Contributing]]
- [[Home]]
