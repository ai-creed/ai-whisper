# Task brief: fix footer year

Task: the footer renders a hard-coded 2025; make it render the current year.

Approved approach: replace the literal with new Date().getFullYear() in the
footer component.

Scope: src/components/Footer.tsx only.

Acceptance checks: footer renders the current year; no other component
changed.
