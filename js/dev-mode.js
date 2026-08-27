// Developer-only safety bypass. This is intentionally opt-in per page load.
export function isDeveloperMode(search = window.location.search) {
  return new URLSearchParams(search).get('dev') === 'true';
}
