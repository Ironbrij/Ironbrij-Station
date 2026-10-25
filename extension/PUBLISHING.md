# Publishing the SavyTime Clock Ball

How to put the extension on the Chrome Web Store, so employees install it with one
click instead of Developer mode.

## What we're making, in one paragraph

SavyTime Clock Ball is a Chrome extension for Ironbrij employees. After they sign in
with their SavyTime account, a small ball (the Ironbrij logo by default) floats on
every website while they're clocked in and counts their worked time. It reads their
punches straight from SavyTime's database, so it appears when they punch in, pauses on
breaks, and disappears when they punch out from anywhere, even with SavyTime closed or
after Chrome restarts. Clicking the ball opens SavyTime itself in Chrome's side panel
to start or stop work, write SOD & EOD, read notifications and send feedback. These are
the real SavyTime pages, so nothing is copied or synced separately. Employees can
change its face, size and colour, turn blinking and jokes on or off, and give it a hat.

## Why publish it on the store

- **No Developer mode.** Chrome shows a warning about developer-mode extensions on every
  start-up, and some company computers block them.
- **Automatic updates.** You upload a new version once and every employee gets it within
  a few hours. With the zip, everyone has to reinstall by hand.
- **A fixed extension ID**, which makes the next point possible.
- **Only Ironbrij people can install it**, if you publish it as Private (see step 6).

## 1. Before you start

1. Merge the `claude/clock-ball` branch and deploy SavyTime. The live site needs the
   Clock Ball page (the Google "Connect" button) and the punch nudges.
2. In `extension/savytime-clock-ball/manifest.json`, check `version`. Every upload
   needs a higher number than the last (1.1.0, then 1.1.1 or 1.2.0, and so on).
3. Remove `"http://localhost:5173/*"` from both places in `manifest.json` (the bridge
   `matches` list) and from `SAVYTIME` in `background.js`. It's only there for testing
   on your own computer, and reviewers question addresses they can't explain.
4. Make the store zip. The store needs `manifest.json` at the top of the zip, not
   inside a folder. In PowerShell, from the project folder:

   ```powershell
   Compress-Archive -Path extension\savytime-clock-ball\* -DestinationPath clock-ball-store.zip -Force
   ```

   (The download on the Clock Ball page, `npm run zip:extension`, keeps the folder
   inside the zip on purpose, because people unzip and load that folder.)

## 2. Developer account (one time)

1. Sign in to <https://chrome.google.com/webstore/devconsole> with the Google account
   that should own the extension. A company account (for example
   `it@ironbrij.com.au`) is better than a personal one, so it doesn't leave with a
   person.
2. Pay the one-time US$5 registration fee and accept the developer agreement.
3. Turn on 2-step verification for that account. The store requires it.
4. Under **Account**, fill in the publisher name (`Ironbrij`) and a contact email.

## 3. Upload

1. **New item** → choose `clock-ball-store.zip`.
2. The dashboard opens the item's draft. Work through the tabs below, then
   **Submit for review**.

## 4. Store listing tab (ready to paste)

- **Name:** SavyTime Clock Ball (comes from the manifest)
- **Summary** (132 characters max):
  `Your SavyTime shift timer on every website, with SavyTime itself one click away in the side panel.`
- **Category:** Productivity → Workflow & Planning
- **Language:** English
- **Description:**

  ```
  The SavyTime Clock Ball keeps your shift time in view while you work.

  Sign in with your Ironbrij SavyTime account and a small ball, with the Ironbrij logo,
  sits on every website while you're clocked in, counting your worked time.

  • Appears when you punch in and disappears when you punch out, from any device.
  • Breaks pause the count.
  • Keeps going if you close SavyTime or restart Chrome mid-shift.
  • Click the ball to open SavyTime beside the page: start or stop work, SOD & EOD,
    notifications and help & feedback, all the real SavyTime pages.
  • Drag it anywhere. Pick a size, the Ironbrij logo or a robot face, colours,
    blinking, jokes, or upload your own hat.

  For Ironbrij employees with a SavyTime account.
  ```

