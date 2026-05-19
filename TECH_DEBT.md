# StackPoker — Tech Debt Log

## Balance sync via socket: `your_chips_updated`

**Recorded:** 2026-05-15 (initial), 2026-05-15 (socket event added)

The `your_chips_updated` socket event is now the **canonical mechanism** for
in-session balance changes that don't come back through an HTTP response.
REST mutations still use the response-level `newBalance` field (8 iOS call
sites, listed below). Both feed the same `AuthViewModel.applyServerBalance`
function, so iOS has one balance-update code path.

### Current emit sources (server → client)

| Source                                   | Reason tag              | Notes |
| ---------------------------------------- | ----------------------- | ----- |
| `softLeaveCashOut` (leave_table socket)  | `cash_out`              | The user-reported bug class — credits chips back when leaving a table. |
| `rejoinRedebit` (join_table socket)      | `rejoin_redebit`        | Re-debits the wallet when reconnecting to a soft-left seat. |
| `rejoinRedebit` (no-op branch)           | `rejoin_noop`           | No mutation happened, but we still emit so any stale HUD refreshes on rejoin. |
| `forceCloseIdleTable` (sweeper)          | `idle_table_closed`     | Per-user emit; refunds every active session's stack. |

### Future emit sources (must use this event, not invent new ones)

- **Admin grant** — emit to the *recipient*'s userRoom from the admin endpoint.
- **Friend tipping** — emit to the recipient's userRoom (sender already gets `newBalance` via HTTP response).
- **Tournament prizes** — emit per winner when results settle.
- **Hand-settlement → wallet flow**, if we ever move chip credits out of seat.stack into chipBalance during play (today they only move on leave).

### Future unification (long-term)

Route REST mutations through the same socket event so iOS can drop the
response-level `newBalance` field entirely and rely on a single subscription
point. Tactical today (HTTP responses are still authoritative for the caller's
own action latency), strategic later when the surface area gets too wide to
keep both in sync.

### iOS wiring

- Subscription: `StackPokerApp.swift` → `authViewModel.bindToSocketChipUpdates(GameSocketClient.shared)` (one subscription, app lifetime).
- Handler: `AuthViewModel.bindToSocketChipUpdates(_:)` routes every event to `applyServerBalance(_:)` regardless of `reason`. Grep marker: `// CHIP MUTATION: server returned newBalance; sync HUD.`
- Payload type: `ChipsUpdatedEvent { newBalance: String, reason: String? }` in `Features/Game/Models/GameModels.swift`.

---

## Chip balance: per-endpoint `newBalance` vs. socket-pushed `balance_updated`

**Recorded:** 2026-05-15

### Current (tactical) approach

Every chip-mutating HTTP endpoint returns a top-level `newBalance: string`
(BigInt-as-string) in its response body. The iOS HUD calls
`AuthViewModel.applyServerBalance(_:)` with that value immediately after each
successful response.

Endpoints that follow this convention:

| Endpoint                                          | Mutation                          | Whose balance is in `newBalance` |
| ------------------------------------------------- | --------------------------------- | -------------------------------- |
| `POST /chips/daily-bonus`                         | credit caller                     | caller                           |
| `POST /chips/transfer`                            | debit sender, credit recipient    | **sender only** — recipient stays stale |
| `POST /cosmetics/purchase`                        | debit caller                      | caller                           |
| `POST /tables/join/:code` (+ direct join)         | debit caller (buy-in)             | caller                           |
| `POST /tables/:id/leave`                          | credit caller (chips returned)    | caller                           |
| `POST /tables/:id/topup`                          | debit caller (top-up)             | caller                           |

iOS side: every call site has a `// CHIP MUTATION: server returned newBalance; sync HUD.`
comment above the `applyServerBalance` call so the pattern is grep-able.

### Known gaps under the current approach

1. **Transfer recipient HUD goes stale.** The receiving user's `chipBalance`
   changes on the server but their app doesn't know until the next `/auth/me`
   (app foreground, pull-to-refresh, etc.).

2. **Admin grant is silent.** `POST /admin/grant-chips` mutates a *third* user's
   balance. There is no response field that could update the target's HUD over
   HTTP. The admin's own response could include the grantee's new balance, but
   that doesn't help the grantee's device.

