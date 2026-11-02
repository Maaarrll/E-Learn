# Running ALLEARN in the classroom (no internet)

The teacher's laptop runs ALLEARN. Students join the laptop's Wi-Fi network and open it in
their browser. No internet and no mobile data are used.

## What you need
- A Windows laptop (stays plugged in during class).
- A Wi-Fi router. It does **not** need internet. The laptop and students' phones all connect to it.
  (Windows "Mobile hotspot" works for a quick test but only allows 8 devices.)

## One-time setup
Easiest: the **portable package** `ALLEARN-Portable.zip` (Node.js and everything else inside, no installing,
no internet). Follow **HOW TO SET UP ALLEARN.html**: unzip to `C:\`, double-click **Start ALLEARN**, allow the firewall.

From the source code instead: install Node.js LTS, copy the folder (not into OneDrive), right-click
**Setup ALLEARN.bat** → Run as administrator (needs internet once), then double-click **Start ALLEARN**.

The first start asks for the teacher's name, a login ID and a password, and puts a **Start ALLEARN** icon on the desktop.

## Before the first class
- [ ] In Admin → Instructors, add a **second main admin** (you), so a forgotten password can be reset.
- [ ] Add every student's LRN (Admin → Allowed LRNs).
- [ ] Upload the videos (Admin → Content → Videos). Phones play 480p fine and it keeps the Wi-Fi fast.
- [ ] Check the laptop's date and time are right (streaks and quiz deadlines use them).
- [ ] Power settings: **Sleep: Never** when plugged in.
- [ ] Dry run: a few phones join, sign up, watch a video and take a quiz.
- [ ] Print **Teacher Card.html** and keep it next to the laptop.

## Every class (teacher)
1. Connect the laptop to the classroom Wi-Fi.
2. Double-click **Start ALLEARN** on the desktop. A page opens with the address and a QR code: show it on the projector.
3. Open the Admin page and open the class.
4. Students: connect to the Wi-Fi, turn off mobile data, scan the QR code.
5. After class: close the ALLEARN window.

**If something goes wrong**
- A phone can't open the page: check it's on the classroom Wi-Fi (not mobile data), then type the address instead of scanning.
- Nobody can open it: close the ALLEARN window and double-click **Start ALLEARN** again.
- The window shows an error: take a photo of it and send it to support.

## Updating ALLEARN (support person)
1. Close ALLEARN and copy `classroom-data` to a USB drive first.
2. Replace every file and folder in the ALLEARN folder with the new version, **except `classroom-data`** (never delete it).
3. Right-click **Setup ALLEARN.bat** → Run as administrator (needs internet), then start ALLEARN.

## Videos
Admin page → Content → Videos → **Add video**, then pick an MP4 file from the laptop.

## Backups
Each time ALLEARN starts, it copies the database to `classroom-data\backups\<date>` (the last 7 are kept).
Now and then, copy the whole `classroom-data` folder to a USB drive. It holds all accounts, progress, videos and profile photos.

To restore: close ALLEARN, rename `classroom-data\db` to `db-old`, copy a backup folder in its place
and rename it to `db`, then start ALLEARN.

## Not available offline
- Email reminders
