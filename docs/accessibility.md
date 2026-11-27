# Accessibility — what is built, what is tested, and the manual screen-reader script

Accessibility is a hard requirement for the Sarab portal. This page records **how** the portal meets it, what
the automated suite proves, what it **cannot** prove, and a step-by-step script for the manual NVDA and
VoiceOver testing that still has to be done by a person.

> **Status (Phase 5):** automated checks 97/97 passing (`make a11y`), zero axe-core violations on 30+ screen
> states in Arabic and English. **Manual testing with NVDA and VoiceOver has not been done yet** — no
> automation can confirm what a screen reader actually *says* or whether the experience is pleasant.

## How the portal is built (by WCAG 2.2 criterion)

| Criterion | What the portal does |
|---|---|
| 1.1.1 Non-text content | No informative images; the decorative emblem and bank logo are `aria-hidden`. Status is always text ("Done", "Waiting"), never colour or icon alone. |
| 1.3.1 Info and relationships | Landmarks (`header`, `nav` ×2 with distinct labels, `main`, `footer`), one `h1` per page, ordered headings, real `<label>`s, `fieldset`/`legend` for radio and checkbox groups, data tables with `<caption>`, `scope`d headers, row headers. Timelines are ordered lists. |
| 1.3.2 Meaningful sequence / 1.3.4 Orientation | DOM order = visual order in both RTL and LTR (logical CSS properties only). |
| 1.4.3/1.4.11 Contrast | Text ≥ 4.5:1, focus ring and UI borders ≥ 3:1 (axe-checked). |
| 1.4.10 Reflow | No horizontal page scrolling at 320 CSS px (checked on 7 pages); wide tables scroll inside a keyboard-focusable region. |
| 1.4.12 Text spacing / 1.4.4 Resize | Relative units, no fixed heights on text containers. |
| 2.1.1 Keyboard / 2.1.2 No trap | Everything works with Tab/Shift+Tab/Enter/Space; automated Tab-through audit on 7 screens finds no trap. |
| 2.2.1 Timing adjustable | **Added in Phase 5:** 2 minutes before the 30-minute session ends, an `alertdialog` takes focus and offers **Stay signed in** (extends by 30 minutes, up to 12 hours) or Sign out; focus returns where it was. |
| 2.4.1 Bypass blocks | "Skip to main content" is the first Tab stop. |
| 2.4.2/2.4.3 Titles and focus order | Every route sets a unique `document.title`; after client-side navigation focus moves to the new `h1`. |
| 2.4.7/2.4.11/2.4.13 Focus visible / not obscured / appearance | 3 px outline + 6 px halo on every focusable element, also in forced-colours mode (`Highlight`). **Phase 5 fix:** date inputs now show the ring when an inner day/month/year segment has focus. |
| 2.5.8 Target size | Buttons ≥ 24×24 px (axe `target-size`). |
| 3.1.1/3.1.2 Language | `<html lang dir>` switches with the UI language; English fragments inside Arabic pages (API names, rule descriptions, makes of car) carry `lang="en" dir="ltr"`; IDs, plates and hashes carry an explicit `dir`. |
| 3.3.1/3.3.3 Errors | An error summary appears at the top, takes focus, is announced (`role=alert`), and invalid fields get `aria-invalid`. |
| 3.3.8 Accessible authentication | Passkeys (no memory test); codes can be pasted; no CAPTCHA. |
| 4.1.3 Status messages | Two live regions (polite + assertive) exist from first paint; results of actions ("Consent revoked", each life-event step, "Delegation signed", tamper result) are announced without moving focus. |
| Reduced motion / forced colours | No animation; `prefers-reduced-motion` and `forced-colors` media queries respected. |

## What `make a11y` checks automatically (real Chromium, against the public URL)

* **axe-core** (WCAG 2.0/2.1/2.2 A + AA + best practice) on 30+ screen states: home, login (+ errors, OTP,
  Telegram code), citizen dashboard (collapsed and with all ministry sections open), bank landing, regulator
  rejection, consent, bank result with technical details, revoke confirmation, signing, inbox, life events,
  delegations, acting-for, counter (start, waiting for code, serving), admin (audit, tamper demo), civil
  registration form (empty, with errors, registered), account activation (3 steps, Arabic; reached from the sign-in page and from the message link with the ID pre-filled),
  Manage citizen (search, results, overview, each ministry screen, errors, remove confirmation; Health in Arabic), session
  warning — in Arabic and English, at desktop width, at 320 px, and in forced-colours mode.
