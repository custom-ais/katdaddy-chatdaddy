// West Valley service area: any 853xx ZIP, plus west Phoenix 850xx ZIPs and West Valley cities.
const WEST_PHOENIX_ZIPS = new Set([
  '85009', '85017', '85019', '85029', '85031', '85033', '85035', '85037', '85043', '85051', '85053',
]);

const WEST_VALLEY_CITIES = [
  'surprise', 'goodyear', 'buckeye', 'peoria', 'avondale', 'glendale', 'sun city', 'sun city west',
  'el mirage', 'litchfield park', 'tolleson', 'waddell', 'youngtown', 'laveen', 'verrado',
];

export function inServiceArea({ zip = '', city = '' }) {
  const z = String(zip).trim().slice(0, 5);
  if (/^853\d\d$/.test(z)) return true;
  if (WEST_PHOENIX_ZIPS.has(z)) return true;
  const c = String(city).trim().toLowerCase();
  return WEST_VALLEY_CITIES.includes(c);
}
