# Talent Carriage – AI Attendance Agent

A web app for HR. It checks one day's attendance, sends a WhatsApp message to every employee
marked **absent or half-day**, understands their reply (with AI for free-text replies), and sends
back the right instructions automatically.

This is the **demo version**. It covers the first stage of `../Workflow.svg` only (first message → reply → system reply).
It does **not** include the 2-day follow-up, reminders, phone calls or HR escalation.

---

## Contents

1. [How it works](#1-how-it-works)
2. [What you need](#2-what-you-need)
3. [Install and run locally](#3-install-and-run-locally)
4. [Configuration (.env) — every variable explained](#4-configuration-env--every-variable-explained) · [how to get each value](#41-how-to-get-each-value--step-by-step)
5. [Meta / WhatsApp setup — where to find everything](#5-meta--whatsapp-setup--where-to-find-everything)
6. [The message template (must be approved by Meta)](#6-the-message-template-must-be-approved-by-meta)
7. [Webhook: making the app reachable with ngrok](#7-webhook-making-the-app-reachable-with-ngrok)
8. [Going live — checklist](#8-going-live--checklist)
9. [Using the dashboard](#9-using-the-dashboard)
10. [Attendance data (Excel import)](#10-attendance-data-excel-import)
11. [Database](#11-database)
12. [Messages sent to employees](#12-messages-sent-to-employees)
13. [API reference](#13-api-reference)
14. [Troubleshooting](#14-troubleshooting)
15. [Security notes](#15-security-notes)
16. [Project structure](#16-project-structure)

---

## 1. How it works

```
 Attendance Excel ──► Import ──► PostgreSQL (employees + day-wise attendance)
                                        │
   Daily at the set time, or "Run check & send" button
                                        ▼
        Find everyone marked  A|A  (full day)   A|P  (first half)   P|A  (second half)
                                        │
                                        ▼
        WhatsApp template message with 4 buttons  ──►  Employee's phone
                                                            │ taps a button / types a reply
                                                            ▼
        Meta sends the reply to our  /webhook  (over the internet, via ngrok)
                                        │
          Button or "1"–"4"  → understood directly
          Free text          → classified by OpenAI (e.g. "I was sick" → option 1)
          Unclear            → asks again, and flags the case for HR
                                        │
                                        ▼
        Sends the matching instruction back on WhatsApp, and updates the dashboard live
```

The dashboard shows each case (employee + absent date), its WhatsApp status (sent / delivered / read / replied),
the employee's answer, the action they need to take, and the full chat.

**Rules the app follows**
- One case per employee per absent date. Running the check twice **never** messages anyone twice.
- Weekly offs (`WO`) and holidays (`HO`) are ignored.
- A half-day gets the half in the date, e.g. *"absent on 17-Aug-2026 (second half)"*.
- A case with no answer after 48 hours is marked **No reply**.

---

## 2. What you need

| Thing | Why | Notes |
|---|---|---|
| **Node.js 20 or newer** | Runs the app | https://nodejs.org (LTS) |
| **Docker Desktop** | Runs the PostgreSQL database | https://www.docker.com/products/docker-desktop |
| **ngrok** (free account) | Gives the app a public HTTPS address, so Meta can deliver replies | https://ngrok.com/download |
| **Meta WhatsApp Cloud API** access | Sends and receives WhatsApp messages | See [section 5](#5-meta--whatsapp-setup--where-to-find-everything) |
| **OpenAI API key** (optional) | Understands free-text replies | https://platform.openai.com/api-keys. Without it, only button taps and "1"–"4" are understood. |

The computer running the app **must stay on** (with the app and ngrok running). Replies only arrive while both are up.

---

## 3. Install and run locally

```bash
# 1. Go into the project folder
cd "Talent Carriage AI Attendance Agent"

# 2. Install dependencies
npm install

# 3. Create your settings file, then fill it in (see section 4)
cp .env.example .env            # Windows: copy .env.example .env

# 4. Start the database (PostgreSQL 16 in Docker, on port 5433)
npm run db:up

# 5. Load the demo attendance data (or import your own file later from the dashboard)
npm run seed                    # imports DEMO_Attendance_data_v1.0.xlsx
#   npm run seed -- "path/to/other_file.xlsx"   to import a different file

# 6. Start the app
npm start
```

Open **http://localhost:3000**. There is no login: the dashboard only opens on the computer running the app.

On start-up the console shows the mode:

```
Attendance Agent on http://localhost:3000
  WhatsApp: DRY RUN (nothing is sent) · AI classifier: on
```

The app starts in **dry run**: messages are only logged, never sent. You can demo the whole flow without Meta
by using the **Simulate employee reply** buttons in the WhatsApp panel.

**Day-to-day commands**

| Command | What it does |
|---|---|
| `npm start` | Start the app |
| `npm run dev` | Start and auto-restart on code changes |
| `npm run db:up` | Start the database container |
| `docker compose stop` | Stop the database (data is kept) |
| `npm run seed` | Import the demo Excel file again (safe to repeat) |

---

## 4. Configuration (.env) — every variable explained

All settings live in the `.env` file in the project folder. **Restart the app (`npm start`) after any change.**

### General

| Variable | Required | Example | What it is |
|---|---|---|---|
| `PORT` | no | `3000` | Port the app listens on. |
| `DATABASE_URL` | yes | `postgres://attendance:attendance@localhost:5433/attendance` | Database connection. The default matches `docker-compose.yml`. |
| `TZ_NAME` | no | `Asia/Kolkata` | Timezone for the daily check and for "today". |
| `DASHBOARD_REMOTE_ACCESS` | no | `false` | `false` = the dashboard only opens on the computer running the app (`http://localhost`). Requests through ngrok get only `/webhook`. `true` = other computers can open it too. **Only use `true` on a trusted office network, never with ngrok running**, because the dashboard has no login. |

### WhatsApp (from Meta — see section 5 for where to find each one)

| Variable | Required | Example | What it is |
|---|---|---|---|
| `WA_DRY_RUN` | yes | `true` / `false` | `true` = nothing is sent (safe testing). `false` = **real WhatsApp messages are sent.** |
| `WA_PHONE_NUMBER_ID` | for live | `123456789012345` | ID of the WhatsApp number that sends messages. **This is not the phone number itself.** |
| `WA_ACCESS_TOKEN` | for live | `EAAG...` | Permanent **System User** access token. |
| `WA_APP_SECRET` | for live | `a1b2c3...` | App Secret. Used to check that webhook calls really come from Meta. |
| `WA_VERIFY_TOKEN` | for live | any random text, e.g. `tc-attend-7f3k9q2m` | **You make this up.** Enter the same value in Meta's webhook settings. |
| `WA_TEMPLATE_NAME` | for live | `attendance_absent_check` | Exact name of the approved template. |
| `WA_TEMPLATE_LANG` | for live | `en` | Template language code. **Must match exactly**: "English" = `en`, "English (US)" = `en_US`, "English (UK)" = `en_GB`. |
| `WA_TEMPLATE_BUTTONS` | for live | `4` | Number of quick-reply buttons on the approved template (`0` if it has none). |
| `WA_GRAPH_VERSION` | no | `v23.0` | Meta Graph API version. |

### AI (optional)

| Variable | Required | Example | What it is |
|---|---|---|---|
| `OPENAI_API_KEY` | no | `sk-proj-...` | OpenAI key for understanding typed replies. Leave empty to turn AI off. |
| `OPENAI_MODEL` | no | `gpt-4o-mini` | Model used. It is cheap: one short call per typed reply. |

To generate a random value for `WA_VERIFY_TOKEN`: `openssl rand -hex 16`, or any password generator.

### 4.1 How to get each value — step by step

Meta renames menus from time to time; if a label differs slightly, look for the closest match.
You need **Admin** access to the company's Meta Business account for the WhatsApp values.

#### Values you can leave as they are
| Variable | Keep |
|---|---|
| `PORT` | `3000` |
| `DATABASE_URL` | `postgres://attendance:attendance@localhost:5433/attendance` (matches `docker-compose.yml`) |
| `TZ_NAME` | `Asia/Kolkata` |
| `WA_GRAPH_VERSION` | `v23.0` |
| `OPENAI_MODEL` | `gpt-4o-mini` |
| `DASHBOARD_REMOTE_ACCESS` | `false` |
| `WA_DRY_RUN` | `true` while testing. Change to `false` only when going live ([section 8](#8-going-live--checklist)). |

#### `WA_VERIFY_TOKEN` — you make it up
1. Create any random text: `openssl rand -hex 16`, or type something like `tc-attend-7f3k9q2m`.
2. Put it in `.env`.
3. Later, type **the same text** into Meta's webhook settings ([section 7.4](#74-connect-it-in-meta)).

#### `WA_PHONE_NUMBER_ID` — from Meta
1. Go to **developers.facebook.com → My Apps** and open the company app.
2. **Use cases → Connect with customers through WhatsApp → Customize**.
3. Open **API Setup** (or **Step 2. Production setup** once the real number has been added).
4. In the **"From"** dropdown, select the company's WhatsApp number.
5. Copy the **Phone number ID** shown below it (a 15–16 digit number). This is **not** the phone number itself.

> If the real number isn't listed yet, finish **Step 2. Production setup** first ([section 5.2](#52-add-the-real-number-step-2-production-setup)).
> For testing, you can use the **test number** under **Step 1. Try it out** ([section 5.8](#58-testing-with-metas-test-number-first-optional)).

#### `WA_ACCESS_TOKEN` — from Meta (permanent System User token)
1. Go to **business.facebook.com** → **Settings** (gear icon, bottom left).
2. **Users → System users → Add**. Name it `attendance-agent`, role **Admin** → **Create system user**.
3. With the system user selected, click **Assign assets**:
   - **Apps** → select the company app → **Full control**
   - **WhatsApp accounts** → select the company's WhatsApp account → **Full control**
   → **Save / Assign**.
4. Click **Generate new token**:
   - **App:** the company app
   - **Token expiration:** **Never**
   - **Permissions:** tick `whatsapp_business_messaging` and `whatsapp_business_management`
   → **Generate token**.
5. **Copy the token right away** (starts with `EAA…`). Meta shows it only once. If you lose it, generate a new one.

> Don't use the token on the API Setup page for real use. It expires after 24 hours.

#### `WA_APP_SECRET` — from Meta
1. **developers.facebook.com → My Apps →** open the company app.
2. Left menu: **App settings → Basic**.
3. Next to **App secret**, click **Show** and enter your Facebook password.
4. Copy the value (32 characters, letters and digits).

#### `WA_TEMPLATE_NAME`, `WA_TEMPLATE_LANG`, `WA_TEMPLATE_BUTTONS` — from WhatsApp Manager
1. Create the template if it doesn't exist yet ([section 6](#6-the-message-template-must-be-approved-by-meta)).
2. Go to **business.facebook.com → WhatsApp Manager → Message templates**.
3. Find the template; its status must be **Active / Approved**.
4. Fill in:
   - `WA_TEMPLATE_NAME` = the template name exactly as shown (e.g. `attendance_absent_check`)
   - `WA_TEMPLATE_LANG` = the language code: English → `en`, English (US) → `en_US`, English (UK) → `en_GB`
   - `WA_TEMPLATE_BUTTONS` = the number of quick-reply buttons on it (`4` if made as described)

#### `OPENAI_API_KEY` — from OpenAI (optional)
1. Sign in at **platform.openai.com**, using the company's account.
2. **Settings → Billing**: add a payment method or credit. The key doesn't work without billing.
3. Go to **API keys** (platform.openai.com/api-keys) → **Create new secret key**. Name it `attendance-agent` → **Create**.
4. **Copy the key right away** (starts with `sk-`). It's shown only once.
5. Optional: under **Limits**, set a monthly budget cap. This app uses very little: one short request per typed reply.

Skip this to run without AI. Button taps and replies of "1"–"4" still work.

#### Final `.env` example
```ini
PORT=3000
DATABASE_URL=postgres://attendance:attendance@localhost:5433/attendance
TZ_NAME=Asia/Kolkata
DASHBOARD_REMOTE_ACCESS=false
WA_DRY_RUN=true
WA_GRAPH_VERSION=v23.0
WA_PHONE_NUMBER_ID=123456789012345
WA_ACCESS_TOKEN=EAAG...long token...
WA_APP_SECRET=0a1b2c3d4e5f60718293a4b5c6d7e8f9
WA_VERIFY_TOKEN=tc-attend-7f3k9q2m
WA_TEMPLATE_NAME=attendance_absent_check
WA_TEMPLATE_LANG=en
WA_TEMPLATE_BUTTONS=4
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4o-mini
```
(All values above are made-up examples.) Restart the app after saving: stop it with `Ctrl+C`, then run `npm start`.

---

## 5. Meta / WhatsApp setup — where to find everything

This needs someone with **Admin** access to the company's Meta Business account.
Meta renames menus from time to time; if a label differs slightly, look for the closest match.

### 5.1 Open the app
**developers.facebook.com → My Apps →** open the company app (e.g. *TC Customer Support*)
**→ Use cases → Connect with customers through WhatsApp → Customize.**

The **Overview** shows three steps:

| Step | Meaning |
|---|---|
| Step 1. Try it out | Meta's **test number**. Good for testing, but it can message only up to 5 registered numbers. |
| Step 2. Production setup | Adds the **company's real WhatsApp number** and a payment method. **Required for going live.** |
| Step 3. Business verification | Company documents verified by Meta. |

### 5.2 Add the real number (Step 2. Production setup)
- Follow **Step 2**: enter the display name and phone number, then confirm with the code sent by SMS or voice call.
- ⚠️ If the number is currently used in the **WhatsApp / WhatsApp Business app on a phone**, it must be removed from
  that app first, or Meta will refuse it. Chats on that phone stop working. Consider using a **new number** just for this.
- Add a **payment method** when asked. Template messages are charged per message.

### 5.3 `WA_PHONE_NUMBER_ID`
WhatsApp use case → **API Setup** (also shown in **Step 1 / Step 2**). Pick the company number in the **"From"**
dropdown. The **Phone number ID** is shown just below it. (The WhatsApp Business Account ID shown there is not needed by the app.)

### 5.4 `WA_ACCESS_TOKEN` (permanent)
The token on the API Setup page **expires after 24 hours**. For real use, create a permanent one:
1. **business.facebook.com → Settings** (gear icon) **→ Users → System users → Add**. Name: `attendance-agent`, role **Admin**.
2. **Assign assets:** the **App** (full control) and the **WhatsApp account** (full control).
3. **Generate new token** → select the app → expiry **Never** → permissions
   `whatsapp_business_messaging` and `whatsapp_business_management` → **Generate**.
4. **Copy it immediately.** Meta shows it only once.

### 5.5 `WA_APP_SECRET`
developers.facebook.com → the app → **App settings → Basic → App secret → Show** (asks for your password).

### 5.6 `WA_VERIFY_TOKEN`
Not from Meta. Make up any random text, put it in `.env`, and type the same text into Meta in [section 7](#7-webhook-making-the-app-reachable-with-ngrok).

### 5.7 App mode
The app must be **Published / Live**. Check the **Publish** item in the app's left menu.
In development mode, Meta does not deliver real messages to the webhook.

### 5.8 Testing with Meta's test number first (optional)
Under **Step 1. Try it out** you get a test number, its Phone number ID and a temporary token.
Add your own phone as a recipient there (max. 5 numbers), then put those values in `.env`.
The test number can use templates created in its own test account. Swap in the real values later; nothing else changes.

---

## 6. The message template (must be approved by Meta)

A business is only allowed to **start** a WhatsApp conversation with a template that Meta has approved.
(The instructions sent after the employee replies are normal messages and need no approval.)

**business.facebook.com → WhatsApp Manager → Message templates → Create template**

| Field | Value |
|---|---|
| Category | **Utility** |
| Name | `attendance_absent_check` |
| Language | English (note the code for `WA_TEMPLATE_LANG`) |
| Body | `Hi {{1}}, our attendance record shows you are marked absent on {{2}}. Please confirm the reason by choosing one option below.` |
| Sample values | `{{1}}` = `Ankit`, `{{2}}` = `17-Aug-2026` |
| Buttons | **Quick reply**, in **this order**: `Yes, I was absent` · `No, I was working` · `Already applied leave` · `Sent regularization` |

Submit, then wait until the status is **Active / Approved** (usually minutes, sometimes up to a day).

**Button order matters.** Button 1 = option 1 … button 4 = option 4. If you use a different name, language or number of
buttons, update `WA_TEMPLATE_NAME`, `WA_TEMPLATE_LANG` and `WA_TEMPLATE_BUTTONS`.
Also update the copy of the text in `src/flow.js` → `firstMessage()`, so the dashboard preview matches.

---

## 7. Webhook: making the app reachable with ngrok

When an employee replies, **Meta sends the reply to our app** at `https://<public-address>/webhook`.
The app runs on a local computer, so **ngrok** creates that public HTTPS address.

### 7.1 Install and log in to ngrok (once)
```bash
# macOS: brew install ngrok      Windows: download from https://ngrok.com/download
ngrok config add-authtoken <your-ngrok-authtoken>     # from https://dashboard.ngrok.com/get-started/your-authtoken
```

### 7.2 Get a fixed address (recommended)
A free ngrok address **changes every time ngrok restarts**, and then Meta's webhook must be updated again.
Avoid this: in the ngrok dashboard, open **Domains** and claim your **free static domain** (e.g. `tc-attendance.ngrok-free.app`).

### 7.3 Start ngrok (keep this window open)
```bash
ngrok http --url=tc-attendance.ngrok-free.app 3000     # with a static domain
# or
ngrok http 3000                                        # random address, changes on restart
```
Your webhook URL is: `https://tc-attendance.ngrok-free.app/webhook`

Check it works: open `https://tc-attendance.ngrok-free.app/health` in a browser. It should show `{"ok":true}`.

### 7.4 Connect it in Meta
developers.facebook.com → the app → WhatsApp use case → **Configuration**:
1. **Webhook → Edit**
   - **Callback URL:** `https://tc-attendance.ngrok-free.app/webhook`
   - **Verify token:** exactly the value of `WA_VERIFY_TOKEN` in `.env`
2. Click **Verify and save**. The app console prints `[webhook] verified by Meta`.
   (The app must be running with the same `WA_VERIFY_TOKEN`, otherwise verification fails.)
3. **Webhook fields → Manage →** subscribe to **`messages`**. This one field carries replies and delivered/read receipts.

> ⚠️ **One app = one webhook URL.** If this Meta app's webhook is already used by another system (e.g. a customer-support chatbot),
> replacing it will break that system. In that case, use a separate Meta app and number for attendance.

> **Permanent hosting:** ngrok is for running on a local computer. For 24/7 use, host the app on a server
> with a domain and HTTPS (any VPS or cloud host). Then use `https://your-domain/webhook` in Meta instead.

---

## 8. Going live — checklist

1. ☐ Real number added (Step 2. Production setup), payment method added, app **Published**
2. ☐ Template `attendance_absent_check` **Approved**
3. ☐ `.env` filled in: `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_TEMPLATE_NAME`, `WA_TEMPLATE_LANG`
4. ☐ `npm start` running, `ngrok` running, `/health` opens in the browser
5. ☐ Webhook verified in Meta and subscribed to **messages**
6. ☐ **Test on your own phone first.** Point one employee at your number:
   ```bash
   docker exec attendance-db psql -U attendance -c "UPDATE employees SET mobile_e164='91XXXXXXXXXX' WHERE full_name='Ankit Panwar'"
   ```
   (Numbers use country code + number, digits only, no `+`.)
7. ☐ Set `WA_DRY_RUN=false` and restart. The dashboard banner changes to **"WhatsApp live"**.
8. ☐ Run the check for a date where that employee is absent. Check that the message arrives, tapping a button
   returns the right instruction, and the dashboard updates within ~5 seconds.
9. ☐ Only then import real attendance data / real numbers.

> ⚠️ With `WA_DRY_RUN=false`, **every employee in the database with a mobile number gets a real message** when flagged.
> The demo Excel file contains real-looking numbers. Replace them before going live with it.

---

## 9. Using the dashboard

| Area | What it does |
|---|---|
| **Top banner** | Case counts: total, waiting for reply, leave needed (option 1), regularization (2), manager approval (3 + 4), needs attention (unclear / no reply / failed). Also shows the mode (dry run / live), AI on/off and the daily check. |
| **Run Attendance Check** | Pick a date. **Preview** lists who is flagged. **Run check & send** shows a confirmation with every name and number, then sends. |
| **Follow-up Cases** | One row per employee + absent date. Absentees not yet messaged show **"Not messaged yet"**. Click a row to open its chat. **All dates** shows every case. |
| **WhatsApp panel** | The full conversation for the selected case. In dry run, it also has **Simulate employee reply** (buttons 1–4 or typed text). |
| **Settings** | **Daily check time** (IST) and **Run the check automatically every day**. When on, the app checks *today's* attendance once a day at that time. |
| **Import Attendance** | Upload a new attendance Excel file (see section 10). |

**Case statuses**

| Status | Meaning |
|---|---|
| Not messaged yet | Absent on that date, no message sent yet |
| Sent / Delivered / Read · awaiting reply | Message sent; ticks come from Meta |
| Replied · guidance sent | Employee answered; the instruction was sent. Done for this demo. |
| Unclear reply · HR check | Reply not understood. The employee was asked to reply 1–4; a later clear reply completes the case. |
| No reply | No answer within 48 hours (or marked manually) |
| Send failed | Meta rejected the message. Hover for the reason; use **Retry send**. |

Tip: open a specific date directly with `http://localhost:3000/?date=2026-08-17`.

---

## 10. Attendance data (Excel import)

The app reads the **TimeOffice "Attendance register"** export (`.xlsx`), the same format as `DEMO_Attendance_data_v1.0.xlsx`.

**Required columns** in the attendance sheet (the sheet name should contain "attendance"; otherwise the first sheet is used):

| Column | Used for |
|---|---|
| `Employee Code` | Unique ID of the employee (used to update existing employees) |
| `Full name` | Name in messages (first name) and dashboard |
| `Mobile number` | WhatsApp number. 10-digit Indian numbers get `91` added automatically. |
| `Department`, `Branch`, `Reporting manager` | Shown in the dashboard |
| Day columns like `1 / 8 \| Sat`, `2 / 8 \| Sun` … | Attendance per day, as `first half\|second half` |

Cell values: `P` present, `A` absent, `WO` weekly off, `HO` holiday. For example, `P|A` = absent in the second half.
The **year** is taken from the report run date in the `Filters` sheet (e.g. `Report was run at 18-09-2026`).

**Importing:** dashboard → **Import Attendance → Import**, or `npm run seed -- "file.xlsx"`.
- New employees are added; existing ones (same Employee Code) are updated, including their phone number.
- A day already in the database is overwritten with the new value. Re-uploading a corrected file is safe.
- Nothing is deleted, and **nothing is sent** by importing.

**For the daily automatic check to find anyone, today's attendance must be imported before the check time.**

---

## 11. Database

PostgreSQL 16, running in Docker (`docker-compose.yml`). Data is stored in the Docker volume `pgdata` and survives restarts.

| Setting | Value |
|---|---|
| Host / port | `localhost:5433` |
| Database / user / password | `attendance` / `attendance` / `attendance` (change in `docker-compose.yml` and `DATABASE_URL` for production) |
| Schema | `db/schema.sql`. Created automatically when the app or seed starts. |

**Tables**

| Table | Contents |
|---|---|
| `employees` | Code, name, department, branch, manager, mobile, `mobile_e164` (WhatsApp format, e.g. `917042097645`) |
| `attendance` | One row per employee per day: `first_half`, `second_half`, raw value |
| `cases` | One per employee + absent date: code (A\|A…), status, WhatsApp message ID, reply option (1–4), reply text, whether AI was used, sent/replied times, error |
| `messages` | Every WhatsApp message in and out: text, status, and the full raw data received from Meta (`payload`) |
| `settings` | Daily check time, automatic check on/off, last automatic run date |

**Useful commands**
```bash
# Open a SQL shell
docker exec -it attendance-db psql -U attendance

# Backup / restore
docker exec attendance-db pg_dump -U attendance attendance > backup.sql
docker exec -i attendance-db psql -U attendance attendance < backup.sql

# Clear all cases and messages (keeps employees + attendance) — e.g. to restart a demo
docker exec attendance-db psql -U attendance -c "TRUNCATE messages, cases RESTART IDENTITY"

# Delete EVERYTHING including the database volume
docker compose down -v
```
Times in the database are stored in UTC; the dashboard shows local time.

---

## 12. Messages sent to employees

All texts are in `src/flow.js` (from `../Workflow.svg`). The system replies can be edited freely (restart after editing).
The first message is the Meta template (edit it in WhatsApp Manager).

| When | Message |
|---|---|
| First message (template) | Hi {name}, our attendance record shows you are marked absent on {date}. Please confirm the reason by choosing one option below. *[4 buttons]* |
| Reply 1 – Yes, I was absent | Please apply leave if leave balance is available. If leave balance is not available, please follow the HR process for unpaid leave/regularization and get it approved by your manager. |
| Reply 2 – No, I was working | Please apply attendance regularization for {date} and get it approved by your manager. |
| Reply 3 – Already applied leave | Please ask your manager to approve your leave for {date}. |
| Reply 4 – Sent regularization | Please ask your manager to approve your regularization request for {date}. |
| Unclear reply | Sorry, we couldn't understand your reply about {date}. Please reply with 1, 2, 3 or 4: … |

**How replies are understood:** button taps map directly to their option. A typed `1`–`4` or an exact option text is matched by rule.
Anything else goes to OpenAI (English, Hindi, Gujarati and Hinglish work), which picks an option only if it is confident.

---

## 13. API reference

There is no login. The dashboard and all `/api/*` routes only answer requests made on the computer running the app, unless `DASHBOARD_REMOTE_ACCESS=true`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Health check (reachable through ngrok) |
| GET / POST | `/webhook` | Meta webhook: verification (GET) and messages/receipts (POST, signature-checked). Reachable through ngrok. |
| GET | `/api/meta` | Mode, AI on/off, data date range |
| GET | `/api/preview?date=YYYY-MM-DD` | Who is flagged on a date (sends nothing) |
| POST | `/api/run` `{"date":"YYYY-MM-DD"}` | Create cases + send first messages |
| GET | `/api/cases?date=YYYY-MM-DD` | Cases (all dates if no date) |
| GET | `/api/cases/:id/messages` | Conversation for a case |
| POST | `/api/cases/:id/send` | Retry a failed case |
| POST | `/api/cases/:id/no-reply` | Mark a case as No reply |
| POST | `/api/cases/:id/simulate` `{"option":1}` or `{"text":"..."}` | Fake an employee reply (dry run only) |
| GET / PUT | `/api/settings` | `check_time` (HH:MM), `scheduler_enabled` |
| POST | `/api/import` (multipart `file`) | Import an attendance Excel file |

---

## 14. Troubleshooting

| Problem | Cause / fix |
|---|---|
| Meta: **"The callback URL or verify token couldn't be validated"** | App or ngrok not running, wrong URL (must end in `/webhook`), or the verify token differs from `WA_VERIFY_TOKEN`. Check that `https://<ngrok>/health` opens. |
| Messages "sent" but nothing arrives on the phone | `WA_DRY_RUN` is still `true`. The banner says "dry run". |
| **Send failed:** `(#131030) Recipient phone number not in allowed list` | Using the test number: add the recipient under Step 1. Try it out. |
| **Send failed:** `(#132001) Template name does not exist in the translation` | `WA_TEMPLATE_NAME` or `WA_TEMPLATE_LANG` doesn't exactly match the approved template (e.g. `en` vs `en_US`), or the template isn't approved yet. |
| **Send failed:** parameter/button count errors | The template doesn't have exactly 2 variables and `WA_TEMPLATE_BUTTONS` buttons. |
| **Send failed:** `(#190) ... access token` / `Session has expired` | The temporary 24-hour token was used. Create a permanent System User token (5.4). |
| **Send failed:** `(#133010) Account not registered` | The number isn't fully set up in Step 2. Production setup. |
| **Send failed:** payment / `131042` | No payment method in WhatsApp Manager. |
| Replies don't show up in the dashboard | Webhook not subscribed to **messages**, app not Published/Live, ngrok address changed, or `WA_APP_SECRET` is wrong (console shows `rejected: bad X-Hub-Signature-256`). |
| Typed replies always "Unclear" | `OPENAI_API_KEY` missing or invalid. The banner shows "AI reply classification off", or the console shows `[classifier] OpenAI failed`. |
| "Nobody is marked absent" for today | Today's attendance hasn't been imported. |
| `npm run db:up` fails | Docker Desktop isn't running, or port 5433 is in use (change it in `docker-compose.yml` and `DATABASE_URL`). |
| "The dashboard is only available on the computer running the app" | Open it at `http://localhost:3000` on that computer, not through the ngrok address. To open it from another computer on the office network, set `DASHBOARD_REMOTE_ACCESS=true` (never with ngrok running). |

The app console logs every run, webhook message and error. Check it first.

---

## 15. Security notes

- **Never share or commit `.env`.** It holds the WhatsApp token, App Secret and OpenAI key. Share `.env.example` instead.
- The dashboard has **no login**. It is protected by only opening on the computer running the app. Keep `DASHBOARD_REMOTE_ACCESS=false` whenever ngrok is running; otherwise anyone with the ngrok address could open the dashboard and send messages to employees. Anyone with access to that computer can use the dashboard.
- Always set `WA_APP_SECRET`. Without it, the app cannot verify that webhook calls come from Meta (the console warns about this).
- If a token or key has been shared in chat or email, **regenerate it** (Meta: System users → the token; OpenAI: API keys).
- Change the database password in `docker-compose.yml` + `DATABASE_URL` for anything beyond a demo.
- Employee phone numbers and replies are personal data. Keep backups private.

---

## 16. Project structure

```
docker-compose.yml        PostgreSQL 16 container
.env.example              Settings template (copy to .env)
db/schema.sql             Tables (created automatically)
scripts/seed.js           Import the demo Excel file
src/server.js             Web server, dashboard access rule, API routes
src/importer.js           Excel → employees + attendance
src/cases.js              Find absentees, create cases, send, handle replies and receipts
src/whatsapp.js           WhatsApp Cloud API calls (template + text), dry-run mode
src/webhook.js            Meta webhook: verification, signature check, events
src/classifier.js         Reply → option 1–4 (rules, then OpenAI)
src/flow.js               All message texts (from Workflow.svg)
src/scheduler.js          Daily automatic check + 48h "No reply"
public/index.html, app.js Dashboard
../Workflow.svg              Full process flowchart (this demo implements the first stage)
DEMO_Attendance_data_v1.0.xlsx  Sample attendance data (August 2026)
```
