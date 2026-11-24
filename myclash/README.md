# MyClash fork layer

Upstream clash-verge-rev stays on the `myclash` branch. Everything that should survive a future
`git merge <official-tag>` lives in this directory or in the files named below.

## Service

`clash-verge-service-ipc/` is upstream tag `v2.7.7` (`3ed29700`) with only the identity renamed:

- core `myclash-mihomo` / `myclash-mihomo-alpha`
- service `io.myclash.app.service` and helper `myclash-service`
- core-execution lock `myclash-service.core-execution.lock`

The crate name stays `clash_verge_service_ipc`, so the app imports do not move. Refresh it from a
clean upstream checkout with:

```bash
node scripts/myclash-retarget-service.mjs --from /path/to/clash-verge-service-ipc
```

Do not edit that tree by hand. Change the script, then rerun it.

## App features kept beside upstream

These paths are additions. A merge should keep them:

- `src/pages/port-switch.tsx`, `src/pages/port-switch.test.ts`
- `src/services/port-switch.ts`, `src/services/port-switch-client.ts`, `src/services/port-switch.test.ts`
- `src-tauri/src/core/manager/reservation.rs`
- `.github/workflows/myclash-release.yml`
- `scripts/myclash-retarget-service.mjs`

Glue that upstream files call into this layer, and that a merge may conflict on:

- app id `io.myclash.app`, product name `MyClash`
- default mixed port `17897`, external controller `127.0.0.1:19097`
- sidecar and service binary names in `src-tauri/tauri*.conf.json`, `scripts/prebuild.mjs`, `scripts/dev-service.mjs`, `src-tauri/packages/windows/installer.nsi`
