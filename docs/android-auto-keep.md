# Keeping jPlay in Android Auto without a computer

CAR-KEEP-001. Owner report: "the play certificate only works once then when I turn off and on my car
the app disappears, make a way that android auto will permanently recognize the app without having
my computer nearby all the time".

Short answer, two ways, neither needing the computer again:

- **On the phone, free, five minutes:** turn on **Unknown sources** in Android Auto's developer
  settings, once. jPlay's Settings has an **Android Auto** card with the steps and a button that
  opens Android Auto's settings.
- **For good, through Google Play:** install jPlay from your own Google Play internal testing track
  ("The Google Play way"). This is the only thing that makes Google Play itself recognise jPlay.

## Measured on the owner's phone, 23 November 2026

Galaxy S23 Ultra, Android Auto 18.0, jPlay 0.20.14 then 0.20.15, projected from the phone to Google's
desktop head unit set to identify as an ordinary car (not as Google's developer head unit).

| Unknown sources | How jPlay was installed | In the car? |
| --- | --- | --- |
| On (it was already on) | From the computer, with Google Play's name | Yes |
| On | From the computer, plain, no installer name | Yes |
| **Off** | From the computer, with Google Play's name | **No**: `Package DENIED; failed all other checks [com.nowplaying.discovery]` |

- **The switch decides. Google Play's name on the install does nothing.** With the switch off the
  "Play" install was refused; with it on, a plain install was accepted.
- Turning the switch back on does not bring jPlay back until the car reconnects.
- With the switch on, jPlay stayed through: Android Auto restarted, the car reconnected, jPlay
  force-stopped, and a connect with the phone's screen off. Seven checks on 0.20.15, listed every time.
- jPlay vanishing **with the switch on** was not reproduced. The only way it was made to vanish was
  the switch being off.
- Not tested: a real car, wireless Android Auto, a phone restart, several days passing, an Android
  Auto update, and an update installed by tapping the APK on the phone (the plain computer install is
  the nearest thing tested).

## How sure the rest is

- **[Inferred]** means: read from a public decompile of Android Auto's app validator, not measured.
- **[Measured]** means: observed in this work; the section above is the phone, anything else the emulator.

## Why jPlay disappears

How Android Auto decides, in order **[Inferred: two public readings of Android Auto's own code,
17.7 (Fermata issue 846) and 17.9 (third-ear); not measured on your phone, and 18.0 may differ]**:

1. Who installed it. On Android 11 and later Android Auto goes by the package that **started** the
   install. `adb install -i com.android.vending` sets the installer *name* only; the package that
   started it is still the computer (`com.android.shell`). So that install does not count as a
   Google Play install, whatever the name says.
2. It is allowed at once if Google Play vouches for it (a Google account on the phone owns it in
   its Play library), or if this exact version was already accepted earlier (a remembered answer).
3. Otherwise it is allowed only when Android Auto's developer switch **Unknown sources** is on, and
   only for some kinds of app. A music app (which jPlay is) is one of those kinds.
4. Otherwise: `Package DENIED; failed all other checks`.

What was measured:

- **[Measured, your phone, 2026-11-23, jPlay 0.20.14, Android Auto 18.0]** the phone records
  `installerPackageName=com.android.vending` and `initiatingPackageName=com.android.shell`: Google
  Play's name only, started by the computer. Exactly the case in step 1.
- **[Not measured]** which check dropped jPlay after your car restarted. If it happens again, look
  at the switch first: if it is off, that is the cause.
- **[Earlier work notes, emulator]** with the switch off, Android Auto logged `Package DENIED; failed
  all other checks [com.nowplaying.discovery]`. The emulator's Google Play check never runs, so it
  cannot show what a real phone does.
- The same notes describe jPlay vanishing "even with Unknown sources on". If the switch is already on
  in your Android Auto and jPlay still goes, the steps below are not the fix: see "If jPlay still
  disappears with Unknown sources on", and "The Google Play way".
- jPlay does not try to reinstall itself or pretend to be Google Play. A normal app cannot set its
  own installer, and faking it is what stops working.

## The fix, on the phone only

1. Open jPlay, go to **Settings**, find the **Android Auto** card and tap
   **Open Android Auto settings**. (Or: phone Settings, search for "Android Auto".)
2. Scroll to the bottom.
3. Tap **Version** ten times, then accept developer mode.
4. Open the three-dot menu (top right) and choose **Developer settings**.
5. Turn on **Unknown sources**.
6. Go back, open **Customize launcher** and make sure **jPlay** is ticked.
7. Reconnect the car (unplug and plug in, or turn the car off and on).

The computer is not needed for jPlay to stay in the car, and the `-i com.android.vending` part of
the install command is not needed while Unknown sources is on **[Measured, see the table]**. A new
version can be installed by opening its APK on the phone **[Inferred: the same check applies; the
tap install itself was not tested]**.

## How to check it worked

1. With the phone connected, jPlay is in the car's app launcher.
2. Turn the car fully off, wait until the screen is dark, turn it on and reconnect. jPlay is still
   there. Do this twice, on different days if you can: the old failure showed up only after a restart.
3. On the phone, Android Auto settings, **Customize launcher** still lists jPlay with a tick.

The Android Auto card in jPlay tells you how jPlay was installed. It **cannot** tell you whether
Unknown sources is on: Android Auto does not let other apps read or change that switch.

| The card says | Meaning |
| --- | --- |
| Google Play installed jPlay | Android Auto keeps it; no switch needed. **[Inferred]** |
| Installed from a computer in Google Play's name | The `adb -i` install. Do the steps above. |
| Installed directly, not by Google Play | A plain adb or file install. Do the steps above. |

## What resets it

All **[Inferred]**; none of these was measured.

- Clearing Android Auto's storage or data, or uninstalling and reinstalling Android Auto: the switch
  lives in Android Auto's own data, so do the steps again.
- A factory reset, or moving to a new phone.
- Turning off developer mode in Android Auto.
- Possibly a large Android Auto update. If jPlay vanishes after one, check the switch first.
- Updating or reinstalling jPlay should **not** reset it. If jPlay is missing after an update, open
  **Customize launcher** and tick it again.

## If jPlay still disappears with Unknown sources on

Then the switch is not what your phone's Android Auto goes by, and the one route known to last is
"The Google Play way" below. Before reinstalling anything, connect the phone to the
computer once **while jPlay is missing** and run:

    adb shell dumpsys package com.nowplaying.discovery | grep -E "installerPackageName|initiatingPackageName"
    adb logcat -d -b all | grep CAR.VALIDATOR

Those two answers say which check dropped it. They have not been captured yet, because every visit
so far reinstalled jPlay first.

## The Google Play way: no switch, no computer

"Signed by the Play Store" is not something an APK can be given afterwards. Android Auto asks the
Play Store app on the phone whether a Google account on that phone **owns jPlay in its Play library,
with the same signing certificate** **[Inferred, from the public reading of Android Auto 17.7 in
Fermata issue 846]**. Only an install that Google Play itself made creates that record. No install
command, installer app or in-app update can write it, which is why the computer install has to be
repeated.

So the one way to be recognised by Google Play for good is to put jPlay in your own Play library:

1. Open a Google Play Console developer account (a one-time fee, your own Google account).
2. Create an app with the package name `com.nowplaying.discovery`.
3. Under **App integrity > Play app signing**, choose **use your own key** and upload jPlay's
   existing signing key (`~/airwave-signing`). This matters: with the same certificate, the Play
   install updates the jPlay already on the phone and keeps its data. With a new Google-made key
   the phone would need jPlay uninstalled first, which deletes its data.
4. Create an **Internal testing** release and upload `jplay-<version>.aab` from the delivery folder.
5. Add your own Google account as a tester, open the opt-in link on the phone, and install or
   update jPlay from Google Play.

After that Google Play is the installer, updates arrive through Google Play, and the car needs
neither the developer switch nor the computer.

Not checked, and worth knowing before paying the fee:

- Nothing was uploaded: this needs your Google account, so none of it was tried.
- jPlay downloads full songs from sources such as YouTube. Internal testing is reviewed lightly, but
  Google can still refuse or remove an app that breaks its policies. A wider release would be refused.
- Google Play limits how large the download for one device may be (its help pages give 200 MB in one
  place and 500 MB in another) and works the figure out itself when the bundle is uploaded. The
  bundle's own file size is in the delivery README.

## What other people report works on the phone alone

From public reports about other sideloaded car apps (navigation apps, which Android Auto treats more
strictly than a music app): an installer app such as King Installer, with **Unknown sources** on,
kept the app in several real cars. It was **not tried here**, and what install record it leaves on
the phone was not examined, so nothing is claimed for it.

## For developers

- `CarInstall.kt` (pure, tested by `CarInstallTest`): `PLAY`, `PLAY_NAME_ONLY` or `SIDELOADED` from
  the installer and initiating package names.
- `MainActivity.kt`, `AirwaveNative.carInstall()` and `AirwaveNative.openCarSettings()`.
- `web/src/engine/car-install.ts`, `web/src/CarKeep.tsx`, `web/src/car-keep.css`.
- **[Measured, emulator only]** With Android Auto on `emulator-5562`, both
  `com.google.android.projection.gearhead.SETTINGS` and
  `android.intent.action.APPLICATION_PREFERENCES` (package-scoped) resolve to the exported
  `.companion.settings.DefaultSettingsActivity`; Android Auto has no launcher activity there;
  `android.settings.APPLICATION_DETAILS_SETTINGS` resolves to the system app-info page. Resolution
  was checked with `cmd package resolve-activity`; the activity was not started.