* **Focus management**: skip link first and working; focus to `h1` after navigation; to the error summary;
  to the OTP field; into confirmations; to the result heading; to the "Stay signed in" button; back to the
  start after finishing at the counter. Manage citizen: to the results heading; to a section heading after a
  save (with the result announced); to the form heading on Edit and back to the button on Cancel; into the
  remove confirmation and back to the Remove button on Cancel; server-side field errors land on the right field.
* **Tab-through audit** (home, dashboard, consent, life events, delegations, counter, registration form, Manage citizen: Civil Registry and Health, forced colours): each
  stop visible, in view, with a ≥ 2 px outline or halo; no keyboard trap.
* **Reflow at 320 px** on home, login, bank, dashboard, life events, delegations, inbox.
* **Live regions**: announcements present after section load, revoke, life-event steps, delegation revoke,
  tamper demo (assertive), session extension.
* **Real passkey** registration and sign-in with Chrome's virtual authenticator (also by a newly activated citizen).
* **Every registration-form control is filled through its accessible name** (label), so an unlabelled control fails the run.
* **Session timeout** with Playwright's fake clock: the warning appears, takes focus, extends the session on
  the server.
* No console errors; the strict CSP holds (the test suite itself had to avoid `eval`).

`make a11y-snapshots` additionally saves the **accessibility tree** of 11 key screens to
`docs/accessibility/tree/` — the roles, names and states a screen reader receives (generate them locally;
they are not committed because they capture a running instance's data).
Manual testers can compare what they hear against these files.

### What automation cannot tell you
Whether announcements are understandable and not too chatty; how Arabic text-to-speech pronounces names,
dates, digits and mixed Arabic/English; whether browse-mode and focus-mode switching feels natural; how the
operating system's passkey dialog behaves; real-world zoom at 200–400 % with magnifiers; and cognitive load.

## Manual test script (to be run by a person)

**Set-ups to cover (minimum):**
1. NVDA 2024+ with **Firefox** and with **Chrome** on Windows 11, Arabic voice installed (e.g. Microsoft
   *Naayf*/*Hoda* via OneCore, or eSpeak NG Arabic) and NVDA's automatic language switching **on**.
2. VoiceOver on **macOS** with Safari (Arabic voice *Majed*), and VoiceOver on **iOS** Safari (rotor, swipe).
3. Optionally TalkBack on Android Chrome, and Windows High Contrast / 400 % zoom without a screen reader.

Use the demo accounts in the README. Record a result (✓ / ✗ + note) for every step.

| # | Flow | Steps | What you should hear / experience | NVDA+FF | NVDA+Chrome | VO macOS | VO iOS |
|---|---|---|---|---|---|---|---|
| 1 | Landing | Open the home page; press **H** / rotor Headings | Page title "Republic of Sarab"; one H1; H2 "Choose a view"; links read with their card headings; language switch button announced in the *other* language ("English") | | | | |
| 2 | Skip link | Tab once, Enter | "Skip to main content" → focus lands in main | | | | |
| 3 | Language switch | Activate "English" | Page re-reads in English; voice switches from Arabic to English automatically | | | | |
| 4 | Login errors | On Sign in, press Continue with empty fields | Error summary is read immediately (alert), fields are "invalid entry" | | | | |
| 5 | Login with code | Sign in as Layla; read the code in Telegram (or, in console mode, in `docker compose logs notifier`); type it | Code field focused and labelled "6-digit code sent by Telegram"; after sign-in "Welcome, Layla…" H1 is read | | | | |
| 6 | My data | Expand "My education" etc. | Button reads "collapsed"/"expanded"; "…loaded" is announced politely; tables: caption read, Ctrl+Alt+arrows (NVDA) / VO table navigation give row and column headers | | | | |
| 7 | Bank consent | Bank → Open an account | Consent page H1; list of what is shared and what is NOT shared is clear; Approve button reachable | | | | |
| 8 | Regulator rejection | "Try an over-reaching request" | Focus moves to "Rejected automatically"; rejected items read as a list | | | | |
| 9 | Revoke | My Mithaq → consents → Revoke | Confirmation receives focus; after "Yes", "Consent revoked" is announced | | | | |
| 10 | Access log | "Who accessed my data" table | Each row: who, from, on behalf of, purpose, result — understandable without seeing it | | | | |
| 11 | Life event: name a baby | As `admin`, report a birth for Layla + Omar (row 18h); as Layla → Life events → press "Send the name…" empty, then type a Latin name in the Arabic field, then a correct name | The baby is an article with heading "Your daughter, born …"; its details read as a list of terms and values; empty send: error summary read at once, both fields "invalid entry"; the Arabic field reads in an Arabic voice, the English one in English; after sending, focus on the baby's heading and "Name sent…" is read; status says who must confirm | | | | |
| 11a | Life event: confirm | As Omar → Life events → Confirm the name | The button says the name it confirms; afterwards focus on the heading, "Name confirmed and baby registered. National ID …" read; each later step announced ("Done: …") without stealing focus; final "All steps are complete" | | | | |
| 12 | Delegation | As Saleh, authorise 1100000031 | Checkbox group legend read; success message read; table row has "Revoke delegation for Omar…" (unique name) | | | | |
| 13 | Acting for | As Omar, act for Saleh → Renew | "You are acting for Saleh…" note read at the top; Renew button names the car; result announced | | | | |
| 14 | Inbox | Open Inbox | Unread count in the sub-navigation link; each message is a heading in an ordered list; "New" badge read | | | | |
| 15 | Counter | As `clerk`, serve Saleh | "Confirmation code sent to the citizen" note is clear (the code itself is never on screen); after confirm, "Now serving…" H2 focused; Finish returns focus to "Start serving" | | | | |
| 16 | Admin tamper | As `admin` → section menu → **Audit log integrity** → Tamper demo | Result is announced assertively and states the entry number where the chain broke | | | | |
| 17 | Session timeout | Stay idle ~28 min (or ask a developer to shorten the session) | Alert dialog "Your session is about to end" read, focus on "Stay signed in"; after activating, "extended" announced and you are back where you were | | | | |
| 18 | Passkey | Add a passkey, sign out, sign in with it | OS/browser passkey dialog is accessible (outside the portal's control — note any problems) | | | | |
| 18a | Civil registration | As `admin` → Civil Registry (staff) → press Register with an empty form, then fill it in | Error summary read immediately; each field says "invalid entry" and reads its own error; radio groups read their legend; "(required)" / "(optional)" read with each label; after registering, focus on "Registered: …" and the new national ID is announced | | | | |
| 18b | Activation | Sign out → "Activate your account" → ID + code → password → Add a passkey | Step list read as a list with the current step; each step's heading takes focus ("Step 2 of 3: Choose a password"); password errors read per field; passkey dialog | | | | |
| 18c | Manage citizen: find | As `admin` → **Manage citizen** → press Search with the field empty, then type a national ID or part of a name | Empty: error summary read at once, field "invalid entry". Search: focus moves to "Search results: 1"; the table's row header is the name; the link reads "Open the records of …" | | | | |
| 18d | Manage citizen: overview | Open the person | H1 "Manage: <name>"; breadcrumb navigation with "current page"; five H3 ministry headings, each followed by a one-line summary and an "Open the … record" link | | | | |
| 18e | Manage citizen: change and error | Civil Registry → change the city → Save address; then Register a marriage with spouse ID "123" | Save: focus jumps to the "Address" heading, "Address saved; the citizen has been told" is read. Error: summary read, both fields "invalid entry" with their own message | | | | |
| 18f | Manage citizen: edit / remove in a table | Education → add a degree → Edit → Cancel → Remove → Cancel → Remove → Remove | Buttons read with the item ("Edit: Bachelor's degree — …"); Edit moves focus to "Edit: …" form heading; Cancel returns to the button; Remove first asks ("Remove "…"?" heading focused), nothing is removed until confirmed | | | | |
| 18h | Hospital: report a birth | As `admin` → **Hospital: report a birth** → Send empty, then fill in and send | Note "acting as hospital staff ADM-0001" read; no name field; "Baby's sex" radio group read with its legend; empty send: summary read, each field reads its own error; after sending, focus on "Birth reported", report number and each parent's account status read; "Report another birth" puts focus back in the mother field | | | | |
| 18g | Manage citizen: checkboxes, Arabic | Switch to Arabic → Health → create the record | Allergies / conditions are groups with their legend read first; Arabic voice for Arabic labels, English for blood type letters; "Health record created" read | | | | |
| 19 | Zoom / high contrast | 400 % zoom; Windows Contrast theme | No content lost or overlapping; focus ring visible everywhere | | | | |

### Things to listen for specifically (known risk areas)
* **Mixed direction**: national IDs, plates such as "م ر ج 6470", SHA-256 hashes and English API names
  inside Arabic sentences — do they read in the right order?
* **Digits**: the portal uses Latin digits in Arabic (`ar-u-nu-latn`); confirm the Arabic voice reads them naturally.
* **Verbosity** during life events (four quick polite announcements) — too chatty, or helpful?
* **Non-modal alert dialog** for the session timeout: with NVDA browse mode, can users still reach the
  page behind it, and is that confusing?
* **Arabic names in English mode** and vice versa: language switching inside names.

When a manual run is done, add the results table here and file issues for every ✗.
