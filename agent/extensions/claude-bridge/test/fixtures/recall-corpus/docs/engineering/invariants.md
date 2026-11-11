# Invariants

Rules that must not break.

## Workspace

- Version source, config and docs only. Credentials, sessions and caches never enter Git.
- Package-owned assets resolve from module location, never from the current directory.

## Pi ↔ multi-harness bridge

- Each Pi session owns a private 0700 namespace with requests, responses and processed directories; bridge files are 0600.
- Bridge clients fail with the exact error "Pi bridge not responding; start/focus Pi in this project." when unavailable.
- UUID replay must not duplicate state changes.

## Build lease

- A harness peer may hold one Build lease for an active saved plan.
- Only human confirmation through interactive Pi `/build-lease approve` grants a lease; headless Pi cannot approve.
- The lease expires four hours after approval and is released on plan clear or Build mode.

## Plan storage

- Plan bodies live under the agent directory, one file per plan id.
- Writes are atomic and bounded to 256 KiB; missing reads degrade to no active plan.
