/**
 * True when `current` is a newer major or minor version than `previous`, so the
 * note after an update only appears when there is something new to read about.
 * A first install (no previous version), a patch release and a downgrade are not.
 * Versions up to 1.16 did not store their version, so without one `usedBefore`
 * (state those versions stored) tells an update from a first install.
 * Kept free of the vscode API so it can be unit tested.
 */
export function isFeatureUpdate(previous: string | undefined, current: string, usedBefore = false): boolean {
  if (!previous) return usedBefore;
  const [prevMajor, prevMinor] = previous.split('.').map(Number);
  const [major, minor] = current.split('.').map(Number);
  return major > prevMajor || (major === prevMajor && minor > prevMinor);
}
