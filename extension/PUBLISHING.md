# Publishing the SavyTime Clock Ball on the Chrome Web Store

Everything to copy and paste is in the boxes below. Do the steps in order.

## What it is (one line)

> SavyTime Clock Ball, by Ironbrij: your SavyTime shift timer on every website, with
> SavyTime itself one click away.

**Why publish it:** employees install it with one click, with no Developer mode. Every
update reaches everyone automatically, and the extension gets one fixed ID.

## Step 0: before you upload (once)

1. **Merge and deploy the `claude/clock-ball` branch.** "Continue with Google", the
   popup's Start/Stop Work card and the privacy page
   (`https://station.savykids.com/privacy`) all live in SavyTime, so the live site must
   have them before Google's reviewers try the extension.
2. **Check the privacy page opens** at `https://station.savykids.com/privacy` without
   signing in.
3. Recommended: **create the Firestore indexes** from `firestore.indexes.json` on the
   live project (`ironbrij-timestation`). This lowers the extension's database reads
   about tenfold.

## Step 1: the zip

The upload file must have `manifest.json` at the top of the zip, not inside a folder,
and use `/` in its paths. In Git Bash, from the project folder:

```bash
cd extension/savytime-clock-ball && /c/Windows/System32/tar.exe -a -cf "../../SavyTime-Clock-Ball-store.zip" * && cd ../..
```

(Don't use PowerShell's `Compress-Archive`: it writes `icons\128.png` with a backslash,
which the store rejects.)

For version 1.2.0 it's already made: **`D:\time station\SavyTime-Clock-Ball-store.zip`**.
The images are in **`D:\time station\SavyTime-Clock-Ball-store-images\`**.

## Step 2: developer account (one time)

1. Go to <https://chrome.google.com/webstore/devconsole> and sign in with the Google
   account that should own the extension. A shared Ironbrij account is better than a
   personal one, so it stays with the company.
2. Accept the agreement and pay the **one-time US$5** fee.
3. Turn on **2-Step Verification** on that Google account (the store requires it).
4. **Account** tab: publisher name `Ironbrij`, a contact email, and verify that email
   (Google sends a link). When asked whether you're a **trader** (EU law): for a free
   tool for your own staff, choose **non-trader**.

## Step 3: upload

**Items → New item →** choose `SavyTime-Clock-Ball-store.zip`.

## Step 4: Store listing tab

| Field | Paste this |
| --- | --- |
| Description | *(the block below)* |
| Category | Productivity → **Workflow & Planning** |
| Language | English |
| Store icon (128×128) | `icons/128.png` from the extension folder |
| Screenshots (1280×800) | `1-ball-on-any-page.png`, `2-sign-in.png`, `3-customise.png` |
| Small promo tile (440×280) | `promo-tile-440x280.png` |
| Official URL | `https://station.savykids.com` (or leave empty) |
| Support URL | `https://station.savykids.com/app/automation` |

The name and the short summary come from the extension itself ("SavyTime Clock Ball";
"Your SavyTime shift timer on every website, with SavyTime itself one click away in the
side panel.").

**Description:**

```
SavyTime Clock Ball, by Ironbrij, keeps your shift time in view while you work.

Sign in with your Ironbrij SavyTime account (Continue with Google) and a small ball with
the Ironbrij logo sits on every website while you're clocked in, counting your worked time.

• Appears when you punch in and disappears when you punch out, from any device.
• Breaks pause the count; your time also shows on the toolbar icon.
• Keeps going if you close SavyTime or reopen the browser mid-shift.
• Start work, stop work and take breaks straight from the extension's popup.
• Click the ball to open SavyTime beside the page: SOD & EOD, notifications,
  help & feedback.
• Drag it anywhere. Pick a size, the Ironbrij logo or a robot face, colours, blinking,
  jokes, or upload your own hat.

For Ironbrij staff with a SavyTime account. It only reads your own punches, and reads
nothing from the websites you visit.
```

## Step 5: Privacy practices tab

**Single purpose:**

```
Shows an Ironbrij employee's current SavyTime shift time on screen, and opens SavyTime so they can start and stop work.
```

**Permission justifications:**

| Permission | Paste this |
| --- | --- |
| `storage` | Saves the employee's SavyTime sign-in, their current shift state and their ball settings (size, face, colour, position, hat) in the browser. |
| `alarms` | Checks the employee's own punches once a minute so the ball appears and disappears with their real punch status. |
| `scripting` | When the extension is first installed or updated, adds the ball to tabs that were already open, so the employee doesn't have to reload them. |
| `sidePanel` | Opens SavyTime in the browser's side panel when the employee clicks the ball. |
| Host permission (all sites) | The shift timer is drawn on top of whatever website the employee is working on, so it must be able to appear on any page. It reads nothing from those pages and sends nothing about them anywhere. |

**Remote code:** choose **No, I am not using remote code.**

**Data usage:** tick
- **Personally identifiable information** (name and email of the signed-in employee)
- **Authentication information** (their SavyTime sign-in)

Then tick all three statements: data isn't sold to third parties, isn't used for
unrelated purposes, and isn't used for creditworthiness or lending.

**Privacy policy URL:**

```
https://station.savykids.com/privacy
```

## Step 6: Distribution tab

- **Visibility:** **Unlisted**, recommended. Anyone with the link can install it, but it
  doesn't show up in store search. Only SavyTime employees can sign in, so outsiders
  can't use it anyway.
  - *Public* also works, but anyone can find it and the review is stricter.
  - *Private* (Google Workspace only) works only if every employee signs in to Chrome
    with an Ironbrij Google Workspace account. Gmail addresses can't use it.
- **Regions:** All regions.
- **Pricing:** Free.

Then **Submit for review**.

## Step 7: the review (how many times?)

- **Your account:** verified once (the US$5 fee, email verification, 2-Step
  Verification).
- **The extension:** reviewed **once per version you submit.** The first review usually
  takes **a few hours to 3 days**. Because the ball needs access to all sites, it can
  get an "in-depth review", which can take up to about 2 weeks. You get an email either
  way.
- **Every later update** (a new version number) is reviewed again, usually faster.
- **If it's rejected,** the email names the rule. Fix it, raise `version` in
  `manifest.json`, re-zip (step 1) and resubmit.

## Step 8: after approval

1. Copy the store link (`https://chromewebstore.google.com/detail/...`).
2. Send it to Claude (or a developer) to point the **Download extension** button on the
   Clock Ball page at it, so the page says "Add to Chrome" instead of the zip steps.
3. Tell employees: open the link, click **Add to Chrome** (Brave works too), then
   **Continue with Google**.
4. Anyone who loaded the zip version should **Remove** it first, so they don't get two
   balls.

## Releasing an update later

1. Change the code in `extension/savytime-clock-ball/` and raise `version` in
   `manifest.json` (1.2.0 → 1.2.1 or 1.3.0).
2. Make the zip (step 1).
3. Developer dashboard → the item → **Package → Upload new package → Submit for
   review**. Everyone gets it automatically once it's approved.

## Trying changes on a local copy

The published extension only talks to `https://station.savykids.com`. To try it
against SavyTime on your own computer, add `"http://localhost:5173/*"` to the bridge's
`matches` in `manifest.json` and to `SAVYTIME` in `background.js`. Load that folder
unpacked, and remove the address again before making a store zip.
