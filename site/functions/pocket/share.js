// Android's share sheet POSTs a shared file to /pocket/share, and Pocket's
// service worker takes it before it leaves the phone. A POST that reaches
// the site means the worker was not installed yet; nothing is read or kept
// here — the phone is sent back to the app, which says to share it again.
// The same answer the claw gives on its tailnet name (src/pocket.ts).
export function onRequestPost() {
  return new Response(null, { status: 303, headers: { Location: "/pocket/#share-unavailable", "Cache-Control": "no-store" } });
}
