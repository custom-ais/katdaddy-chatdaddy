// DVS West Valley service coverage, from the office's coverage list (Oct 30 2026).
// The rule: ZIPs on the list that start with 852 get a travel charge, 851 is a no-go, and the
// rest of the list (850 Phoenix, 853 West Valley) is the service area. Anything not on the list
// isn't served. Saved settings can change the lists; this is the starting point and what
// Settings → Service area restores.

export const COVERAGE_VERSION = 2;

/** In the service area: books normally. */
export const COVERAGE_IN = ["85003", "85004", "85006", "85007", "85008", "85009", "85012", "85013", "85015", "85016", "85017", "85018", "85019", "85020", "85021", "85022", "85023", "85024", "85027", "85028", "85029", "85031", "85032", "85033", "85034", "85035", "85037", "85039", "85041", "85043", "85044", "85045", "85048", "85050", "85051", "85053", "85054", "85083", "85085", "85086", "85087", "85301", "85302", "85303", "85304", "85305", "85306", "85307", "85308", "85310", "85323", "85326", "85335", "85338", "85340", "85345", "85351", "85353", "85355", "85361", "85363", "85373", "85374", "85375", "85378", "85379", "85381", "85382", "85383", "85385", "85387", "85388", "85390", "85392", "85395", "85396"];

/** Just outside (852): told about the travel charge, then continue or find someone more local. */
export const COVERAGE_TRAVEL = ["85201", "85202", "85203", "85204", "85205", "85206", "85207", "85208", "85209", "85210", "85212", "85213", "85215", "85224", "85225", "85226", "85233", "85234", "85248", "85249", "85250", "85251", "85253", "85254", "85255", "85256", "85257", "85258", "85259", "85260", "85262", "85266", "85268", "85281", "85282", "85283", "85284", "85286", "85295", "85296", "85297", "85298"];

/** On the list but a no-go (851). Listed for reference: they are simply left out of both lists above. */
export const COVERAGE_NO_GO = ["85118", "85119", "85120", "85122", "85140", "85142", "85143", "85193", "85194"];
