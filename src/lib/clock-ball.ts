/**
 * The SavyTime Clock Ball browser extension. It signs in on its own and reads
 * the employee's punches from the database itself; these pages only nudge it
 * when a punch is made and let a Google sign-in connect it.
 */

/** Page → extension messages carry this as `source`. */
export const CLOCK_BALL_MESSAGE = "savytime-clock-ball";
/** The extension's replies carry this as `source`. */
export const CLOCK_BALL_REPLY = "savytime-clock-ball-extension";
/** The live listing on the Chrome Web Store, where everyone installs it from. */
export const CLOCK_BALL_STORE =
  "https://chromewebstore.google.com/detail/iolgbkgjdineoalolodapkidkjjgbeof";
