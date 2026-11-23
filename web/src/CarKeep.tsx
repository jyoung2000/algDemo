import { useState } from 'react';
import { carInstall, openCarSettings, type CarVerdict } from './engine/car-install';
import './car-keep.css';

/**
 * CAR-KEEP-001 (owner: "the play certificate only works once then when I turn off and on my car the
 * app disappears, make a way that android auto will permanently recognize the app without having my
 * computer nearby"): the Settings "Android Auto" card.
 *
 * It says how this copy of jPlay was installed and gives the phone-only steps that keep it in the
 * car: Android Auto's own "Unknown sources" developer switch. jPlay cannot read or change that
 * switch, so the card explains and opens Android Auto's settings; it never claims the switch's
 * state. The rule behind the wording is inferred from public analysis of Android Auto 17.9
 * (docs/android-auto-keep.md), which is why the wording says "may" and "should".
 *
 * Android only: where the bridge has no carInstall() (Windows, a browser, older APKs) it renders
 * nothing.
 */

/** One line per verdict: how jPlay got onto the phone and what that means in the car. */
export const INSTALL_LINE: Record<CarVerdict, string> = {
  PLAY: 'Google Play installed jPlay on this phone. Android Auto keeps apps that Google Play installed.',
  PLAY_NAME_ONLY:
    "jPlay was installed from a computer in Google Play's name. Android Auto may hide it again once it checks with Google Play.",
  SIDELOADED: 'jPlay was installed directly, not by Google Play. Android Auto hides apps like this unless its "Unknown sources" switch is on.',
};

export const STEPS: readonly string[] = [
  'Open Android Auto settings and scroll to the bottom.',
  'Tap "Version" ten times, then accept developer mode.',
  'Open the three-dot menu and choose "Developer settings".',
  'Turn on "Unknown sources".',
  'Open "Customize launcher" and make sure jPlay is ticked.',
  'Reconnect the car.',
];

export const OPEN_FAILED = "Could not open Android Auto settings. Search for Android Auto in your phone's Settings app.";

export function CarKeep() {
  // Read once: the install source cannot change while the app is running.
  const [info] = useState(carInstall);
  const [failed, setFailed] = useState(false);
  if (!info) return null;

  const { installed, version } = info.androidAuto;
  return (
    <section className="card carkeep" aria-labelledby="carkeep-h">
      <h2 id="carkeep-h">Android Auto</h2>
      <p className="carkeep__line" data-verdict={info.verdict}>
        {INSTALL_LINE[info.verdict]}
      </p>
      {installed ? (
        version && <p className="note">Android Auto on this phone: version {version}.</p>
      ) : (
        <p className="note note--bad">Android Auto is not installed on this phone. Install it from Google Play first.</p>
      )}

      <p className="carkeep__lead">
        {info.verdict === 'PLAY' ? 'If jPlay ever goes missing from the car, do this once on the phone:' : 'To keep jPlay in the car without a computer, do this once on the phone:'}
      </p>
      <ol className="carkeep__steps">
        {STEPS.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>

      <div className="carkeep__actions">
        <button className="push push--default carkeep__open" type="button" onClick={() => setFailed(!openCarSettings())}>
          Open Android Auto settings
        </button>
      </div>
      {failed && (
        <p className="note note--bad" role="alert">
          {OPEN_FAILED}
        </p>
      )}

      <p className="note">jPlay cannot read or change that switch itself, so it cannot tell you whether it is on.</p>
      <p className="note">The other lasting way is to install jPlay through a Google Play internal testing track, so Google Play installs and updates it.</p>
    </section>
  );
}
