# WhatsApp Gemini AI Bot (`@whiskeysockets/baileys` + `@google/genai`)

Production-ready WhatsApp bot featuring **8-digit Pairing Code login**, **Google Gemini AI chat**, **Group Anti-Link auto-deletion**, and an **Automated Bengali Private Inbox Assistant**.

## Commands (Prefix: `.`)

| Command | Scope | Description |
| :--- | :--- | :--- |
| `.ai <query>` / `.gemini <query>` | Any chat | Queries Google Gemini (`gemini-4-hydrogen`) and replies with the AI response. |
| `.antilink delete on` | Groups (Admin) | Automatically deletes any message containing links (`http://`, `https://`, `www.`, `t.me`, `youtube.com`, `facebook.com`, etc.) when the bot is a group admin. |
| `.antilink delete off` | Groups (Admin) | Disables link auto-deletion in the current group. |
| `.autoreply on` / `.autoreply off` | Owner | Enables/disables the polite Bengali private inbox auto-reply assistant. |
| `.ping` / `.help` | Any chat | Health check and command overview. |

## Local Setup

1. Install dependencies (Node.js >= 20 required):
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and add your `GEMINI_API_KEY`:
   ```bash
   cp .env.example .env
   ```
3. Start the bot:
   ```bash
   npm start
   ```
4. Enter your WhatsApp phone number with country code (e.g. `8801712345678`) when prompted. An **8-digit pairing code** will print in your terminal.
5. On your phone, open **WhatsApp > Linked Devices > Link a Device > Link with phone number instead** and enter the 8-digit code.

## Deploying to Render

1. Push this `/bot` folder to a GitHub repository.
2. Create a new **Web Service** on [Render](https://render.com) (or use the included `render.yaml` Blueprint).
3. Configure Environment Variables in Render:
   - `GEMINI_API_KEY`: Your Google Gemini API key
   - `PAIRING_PHONE_NUMBER`: Your WhatsApp number with country code (e.g. `8801712345678`)
4. **Persistent Session Note:** Add a Render Persistent Disk mounted at `/opt/render/project/src/auth_info_baileys` (or set `AUTH_DIR` to your disk mount path) so your WhatsApp session survives service restarts.
5. Open the Render **Logs** tab on first boot to copy your 8-digit pairing code and link your device.
