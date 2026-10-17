# Mobile Plan — 14 of 50 points

**4 points** offline persistence/sync (script + desk check) · **10 points** UI & HCI (human judges, one 10-minute slot from 15:15).

The judges run the **same three tasks on every team**. Build for those three tasks first and everything else second.

> Task A — find a league's standings and open one match
> Task B — buy a merchandise item with the mock payment and open the receipt
> Task C — as Club Manager, perform a roster action; then repeat one action in airplane mode and sync

---

## 1. Stack

| Concern | Choice |
|---|---|
| Framework | Flutter (Android) — one codebase, fast release APK |
| HTTP | `dio` with a single base-URL provider |
| Local cache | `hive` — fixtures, standings, club profiles |
| Action queue | `hive` box, stores the §5.14 action shape verbatim |
| Secure storage | `flutter_secure_storage` → Android Keystore (NFR-5, mandatory) |
| Connectivity | `connectivity_plus` → online / offline / syncing stream |
| State | `provider` or plain `ChangeNotifier`. Do not introduce Riverpod/Bloc today. |

Output path is fixed by the spec: **`mobile/release/app-release.apk`**.

```bash
flutter build apk --release
cp build/app/outputs/flutter-apk/app-release.apk release/app-release.apk
```

---

## 2. Build order (D works alone, 11:45 → 14:30)

| Time | Deliverable |
|---|---|
| 11:45–12:15 | Project scaffold, theme file, settings screen with editable server URL, login against the 5 demo accounts, token in Keystore |
| 12:15–12:45 | API client + Hive cache; Fixtures list screen (status chip + time, tappable) |
| 12:45–13:15 | Match detail (score, event timeline, pinned product slot) + Standings table with qualification status |
| 13:15–13:45 | Offline layer: cache writes on every successful fetch, connectivity banner, action queue box |
| 13:45–14:15 | Roster management (Club Manager) + Scoring entry (Organizer) — both write to the queue when offline |
| 14:15–14:30 | Store: catalogue → variant picker → cart → checkout → receipt view. **Build the APK. Commit it.** |
| 14:30–14:45 | Run the judges' three tasks end to end, plus the full airplane-mode sequence |

If you are behind at 14:15, ship the Store screen read-only and keep checkout on the backend only — but **never** skip the APK commit or the offline queue.

---

## 3. Screens and what each must show

| Screen | Mandatory content |
|---|---|
| Login | Email + password; lands on a role-aware home |
| Fixtures | Match list with status + time; tap opens match |
| Match detail | Live score (polling every 3 s is acceptable), event timeline, pinned product showcase |
| Standings | Points table for a league with clinched / eliminated / still possible |
| Club profile | Club info, roster, staff, home venue |
| Store | Catalogue, variant picker, cart, checkout with mock gateway, receipt view/download |
| Roster management | Club Manager: add / transfer / loan / release |
| Scoring entry | Organizer: append a score event and a compensating event |
| Sync status | Always-visible Online / Offline / Syncing indicator + the pending queue |

Role gating matters — rubric area 5 is "right screen for the right role". A Player must not see the scoring-entry screen at all.

---

## 4. The offline queue — store the server's format, not your own

```dart
// exactly the §5.14 action shape
{
  "action_id": "a-<uuid>",
  "type": "score_event",            // or "roster_transfer"
  "queued_at": "2026-10-17T11:00:00Z",
  "base_version": 3,                // last version this device saw
  "payload": { /* the /events or /roster/transfer body, unchanged */ }
}
```

Sync is then one call:

```
POST /audit/v1/offline-sync
{ "device_id": "<stable-device-id>", "actions": [ ...queued in order... ] }
```

The response gives a per-action `status` (`applied` / `rejected` / `duplicate`), a `resolution`, and an `error_code`. **Show the plain-language meaning, never the code:**

| `error_code` | What the user reads |
|---|---|
| `SQUAD_FULL` | "That squad is already full." |
| `NOT_IN_SQUAD` | "This player is no longer in that squad." |
| `TRANSFER_WINDOW_CLOSED` | "The transfer window was closed on that date." |
| `PLAYER_ON_LOAN` | "This player is currently on loan and can't be moved." |
| `MATCH_NOT_IN_PROGRESS` | "That match wasn't live when the action was recorded." |
| `INVALID_BASE_VERSION` | "Your device was ahead of the server. Refresh and try again." |
| `DUPLICATE_EVENT_ID` | "This was already recorded." |

Clear the queue only after the response is shown. Re-sending the same request must come back all-`duplicate` and change nothing — test that once.

---

## 5. Desk-check rehearsal (run this at 14:30, not 15:10)

1. Online: open Fixtures, Standings, a Club profile.
2. Airplane mode on. All three screens still open from cache, "Offline" badge visible.
3. As Organizer, append a score event. As Manager, do a roster action. Both show as **pending**.
4. **Force-close the app. Reopen it. Still offline. The two pending actions are still there.** ← teams fail here most often, because the queue was only in memory
5. Network on. App syncs automatically (or via an obvious Sync button), shows applied/rejected with reasons, queue empties.

---

## 6. Cheap UI/HCI points (rubric areas 1–5)

These take minutes each and are most of the 10 points:

- **One** `ThemeData`: same font scale, same spacing unit, same button style everywhere. Apply the tenant's logo and primary color.
- A loading indicator on every network call. Never a frozen screen.
- A success snackbar after every write.
- Empty states with text: "No matches yet", not a blank list.
- Tap targets ≥ 48 dp; body text ≥ 16 sp; contrast checked on the score and the Buy button.
- Status never conveyed by color alone — pair each color with an icon or a word ("Live", "Completed").
- A confirm dialog before release/transfer (risky action).
- Test at 360×640 dp and after rotation. Nothing overflows.
- Zero raw error codes in the UI. Ever.

A plain app that does all nine of these outscores a beautiful app that shows "Error 500".
