This page explains where the wiki source lives, how it gets published to the GitHub wiki, and the rule that documentation changes ship with the code change that makes them necessary. For the writing conventions themselves, see [[Documentation Guidelines]].

## Where the source lives

The wiki pages are authored **in the main repo**, under `docs/wiki/`, as flat markdown files. This keeps docs reviewable in the same pull request as the code they describe. Filenames are the page titles: hyphens render as spaces, and the `Dev-` prefix groups the contributor pages (a separate `User-` set covers merchants installing the plugin).

Editing a page is an ordinary repo edit — change the `.md` file in `docs/wiki/`, and it goes through the same PR and review as any other change.

## How to publish to the GitHub wiki

A GitHub wiki is its own git repository at `https://github.com/Comfyballs/MedusaOngoingWarehousePlugin.wiki.git`. Only commits on that repo's default branch go live. To publish the `docs/wiki/` source to it, push the files there:

```bash
# Clone the wiki repo (once), alongside the main checkout:
git clone git@github.com:Comfyballs/MedusaOngoingWarehousePlugin.wiki.git

# Copy the current source over and publish:
cp path/to/main-repo/docs/wiki/*.md MedusaOngoingWarehousePlugin.wiki/
cd MedusaOngoingWarehousePlugin.wiki
git add .
git commit -m "docs: sync wiki from docs/wiki"
git push
```

The `docs/wiki/` directory in the main repo is the source of truth; the wiki repo is a publish target. Edit in `docs/wiki/`, then sync — do not edit the live wiki directly, or the next sync will overwrite your change.

> **Note**
> Keep all content pages at the wiki repo root. GitHub wiki cross-page linking across subdirectories is unreliable, so the flat `Dev-*` / `User-*` layout is deliberate. Use a real subdirectory only for binary assets such as images.

## The docs-update rule

Treat documentation like a compensation step in a workflow: a change is not done until the docs match it. Any PR that changes:

- a plugin option,
- a public extension-point shape (provider methods, module models, route paths), or
- an install, build, or test command,

must update the corresponding wiki page **in the same PR**, not as a follow-up. A reviewer should block a PR on a missing doc update the same way they would block on a missing test.

If a page does not exist yet for something you just built, write the minimum page rather than skip it. A stale doc is worse than no doc, so when something is removed, trim or delete its page rather than let it rot. Prefer linking to one authoritative page over duplicating an explanation across two.

## Related pages

- [[Documentation Guidelines]]
- [[Dev Contributing]]
- [[Dev Architecture]]
