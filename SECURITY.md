# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| `main` (current) | ✅ |
| Older commits | ❌ |

This is a competition prototype, not a certified flight system. Do not use it
for live rescue, passenger, or safety-critical operations.

## Reporting a vulnerability

Please report security issues **privately** to **tarunjan2007@gmail.com**.
Do not open a public GitHub issue for a vulnerability.

Include:

- a short description and impact,
- steps to reproduce,
- the affected commit/version,
- any suggested fix.

You will get an acknowledgement within 72 hours. Please give a reasonable
window to fix the issue before any public disclosure.

## Security model

The GCS is designed to run **offline on one operator laptop**:

- **No internet dependency** — no CDNs, map tiles, external fonts, or remote
  APIs. The dashboard and all assets are served locally.
- **Allowlisted controls** — the dashboard can emit only `START` and `ABORT`.
  The backend rejects every other command and logs the attempt.
- **Simulator-only reset** — the debrief reset is a local demo convenience. It
  is enabled only with `python run.py --sim`, requires the ingest client to
  identify itself as the simulator, and is refused while the mission is
  airborne. A real drone never receives a reset command.
- **Strict ingest validation** — every drone message is validated with
  Pydantic before it is cached or broadcast.
- **Local logs** — mission JSONL and reports are written to `logs/` and are
  git-ignored.
- **Localhost by default** — the launcher binds to `127.0.0.1` unless you
  explicitly pass `--host`.
- **Hardened responses** — the backend sets `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy` headers.

## Deployment hardening checklist

1. Run with the default `--host 127.0.0.1` unless the drone must connect over
   a network.
2. If the drone connects over Wi-Fi, use a **dedicated, isolated access point**
   with a strong WPA3/WPA2 password. Never expose `/ingest` or `/ws` to the
   public internet.
3. Keep the laptop patched and run a host firewall that allows only the GCS
   ports and the drone subnet.
4. Do not run untrusted code or browser extensions on the operator laptop.
5. Verify the drone link and the failsafe strip before every flight.
6. Treat the GCS as a **display and command console**, not as the flight
   controller. The drone must have its own independent failsafes (link loss,
   low battery, geofence, return-to-home).
7. Back up `logs/` after each run; reports are the evidence trail.

## Out of scope

- Physical security of the drone or laptop.
- Vulnerabilities in third-party dependencies (report them upstream, but let
  us know if they affect this project).
- Social-engineering attacks.
