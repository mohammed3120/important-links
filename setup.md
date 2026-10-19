# Important Links: Google Drive sync setup (Google Cloud, step by step)

This guide is only for the **Google sign-in** sync method. It takes about 10 to 15 minutes and is done once.

> **Don't want Google Cloud?** Use the **Synced folder** method instead (Settings → Sync → Method → Synced folder). It needs no Google Cloud project at all.

Everything you create here is yours. Nothing is shared with anyone else. The extension never stores anything in the project files; you enter the values in the extension's Settings.

---

## What you will have at the end

| Item | Where you get it | Where you put it |
|---|---|---|
| Google Cloud project | Google Cloud console | (nothing to enter) |
| Google Drive API enabled | Google Cloud console | (nothing to enter) |
| OAuth consent screen with you as test user | Google Cloud console | (nothing to enter) |
| **Client ID** | Google Cloud console → Credentials | Extension → Settings → Google Cloud client |
| **Client secret** | Google Cloud console → Credentials | Extension → Settings → Google Cloud client |
| **Redirect URI** | Extension → Settings → Google Cloud client | Google Cloud console → Credentials |

The Google Cloud console changes its layout from time to time. If a menu name differs slightly, look for the same words in the left menu or use the search bar at the top.

---

## Part 0: Before you start

1. Use **Google Chrome**, signed in to the Google account you want to sync with (for example `you@gmail.com`).
2. Install the extension: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the `important-links` folder.
3. On that page, confirm the extension's **ID** is `opcgpedigbcmnndabghghifopdggpbkg`. If it is different, note the one you see; you will use the address that the extension shows in Part 5.
4. Open the extension popup → click the gear icon (**Settings**) → **Sync** → set **Method** to **Google sign-in**. Open the **Google Cloud client** section. Keep this open; you will come back to it.

---

## Part 1: Create the Google Cloud project

1. Go to https://console.cloud.google.com and sign in.
2. If this is your first time, accept the terms of service when asked.
3. At the top left, click the **project selector** (it shows a project name or "Select a project").
4. In the window that opens, click **New project**.
5. Fill in:
   - **Project name:** `Important Links`
   - **Organization / Location:** leave the default (usually "No organization")
6. Click **Create**. Wait a few seconds for the notification that the project is ready.
7. Click the project selector again and **select the new project** `Important Links`. Check that its name is now shown at the top of the page. Every step below must be done with this project selected.

You do not need to enable billing. Google Drive API usage for personal use is free.

---

## Part 2: Enable the Google Drive API

1. Open the left menu (☰) → **APIs & Services** → **Library**.
2. In the search box type `Google Drive API`.
3. Click **Google Drive API** in the results (not "Drive Activity" or "Drive Labels").
4. Click **Enable** and wait until the page shows the API overview.

If you skip this step, the extension will show "The Google Drive API isn't enabled for your Google Cloud project".

---

## Part 3: Configure the OAuth consent screen

Google calls this the "OAuth consent screen" in older consoles and **Google Auth Platform** in newer ones. The settings are the same.

1. Open the left menu → **APIs & Services** → **OAuth consent screen**. In newer consoles you may see **Google Auth Platform** instead, with a "Get started" button. Click it if shown.
2. **App information** (Branding):
   - **App name:** `Important Links`
   - **User support email:** choose your email
3. **Audience / User type:** choose **External**, then continue.
4. **Contact information:** enter your email address.
5. Accept the policy checkbox and click **Create** (or **Continue / Save**).

### 3a. Add the permission (scope)

1. Go to **Data Access** (older console: the **Scopes** step, "Add or remove scopes").
2. Click **Add or remove scopes**.
3. In the filter or in "Manually add scopes", enter:

   `https://www.googleapis.com/auth/drive`

4. Click **Add to table** (if shown), then **Update**, then **Save**.

   If you cannot find it in the list, paste the line above into "Manually add scopes". Google marks this scope as **restricted**; that is expected. The extension needs it to let you browse and pick an existing Drive folder.

### 3b. Add yourself as a test user (required)

While the app is in **Testing** mode, only listed accounts may sign in. Without this you get **Error 403: access_denied**.

1. Go to **Audience** (older console: **Test users** on the consent screen page).
2. Under **Test users**, click **Add users**.
3. Enter every Google account you will sign in with, for example `you@gmail.com`. Add one per line.
4. Click **Save**.

---

## Part 4: Create the OAuth client (Web application)

The client type matters. It **must be "Web application"**. A "Chrome Extension" or "Desktop" client will not work for this method.

1. Open the left menu → **APIs & Services** → **Credentials** (or **Google Auth Platform → Clients**).
2. Click **Create credentials** → **OAuth client ID** (or **Create client**).
3. **Application type:** select **Web application**.
4. **Name:** `Important Links web client`.
5. Leave **Authorized JavaScript origins** empty.
6. Under **Authorized redirect URIs**, click **Add URI** and paste exactly:

   `https://opcgpedigbcmnndabghghifopdggpbkg.chromiumapp.org/`

   Rules for this value:
   - It must match character for character, **including the final `/`**.
   - No spaces before or after.
   - Put it under **redirect URIs**, not under JavaScript origins.
   - If your extension ID is different (Part 0, step 3), use the exact address shown in the extension's Google Cloud client section. Click its **Copy** button and paste.
