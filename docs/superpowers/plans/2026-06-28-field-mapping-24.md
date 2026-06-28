# Ongoing Warehouse Plugin — Issue #24: Medusa→PostOrderModel field mapping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `PostOrderModel` placeholder with real typed Ongoing DTOs and add a pure, fully unit-tested `mapOrderToPostOrderModel` mapper that translates a Medusa order + fulfillment into a valid Ongoing `PostOrderModel`, failing fast with operator-readable terminal `OngoingApiError`s on invalid input.

**Architecture:** Pure-TS, no Medusa runtime dependency. The mapper is a **pure function** that takes a **single flat `MapOrderInput` object** (the fields `pushOrderToOngoing` #26 and `syncOrderEditToOngoing` #27 will hydrate via `query.graph`), so it is testable against in-memory fixtures with zero mocking. The mapper does **not** take a `query`/container and does **not** resolve SKUs. SKU→articleNumber resolution and the SKU-collision rule are out of scope (issue #29) and are performed by the **caller** (#26/#27) upstream — inside a workflow step that has `query`, they call the #29 resolver (`resolveArticleNumber(query, sku)`) to populate each line's `article_number` **before** invoking this mapper. The mapper receives an already-resolved `article_number` per line and only fail-fast validates that it is non-empty; it never calls the resolver itself. `wayOfDelivery`/`transporter` are intentionally left omitted in this M2 baseline; a follow-up issue adds the shipping-option→`wayOfDelivery` code mapping.

**Tech Stack:** Medusa v2.16.0 (`@medusajs/framework`), TypeScript 5.6 (Node16 module resolution), yarn 4.6, Jest + `@swc/jest` for unit tests. Mapper is plain TypeScript (no Medusa imports).

## Global Constraints

- Medusa version floor: **2.16.0** (all `@medusajs/*` pinned to 2.16.0).
- Package manager: **yarn 4.6.0**. Node **>= 20**.
- Module names MUST be **camelCase**, never dashes.
- Prices and quantities are sent to Ongoing **as-is** — never ×100, ÷100, or any unit conversion. Medusa is not minor-units.
- Country codes: Medusa stores ISO-2 **lowercase** (e.g. `"no"`). Map straight through to `consignee.countryCode` with no case change unless the spec for a downstream issue says otherwise — Ongoing accepts the value as given here.
- Currency: there is **NO** top-level currency field on `PostOrderModel`. Currency is **per line only** (`PostOrderLinePrices.currencyCode`), set from `order.currency_code`. Ongoing convention is **uppercase**, so uppercase the order currency when writing it onto line prices.
- `PostOrderModel` is `additionalProperties: false` in the Ongoing OpenAPI (v57): the mapper MUST NOT emit keys outside the typed shape. Omit optional fields (do not set them to `undefined`-bearing keys where avoidable; `JSON.stringify` drops `undefined`, which keeps the payload clean).
- Terminal validation failures throw `OngoingApiError` with `kind: "terminal"` (no `status`), producing `sync_state=error` / `error_class=terminal` downstream. Messages must be operator-readable.
- TDD: write the failing Jest unit test first, watch it fail, then implement. Mapper logic is business logic, so TDD is required (not exempt scaffolding).
- This is a **plugin**, not an app: no local Postgres/Medusa instance. All tests here are **pure unit tests** (in-memory fixtures, no DB, no `fetch`). Build correctness is verified with `yarn build`.

---

## File Structure

**Modify:**
- `src/lib/ongoing/types.ts` — replace the `PostOrderModel = Record<string, unknown>` placeholder with the real typed interface tree (`PostOrderModel`, `PostOrderConsignee`, `PostOrderLine`, `PostOrderLinePrices`, `CodeNamePair`, `PostOrderTransporter`, `PostOrderNotification`) plus the mapper input types.
- `src/lib/ongoing/index.ts` — barrel already does `export * from "./types"`, so new types are re-exported automatically; add an explicit `export { mapOrderToPostOrderModel } from "./order-mapper"`.

**Create:**
- `src/lib/ongoing/order-mapper.ts` — `mapOrderToPostOrderModel` + the internal validation helpers (all pure functions).
- `src/lib/ongoing/__tests__/order-mapper.test.ts` — unit tests.

**Responsibility split:** types live in `types.ts` (already the home of the Ongoing DTOs); the mapping behavior lives in its own `order-mapper.ts` so the file stays focused and the import surface for #26/#27 is a single named function. `errors.ts` is reused as-is (no change) — the mapper imports `OngoingApiError` from it.

---

## Task 1: Real PostOrderModel types

**Files:**
- Modify: `src/lib/ongoing/types.ts:45-46` (the comment + `export type PostOrderModel = Record<string, unknown>`)

**Interfaces:**
- Consumes: nothing.
- Produces (exact shapes, used by Task 2's mapper and by workflows #26/#27):
  - `interface CodeNamePair { code: string; name?: string }`
  - `interface PostOrderLinePrices { linePrice?: number; customerLinePrice?: number; currencyCode?: string; discountPercentage?: number; totalVat?: number }`
  - `interface PostOrderLine { rowNumber: string; articleNumber: string; numberOfItems?: number; weight?: number; prices?: PostOrderLinePrices }`
  - `interface PostOrderConsignee { customerNumber?: string; name?: string; address1?: string; address2?: string; address3?: string; postCode?: string; city?: string; countryCode?: string; countryStateCode?: string; remark?: string; doorCode?: string; organisationNumber?: string; vatNumber?: string; deliveryInstruction?: string }`
  - `interface PostOrderTransporter { transporterCode?: string; transporterServiceCode?: string; paymentAdvanced?: boolean }`
  - `interface PostOrderNotification { email?: string; telephone?: string }`
  - `interface PostOrderModel { goodsOwnerId: number; orderNumber: string; deliveryDate: string; consignee: PostOrderConsignee; orderLines?: PostOrderLine[]; freightPrice?: number; customerPrice?: number; wayOfDelivery?: CodeNamePair; transporter?: PostOrderTransporter; emailNotification?: PostOrderNotification; smsNotification?: PostOrderNotification; telephoneNotification?: PostOrderNotification }`
  - Mapper input DTOs (plain, Medusa-shaped subset the workflows will hydrate):
    - `interface MapOrderInputAddress { first_name?: string | null; last_name?: string | null; address_1?: string | null; address_2?: string | null; city?: string | null; postal_code?: string | null; country_code?: string | null; phone?: string | null }`
    - `interface MapOrderInputLine { article_number?: string | null; quantity?: number | null; weight?: number | null; unit_price?: number | null; currency_code?: string | null }`
    - `interface MapOrderInput { goods_owner_id: number; order_number: string; delivery_date?: string | Date | null; currency_code?: string | null; email?: string | null; shipping_address?: MapOrderInputAddress | null; lines: MapOrderInputLine[] }`

- [ ] **Step 1: Replace the placeholder type block**

In `src/lib/ongoing/types.ts`, replace these two lines:
```ts
// Full Medusa->Ongoing order mapping is implemented in Milestone 2.
export type PostOrderModel = Record<string, unknown>
```
with the full typed tree:
```ts
// --- Ongoing PostOrderModel (ProcessOrder body, OpenAPI v57) ---
// `additionalProperties: false` on the server: only emit keys defined here.

export interface CodeNamePair {
  code: string
  name?: string
}

export interface PostOrderLinePrices {
  linePrice?: number
  customerLinePrice?: number
  currencyCode?: string
  discountPercentage?: number
  totalVat?: number
}

export interface PostOrderLine {
  rowNumber: string
  articleNumber: string
  numberOfItems?: number
  weight?: number
  prices?: PostOrderLinePrices
}

export interface PostOrderConsignee {
  customerNumber?: string
  name?: string
  address1?: string
  address2?: string
  address3?: string
  postCode?: string
  city?: string
  countryCode?: string
  countryStateCode?: string
  remark?: string
  doorCode?: string
  organisationNumber?: string
  vatNumber?: string
  deliveryInstruction?: string
}

export interface PostOrderTransporter {
  transporterCode?: string
  transporterServiceCode?: string
  paymentAdvanced?: boolean
}

// Phone/email notifications live on these objects, NOT on the consignee.
export interface PostOrderNotification {
  email?: string
  telephone?: string
}

export interface PostOrderModel {
  // Required (exactly 4 top-level required fields).
  goodsOwnerId: number
  orderNumber: string
  deliveryDate: string
  consignee: PostOrderConsignee
  // Optional.
  orderLines?: PostOrderLine[]
  freightPrice?: number
  customerPrice?: number
  wayOfDelivery?: CodeNamePair
  transporter?: PostOrderTransporter
  emailNotification?: PostOrderNotification
  smsNotification?: PostOrderNotification
  telephoneNotification?: PostOrderNotification
}

// --- Mapper input (Medusa-shaped subset hydrated by the push/edit workflows) ---

export interface MapOrderInputAddress {
  first_name?: string | null
  last_name?: string | null
  address_1?: string | null
  address_2?: string | null
  city?: string | null
  postal_code?: string | null
  // ISO-2, lowercase as Medusa stores it.
  country_code?: string | null
  phone?: string | null
}

export interface MapOrderInputLine {
  // Pre-resolved by the CALLER (#26/#27) via the SKU->articleNumber resolver
  // (issue #29) BEFORE this mapper runs. The mapper never resolves SKUs; it
  // only treats a missing/empty value as a terminal error.
  article_number?: string | null
  quantity?: number | null
  weight?: number | null
  unit_price?: number | null
  currency_code?: string | null
}

export interface MapOrderInput {
  goods_owner_id: number
  order_number: string
  // ISO date-time string or Date; required to form deliveryDate.
  delivery_date?: string | Date | null
  // Order currency; uppercased onto each line's prices.currencyCode.
  currency_code?: string | null
  email?: string | null
  shipping_address?: MapOrderInputAddress | null
  lines: MapOrderInputLine[]
}
```

- [ ] **Step 2: Verify it compiles in isolation**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors referencing `types.ts`. (If the repo's `tsc` surfaces pre-existing unrelated errors, confirm none are in `src/lib/ongoing/types.ts`.) The client still imports `PostOrderModel` as a type only (`putOrder(order: PostOrderModel)`), which remains valid because `PostOrderModel` is still exported.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ongoing/types.ts
git commit -m "feat(ongoing-client): replace PostOrderModel placeholder with typed DTO tree (#24)"
```

---

## Task 2: Pure order mapper + fail-fast terminal validation

**Files:**
- Create: `src/lib/ongoing/order-mapper.ts`
- Test: `src/lib/ongoing/__tests__/order-mapper.test.ts`

**Interfaces:**
- Consumes: `OngoingApiError` from `./errors`; `MapOrderInput`, `MapOrderInputAddress`, `MapOrderInputLine`, `PostOrderModel`, `PostOrderConsignee`, `PostOrderLine`, `PostOrderNotification` from `./types`.
- Produces:
  - `function mapOrderToPostOrderModel(input: MapOrderInput): PostOrderModel` — **pure**. Takes the single flat `MapOrderInput` object whose `lines[]` already carry a resolved `article_number` (no `query`/container, no SKU resolution). Returns a valid `PostOrderModel`, or throws a **terminal** `OngoingApiError` on invalid input. No network, no Medusa, no I/O. (Canonical M2 contract: #24 owns this mapper; #26/#27 build a `MapOrderInput` and call it with that single object.)

**Mapping rules (verified against Ongoing OpenAPI v57):**
- `goodsOwnerId` ← `input.goods_owner_id`.
- `orderNumber` ← `input.order_number` (trimmed; must be non-empty).
- `deliveryDate` ← ISO date-time string from `input.delivery_date` (a `Date` → `.toISOString()`; a string → validated parseable then normalized to ISO).
- `consignee.name` ← `first_name` + `last_name` joined with a single space, trimmed (must be non-empty).
- `consignee.address1/address2/city/postCode/countryCode` ← `address_1`/`address_2`/`city`/`postal_code`/`country_code` (country code passed through unchanged — lowercase ISO-2).
- Per line: `rowNumber` ← sequential 1-based index as a string; `articleNumber` ← `article_number` (trimmed, must be non-empty); `numberOfItems` ← `quantity` (must be > 0); `weight` ← `weight` (omitted if null/undefined); `prices` ← `{ linePrice: unit_price (as-is), currencyCode: (line currency ?? order currency) uppercased }` — omit `prices` entirely if there's no price and no currency.
- Notifications: if `input.email` is present → `emailNotification = { email }`. If `shipping_address.phone` is present → `telephoneNotification = { telephone: phone }`. These are NOT placed on the consignee.
- `wayOfDelivery`/`transporter`: intentionally omitted (M2 baseline). A follow-up issue adds a shipping-option→`wayOfDelivery` code mapping; do not block on it.

**Terminal validation (throw `OngoingApiError({ kind: "terminal" })`, operator-readable message):**
- `shipping_address` missing/null → throws.
- missing `country_code` (empty/whitespace) → throws.
- missing `postCode` (`postal_code` empty/whitespace) → throws.
- missing consignee `name` (both names empty/whitespace) → throws.
- any line whose `article_number` is empty/whitespace → throws. SKU→articleNumber resolution + collision handling (#29) is performed by the caller (#26/#27) upstream; this mapper does NOT call the resolver — its fail-fast check only verifies each line already carries a non-empty `article_number`.
- any line whose `numberOfItems` is `<= 0` (or null/undefined/NaN) → throws.
- `delivery_date` not formable into an ISO date-time (null/undefined, or an unparseable string) → throws.

- [ ] **Step 1: Write the failing test**

Create `src/lib/ongoing/__tests__/order-mapper.test.ts`:
```ts
import { mapOrderToPostOrderModel } from "../order-mapper"
import { OngoingApiError } from "../errors"
import type { MapOrderInput } from "../types"

const baseInput = (): MapOrderInput => ({
  goods_owner_id: 42,
  order_number: "1001-abc123",
  delivery_date: "2026-07-01T10:00:00.000Z",
  currency_code: "nok",
  email: "buyer@example.test",
  shipping_address: {
    first_name: "Ada",
    last_name: "Lovelace",
    address_1: "Storgata 1",
    address_2: "Leil 4",
    city: "Oslo",
    postal_code: "0155",
    country_code: "no",
    phone: "+4798765432",
  },
  lines: [
    { article_number: "SKU-1", quantity: 2, weight: 0.5, unit_price: 199.5, currency_code: "nok" },
    { article_number: "SKU-2", quantity: 1, unit_price: 49.0 },
  ],
})

describe("mapOrderToPostOrderModel — happy path", () => {
  it("produces a valid PostOrderModel with required top-level fields", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    expect(out.goodsOwnerId).toBe(42)
    expect(out.orderNumber).toBe("1001-abc123")
    expect(out.deliveryDate).toBe("2026-07-01T10:00:00.000Z")
    expect(out.consignee).toBeDefined()
  })

  it("maps the shipping address onto the consignee (name joined, country unchanged)", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    expect(out.consignee).toEqual({
      name: "Ada Lovelace",
      address1: "Storgata 1",
      address2: "Leil 4",
      city: "Oslo",
      postCode: "0155",
      countryCode: "no", // ISO-2 lowercase, passed through unchanged
    })
  })

  it("maps lines: 1-based rowNumber, article number, quantity, weight, as-is prices", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    expect(out.orderLines).toEqual([
      {
        rowNumber: "1",
        articleNumber: "SKU-1",
        numberOfItems: 2,
        weight: 0.5,
        prices: { linePrice: 199.5, currencyCode: "NOK" },
      },
      {
        rowNumber: "2",
        articleNumber: "SKU-2",
        numberOfItems: 1,
        prices: { linePrice: 49.0, currencyCode: "NOK" },
      },
    ])
  })

  it("puts email/phone on notification objects, not the consignee", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    expect(out.emailNotification).toEqual({ email: "buyer@example.test" })
    expect(out.telephoneNotification).toEqual({ telephone: "+4798765432" })
    expect(out.consignee).not.toHaveProperty("phone")
    expect(out.consignee).not.toHaveProperty("email")
  })

  it("omits wayOfDelivery and transporter in the M2 baseline", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    expect(out.wayOfDelivery).toBeUndefined()
    expect(out.transporter).toBeUndefined()
  })

  it("uses the order currency (uppercased) when a line has no currency", () => {
    const input = baseInput()
    input.lines[0].currency_code = null
    const out = mapOrderToPostOrderModel(input)
    expect(out.orderLines![0].prices!.currencyCode).toBe("NOK")
  })

  it("converts a Date delivery_date to an ISO string", () => {
    const input = baseInput()
    input.delivery_date = new Date("2026-08-15T08:30:00.000Z")
    const out = mapOrderToPostOrderModel(input)
    expect(out.deliveryDate).toBe("2026-08-15T08:30:00.000Z")
  })

  it("passes prices through with no unit conversion (no x100)", () => {
    const input = baseInput()
    input.lines[0].unit_price = 12.34
    const out = mapOrderToPostOrderModel(input)
    expect(out.orderLines![0].prices!.linePrice).toBe(12.34)
  })

  it("emits no keys outside the typed PostOrderModel shape", () => {
    const out = mapOrderToPostOrderModel(baseInput())
    const allowed = new Set([
      "goodsOwnerId", "orderNumber", "deliveryDate", "consignee", "orderLines",
      "freightPrice", "customerPrice", "wayOfDelivery", "transporter",
      "emailNotification", "smsNotification", "telephoneNotification",
    ])
    // JSON round-trip drops undefined keys, mirroring the wire payload.
    for (const key of Object.keys(JSON.parse(JSON.stringify(out)))) {
      expect(allowed.has(key)).toBe(true)
    }
  })
})

