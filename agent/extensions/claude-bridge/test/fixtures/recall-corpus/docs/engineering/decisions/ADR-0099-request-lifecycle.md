---
id: ADR-0099
title: Bridge request lifecycle
status: Active
date: 2026-11-11
---

# ADR-0099: Bridge request lifecycle

## Decision

- Pi claims a request by renaming it into inflight/. After a restart, leftovers become outcome unknown and are never re-run.
- Clients withdraw unclaimed requests and report not delivered.

## Why

- A crash between commit and answer must not look like a plain failure.
