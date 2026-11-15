# Security Specification & Payload-First Audit

## 1. Data Invariants
1. Every document across `bot_settings`, `dictionary_entries`, `chat_memories`, `inbox_notes`, and `bot_sessions` MUST belong to a verified authenticated user (`request.auth != null && request.auth.token.email_verified == true`) whose `uid` matches `ownerId` OR who is the bootstrapped owner admin (`ifxnoteedge81@gmail.com`).
2. Every document ID path variable (`settingId`, `entryId`, `chatId`, `noteId`, `sessionId`) MUST match `^[a-zA-Z0-9_\\-]+$` and be `<= 128` characters.
3. `createdAt` and `ownerId` are immutable on update; `createdAt` and `updatedAt` MUST equal `request.time`.
4. All strings have explicit `.size()` bounds and arrays (`chat_memories.turns`) have `.size() <= 20`.
5. No client may read or list documents belonging to another user (`resource.data.ownerId == request.auth.uid || isAdmin()`).
6. Catch-all default deny rule `match /{document=**} { allow read, write: if false; }` is placed first.

## 2. Adversarial Test Payloads ("Dirty Dozen")
1. Unauthenticated read/write to `bot_settings/primary` -> `PERMISSION_DENIED`.
2. Authenticated user with `email_verified: false` spoofing `ifxnoteedge81@gmail.com` -> `PERMISSION_DENIED`.
3. Non-owner user attempting `get` on `bot_sessions/primary` -> `PERMISSION_DENIED`.
4. Create `bot_settings/primary` with mismatched `ownerId != request.auth.uid` -> `PERMISSION_DENIED`.
5. Create `dictionary_entries/e1` with shadow field `isAdmin: true` -> `PERMISSION_DENIED` (blocked by `hasOnly`).
6. Create `dictionary_entries/e1` with 2KB `entryId` path poisoning -> `PERMISSION_DENIED` (`isValidId`).
7. Update `bot_settings/primary` attempting to mutate immutable `ownerId` or `createdAt` -> `PERMISSION_DENIED`.
8. Update `bot_settings/primary` with invalid `assistantTone: "hacked"` -> `PERMISSION_DENIED`.
9. Create `chat_memories/c1` with `turns.size() > 20` -> `PERMISSION_DENIED`.
10. Create `inbox_notes/n1` with client-forged `createdAt` not equal to `request.time` -> `PERMISSION_DENIED`.
11. Unfiltered `list` query on `dictionary_entries` by another user -> `PERMISSION_DENIED` (`resource.data.ownerId == request.auth.uid || isAdmin()`).
12. Update `inbox_notes/n1` changing `summary` instead of `resolved` -> `PERMISSION_DENIED` (blocked by action-based `affectedKeys().hasOnly`).
