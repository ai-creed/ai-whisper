# Auth session design (approved spec)

Goal: replace cookie-session auth with short-lived JWTs plus refresh tokens.

Scope: login, refresh, logout endpoints; middleware swap; token rotation on
refresh. Non-goals: SSO, MFA.

Acceptance: existing auth integration tests pass unchanged; refresh rotation
covered by a new test; no token accepted after logout.