3. **Socket-driven balance changes are silent.** The following server-side
   mutations happen *outside* a request/response cycle (driven by game state
   transitions or socket events) and currently emit nothing balance-related to
   the affected user:
   - `softLeaveCashOut` (auto-cashout when a player disconnects past the grace
     window or sits out for too long)
   - `rejoinRedebit` (re-buy on rejoin if their seat was cleared)
   - Hand settlement credits/debits inside the engine
   The socket emits we already send (`game_state`, `hand_ended`, `player_left`,
   `table_closed`, etc.) carry seat-stack data but NOT wallet balance.

### Long-term direction

**Partially landed 2026-05-15** — the dedicated socket event now exists as
`your_chips_updated` (see the top section of this file). It covers the three
socket-driven gaps below (softLeaveCashOut / rejoinRedebit / idle sweep). The
remaining gaps (transfer recipient, admin grant) still need to start emitting
through the same event before this section can be considered fully closed.

Once every wallet mutation point emits `your_chips_updated`, the per-endpoint
HTTP `newBalance` field becomes redundant for *reachable* users — but we
should keep it for HTTP-flow latency reasons (UI shouldn't wait for a socket
round-trip after a button press) and because the HTTP response is the ground
truth for the caller's own action.

### When to escalate

Promote this from "tactical OK" to "fix now" when **any** of the following
ship:
- A feature that depends on the recipient seeing transfers in real time
  (e.g. friend-to-friend tipping with a UX expectation of instant feedback).
- A live-stream / table-spectator mode where third parties watch balance
  movement.
- Anti-fraud tooling that requires an authoritative client-side balance feed.

Until then the tactical approach holds: server-authoritative, response-driven,
HUD updates one runloop tick after the action.

---

## Cosmetics — avatar frame visibility on non-self avatar sites

**Recorded:** 2026-05-18 (Phase 4b)

Phase 4b wired `AvatarFrameRenderer` into the four hero-facing avatar render
sites (lobby header, profile header in tabbed root, profile-edit header) and
into the seat-level inline avatar in `PokerTableView.TargetSeatView`. The
table render path is the only **non-self** site that can render a frame today,
and only because seats carry `equippedCosmetics` over the wire.

### Sites that still render bare avatars for other users

| Call site                                            | Why it cannot show frames yet |
| ---------------------------------------------------- | ----------------------------- |
| Friends list rows                                    | `FriendProfile` payload has no cosmetics field — would need backend extension and a per-friend cache. |
| Invite picker / friend-search results                | Same — `UserSearchResult` is name + avatarUrl + id only. |
| Table card rows in lobby                             | Lobby table summary doesn't enumerate seat occupants' cosmetics, just count + names. |
| Profile picker preview (`ProfileView.swift:740`)     | Skipped on purpose — overlaying a frame around the emoji being edited muddies what the user is selecting. Leave bare. |

When extending: pick **one** payload field name (`equippedCosmetics: { [category]: id }`)
and reuse the iOS `AvatarView(avatarFrameId:)` plumbing already in place. No
renderer changes needed — only data plumbing.

### Mythic_inferno animation (polish pass)

The `avatar_frame_mythic_inferno` renderer ships as a **static** AngularGradient
flame ring in Phase 4b. The intended polish-pass version uses `TimelineView` to
rotate the gradient (~6s per revolution) and adds particle flame tongues
licking outward from the four cardinal spikes. Estimated work: 30-45 min,
single renderer file edit — no callers change.

Defer until: post-TestFlight, or sooner if mythic-tier needs more "wow" in a
marketing screenshot pass.

---

## iOS — `AdminPanelView.swift` is orphaned

**Recorded:** 2026-05-18 (Phase 4b extension)

`Features/Game/Views/AdminPanelView.swift` exists in the iOS source tree but
has **no presentation site or references** anywhere in the codebase. The
header comment claims "Accessible only to table owners and system admins"
but there's no DEBUG gate, role check, or feature flag — the view is dead
code that was scaffolded but never wired up.

Today's actual dev surface lives in `SettingsSheet.devSection`
(`Features/Profile/Views/ProfileView.swift:549-574`): a "Dev Tools" section
gated client-side by being always visible, server-side by `isAdmin`. The
Phase 4b extension added the "Add Test Friends" button here under
`#if DEBUG` for build-flag enforcement.

