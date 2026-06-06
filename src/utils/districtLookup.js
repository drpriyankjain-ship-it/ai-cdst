/**
 * Maps reverse-geocode strings returned by expo-location to WB district codes
 * used in epi_prior_wb.json. Covers all 23 districts plus common alternate
 * spellings and former undivided district names.
 */

const NAME_TO_CODE = {
  'darjeeling':              'WB_DJL',
  'kalimpong':               'WB_KLP',
  'alipurduar':              'WB_ALP',
  'jalpaiguri':              'WB_JPG',
  'cooch behar':             'WB_CCB',
  'koch bihar':              'WB_CCB',
  'north dinajpur':          'WB_UDN',
  'uttar dinajpur':          'WB_UDN',
  'raiganj':                 'WB_UDN',
  'south dinajpur':          'WB_DDN',
  'dakshin dinajpur':        'WB_DDN',
  'balurghat':               'WB_DDN',
  'malda':                   'WB_MLD',
  'english bazar':           'WB_MLD',
  'murshidabad':             'WB_MSD',
  'nadia':                   'WB_NDA',
  'birbhum':                 'WB_BRB',
  'purba bardhaman':         'WB_PBD',
  'east burdwan':            'WB_PBD',
  'east bardhaman':          'WB_PBD',
  'burdwan':                 'WB_PBD',
  'bardhaman':               'WB_PBD',
  'paschim bardhaman':       'WB_WBD',
  'west burdwan':            'WB_WBD',
  'west bardhaman':          'WB_WBD',
  'hooghly':                 'WB_HGL',
  'hugli':                   'WB_HGL',
  'howrah':                  'WB_HWR',
  'haora':                   'WB_HWR',
  'kolkata':                 'WB_KOL',
  'calcutta':                'WB_KOL',
  'north 24 parganas':       'WB_N24',
  'north twenty four parganas': 'WB_N24',
  'north 24parganas':        'WB_N24',
  'south 24 parganas':       'WB_S24',
  'south twenty four parganas': 'WB_S24',
  'south 24parganas':        'WB_S24',
  'paschim medinipur':       'WB_WMD',
  'west midnapore':          'WB_WMD',
  'west medinipur':          'WB_WMD',
  'purba medinipur':         'WB_EMD',
  'east midnapore':          'WB_EMD',
  'east medinipur':          'WB_EMD',
  'jhargram':                'WB_JGM',
  'bankura':                 'WB_BKR',
  'purulia':                 'WB_PRL',
};

/**
 * Given a LocationGeocodedAddress from expo-location's reverseGeocodeAsync,
 * returns { district_code, district } or null if not resolvable.
 */
export function resolveWBDistrict(geocoded) {
  if (!geocoded) return null;

  // subregion is the most reliable district field for Indian addresses.
  // Fall back through district → city in case subregion is absent or wrong.
  const candidates = [
    geocoded.subregion,
    geocoded.district,
    geocoded.city,
  ].filter(Boolean);

  for (const raw of candidates) {
    const normalized = raw.toLowerCase().trim().replace(/\s+district$/i, '').replace(/\s+/g, ' ');
    if (NAME_TO_CODE[normalized]) {
      return { district_code: NAME_TO_CODE[normalized], district: raw };
    }
    // Substring match for partial names (e.g. "North 24 Parganas District")
    for (const [key, code] of Object.entries(NAME_TO_CODE)) {
      if (normalized.includes(key) || key.includes(normalized)) {
        return { district_code: code, district: raw };
      }
    }
  }

  return null;
}
