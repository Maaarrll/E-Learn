# Running ALLEARN in the classroom (no internet)

The teacher's laptop runs ALLEARN. Students join the laptop's Wi-Fi network and open it in
their browser. No internet and no mobile data are used.

## What you need
- A Windows laptop (stays plugged in during class).
- A Wi-Fi router. It does **not** need internet. The laptop and students' phones all connect to it.
  (Windows "Mobile hotspot" works for a quick test but only allows 8 devices.)

## One-time setup (needs internet once)
1. Install **Node.js LTS** from https://nodejs.org.
2. Copy the whole ALLEARN folder to the laptop (for example `C:\ALLEARN`). Don't use a OneDrive folder.
3. Right-click **Setup ALLEARN.bat** and choose **Run as administrator**.
   It installs ALLEARN, puts a **Start ALLEARN** icon on the desktop and lets phones through the firewall.
4. Double-click **Start ALLEARN**. The first time, it asks for the teacher's name, a login ID and a password.

## Every class (teacher)
1. Connect the laptop to the classroom Wi-Fi.
2. Double-click **Start ALLEARN** on the desktop. A page opens with the address and a QR code: show it on the projector.
3. Open the Admin page and open the class.
4. Students: connect to the Wi-Fi, turn off mobile data, scan the QR code.
5. After class: close the ALLEARN window.

In the laptop's power settings, set **Sleep: Never** while plugged in, so students aren't cut off mid-class.

## Videos
Admin page → Content → Videos → **Add video**, then pick an MP4 file from the laptop.

## Backups
Each time ALLEARN starts, it copies the database to `classroom-data\backups\<date>` (the last 7 are kept).
Now and then, copy the whole `classroom-data` folder to a USB drive. It holds all accounts, progress and videos.

To restore: close ALLEARN, rename `classroom-data\db` to `db-old`, copy a backup folder in its place
and rename it to `db`, then start ALLEARN.

## Not available offline
- Profile photo uploads
- Email reminders