**Decision needed:** either wire `AdminPanelView` up with a clear story for
what belongs there (kick/ban/grant from the table itself? full per-user
admin?), or delete it cleanly. Don't bundle the cleanup with feature work —
it should be its own follow-up commit so the diff is unambiguous.

---

## CardBackRenderer — only 2 of 8 catalog ids supported

**Recorded:** 2026-05-18 (store redesign)

`CardBackRenderer.supports(_:)` returns true only for
`card_back_classic_red` and `card_back_classic_blue`. The other 6 card-back
ids in `cosmetics_catalog.json` (vegas_neon, midnight_velvet, vintage_lace,
desert_dune, blueprint, geode_purple) fall through to the
`CosmeticImageView` placeholder, so the Card Backs section in the
redesigned store mixes procedural renders with rarity-tinted placeholder
tiles.

Acceptable short-term — the procedural-vs-placeholder split is visible but
not confusing (placeholders carry the cosmetic name and rarity, so the
player still understands what's for sale). The visual inconsistency is
the only real cost.

Extend the renderer to cover the remaining 6 ids in a follow-up commit,
separate from store redesign — purely a renderer addition, no callsite
changes. The store's `StoreCosmeticPreview` dispatch automatically picks
the procedural branch as soon as `CardBackRenderer.supports(id)` returns
true for that id.

---

## Locker — empty-state "Visit Store" deep-link is dismiss-only

**Recorded:** 2026-05-18

The Locker v1 (`Features/Cosmetics/Views/LockerView.swift`) renders a
per-category empty state with a "Visit Store" CTA when the player owns
zero items in that category. Today the CTA only dismisses the Locker
cover and drops the player back on whatever Store meta-tab they were on
when they entered — it does **not** programmatically scroll the Store to
the matching sub-category section.

### Why deferred

v1 ships with two categories (avatar frames + card backs) and the
catalog seeds every account with one purchasable item in each, so the
empty state effectively only appears when a future category lands with
zero seeded ownership. Building the deep-link plumbing now would add:

- A `StoreView` programmatic-scroll surface keyed by `CosmeticCategory`.
- A meta-tab auto-switch (the target category may live in a different
  meta-tab than the one the player has open).
- A scroll-after-layout settle in StoreView's onAppear so the target
  section is actually on-screen when the user lands.

None of that is load-bearing for v1.

### Follow-up shape

Add a `pendingScrollTarget: CosmeticCategory?` to StoreViewModel, set
it from the Locker dismiss callback, and consume it in StoreView's
onAppear (switch meta-tab → ScrollViewReader.scrollTo). Keep the
dismiss-only path as the fallback for cases where the target category
isn't in the active catalog (network failures, feature-flagged
categories, etc.).

---

## iOS: `addBot()` swallows server errors silently

**Recorded:** 2026-05-18

`Features/Game/ViewModels/GameViewModel.swift:926` sets
`errorMessage` on bot-add failure (e.g. `BOT_ERROR: Bot already at this
table`, `Table is full`, network failure) but **nothing surfaces it to
the user**. The user taps "Add Bot", nothing visible happens, and the
only signal is a value set on `@Published var errorMessage` that no
on-screen toast/banner currently observes in the table scene.

### Why this hurt us

This bug masked the actual root cause of the "can't add multiple bots
in TestFlight" report on 2026-05-18 — the backend was running stale
single-bot code, so the second add-bot call returned 400 with a
meaningful error message, but the iOS side ate it. User experience was
indistinguishable from "feature silently broken" instead of "server
rejected the request because <reason>".

### Follow-up shape

Wire `errorMessage` into a transient toast on the table scene (sibling
of the `EquipErrorToast` / `PurchaseErrorToast` pattern in
`StoreView.swift`). 3s auto-dismiss, tap-to-dismiss, ink-stroked
warning style consistent with the existing toasts. Same wiring should
cover other GameViewModel error paths that today only set
`errorMessage` (grep `errorMessage =` in GameViewModel.swift —
multiple call sites have the same silent-error problem).

Keep the gate narrow: a generic "Something went wrong" toast is worse
than nothing because it gives the user no actionable info. Mirror the
existing toasts which pattern-match on a concrete error enum and
produce specific copy ("Table is full", "All bot profiles already
seated", etc.).