describe("mapOrderToPostOrderModel — terminal validation", () => {
  const expectTerminal = (mutate: (i: MapOrderInput) => void, messagePattern: RegExp) => {
    const input = baseInput()
    mutate(input)
    let thrown: unknown
    try {
      mapOrderToPostOrderModel(input)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(OngoingApiError)
    expect((thrown as OngoingApiError).kind).toBe("terminal")
    expect((thrown as OngoingApiError).message).toMatch(messagePattern)
  }

  it("throws when shipping_address is missing", () => {
    expectTerminal((i) => { i.shipping_address = null }, /shipping address/i)
  })

  it("throws when country_code is missing", () => {
    expectTerminal((i) => { i.shipping_address!.country_code = "" }, /country/i)
  })

  it("throws when postal_code is missing", () => {
    expectTerminal((i) => { i.shipping_address!.postal_code = "  " }, /post(al)? ?code/i)
  })

  it("throws when consignee name is empty", () => {
    expectTerminal((i) => {
      i.shipping_address!.first_name = ""
      i.shipping_address!.last_name = "  "
    }, /name/i)
  })

  it("throws when a line has no resolvable article number", () => {
    expectTerminal((i) => { i.lines[1].article_number = "" }, /article number/i)
  })

  it("throws when a line quantity is <= 0", () => {
    expectTerminal((i) => { i.lines[0].quantity = 0 }, /quantity|numberOfItems/i)
  })

  it("throws when delivery_date is not formable", () => {
    expectTerminal((i) => { i.delivery_date = "not-a-date" }, /delivery date/i)
  })

  it("throws when delivery_date is missing", () => {
    expectTerminal((i) => { i.delivery_date = null }, /delivery date/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn test src/lib/ongoing/__tests__/order-mapper.test.ts`
Expected: FAIL — cannot find module `../order-mapper`.

- [ ] **Step 3: Implement the mapper**

Create `src/lib/ongoing/order-mapper.ts`:
```ts
import { OngoingApiError } from "./errors"
import type {
  MapOrderInput,
  MapOrderInputAddress,
  MapOrderInputLine,
  PostOrderConsignee,
  PostOrderLine,
  PostOrderLinePrices,
  PostOrderModel,
} from "./types"

function terminal(message: string): never {
  throw new OngoingApiError(message, { kind: "terminal" })
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function trimOrUndefined(value: unknown): string | undefined {
  return nonEmpty(value) ? value.trim() : undefined
}

function toIsoDeliveryDate(value: MapOrderInput["delivery_date"]): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      terminal("[ongoing] order has an invalid delivery date")
    }
    return value.toISOString()
  }
  if (nonEmpty(value)) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
      terminal(`[ongoing] order has an unparseable delivery date "${value}"`)
    }
    return parsed.toISOString()
  }
  return terminal("[ongoing] order is missing a delivery date")
}

function mapConsignee(address: MapOrderInputAddress | null | undefined): PostOrderConsignee {
  if (!address) {
    terminal("[ongoing] order is missing a shipping address (consignee cannot be built)")
  }
  const name = [trimOrUndefined(address.first_name), trimOrUndefined(address.last_name)]
    .filter(Boolean)
    .join(" ")
  if (!nonEmpty(name)) {
    terminal("[ongoing] shipping address is missing a recipient name")
  }
  if (!nonEmpty(address.country_code)) {
    terminal("[ongoing] shipping address is missing a country code")
  }
  if (!nonEmpty(address.postal_code)) {
    terminal("[ongoing] shipping address is missing a postal code")
  }

  const consignee: PostOrderConsignee = {
    name,
    // ISO-2 lowercase, passed through unchanged.
    countryCode: address.country_code!.trim(),
    postCode: address.postal_code!.trim(),
  }
  const address1 = trimOrUndefined(address.address_1)
  if (address1) {
    consignee.address1 = address1
  }
  const address2 = trimOrUndefined(address.address_2)
  if (address2) {
    consignee.address2 = address2
  }
  const city = trimOrUndefined(address.city)
  if (city) {
    consignee.city = city
  }
  return consignee
}

function mapLine(
  line: MapOrderInputLine,
  index: number,
  orderCurrency: string | undefined
): PostOrderLine {
  const rowNumber = String(index + 1)
  const articleNumber = trimOrUndefined(line.article_number)
  if (!articleNumber) {
    // Article number is resolved upstream by the CALLER (#26/#27) via the #29 resolver; this mapper only validates it is present.
    terminal(`[ongoing] order line ${rowNumber} has no resolvable article number (SKU did not resolve)`)
  }
  const quantity = line.quantity
  if (typeof quantity !== "number" || Number.isNaN(quantity) || quantity <= 0) {
    terminal(`[ongoing] order line ${rowNumber} (article ${articleNumber}) has a non-positive quantity`)
  }

  const mapped: PostOrderLine = {
    rowNumber,
    articleNumber,
    numberOfItems: quantity, // as-is, no conversion
  }
  if (typeof line.weight === "number" && !Number.isNaN(line.weight)) {
    mapped.weight = line.weight
  }

  const currencyCode = (nonEmpty(line.currency_code) ? line.currency_code : orderCurrency)
    ?.trim()
    .toUpperCase()
  const prices: PostOrderLinePrices = {}
  if (typeof line.unit_price === "number" && !Number.isNaN(line.unit_price)) {
    prices.linePrice = line.unit_price // as-is, no x100
  }
  if (currencyCode) {
    prices.currencyCode = currencyCode
  }
  if (Object.keys(prices).length > 0) {
    mapped.prices = prices
  }
  return mapped
}

export function mapOrderToPostOrderModel(input: MapOrderInput): PostOrderModel {
  const orderNumber = trimOrUndefined(input.order_number)
  if (!orderNumber) {
    terminal("[ongoing] order is missing an order number")
  }

  const orderCurrency = nonEmpty(input.currency_code) ? input.currency_code.trim() : undefined

  const model: PostOrderModel = {
    goodsOwnerId: input.goods_owner_id,
    orderNumber,
    deliveryDate: toIsoDeliveryDate(input.delivery_date),
    consignee: mapConsignee(input.shipping_address),
  }

  const lines = input.lines ?? []
  if (lines.length > 0) {
    model.orderLines = lines.map((line, index) => mapLine(line, index, orderCurrency))
  }

  if (nonEmpty(input.email)) {
    model.emailNotification = { email: input.email.trim() }
  }
  const phone = trimOrUndefined(input.shipping_address?.phone)
  if (phone) {
    model.telephoneNotification = { telephone: phone }
  }

  // wayOfDelivery / transporter intentionally omitted in the M2 baseline.
  return model
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `yarn test src/lib/ongoing/__tests__/order-mapper.test.ts`
Expected: PASS (all happy-path + terminal cases green).

- [ ] **Step 5: Export the mapper from the lib barrel**

In `src/lib/ongoing/index.ts`, add (the existing `export * from "./types"` already re-exports the new types):
```ts
export { mapOrderToPostOrderModel } from "./order-mapper"
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/ongoing/order-mapper.ts src/lib/ongoing/__tests__/order-mapper.test.ts src/lib/ongoing/index.ts
git commit -m "feat(ongoing-client): pure Medusa->PostOrderModel mapper with fail-fast terminal validation (#24)"
```

---

## Task 3: Full build + suite verification

**Files:** none (verification only).

**Interfaces:**
- Consumes: everything from Tasks 1–2.
- Produces: confidence that the plugin compiles and all unit tests pass.

- [ ] **Step 1: Run the whole lib test suite**

Run: `yarn test src/lib/ongoing`
Expected: PASS — existing `errors`, `throttle`, `client.*` suites plus the new `order-mapper` suite all green.

- [ ] **Step 2: Run the full unit suite**

Run: `yarn test`
Expected: all suites PASS.

- [ ] **Step 3: Build the plugin**

Run: `yarn build`
Expected: `medusa plugin:build` completes with no TypeScript errors; output appears under `.medusa/server`. This confirms the new types and mapper compile under the server `tsconfig` and the `putOrder(order: PostOrderModel)` signature still type-checks against the real (no longer `Record<string, unknown>`) shape.

- [ ] **Step 4: Commit (only if build produced tracked artifacts that should be committed)**

> NOTE: `.medusa/server` is the build output and is typically gitignored (published, not committed). If `git status` shows no changes after `yarn build`, skip this commit — the work was committed in Tasks 1–2. If the repo convention commits anything from the build, stage only those tracked files.

---

## Self-Review (completed during planning)

- **Spec coverage (§11 field-mapping bullet + issue #24):** explicit Medusa→`PostOrderModel` mapping for shipping address (ISO-2 lowercase country, postal), consignee/contact (name join), line items (article number from #29 resolver, quantity), weights, per-line currency from order currency (uppercased) — Task 2 ✓. Prices sent as-is, no minor-units — enforced + tested ("no x100") ✓. Fail-fast validation → terminal `OngoingApiError` with operator-readable messages → drives `sync_state=error`/`error_class=terminal` downstream — Task 2 ✓. Phone/email on notification objects per OpenAPI v57 (NOT consignee) ✓. No top-level currency field; currency per line only ✓. `additionalProperties: false` respected (no stray keys) + test guard ✓. `wayOfDelivery`/`transporter` omitted in M2 baseline with a noted follow-up issue ✓. SKU→articleNumber resolution + collision rule deferred to #29 (mapper consumes a pre-resolved `article_number`, treats empty as terminal, references #29) ✓.
- **Placeholder scan:** every code step contains complete code; the single NOTE (Task 3 Step 4) is a conditional verify-point with the resolution stated, not missing content.
- **Type consistency:** `mapOrderToPostOrderModel(input: MapOrderInput): PostOrderModel` is named identically in Task 1's Produces block, Task 2's implementation, the barrel export, and the tests. `PostOrderModel`, `PostOrderConsignee`, `PostOrderLine`, `PostOrderLinePrices`, `PostOrderNotification`, `MapOrderInput`, `MapOrderInputAddress`, `MapOrderInputLine` field names match between `types.ts` (Task 1) and `order-mapper.ts` (Task 2). The mapper imports `OngoingApiError` from the existing `./errors` (unchanged) and constructs it with `{ kind: "terminal" }`, matching the `OngoingApiError` constructor signature (`message`, `{ status?, kind, retryAfterMs?, body? }`) in `src/lib/ongoing/errors.ts`.
- **Consumer fit (#26/#27):** the mapper is a single pure function with an in-memory input DTO, so `pushOrderToOngoing` (#26) and `syncOrderEditToOngoing` (#27) call it after hydrating `MapOrderInput` from `query.graph`, then pass the result to `client.putOrder`. No Medusa coupling leaks into the mapper.

## Known verify-points carried forward
- `wayOfDelivery`/`transporter` population — separate follow-up issue (shipping-option→`wayOfDelivery` code mapping). Not blocking #24.
- SKU→`articleNumber` resolution + the SKU-collision rule — issue #29, invoked by the caller (#26/#27) upstream. The mapper depends on its output (`article_number` per line) but does not implement or call it.
