// Loads the Google Maps JavaScript API once, with the dashboard's browser key (restricted to the
// dashboard's web address in Google Cloud). The service-area map draws Google's map under its
// Leaflet tools; without a key, or if Google rejects it, the map stays on OpenStreetMap.

let loading: Promise<void> | null = null;

export function loadGoogleMaps(key: string): Promise<void> {
  const w = window as any;
  if (w.google?.maps?.Map) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const callback = '__bobGoogleMapsReady';
    const fail = (message: string) => { clearTimeout(timer); loading = null; reject(new Error(message)); };
    const timer = setTimeout(() => fail('Google Maps did not load in time.'), 15_000);
    w[callback] = () => { clearTimeout(timer); resolve(); };
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=${callback}`;
    script.async = true;
    script.onerror = () => fail('Google Maps could not load.');
    document.head.appendChild(script);
  });
  return loading;
}

/** Google calls window.gm_authFailure when the key is wrong or not allowed on this web address. */
export function onGoogleMapsAuthFailure(handler: () => void) {
  (window as any).gm_authFailure = handler;
  return () => { if ((window as any).gm_authFailure === handler) delete (window as any).gm_authFailure; };
}
