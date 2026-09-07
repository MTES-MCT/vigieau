# Production alert investigation, 2026-09-07

## Verified incident

- Production smoke run: https://github.com/MTES-MCT/vigieau/actions/runs/34084191613
- The 12 scheduled runs after the September 4 history-preservation release failed.
- `statistics` detects the missing July 11 through August 31 interval (52 days).
- `admin` and `datagouv` both stop on `sparse_statistic_cache`.
- Public availability, browser rendering and SANDRE checks passed in that run.
- At inspection, public statistics were current through September 7, with 4,946
  available dates and all three public web instances ready.
- External publication last succeeded on September 4 at 04:26 UTC. Its health
  reports `stale`, with historical exports blocked by the sparse cache.
- A separate September 3 failure was a single HTTP 503 from the address API:
  https://github.com/MTES-MCT/vigieau/actions/runs/33715575629

## Historical correctness

Read-only production SQL found all 52 national snapshots still present, complete
for 34,943 communes and tagged with repair
`2d8f1cf4-ad79-492a-82cf-ac57c428f8f1`. The active certified repair view is empty.
That repair was attested through epoch 796. Epochs 798 through 811 include actual
published-source mutations overlapping the repaired interval; epoch 810 starts
on July 11. These are bounded invalidations (`fallback: false`). The loss of
certification therefore cannot be repaired by simply reactivating the old audit.

The deployed admin revision `7bd5568` already includes range-aware invalidation.
Generic historical replay is intentionally gated to an isolated database because
it reads mutable canonical geometries. Its final promotion can also hold current
publication locks during substantial writes. Neither bypassing that gate nor
clearing the dirty range is an acceptable monitoring repair. The real history
incident must remain open until new source-valid results are certified.

## Scalingo alerts applied

All new alerts use the existing default email notifier, whose recipient is the
logged-in operator. The custom `ALERTE VIGIEAU` notifiers had no recipients and
were not selected. No app restart or production data write was required.

| App | Container | Metric | Threshold | Duration | Reminder | Alert ID |
| --- | --- | --- | --- | --- | --- | --- |
| regleau-back-prod | web | memory | 90% | 10 min | 24 h | al-fd89a6ac-3d47-4dc1-9312-a8811874c2cd |
| regleau-back-prod | web | 5XX | 5/min | 5 min | 24 h | al-e3293777-36ba-442a-b17a-9dbc672a1d01 |
| regleau-back-prod | clock | memory | 90% | 10 min | 24 h | al-56210a8d-2ce7-4f89-bf60-34dc210a10bb |
| regleau-back-prod | currentzoneworker | memory | 90% | 10 min | 24 h | al-51c7d26e-de3e-4361-8d04-a828b4c32ed9 |
| preservonsleau-api-prod | web | 5XX | 5/min | 5 min | 24 h | al-8e52554d-19a5-4826-8d9a-5198c51df519 |
| preservonsleau-api-prod | web | memory | 90% | 10 min | 24 h | al-26775cee-5bcd-49c8-8a0d-6982eafe4433 |
| preservonsleau-api-prod | statcache | memory | 90% | 10 min | 24 h | al-9342b46f-724d-48eb-b691-c313d1132725 |

Existing public p95 alert `al-0206ca91-41fc-452d-8e8d-f7915f35037d` keeps its
1,000 ms threshold. Confirmation now requires five minutes (previously two),
reminders are daily, and the default notifier is explicitly selected.

To disable an individual added alert without affecting service:

```sh
scalingo --app APP alerts-disable ALERT_ID
```

The exact IDs above permit a scoped rollback without removing unrelated alerts.
Do not simulate memory exhaustion or HTTP failure in production to test delivery.

## Delivery verification

See [Production monitoring](production-monitoring.md) for the collector, incident
state and notification lifecycle. Native Scalingo alert configuration is verified;
email delivery cannot be inferred from a successful configuration API response.

The first full collector run opened the real history incident, assigned to the
operator: https://github.com/MTES-MCT/vigieau/issues/51. Its GitHub notification
was observed through the operator's authenticated notification API. The next run
kept a single issue and no comments, but updating the issue body still refreshed
the notification. The collector now performs no issue writes on an unchanged
persistent failure until a daily reminder or a meaningful transition.

After that correction, full run
https://github.com/MTES-MCT/vigieau/actions/runs/34094968096 (attempt 2) completed
successfully. The notification thread stayed at `2026-09-07T07:11:37Z`, unchanged
from before that run. There was still one open incident and zero comments. Its
`Production / certified-history` check remained red; availability, current caches,
clock, zones, browser and SANDRE checks were green. External publications were
explicitly grouped under the confirmed historical cause, not marked recovered.

The first attempt exposed a test that expected a local HTTP request to reach its
test server within 75 milliseconds. It failed on the shared runner before any
production observation. The timeout tests now control cancellation explicitly;
all unit tests remain mandatory in CI, but do not run inside the scheduled
collector. A unit-test failure must not block production observation.

The legacy `production-smoke.yml` schedule is therefore removed. Its six strict
manual checks remain available; the same six checks also remain scheduled through
the incident collector. No production application restart, write freeze, data
change or history recertification was performed during this alerting change.
