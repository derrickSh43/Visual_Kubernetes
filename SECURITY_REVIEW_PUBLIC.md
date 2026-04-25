# Visual Kubernetes Security Check Summary

Date: 2026-04-25

Scope: local-only MVP security review of the current Visual Kubernetes repository state. This was a review and verification pass only; no production hardening is claimed.

Reviewed commit baseline: `97f3bd9 Complete golden review pass`

## Summary

Visual Kubernetes is currently a browser-only local prototype. The reviewed codebase does not include a backend API, database server, authentication system, deployment service, or server-side secret store. The app stores workspace state in the browser and generates Kubernetes YAML/Terraform files for download.

The project README already warns reviewers that this MVP should be run locally only and should not be deployed publicly.

## Checks Performed

- Dependency advisory check with `npm audit --omit=dev`: `0 vulnerabilities`.
- Full dependency advisory check with `npm audit`: `0 vulnerabilities`.
- Static source search for high-risk browser patterns including `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, network calls, and message APIs.
- Review of local persistence paths using `localStorage` and IndexedDB snapshots.
- Review of export/download paths for generated YAML, Terraform, and ZIP bundles.
- Review of CI workflow for install, lint, test, and build enforcement.
- Verification commands:
  - `npm.cmd run lint`: passed.
  - `npm.cmd run test`: passed, 59 tests.
  - `npm.cmd run build`: passed.
- Follow-up review of Snyk SAST findings reported after the initial pass.

## Results

- No dependency vulnerabilities were reported by `npm audit`.
- No backend-facing attack surface was found in this repo.
- No usage of `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or `new Function` was found in app source.
- No app runtime network calls such as `fetch`, `XMLHttpRequest`, or `WebSocket` were found in app source.
- CI runs dependency install, lint, tests, and build on pushes to `main` and pull requests.
- The app includes validation for several risky infrastructure model states, including missing TLS secrets, public exposure warnings, root/privilege-escalation warnings, unresolved secret references, invalid dependency edges, and cross-namespace/cross-cluster warnings.

## Snyk Follow-Up

Snyk reported three source-code findings after the initial review:

- Two `Hardcoded Non-Cryptographic Secret` findings in starter sample data.
- One `DOM-based Cross-site Scripting (XSS)` finding in the legacy clipboard fallback path.

Follow-up remediation removed the starter sample `existingSecret.secretKey` values that triggered the hardcoded-secret findings and removed the DOM `textarea`/`appendChild`/`execCommand` clipboard fallback. Copy now uses the browser Clipboard API when available and reports when it is unavailable.

Post-remediation verification:

- `npm.cmd run lint`: passed.
- `npm.cmd run test`: passed, 59 tests.
- `npm.cmd run build`: passed.

## Known Prototype Limitations

- No authentication or authorization model exists.
- Local browser storage is used for workspace and snapshot data.
- Inline secret values can be modeled and exported into generated Kubernetes `Secret` YAML using `stringData`.
- Generated YAML/Terraform should be reviewed before use against real infrastructure.
- No content security policy, hosting hardening, threat model, or public deployment controls have been implemented yet.
- This check does not certify the tool as production-ready.

## Conclusion

No critical security blocker was found for the stated local-only MVP usage. The reviewed state is acceptable to share for feedback as a prototype, as long as reviewers understand it is not hardened for public hosting or production use.
