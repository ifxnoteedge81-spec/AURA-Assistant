---
title: WaNexus Studio
emoji: 🤖
colorFrom: emerald
colorTo: slate
sdk: docker
app_port: 7860
pinned: false
---

# WaNexus Studio — Autonomous WhatsApp Executive Assistant

Full-stack WhatsApp AI Assistant, 5-Key Gemini Pool + OpenRouter Dynamic Free Brain, Autonomous Multi-Step Action Agent, Web Research & Email/WhatsApp Outreach, Mobile Browser/PWA Offload Worker, 5-Minute Self-Healing Watchdog, and 24/7 Keep-Alive.

## Hugging Face Spaces Setup (Docker SDK)

1. Create a new **Space** on Hugging Face and select **Docker** as the SDK (leave template blank or push this repository via GitHub / Git).
2. The `Dockerfile` automatically builds the Vite + PWA frontend, exposes port `7860`, sets non-root `UID 1000` permissions, and runs `npm start` (`node server.ts`).
3. Add your secrets under **Space Settings -> Variables and secrets**:
   - `GEMINI_API_KEY_1` .. `GEMINI_API_KEY_5` (or `GEMINI_API_KEY`)
   - `OPENROUTER_API_KEY`
   - `TAVILY_API_KEY` / `SERPER_API_KEY` (optional web research)
   - `FIREBASE_SERVICE_ACCOUNT_JSON` (Service Account JSON for project `gen-lang-client-0860563178`)
   - `OWNER_EMAIL` & `DASHBOARD_PIN` / `DASHBOARD_AUTH_SECRET`
   - `ENABLE_SELF_PING=true` (auto-detects Hugging Face `SPACE_HOST` every 4 minutes)