- **Icon:** `extension/savytime-clock-ball/icons/128.png`
- **Screenshots:** at least one, 1280×800 or 640×400. Good ones: the ball on a normal
  website, the popup with its options, and the side panel open with SavyTime.
- **Small promo tile:** 440×280 (required). The ball on a blue background with
  "SavyTime Clock Ball" is enough.

## 5. Privacy practices tab

**Single purpose:**

```
Shows an Ironbrij employee's current SavyTime shift time on screen and opens SavyTime in
the side panel.
```

**Permission justifications:**

| Permission | Justification to paste |
| --- | --- |
| `storage` | Saves the employee's sign-in, their current shift state and their ball settings (size, face, colour, position). |
| `alarms` | Checks the employee's punches once a minute so the ball appears and disappears with their real punch status. |
| `scripting` | When first installed, adds the ball to tabs that were already open, so the employee doesn't have to reload them. |
| `sidePanel` | Opens SavyTime in Chrome's side panel when the employee clicks the ball. |
| Host permission `<all_urls>` | The ball is shown on top of whatever website the employee is working on, so it must be able to appear on any page. It reads nothing from those pages. |

- **Remote code:** No. All code is in the package. (The side panel shows the SavyTime
  website in a frame, which isn't remote code.)
- **Data usage:** tick **Authentication information** (the SavyTime sign-in) and
  **Personally identifiable information** (the employee's email and name). Then tick
  all three certifications: data isn't sold, isn't used for unrelated purposes, and
  isn't used for credit decisions.
- **Privacy policy URL:** required. Add a page to SavyTime, for example
  `https://station.savykids.com/privacy`, that says at least:

  ```
  The SavyTime Clock Ball extension stores your SavyTime sign-in and your ball settings
  on your own computer, in the browser. It uses them only to read your own punches from
  SavyTime and show your shift time. It does not read the websites you visit, and sends
  nothing to anyone except SavyTime's own database (Google Firebase). Signing out of the
  extension, or removing it, deletes what it stored.
  ```

## 6. Distribution tab

- **Visibility:**
  - **Private** (best for "strict" access): only accounts in your Google Workspace
    domain can see or install it. This needs the developer account to belong to the
    Ironbrij Workspace, and each employee to sign in to Chrome with their Ironbrij
    Google account.
  - **Unlisted:** anyone with the link can install it, but it doesn't appear in
    search. The extension still refuses to sign in anyone who isn't a SavyTime
    employee.
  - Don't choose **Public**.
- **Regions:** all regions, or only the countries your staff work from.

## 7. Review

- Expect a few days. Because the ball needs `<all_urls>`, it may get the longer
  "in-depth review". Clear justifications (step 5) speed this up.
- If it's rejected, the email says which rule. Fix it, raise `version`, re-zip and
  resubmit.

## 8. After it's approved

1. Copy the store link (`https://chromewebstore.google.com/detail/...`).
2. Point the **Download extension** button on the Clock Ball page at it, replacing the
   zip, and shorten the install steps to "Add to Chrome" and "Sign in". Send me the link
   and I'll make that change.
3. Ask anyone who loaded the zip version to **Remove** it first, so they don't end up
   with two balls.
4. **If the extension can't sign in:** look in Google Cloud Console under APIs &
   Services → Credentials for the Firebase browser key. If it's restricted to certain
   websites, add `chrome-extension://<the store extension ID>/*` to its allowed
   referrers.

## Releasing an update later

1. Change the code in `extension/savytime-clock-ball/` and raise `version` in
   `manifest.json`.
2. Run `npm run zip:extension` (the download on the website) and make the store zip
   (step 1.4).
3. Dashboard → the item → **Package** → **Upload new package** → **Submit for
   review**. Employees get it automatically once approved.

Brave uses the Chrome Web Store, so Brave users install from the same link. Microsoft
Edge can too (it asks to "Allow extensions from other stores"), or you can publish
the same zip on Edge Add-ons later.
