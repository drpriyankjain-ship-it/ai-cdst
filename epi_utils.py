"""
CDST — shared epidemiological utilities
========================================
Imported by History Stage and Diagnosis Stage.

Keeps the following in one place so the two stages never drift:

  DISTRICT_CODE_TO_STATE   — all-India state lookup keyed by district_code prefix
  state_from_district_code — derives readable state name from a district_code string
  MONTH_TO_SEASON          — month number → epi season key
  load_baseline_diseases   — Layer 1 hardcoded eastern-India disease burden string
  load_epi_prior           — Layer 2 district + season IDSP/NVBDCP lookup
"""

import json

EPI_PRIOR_PATH = "data/epi_prior_wb.json"


# ---------------------------------------------------------------------------
# State lookup — all 28 states + 6 UTs, keyed by district_code prefix
# ---------------------------------------------------------------------------

DISTRICT_CODE_TO_STATE = {
    # States
    "AP": "Andhra Pradesh",
    "AR": "Arunachal Pradesh",
    "AS": "Assam",
    "BR": "Bihar",
    "CG": "Chhattisgarh",
    "GA": "Goa",
    "GJ": "Gujarat",
    "HR": "Haryana",
    "HP": "Himachal Pradesh",
    "JH": "Jharkhand",
    "JK": "Jammu and Kashmir",
    "KA": "Karnataka",
    "KL": "Kerala",
    "MP": "Madhya Pradesh",
    "MH": "Maharashtra",
    "MN": "Manipur",
    "ML": "Meghalaya",
    "MZ": "Mizoram",
    "NL": "Nagaland",
    "OD": "Odisha",
    "PB": "Punjab",
    "RJ": "Rajasthan",
    "SK": "Sikkim",
    "TN": "Tamil Nadu",
    "TG": "Telangana",
    "TR": "Tripura",
    "UP": "Uttar Pradesh",
    "UK": "Uttarakhand",
    "WB": "West Bengal",
    # Union Territories
    "AN": "Andaman and Nicobar Islands",
    "CH": "Chandigarh",
    "DL": "Delhi",
    "LA": "Ladakh",
    "LD": "Lakshadweep",
    "PY": "Puducherry",
}


def state_from_district_code(district_code: str) -> str:
    """
    Derive state name from district_code prefix convention.
    e.g. 'WB_MSD' → 'West Bengal', 'BR_MZF' → 'Bihar', 'MH_PNE' → 'Maharashtra'.
    Falls back to 'rural India' if prefix is not recognised.
    """
    prefix = district_code.split("_")[0].upper()
    return DISTRICT_CODE_TO_STATE.get(prefix, "rural India")


# ---------------------------------------------------------------------------
# Season mapping
# ---------------------------------------------------------------------------

MONTH_TO_SEASON = {
    1: "winter",        2: "winter",        3: "pre_monsoon",
    4: "pre_monsoon",   5: "pre_monsoon",   6: "monsoon",
    7: "monsoon",       8: "monsoon",       9: "monsoon",
    10: "post_monsoon", 11: "post_monsoon", 12: "winter",
}


# ---------------------------------------------------------------------------
# Layer 1 — baseline disease burden (rural India primary care)
# ---------------------------------------------------------------------------

def load_baseline_diseases() -> str:
    """
    Layer 1 — common primary care presentations across rural India.
    Hardcoded string injected directly into History and Diagnosis Stage prompts.
    Not retrieved, not embedded — stable across all sessions.
    The state name injected separately via the prompt framing.
    """
    return (
        "LAYER 1 — BASELINE DISEASE BURDEN (rural India primary care):\n"
        "Always consider these regardless of location or season:\n"
        "  Respiratory : acute RTI, pneumonia, pulmonary TB, COPD exacerbation, asthma\n"
        "  Fever       : typhoid, malaria, dengue, UTI, viral syndrome, scrub typhus\n"
        "  GI          : acute gastroenteritis, peptic ulcer disease, cholera, hepatitis A/E\n"
        "  Cardiac     : hypertension, heart failure, ischaemic heart disease\n"
        "  Metabolic   : type 2 diabetes, iron-deficiency anaemia, malnutrition, B12 deficiency\n"
        "  Neurological: stroke, GBS, peripheral neuropathy, epilepsy, cord compression\n"
        "  Obstetric   : pre-eclampsia, anaemia in pregnancy, post-partum sepsis\n"
        "  Trauma      : snake envenomation, fractures, burns\n"
        "These anchor the differential. Layer 2 elevates endemic infectious diseases "
        "where locally relevant — it does not replace this baseline."
    )


# ---------------------------------------------------------------------------
# Layer 2 — district + season epi prior (IDSP/NVBDCP data)
# ---------------------------------------------------------------------------

def load_epi_prior(district_code: str, month: int) -> str:
    """
    Layer 2 — IDSP/NVBDCP district + season endemic disease weights.
    Returns a formatted string for prompt injection, or empty string
    if the district is unknown (logged as a data gap warning).

    Weights are relative (0-1), NOT absolute incidence rates.
    """
    with open(EPI_PRIOR_PATH) as f:
        prior = json.load(f)

    season        = MONTH_TO_SEASON.get(month, "monsoon")
    district_data = prior.get("districts", {}).get(district_code)

    if not district_data:
        print(
            f"[EPI PRIOR WARNING] District '{district_code}' not in "
            f"epi_prior_wb.json. Layer 2 modifier absent. Add district to resolve."
        )
        return ""

    season_diseases = district_data.get("seasons", {}).get(season, [])
    if not season_diseases:
        return ""

    district_name = district_data.get("name", district_code)
    lines = "\n".join(
        "  - {disease}: weight {weight:.2f}{note}".format(
            disease=d["disease"],
            weight=d["weight"],
            note=f" — {d['note']}" if d.get("note") else ""
        )
        for d in sorted(season_diseases, key=lambda x: x["weight"], reverse=True)
    )
    return (
        f"LAYER 2 — DISTRICT/SEASON MODIFIER "
        f"({district_name}, {season} season, IDSP/NVBDCP data):\n"
        "The following endemic diseases have elevated local prevalence right now.\n"
        "Weight appropriately — they modify but do not replace Layer 1 above.\n"
        f"{lines}"
    )