7. Click **Create**.
8. A window shows your **Client ID** and **Client secret**.
   - Client ID looks like `123456789012-abcdefg.apps.googleusercontent.com`
   - Client secret looks like `GOCSPX-xxxxxxxxxxxxxxxx`
9. Copy both. You can also click **Download JSON** as a backup. You can view them again later by opening the client in Credentials.

Keep the client secret private. Do not post it publicly or commit it to a public repository.

---

## Part 5: Enter the client in the extension (no file editing)

1. In the extension: **Settings → Sync → Method: Google sign-in → Google Cloud client**.
2. Paste the **Client ID**.
3. Paste the **Client secret**. Use **Show** to check it was pasted correctly.
4. **Passphrase (optional but recommended on shared computers):**
   - Enter at least 8 characters to encrypt the secret and your Google login on this computer.
   - After you restart the browser you will unlock once with this passphrase before syncing resumes.
   - If you forget it, click **Remove** and enter the client again. Your links and Drive file are not affected.
5. Click **Save client**.
6. Confirm the **redirect URI** shown in the panel is identical to the one you added in Part 4. If it is not, go back and fix the Google Cloud client.

---

## Part 6: Connect and choose the Drive folder

1. Click **Connect Google Drive**. A full page opens (sign-in cannot run inside the small popup).
2. Choose your Google account.
3. Google may show **"Google hasn't verified this app"**. This is normal for your own app. Click **Advanced** → **Go to Important Links (unsafe)**.
4. Review the permission and click **Continue / Allow**.
5. Back in the extension, click **Choose…** next to **Drive folder**, browse to a folder (or create one, for example `ImportantLinks`), and click **Use "…"**.
6. A preview shows what will be merged. Click **Merge and sync** (or **Create and sync**). You can click **Save backup first** if you want a copy of your links.

Sync is now active. By default it runs on open, a few seconds after changes, and every 15 minutes.

### On a second computer

1. Install the extension the same way (same `manifest.json`, so the same extension ID).
2. Repeat Part 5 (enter the same client ID and secret) and Part 6.
3. Choose the **same Drive folder and the same sync file name** (default `important-links-sync.json`).

You do **not** need to add the redirect URI again as long as the extension ID is the same.

---

## Part 7: Optional: stop the weekly reconnect

While the app is in **Testing** mode, Google expires the login after **7 days**, and you click **Reconnect Google Drive** about once a week.

To stop that for a personal app:

1. Open **OAuth consent screen** (or **Google Auth Platform → Audience**).
2. Under **Publishing status**, click **Publish app** → **Confirm**.
3. You do not need to submit it for verification if only you use it. Google will show the "unverified app" warning each time you sign in (use **Advanced → Go to …**), but the login stays valid.

Do this only for personal use, because the app uses a restricted scope (`drive`).

---

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| **redirect_uri_mismatch** or "doesn't comply with Google's OAuth 2.0 policy… register the redirect URI" | The redirect address is not registered on the client, or has a typo | Part 4, step 6. Copy the address from the extension and paste it under **Authorized redirect URIs**. Save and wait a few minutes. |
| No "Authorized redirect URIs" field at all | Wrong client type | Create a new **Web application** client (Part 4). |
| **Error 403: access_denied** / "has not completed the Google verification process" | Your account is not a test user | Part 3b. Add your account under Test users. |
| "Google rejected the client ID or secret" | Typo, or secret from another client | Re-copy both from Credentials. Use **Remove**, then **Save client** again. |
| "The Google Drive API isn't enabled…" | Part 2 skipped, or wrong project | Enable the Drive API in the same project. |
| "Locked" status | Passphrase set and the browser was restarted | Enter the passphrase under Google Cloud client → **Unlock**. |
| "Authentication required" / must reconnect weekly | Testing-mode token expired (7 days) or access was revoked | Click **Reconnect Google Drive**, or see Part 7. |
| "Google didn't grant long-lived access" | An older grant exists without a refresh token | Open https://myaccount.google.com/permissions, remove **Important Links**, then connect again. |
| Still failing after changes in the console | Google needs a few minutes to apply changes | Wait 5 to 10 minutes and retry. |

---

## Security notes

- The **client ID, client secret and login token** are stored only in this browser profile's extension storage, in a record separate from your links. They are never exported, synced or logged, and are sent only to Google.
- Without a passphrase they are stored as plain text, like any extension setting. Anyone with access to your computer account and browser profile could read them. Use a passphrase on shared computers.
- Clicking **Disconnect** revokes the extension's access at Google and deletes the saved login. **Remove** deletes the saved client ID and secret.
- You can review or remove the extension's access at any time: https://myaccount.google.com/permissions
- If your client secret is ever exposed, open the client in Credentials, add a new secret, delete the old one, then **Remove** and re-enter the client in the extension.
