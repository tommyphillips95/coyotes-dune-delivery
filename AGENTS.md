# AGENTS.md

This repo is Coyote's Dune Delivery — a live vanilla JS + Netlify + Supabase app.

Shared desk for Grok + Claude + Codex:
https://github.com/tommyphillips95/coyote-war-room

Read that repo's AGENTS.md, docs/dune-delivery.md, and docs/REVIEW-PACKET.md before changing behavior.

Rules:
- Incremental PRs. Do not rewrite this into Next.js/RN as the first move.
- Branch `agent/<grok|claude|codex>/<slug>`
- Treat SSN/bank columns and README default passwords as security findings, not examples to copy.
- Prefer one backend (Netlify + Supabase). backend/server.js is missing; do not grow the Express leftover unless Tommy asks.
