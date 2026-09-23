/**
 * True when `current` is a newer major or minor version than `previous`, so the
 * note after an update only appears when there is something new to read about.
 * A first install (no previous version), a patch release and a downgrade are not.
 * Kept free of the vscode API so it can be unit tested.
 */
export function isFeatureUpdate(previous: string | undefined, current: string): boolean {
  if (!previous) return false;
  const [prevMajor, prevMinor] = previous.split('.').map(Number);
  const [major, minor] = current.split('.').map(Number);
  return major > prevMajor || (major === prevMajor && minor > prevMinor);
}
