# ApnaServo iOS server-driven architecture audit

Date: 2026-09-11

## Current architecture

- The native SwiftUI user app reads the published customer/iOS configuration from `GET /api/app-control/config?app=customer&platform=ios`.
- MongoDB `AppControlConfig` stores isolated draft and published snapshots with a monotonic version. `AppControlItem` stores scheduled banners and announcements.
- Admin App Control Center already supports app/platform targeting, safe theme tokens, home-section controls, service availability/media, feature definitions, preview, publishing, rollback and audit events.
- Booking prices, availability enforcement, booking creation and partner dispatch remain backend-owned. Remote configuration is not used as an authorization or payment source.

## Problems found

1. iOS discarded a valid published configuration whenever the next request failed; there was no persisted last-known-good layer.
2. The public envelope had a config version but no explicit schema compatibility metadata.
3. The supported home component set is intentionally finite. The master prompt's additional modules cannot safely be activated until native renderers and analytics contracts ship.
4. Theme support is partially consumed in iOS. Expanding every token requires incremental component migration and contrast/accessibility tests.
5. Existing configuration is stored as a versioned structured snapshot plus normalized campaign/service records, not the proposed complete normalized builder schema. Migrating it in one step would add booking and release risk.

## Implemented foundation

- Persist the last successfully decoded and compatible envelope in iOS `UserDefaults`.
- Startup order is now bundled defaults, then persisted last-known-good configuration, then a fresh published configuration.
- Reject unsupported schema/app-version envelopes without replacing the working cached configuration.
- Public responses now declare `schemaVersion`, `minimumAppVersion`, and `maximumAppVersion` compatibility fields.
- Unknown JSON remains ignored by Swift decoding and unknown home section identifiers are rejected server-side.

## Booking-flow dependencies that must remain stable

`service id/category -> address and coordinates -> booking payload/idempotency -> backend validation -> booking record -> admin confirmation -> eligible partner dispatch -> partner request -> push/socket update -> status/payment/completion`.

Remote content may explain or hide supported UI, but it must never set price, authorize a booking, choose a partner, confirm payment, or bypass backend validation.

## Phased migration

1. Extend the native component registry and move the current home screen to ordered renderer output while retaining bundled defaults.
2. Add normalized screen/component releases and asset metadata without deleting the current published snapshot.
3. Add draft validation reports and device-size preview fixtures in Admin.
4. Add campaign targeting, version gates and percentage rollout using deterministic server-side assignment.
5. Add impression/click/booking attribution with data minimization and retention controls.
6. Migrate remaining visual tokens component-by-component with Dynamic Type, VoiceOver, contrast and reduced-motion tests.

Each phase publishes behind a kill switch. Rollback restores the previous published snapshot; old clients ignore unsupported fields/components and continue from their last-known-good or bundled configuration.

## Security and performance risks

- Only allowlisted component/action identifiers and HTTPS media URLs may be published.
- Admin publish/rollback remains role-protected and audited.
- Never accept remote regex or navigation as executable code; regex validation should be replaced by named validators before wider form-builder use.
- Add ETag/If-None-Match after response caching is coordinated with scheduled campaigns; otherwise a stale CDN entry could outlive a campaign boundary.
- Keep payloads bounded and split analytics/assets/catalog endpoints before the config grows materially.

## Test plan

- Valid fresh config, offline startup, corrupt cache, unsupported schema, min/max app-version mismatch.
- Unknown section/action, malformed colors/URLs, missing asset and failed CDN.
- Draft/preview/publish/rollback and unauthorized publish.
- Full existing booking regression through partner acceptance, status notifications, payment and completion.
- Dynamic Type, VoiceOver, contrast, reduced motion, small/large iPhone layouts and memory/network profiling.

## Rollback

Backend rollback uses the existing audited release history. iOS keeps the prior compatible payload until a new valid publish arrives; deleting the local cache returns it to bundled defaults. No booking collections or booking APIs are migrated by this foundation change.
