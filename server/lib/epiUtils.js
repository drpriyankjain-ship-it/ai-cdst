/**
 * CDST — Shared Epidemiological Utilities
 * ========================================
 * Direct port of epi_utils.py
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = existsSync(join(__dirname, '..', '..', 'data'))
  ? join(__dirname, '..', '..', 'data')   // Local dev: server/lib/ → ../../data/
  : join(__dirname, '..', 'data');          // EB deploy: lib/ → ../data/
const EPI_PRIOR_PATH = join(DATA_DIR, 'epi_prior_wb.json');

// ---------------------------------------------------------------------------
// State lookup — all 28 states + 6 UTs, keyed by district_code prefix
// ---------------------------------------------------------------------------

export const DISTRICT_CODE_TO_STATE = {
  AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar',
  CG: 'Chhattisgarh', GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana',
  HP: 'Himachal Pradesh', JH: 'Jharkhand', JK: 'Jammu and Kashmir',
  KA: 'Karnataka', KL: 'Kerala', MP: 'Madhya Pradesh', MH: 'Maharashtra',
  MN: 'Manipur', ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland',
  OD: 'Odisha', PB: 'Punjab', RJ: 'Rajasthan', SK: 'Sikkim',
  TN: 'Tamil Nadu', TG: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh',
  UK: 'Uttarakhand', WB: 'West Bengal',
  AN: 'Andaman and Nicobar Islands', CH: 'Chandigarh', DL: 'Delhi',
  LA: 'Ladakh', LD: 'Lakshadweep', PY: 'Puducherry',
};

/**
 * Derive state name from district_code prefix convention.
 * e.g. 'WB_MSD' → 'West Bengal', 'BR_MZF' → 'Bihar'
 */
export function stateFromDistrictCode(districtCode) {
  const prefix = districtCode.split('_')[0].toUpperCase();
  return DISTRICT_CODE_TO_STATE[prefix] || 'rural India';
}

// ---------------------------------------------------------------------------
// Season mapping
// ---------------------------------------------------------------------------

export const MONTH_TO_SEASON = {
  1: 'winter', 2: 'winter', 3: 'pre_monsoon',
  4: 'pre_monsoon', 5: 'pre_monsoon', 6: 'monsoon',
  7: 'monsoon', 8: 'monsoon', 9: 'monsoon',
  10: 'post_monsoon', 11: 'post_monsoon', 12: 'winter',
};

// ---------------------------------------------------------------------------
// Layer 1 — baseline disease burden (rural India primary care)
// ---------------------------------------------------------------------------

export function loadBaselineDiseases() {
  return (
    'LAYER 1 — BASELINE DISEASE BURDEN (rural India primary care):\n' +
    'Always consider these regardless of location or season:\n' +
    '  Respiratory : acute RTI, pneumonia, pulmonary TB, COPD exacerbation, asthma\n' +
    '  Fever       : typhoid, malaria, dengue, UTI, viral syndrome, scrub typhus\n' +
    '  GI          : acute gastroenteritis, peptic ulcer disease, cholera, hepatitis A/E\n' +
    '  Cardiac     : hypertension, heart failure, ischaemic heart disease\n' +
    '  Metabolic   : type 2 diabetes, iron-deficiency anaemia, malnutrition, B12 deficiency\n' +
    '  Neurological: stroke, GBS, peripheral neuropathy, epilepsy, cord compression\n' +
    '  Obstetric   : pre-eclampsia, anaemia in pregnancy, post-partum sepsis\n' +
    '  Trauma      : snake envenomation, fractures, burns\n' +
    'Consider each of these where compatible with the presenting features. ' +
    'Layer 2 elevates endemic infectious diseases where locally relevant — ' +
    'it does not replace this baseline. Neither layer overrides the presenting complaint.'
  );
}

// ---------------------------------------------------------------------------
// Layer 2 — district + season epi prior (IDSP/NVBDCP data)
// ---------------------------------------------------------------------------

export function loadEpiPrior(districtCode, month) {
  if (!existsSync(EPI_PRIOR_PATH)) {
    console.log(`[EPI PRIOR WARNING] ${EPI_PRIOR_PATH} not found. Layer 2 modifier absent.`);
    return '';
  }
  let prior;
  try {
    prior = JSON.parse(readFileSync(EPI_PRIOR_PATH, 'utf-8'));
  } catch (e) {
    console.log(`[EPI PRIOR WARNING] Failed to parse epi_prior_wb.json: ${e.message}`);
    return '';
  }
  const season = MONTH_TO_SEASON[month] || 'monsoon';
  const districtData = (prior.districts || {})[districtCode];

  if (!districtData) {
    console.log(
      `[EPI PRIOR WARNING] District '${districtCode}' not in epi_prior_wb.json. Layer 2 modifier absent.`
    );
    return '';
  }

  const seasonDiseases = (districtData.seasons || {})[season] || [];
  if (seasonDiseases.length === 0) return '';

  const districtName = districtData.name || districtCode;
  const lines = seasonDiseases
    .sort((a, b) => b.weight - a.weight)
    .map(d => `  - ${d.disease}: weight ${d.weight.toFixed(2)}${d.note ? ` — ${d.note}` : ''}`)
    .join('\n');

  return (
    `LAYER 2 — DISTRICT/SEASON MODIFIER (${districtName}, ${season} season, IDSP/NVBDCP data):\n` +
    'The following endemic diseases have elevated local prevalence right now.\n' +
    'Weight appropriately — they modify but do not replace Layer 1 above.\n' +
    lines
  );
}
