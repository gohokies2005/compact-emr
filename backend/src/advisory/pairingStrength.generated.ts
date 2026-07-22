// AUTO-VENDORED from flatratenexus-project/references/medical_literature/curated/pairing_strength.json
// by backend/scripts/vendor-pairing-strength.cjs. DO NOT hand-edit — re-run the script on any source change.
// Source of truth is FRN's [STRENGTH:] anchors (built to .json via `node app/scripts/_build_pairing_strength.js`).
// This is a GRADE for the pairing the drafter already chose — it never picks the drafter's direction.
import type { PairingStrength } from './pairingStrengthLookup.js';

export const PAIRING_STRENGTH_SOURCE_VERSION = "1.0";

export const PAIRING_STRENGTHS: readonly PairingStrength[] = [
  {
    "upstream": "PTSD",
    "downstream": "alcohol use disorder",
    "grade_raw": "STRONG (AUD)",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG (AUD)",
    "pmids": [
      "24933396",
      "35587413",
      "39740784",
      "32493131",
      "24458060"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "alcohol use disorder",
      "substance use disorder",
      "alcohol abuse",
      "alcohol use",
      "alcoholism",
      "aud",
      "cannabis",
      "drug abuse",
      "opioid use",
      "oud",
      "substance abuse",
      "substance use",
      "sud"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "sud"
    ]
  },
  {
    "upstream": "CHRONIC KIDNEY DISEASE",
    "downstream": "anemia",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "24392162",
      "32041774",
      "33842503",
      "30970355",
      "22935483"
    ],
    "upstream_variants": [
      "chronic kidney disease",
      "ckd",
      "kidney disease",
      "nephropath",
      "renal insufficiency"
    ],
    "downstream_variants": [
      "anemia",
      "anaemia",
      "anemia of chronic kidney disease",
      "low hemoglobin",
      "low hgb",
      "renal anemia"
    ],
    "upstream_topics": [
      "ckd"
    ],
    "downstream_topics": [
      "anemia"
    ]
  },
  {
    "upstream": "CHRONIC PAIN",
    "downstream": "anxiety",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "40053352",
      "35211169",
      "35974687",
      "34272314",
      "40124113"
    ],
    "upstream_variants": [
      "chronic pain"
    ],
    "downstream_variants": [
      "anxiety",
      "gad",
      "generalized anxiety",
      "obsessive compulsive",
      "ocd",
      "panic",
      "panic disorder"
    ],
    "upstream_topics": [],
    "downstream_topics": [
      "anxiety"
    ]
  },
  {
    "upstream": "TINNITUS",
    "downstream": "anxiety",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "38297917",
      "40088765",
      "36769823",
      "42168216",
      "32670119",
      "25766493"
    ],
    "upstream_variants": [
      "tinnitus",
      "ear ringing",
      "ears ringing",
      "head noise",
      "ringing in",
      "ringing in ears"
    ],
    "downstream_variants": [
      "anxiety",
      "gad",
      "generalized anxiety",
      "obsessive compulsive",
      "ocd",
      "panic",
      "panic disorder"
    ],
    "upstream_topics": [
      "tinnitus"
    ],
    "downstream_topics": [
      "anxiety"
    ]
  },
  {
    "upstream": "ALLERGIC RHINITIS",
    "downstream": "asthma",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "18805333",
      "11897985",
      "30220097",
      "20441427",
      "17115970"
    ],
    "upstream_variants": [
      "allergic rhinitis",
      "hay fever",
      "rhinitis",
      "vasomotor rhinitis"
    ],
    "downstream_variants": [
      "asthma",
      "rad",
      "reactive airway"
    ],
    "upstream_topics": [
      "allergic_rhinitis"
    ],
    "downstream_topics": [
      "asthma"
    ]
  },
  {
    "upstream": "HYPERTENSION",
    "downstream": "atrial fibrillation",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "8114238",
      "21444879",
      "29348255",
      "8313561",
      "25855678"
    ],
    "upstream_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "downstream_variants": [
      "atrial fibrillation",
      "a fib",
      "afib"
    ],
    "upstream_topics": [
      "hypertension"
    ],
    "downstream_topics": [
      "atrial_fibrillation"
    ]
  },
  {
    "upstream": "OBSTRUCTIVE SLEEP APNEA",
    "downstream": "atrial fibrillation",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "17276180",
      "30687538",
      "30757948",
      "37806037",
      "38033089"
    ],
    "upstream_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "downstream_variants": [
      "atrial fibrillation",
      "a fib",
      "afib"
    ],
    "upstream_topics": [
      "sleep_apnea"
    ],
    "downstream_topics": [
      "atrial_fibrillation"
    ]
  },
  {
    "upstream": "GERD",
    "downstream": "Barrett's esophagus",
    "grade_raw": "STRONG (general pathway); STRONG-to-MODERATE per-case, conditioned on CHRONIC long-standing GERD",
    "grade_tier": "moderate-strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG (general pathway); STRONG-to-MODERATE per-case, conditioned on CHRONIC long-standing GERD",
    "pmids": [
      "17461453",
      "20485283",
      "9260792",
      "18556417",
      "35354777"
    ],
    "upstream_variants": [
      "gerd",
      "barrett",
      "esophageal adenocarcinoma",
      "esophageal cancer",
      "esophagit",
      "gastroesophageal reflux",
      "heartburn",
      "hiatal hernia",
      "indigestion",
      "reflux"
    ],
    "downstream_variants": [
      "barrett's esophagus",
      "barrett esophagus",
      "barrett's oesophagus",
      "barretts esophagus",
      "columnar metaplasia",
      "intestinal metaplasia",
      "barrett",
      "esophageal adenocarcinoma",
      "esophageal cancer",
      "esophagit",
      "gastroesophageal reflux",
      "gerd",
      "heartburn",
      "hiatal hernia",
      "indigestion",
      "reflux"
    ],
    "upstream_topics": [
      "gerd"
    ],
    "downstream_topics": [
      "barretts_esophagus",
      "gerd"
    ]
  },
  {
    "upstream": "DIABETES",
    "downstream": "chronic kidney disease",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "28143897",
      "32363737",
      "27536666",
      "33322614",
      "29262395"
    ],
    "upstream_variants": [
      "diabetes",
      "a1c",
      "diabetes mellitus",
      "diabetic",
      "dm",
      "dm2",
      "hyperglycem",
      "insulin resist",
      "prediabetes",
      "t2d",
      "t2dm",
      "type 2 diabetes"
    ],
    "downstream_variants": [
      "chronic kidney disease",
      "diabetic nephropathy",
      "ckd",
      "kidney disease",
      "nephropath",
      "renal insufficiency",
      "a1c",
      "diabetes",
      "diabetes mellitus",
      "diabetic",
      "dm",
      "dm2",
      "hyperglycem",
      "insulin resist",
      "prediabetes",
      "t2d",
      "t2dm",
      "type 2 diabetes"
    ],
    "upstream_topics": [
      "t2d"
    ],
    "downstream_topics": [
      "ckd",
      "t2d"
    ]
  },
  {
    "upstream": "HYPERTENSION",
    "downstream": "chronic kidney disease",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "7494564",
      "15851645",
      "34999880"
    ],
    "upstream_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "downstream_variants": [
      "chronic kidney disease",
      "ckd",
      "kidney disease",
      "nephropath",
      "renal insufficiency"
    ],
    "upstream_topics": [
      "hypertension"
    ],
    "downstream_topics": [
      "ckd"
    ]
  },
  {
    "upstream": "GERD",
    "downstream": "chronic laryngitis",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "39854415",
      "33060393",
      "29327685",
      "16598991",
      "17345925"
    ],
    "upstream_variants": [
      "gerd",
      "barrett",
      "esophageal adenocarcinoma",
      "esophageal cancer",
      "esophagit",
      "gastroesophageal reflux",
      "heartburn",
      "hiatal hernia",
      "indigestion",
      "reflux"
    ],
    "downstream_variants": [
      "chronic laryngitis",
      "lpr",
      "chronic cough",
      "chronic hoarseness",
      "laryngitis",
      "laryngitis lpr",
      "laryngopharyngeal reflux",
      "reflux laryngitis"
    ],
    "upstream_topics": [
      "gerd"
    ],
    "downstream_topics": [
      "laryngitis_lpr"
    ]
  },
  {
    "upstream": "ALLERGIC RHINITIS",
    "downstream": "chronic rhinosinusitis",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "15090914",
      "23541327",
      "38987868",
      "26654194",
      "29401486",
      "32077450"
    ],
    "upstream_variants": [
      "allergic rhinitis",
      "hay fever",
      "rhinitis",
      "vasomotor rhinitis"
    ],
    "downstream_variants": [
      "chronic rhinosinusitis",
      "chronic sinus",
      "crs",
      "nasal polyp",
      "rhinosinusitis",
      "sinus infection",
      "sinusitis"
    ],
    "upstream_topics": [
      "allergic_rhinitis"
    ],
    "downstream_topics": [
      "rhinosinusitis"
    ]
  },
  {
    "upstream": "PTSD",
    "downstream": "chronic widespread pain",
    "grade_raw": "MODERATE — frame CAUSATION and/or AGGRAVATION",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE — frame CAUSATION and/or AGGRAVATION",
    "pmids": [
      "24336429",
      "24806468",
      "19691031",
      "31164966",
      "12553128"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "chronic widespread pain",
      "central sensitization",
      "central sensitization syndrome",
      "centralized pain",
      "chronic pain syndrome",
      "widespread pain"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "chronic_widespread_pain"
    ]
  },
  {
    "upstream": "OBSTRUCTIVE SLEEP APNEA",
    "downstream": "cognitive impairment",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "21828324",
      "28905231",
      "25878183",
      "30597615",
      "40214959"
    ],
    "upstream_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "downstream_variants": [
      "cognitive impairment",
      "mci",
      "dementia",
      "cognitive decline",
      "cognitive dementia",
      "memory impairment",
      "memory loss",
      "memory problems",
      "mild cognitive impairment"
    ],
    "upstream_topics": [
      "sleep_apnea"
    ],
    "downstream_topics": [
      "cognitive_dementia"
    ]
  },
  {
    "upstream": "HYPERLIPIDEMIA",
    "downstream": "coronary artery disease",
    "grade_raw": "STRONG (science); ADMIN CAVEAT below",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG (science); ADMIN CAVEAT below",
    "pmids": [
      "23083789",
      "18061058",
      "21067804",
      "28444290"
    ],
    "upstream_variants": [
      "hyperlipidemia",
      "dyslipidemia",
      "high cholesterol",
      "hypercholesterolemia",
      "lipid disorder",
      "lipid disorders"
    ],
    "downstream_variants": [
      "coronary artery disease",
      "ihd",
      "angina",
      "cad",
      "cardiovascular",
      "coronary",
      "heart disease",
      "ischemic heart",
      "ischemic heart disease",
      "myocardial infarct",
      "nstemi",
      "stemi"
    ],
    "upstream_topics": [
      "lipid_disorders"
    ],
    "downstream_topics": [
      "cardiovascular"
    ]
  },
  {
    "upstream": "HYPERTENSION",
    "downstream": "coronary artery disease",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "12493255",
      "24881994",
      "7843763",
      "26724178",
      "34461040"
    ],
    "upstream_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "downstream_variants": [
      "coronary artery disease",
      "ischemic heart disease",
      "angina",
      "cad",
      "cardiovascular",
      "coronary",
      "heart disease",
      "ihd",
      "ischemic heart",
      "myocardial infarct",
      "nstemi",
      "stemi"
    ],
    "upstream_topics": [
      "hypertension"
    ],
    "downstream_topics": [
      "cardiovascular"
    ]
  },
  {
    "upstream": "GERD",
    "downstream": "dental erosion",
    "grade_raw": "STRONG (association + mechanism; multifactorial caveat)",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG (association + mechanism; multifactorial caveat)",
    "pmids": [
      "38552999",
      "35917996",
      "18373634",
      "19552365",
      "22194748",
      "33571021"
    ],
    "upstream_variants": [
      "gerd",
      "barrett",
      "esophageal adenocarcinoma",
      "esophageal cancer",
      "esophagit",
      "gastroesophageal reflux",
      "heartburn",
      "hiatal hernia",
      "indigestion",
      "reflux"
    ],
    "downstream_variants": [
      "dental erosion",
      "dental lesions",
      "enamel erosion",
      "erosive tooth wear",
      "perimylolysis",
      "tooth erosion",
      "tooth wear"
    ],
    "upstream_topics": [
      "gerd"
    ],
    "downstream_topics": [
      "dental_erosion"
    ]
  },
  {
    "upstream": "CHRONIC PAIN",
    "downstream": "depression",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "24012953",
      "28706741",
      "9186019",
      "40053352"
    ],
    "upstream_variants": [
      "chronic pain",
      "musculoskeletal pain"
    ],
    "downstream_variants": [
      "depression",
      "depressive",
      "dysthym",
      "major depressive",
      "mdd",
      "persistent depressive"
    ],
    "upstream_topics": [],
    "downstream_topics": [
      "depression"
    ]
  },
  {
    "upstream": "HEARING LOSS",
    "downstream": "depression",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "39497727",
      "36896880",
      "32959064",
      "29202654",
      "38259802"
    ],
    "upstream_variants": [
      "hearing loss",
      "audiometric",
      "hard of hearing",
      "loss of hearing",
      "presbycusis",
      "sensorineural hearing",
      "snhl"
    ],
    "downstream_variants": [
      "depression",
      "depressive",
      "dysthym",
      "major depressive",
      "mdd",
      "persistent depressive"
    ],
    "upstream_topics": [
      "hearing_loss"
    ],
    "downstream_topics": [
      "depression"
    ]
  },
  {
    "upstream": "HYPOTHYROIDISM",
    "downstream": "depression",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "34524390",
      "30621645",
      "11840307",
      "37855318",
      "30375372"
    ],
    "upstream_variants": [
      "hypothyroidism",
      "graves",
      "hashimoto",
      "hypothyroid",
      "levothyrox",
      "low thyroid",
      "low tsh",
      "thyroid disorder",
      "thyroidectomy",
      "underactive thyroid"
    ],
    "downstream_variants": [
      "depression",
      "depressive",
      "dysthym",
      "major depressive",
      "mdd",
      "persistent depressive"
    ],
    "upstream_topics": [
      "hypothyroidism"
    ],
    "downstream_topics": [
      "depression"
    ]
  },
  {
    "upstream": "MIGRAINE",
    "downstream": "depression",
    "grade_raw": "STRONG (forward arm)",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG (forward arm)",
    "pmids": [
      "7928322",
      "12707434",
      "23588795",
      "38397400",
      "10668688",
      "38881795"
    ],
    "upstream_variants": [
      "migraine",
      "post traumatic headache",
      "posttraumatic headache"
    ],
    "downstream_variants": [
      "depression",
      "depressive",
      "dysthym",
      "major depressive",
      "mdd",
      "persistent depressive"
    ],
    "upstream_topics": [
      "migraine"
    ],
    "downstream_topics": [
      "depression"
    ]
  },
  {
    "upstream": "OBSTRUCTIVE SLEEP APNEA",
    "downstream": "depression",
    "grade_raw": "MODERATE-STRONG",
    "grade_tier": "moderate-strong",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE-STRONG",
    "pmids": [
      "33158487",
      "27139243",
      "30130421",
      "32651433"
    ],
    "upstream_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "downstream_variants": [
      "depression",
      "depressive",
      "dysthym",
      "major depressive",
      "mdd",
      "persistent depressive"
    ],
    "upstream_topics": [
      "sleep_apnea"
    ],
    "downstream_topics": [
      "depression"
    ]
  },
  {
    "upstream": "TBI",
    "downstream": "depression",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "34931535",
      "38117134",
      "32508733",
      "39603437",
      "30535946",
      "30929221"
    ],
    "upstream_variants": [
      "tbi",
      "blast injury",
      "concussion",
      "mtbi",
      "pcs",
      "post concussion",
      "postconcussion",
      "traumatic brain injury"
    ],
    "downstream_variants": [
      "depression",
      "depressive",
      "dysthym",
      "major depressive",
      "mdd",
      "persistent depressive"
    ],
    "upstream_topics": [
      "tbi"
    ],
    "downstream_topics": [
      "depression"
    ]
  },
  {
    "upstream": "TINNITUS",
    "downstream": "depression",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "35401414",
      "40088765",
      "34110355",
      "40818309"
    ],
    "upstream_variants": [
      "tinnitus",
      "ear ringing",
      "ears ringing",
      "head noise",
      "ringing in",
      "ringing in ears"
    ],
    "downstream_variants": [
      "depression",
      "depressive",
      "dysthym",
      "major depressive",
      "mdd",
      "persistent depressive"
    ],
    "upstream_topics": [
      "tinnitus"
    ],
    "downstream_topics": [
      "depression"
    ]
  },
  {
    "upstream": "DIABETES",
    "downstream": "erectile dysfunction",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "28722225",
      "33951654",
      "12716821",
      "15184671"
    ],
    "upstream_variants": [
      "diabetes",
      "a1c",
      "diabetes mellitus",
      "diabetic",
      "dm",
      "dm2",
      "hyperglycem",
      "insulin resist",
      "prediabetes",
      "t2d",
      "t2dm",
      "type 2 diabetes"
    ],
    "downstream_variants": [
      "erectile dysfunction",
      "ed",
      "erectile",
      "impotence"
    ],
    "upstream_topics": [
      "t2d"
    ],
    "downstream_topics": [
      "erectile_dysfunction"
    ]
  },
  {
    "upstream": "HYPERTENSION",
    "downstream": "erectile dysfunction",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "32073535",
      "9039073",
      "10992363",
      "17151696",
      "10731462"
    ],
    "upstream_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "downstream_variants": [
      "erectile dysfunction",
      "ed",
      "erectile",
      "impotence"
    ],
    "upstream_topics": [
      "hypertension"
    ],
    "downstream_topics": [
      "erectile_dysfunction"
    ]
  },
  {
    "upstream": "OBSTRUCTIVE SLEEP APNEA",
    "downstream": "erectile dysfunction",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "26395783",
      "24813467",
      "35250871",
      "31715462",
      "29795528"
    ],
    "upstream_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "downstream_variants": [
      "erectile dysfunction",
      "ed",
      "erectile",
      "impotence"
    ],
    "upstream_topics": [
      "sleep_apnea"
    ],
    "downstream_topics": [
      "erectile_dysfunction"
    ]
  },
  {
    "upstream": "PTSD",
    "downstream": "erectile dysfunction",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "20731284",
      "23088675",
      "34257051",
      "25665140"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "erectile dysfunction",
      "ed",
      "erectile",
      "impotence"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "erectile_dysfunction"
    ]
  },
  {
    "upstream": "PTSD",
    "downstream": "female sexual dysfunction",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "34257051",
      "32216146",
      "25847589",
      "19440080",
      "37279603"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "female sexual dysfunction",
      "anorgasmia",
      "female arousal disorder",
      "hsdd",
      "hypoactive sexual desire",
      "sexual dysfunction female",
      "benign prostatic",
      "benign prostatic hyperplasia",
      "bph",
      "endometriosis",
      "pelvic floor",
      "premature ejaculation",
      "prostate enlargement",
      "prostatitis",
      "reproductive genitourinary",
      "sexual dysfunction",
      "urethritis",
      "vaginismus"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "female_sexual_dysfunction",
      "reproductive_genitourinary"
    ]
  },
  {
    "upstream": "PTSD",
    "downstream": "fibromyalgia",
    "grade_raw": "MODERATE-STRONG",
    "grade_tier": "moderate-strong",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE-STRONG",
    "pmids": [
      "41568551",
      "32567748",
      "28543929",
      "17188125",
      "20074445"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "fibromyalgia",
      "cfs",
      "chronic fatigue",
      "fibro",
      "me/cfs",
      "myalgic encephalomyelitis"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "fibromyalgia"
    ]
  },
  {
    "upstream": "CHRONIC NSAID USE",
    "downstream": "GERD",
    "grade_raw": "MODERATE (GERD symptoms) / STRONG (erosive esophagitis/injury)",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE (GERD symptoms) / STRONG (erosive esophagitis/injury)",
    "pmids": [
      "28232473",
      "19577798",
      "11197285",
      "24672789"
    ],
    "upstream_variants": [
      "chronic nsaid use"
    ],
    "downstream_variants": [
      "gerd",
      "upper gi mucosal injury",
      "barrett",
      "esophageal adenocarcinoma",
      "esophageal cancer",
      "esophagit",
      "gastroesophageal reflux",
      "heartburn",
      "hiatal hernia",
      "indigestion",
      "reflux"
    ],
    "upstream_topics": [],
    "downstream_topics": [
      "gerd"
    ]
  },
  {
    "upstream": "OBESITY",
    "downstream": "GERD",
    "grade_raw": "STRONG (obesity = intermediate step per VAOPGCPREC 1-2017)",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG (obesity = intermediate step per VAOPGCPREC 1-2017)",
    "pmids": [
      "16061918",
      "16738270",
      "16530504",
      "28267445",
      "23358462"
    ],
    "upstream_variants": [
      "obesity",
      "weight gain",
      "morbid obesity",
      "overweight"
    ],
    "downstream_variants": [
      "gerd",
      "barrett",
      "esophageal adenocarcinoma",
      "esophageal cancer",
      "esophagit",
      "gastroesophageal reflux",
      "heartburn",
      "hiatal hernia",
      "indigestion",
      "reflux"
    ],
    "upstream_topics": [
      "obesity"
    ],
    "downstream_topics": [
      "gerd"
    ]
  },
  {
    "upstream": "PTSD",
    "downstream": "GERD",
    "grade_raw": "WEAK — frame AGGRAVATION, carry the null-MR counter",
    "grade_tier": "weak",
    "verdict_anchor": "borderline",
    "framing_note": "WEAK — frame AGGRAVATION, carry the null-MR counter",
    "pmids": [
      "41234289",
      "38911441",
      "40388735"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "gerd",
      "barrett",
      "esophageal adenocarcinoma",
      "esophageal cancer",
      "esophagit",
      "gastroesophageal reflux",
      "heartburn",
      "hiatal hernia",
      "indigestion",
      "reflux"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "gerd"
    ]
  },
  {
    "upstream": "DIURETIC",
    "downstream": "gout",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "22031222",
      "22240117",
      "24449584",
      "21896142",
      "29976236"
    ],
    "upstream_variants": [
      "diuretic"
    ],
    "downstream_variants": [
      "gout",
      "hyperuricemia",
      "gouty arthritis",
      "tophaceous gout",
      "urate"
    ],
    "upstream_topics": [],
    "downstream_topics": [
      "gout"
    ]
  },
  {
    "upstream": "TMD",
    "downstream": "headache",
    "grade_raw": "MODERATE — frame AGGRAVATION (3.310b)",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE — frame AGGRAVATION (3.310b)",
    "pmids": [
      "32962244",
      "39801093",
      "22767961",
      "20664830"
    ],
    "upstream_variants": [
      "tmd",
      "tmj",
      "bruxism",
      "jaw pain",
      "myofascial jaw",
      "sleep bruxism",
      "teeth grinding",
      "temporomandibular"
    ],
    "downstream_variants": [
      "headache",
      "migraine",
      "post traumatic headache",
      "posttraumatic headache"
    ],
    "upstream_topics": [
      "tmd"
    ],
    "downstream_topics": [
      "migraine"
    ]
  },
  {
    "upstream": "HYPOTHYROIDISM",
    "downstream": "hyperlipidemia",
    "grade_raw": "STRONG (overt) / MODERATE (subclinical)",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG (overt) / MODERATE (subclinical)",
    "pmids": [
      "12829694",
      "12034052",
      "37100404",
      "35078310",
      "28342184",
      "25124461"
    ],
    "upstream_variants": [
      "hypothyroidism",
      "graves",
      "hashimoto",
      "hypothyroid",
      "levothyrox",
      "low thyroid",
      "low tsh",
      "thyroid disorder",
      "thyroidectomy",
      "underactive thyroid"
    ],
    "downstream_variants": [
      "hyperlipidemia",
      "dyslipidemia",
      "high cholesterol",
      "hypercholesterolemia",
      "lipid disorder",
      "lipid disorders"
    ],
    "upstream_topics": [
      "hypothyroidism"
    ],
    "downstream_topics": [
      "lipid_disorders"
    ]
  },
  {
    "upstream": "CHRONIC musculoskeletal PAIN",
    "downstream": "hypertension",
    "grade_raw": "MODERATE — NSAID leg strongest",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE — NSAID leg strongest",
    "pmids": [
      "12411450",
      "8037411",
      "25786044",
      "23245863",
      "15341037"
    ],
    "upstream_variants": [
      "chronic musculoskeletal pain"
    ],
    "downstream_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "upstream_topics": [],
    "downstream_topics": [
      "hypertension"
    ]
  },
  {
    "upstream": "OBSTRUCTIVE SLEEP APNEA",
    "downstream": "hypertension",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "10805822",
      "22618924",
      "34148375",
      "27188535"
    ],
    "upstream_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "downstream_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "upstream_topics": [
      "sleep_apnea"
    ],
    "downstream_topics": [
      "hypertension"
    ]
  },
  {
    "upstream": "PTSD",
    "downstream": "hypertension",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "27534802",
      "27566327",
      "33060048"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "hypertension"
    ]
  },
  {
    "upstream": "TYPE 2 DIABETES",
    "downstream": "hypertension",
    "grade_raw": "MODERATE (nephropathy pathway) / WEAK (bare metabolic)",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE (nephropathy pathway) / WEAK (bare metabolic)",
    "pmids": [
      "34601960",
      "24582094",
      "27707707",
      "23942764",
      "26429079",
      "32389340"
    ],
    "upstream_variants": [
      "type 2 diabetes",
      "a1c",
      "diabetes",
      "diabetes mellitus",
      "diabetic",
      "dm",
      "dm2",
      "hyperglycem",
      "insulin resist",
      "prediabetes",
      "t2d",
      "t2dm"
    ],
    "downstream_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "upstream_topics": [
      "t2d"
    ],
    "downstream_topics": [
      "hypertension"
    ]
  },
  {
    "upstream": "weight gain",
    "downstream": "hypertension",
    "grade_raw": "STRONG mechanism",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG mechanism",
    "pmids": [
      "25767285",
      "9441586",
      "29581553",
      "12196085"
    ],
    "upstream_variants": [
      "weight gain",
      "obesity",
      "morbid obesity",
      "overweight"
    ],
    "downstream_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "upstream_topics": [
      "obesity"
    ],
    "downstream_topics": [
      "hypertension"
    ]
  },
  {
    "upstream": "CHRONIC OPIOID THERAPY",
    "downstream": "hypogonadism",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "31511863",
      "27516365",
      "14622741",
      "41735247",
      "22786453",
      "22183092"
    ],
    "upstream_variants": [
      "chronic opioid therapy"
    ],
    "downstream_variants": [
      "hypogonadism",
      "low testosterone",
      "androgen deficiency",
      "hypogonadotropic",
      "low t",
      "opiad",
      "opioid induced androgen deficiency",
      "testosterone deficiency"
    ],
    "upstream_topics": [],
    "downstream_topics": [
      "hypogonadism"
    ]
  },
  {
    "upstream": "PTSD",
    "downstream": "insomnia",
    "grade_raw": "MODERATE-STRONG",
    "grade_tier": "moderate-strong",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE-STRONG",
    "pmids": [
      "35618150",
      "41167443",
      "28363448",
      "24367137"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "insomnia",
      "chronic sleep disorder",
      "can't sleep",
      "cant sleep",
      "difficulty sleeping",
      "sleep disturbance",
      "trouble sleeping",
      "unable to sleep"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "insomnia"
    ]
  },
  {
    "upstream": "TINNITUS",
    "downstream": "insomnia",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "32568801",
      "22750224",
      "42168216",
      "33637233",
      "38532055",
      "30628492"
    ],
    "upstream_variants": [
      "tinnitus",
      "ear ringing",
      "ears ringing",
      "head noise",
      "ringing in",
      "ringing in ears"
    ],
    "downstream_variants": [
      "insomnia",
      "chronic sleep disturbance",
      "can't sleep",
      "cant sleep",
      "difficulty sleeping",
      "sleep disturbance",
      "trouble sleeping",
      "unable to sleep"
    ],
    "upstream_topics": [
      "tinnitus"
    ],
    "downstream_topics": [
      "insomnia"
    ]
  },
  {
    "upstream": "ANXIETY",
    "downstream": "irritable bowel syndrome",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "22234979",
      "27444264",
      "32715790",
      "35799238",
      "32922317"
    ],
    "upstream_variants": [
      "anxiety",
      "gad",
      "generalized anxiety",
      "obsessive compulsive",
      "ocd",
      "panic",
      "panic disorder"
    ],
    "downstream_variants": [
      "irritable bowel syndrome",
      "ibs",
      "irritable bowel"
    ],
    "upstream_topics": [
      "anxiety"
    ],
    "downstream_topics": [
      "ibs"
    ]
  },
  {
    "upstream": "MIGRAINE WITH AURA",
    "downstream": "ischemic stroke",
    "grade_raw": "MODERATE — AURA-SPECIFIC ONLY",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE — AURA-SPECIFIC ONLY",
    "pmids": [
      "19861375",
      "22172624",
      "15596418",
      "33835736",
      "17690308"
    ],
    "upstream_variants": [
      "migraine with aura",
      "migraine",
      "post traumatic headache",
      "posttraumatic headache"
    ],
    "downstream_variants": [
      "ischemic stroke",
      "brain infarct",
      "cerebral infarction",
      "cerebrovascular accident",
      "cva",
      "stroke"
    ],
    "upstream_topics": [
      "migraine"
    ],
    "downstream_topics": [
      "stroke"
    ]
  },
  {
    "upstream": "OBESITY",
    "downstream": "knee osteoarthritis",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "26656979",
      "27059260",
      "22237485",
      "37578613"
    ],
    "upstream_variants": [
      "obesity",
      "weight gain",
      "morbid obesity",
      "overweight"
    ],
    "downstream_variants": [
      "knee osteoarthritis",
      "ac joint",
      "acl",
      "ankle",
      "degenerative arthritis",
      "degenerative joint",
      "djd",
      "glenohumeral arthritis",
      "hip",
      "knee",
      "mcl",
      "meniscal",
      "meniscus",
      "oa",
      "osteoarthritic",
      "osteoarthritis",
      "shoulder"
    ],
    "upstream_topics": [
      "obesity"
    ],
    "downstream_topics": [
      "osteoarthritis"
    ]
  },
  {
    "upstream": "OBESITY",
    "downstream": "lumbar spine degeneration",
    "grade_raw": "MODERATE; obesity = 1-2017 intermediate step",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE; obesity = 1-2017 intermediate step",
    "pmids": [
      "20007994",
      "23497297",
      "31027158",
      "24569641"
    ],
    "upstream_variants": [
      "obesity",
      "weight gain",
      "morbid obesity",
      "overweight"
    ],
    "downstream_variants": [
      "lumbar spine degeneration",
      "chronic low back pain",
      "back pain",
      "ddd",
      "degenerative disc",
      "lbp",
      "low back",
      "lower back",
      "lumbar",
      "lumbar disc",
      "lumbar spine",
      "lumbosacral",
      "sacroiliac",
      "sacroiliitis",
      "si joint",
      "spinal stenosis",
      "spondylolisthesis",
      "spondylolysis"
    ],
    "upstream_topics": [
      "obesity"
    ],
    "downstream_topics": [
      "lumbar_spine"
    ]
  },
  {
    "upstream": "OBSTRUCTIVE SLEEP APNEA",
    "downstream": "migraine",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "39925173",
      "37669991",
      "28374233",
      "24928423",
      "39881850"
    ],
    "upstream_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "downstream_variants": [
      "migraine",
      "chronic headache",
      "post traumatic headache",
      "posttraumatic headache"
    ],
    "upstream_topics": [
      "sleep_apnea"
    ],
    "downstream_topics": [
      "migraine"
    ]
  },
  {
    "upstream": "PTSD",
    "downstream": "migraine",
    "grade_raw": "MODERATE — frame AGGRAVATION, carry the MR-null counter",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE — frame AGGRAVATION, carry the MR-null counter",
    "pmids": [
      "21592096",
      "41705319",
      "41420111",
      "26473981"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "migraine",
      "post traumatic headache",
      "posttraumatic headache"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "migraine"
    ]
  },
  {
    "upstream": "TRAUMATIC BRAIN INJURY",
    "downstream": "migraine",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "39136870",
      "40100309",
      "19220499",
      "22404747",
      "33242991",
      "40394964"
    ],
    "upstream_variants": [
      "traumatic brain injury",
      "blast injury",
      "concussion",
      "mtbi",
      "pcs",
      "post concussion",
      "postconcussion",
      "tbi"
    ],
    "downstream_variants": [
      "migraine",
      "post traumatic headache",
      "posttraumatic headache"
    ],
    "upstream_topics": [
      "tbi"
    ],
    "downstream_topics": [
      "migraine"
    ]
  },
  {
    "upstream": "DIABETES",
    "downstream": "NAION",
    "grade_raw": "WEAK-MODERATE — most consistent independent multivariate signal after OSA",
    "grade_tier": "weak-moderate",
    "verdict_anchor": "borderline",
    "framing_note": "WEAK-MODERATE — most consistent independent multivariate signal after OSA",
    "pmids": [
      "9366670",
      "7977604"
    ],
    "upstream_variants": [
      "diabetes",
      "a1c",
      "diabetes mellitus",
      "diabetic",
      "dm",
      "dm2",
      "hyperglycem",
      "insulin resist",
      "prediabetes",
      "t2d",
      "t2dm",
      "type 2 diabetes"
    ],
    "downstream_variants": [
      "naion",
      "aion",
      "anterior ischemic optic neuropathy",
      "ischemic optic neuropathy",
      "non arteritic anterior ischemic optic neuropathy",
      "nonarteritic anterior ischemic optic neuropathy"
    ],
    "upstream_topics": [
      "t2d"
    ],
    "downstream_topics": [
      "naion"
    ]
  },
  {
    "upstream": "HYPERTENSION",
    "downstream": "NAION",
    "grade_raw": "WEAK-MODERATE — lean on the nocturnal-hypotension mechanism",
    "grade_tier": "weak-moderate",
    "verdict_anchor": "borderline",
    "framing_note": "WEAK-MODERATE — lean on the nocturnal-hypotension mechanism",
    "pmids": [
      "7977604",
      "8172267",
      "15722660"
    ],
    "upstream_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "downstream_variants": [
      "naion",
      "aion",
      "anterior ischemic optic neuropathy",
      "ischemic optic neuropathy",
      "non arteritic anterior ischemic optic neuropathy",
      "nonarteritic anterior ischemic optic neuropathy"
    ],
    "upstream_topics": [
      "hypertension"
    ],
    "downstream_topics": [
      "naion"
    ]
  },
  {
    "upstream": "OBSTRUCTIVE SLEEP APNEA",
    "downstream": "NAION",
    "grade_raw": "MODERATE — strongest & most VA-relevant",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE — strongest & most VA-relevant",
    "pmids": [
      "26443989",
      "21851924",
      "30171667"
    ],
    "upstream_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "downstream_variants": [
      "naion",
      "aion",
      "anterior ischemic optic neuropathy",
      "ischemic optic neuropathy",
      "non arteritic anterior ischemic optic neuropathy",
      "nonarteritic anterior ischemic optic neuropathy"
    ],
    "upstream_topics": [
      "sleep_apnea"
    ],
    "downstream_topics": [
      "naion"
    ]
  },
  {
    "upstream": "ANXIETY",
    "downstream": "OSA",
    "grade_raw": "WEAK-MODERATE",
    "grade_tier": "weak-moderate",
    "verdict_anchor": "borderline",
    "framing_note": "WEAK-MODERATE",
    "pmids": [
      "34270410",
      "25406268"
    ],
    "upstream_variants": [
      "anxiety",
      "gad",
      "generalized anxiety",
      "obsessive compulsive",
      "ocd",
      "panic",
      "panic disorder"
    ],
    "downstream_variants": [
      "osa",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "anxiety"
    ],
    "downstream_topics": [
      "sleep_apnea",
      "osa"
    ]
  },
  {
    "upstream": "ASTHMA",
    "downstream": "OSA",
    "grade_raw": "MODERATE (prospective incident-OSA association, adjusted RR 1.39; single cohort, mechanism not yet established)",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE (prospective incident-OSA association, adjusted RR 1.39; single cohort, mechanism not yet established)",
    "pmids": [
      "25585327"
    ],
    "upstream_variants": [
      "asthma",
      "rad",
      "reactive airway"
    ],
    "downstream_variants": [
      "osa",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "asthma"
    ],
    "downstream_topics": [
      "sleep_apnea",
      "osa"
    ]
  },
  {
    "upstream": "CERVICAL SPINE",
    "downstream": "OSA",
    "grade_raw": "WEAK (ordinary cervical DDD/strain) / WEAK-MODERATE (anterior cervical fusion hardware, fixed cervical kyphosis, or destructive upper-cervical / RA lesion that reduces retropharyngeal space)",
    "grade_tier": "weak-moderate",
    "verdict_anchor": "borderline",
    "framing_note": "WEAK (ordinary cervical DDD/strain) / WEAK-MODERATE (anterior cervical fusion hardware, fixed cervical kyphosis, or destructive upper-cervical / RA lesion that reduces retropharyngeal space)",
    "pmids": [
      "33007717",
      "20436381"
    ],
    "upstream_variants": [
      "cervical spine",
      "acdf",
      "adjacent segment",
      "anterior cervical discectomy",
      "cervical djd",
      "cervical fusion",
      "cervical myelopathy",
      "cervical spine osteoarthritis",
      "cervical spondylosis",
      "cervical spondylotic",
      "cervical stenosis",
      "cervical strain",
      "cervicogenic",
      "cervicogenic headache",
      "dcm",
      "degenerative cervical myelopathy",
      "dysphagia",
      "neck arthritis",
      "neck pain",
      "thoracic back pain",
      "thoracic pain",
      "whiplash",
      "whiplash associated"
    ],
    "downstream_variants": [
      "osa",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "cervical_spine"
    ],
    "downstream_topics": [
      "sleep_apnea",
      "osa"
    ]
  },
  {
    "upstream": "CHRONIC BRONCHITIS",
    "downstream": "OSA",
    "grade_raw": "MODERATE (3.310(b) overlap-aggravation of pre-existing OSA) / NOT supportable as de novo causation",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE (3.310(b) overlap-aggravation of pre-existing OSA) / NOT supportable as de novo causation",
    "pmids": [
      "20378728",
      "28169105",
      "38932721",
      "35508332"
    ],
    "upstream_variants": [
      "chronic bronchitis",
      "copd",
      "chronic obstructive",
      "chronic obstructive pulmonary",
      "emphysema"
    ],
    "downstream_variants": [
      "osa",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "copd"
    ],
    "downstream_topics": [
      "sleep_apnea",
      "osa"
    ]
  },
  {
    "upstream": "DEPRESSION",
    "downstream": "OSA",
    "grade_raw": "MODERATE (weight/antidepressant-mediated + arousal pathway) / WEAK-MODERATE (bare direct — bidirectional confounding)",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE (weight/antidepressant-mediated + arousal pathway) / WEAK-MODERATE (bare direct — bidirectional confounding)",
    "pmids": [
      "26999550",
      "25406268",
      "34270410"
    ],
    "upstream_variants": [
      "depression",
      "major depressive disorder",
      "depressive",
      "dysthym",
      "major depressive",
      "mdd",
      "persistent depressive"
    ],
    "downstream_variants": [
      "osa",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "depression"
    ],
    "downstream_topics": [
      "sleep_apnea",
      "osa"
    ]
  },
  {
    "upstream": "GERD",
    "downstream": "OSA",
    "grade_raw": "WEAK (BMI-independent association only, OR 1.53; direction not established and GERD did not affect OSA severity — associate, do not assert causation)",
    "grade_tier": "weak",
    "verdict_anchor": "borderline",
    "framing_note": "WEAK (BMI-independent association only, OR 1.53; direction not established and GERD did not affect OSA severity — associate, do not assert causation)",
    "pmids": [
      "37300443"
    ],
    "upstream_variants": [
      "gerd",
      "barrett",
      "esophageal adenocarcinoma",
      "esophageal cancer",
      "esophagit",
      "gastroesophageal reflux",
      "heartburn",
      "hiatal hernia",
      "indigestion",
      "reflux"
    ],
    "downstream_variants": [
      "osa",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "gerd"
    ],
    "downstream_topics": [
      "sleep_apnea",
      "osa"
    ]
  },
  {
    "upstream": "HYPOTHYROIDISM",
    "downstream": "OSA",
    "grade_raw": "WEAK-MODERATE (Mendelian-randomization supports a causal DIRECTION hypothyroid→OSA, OR 1.734; thin bedside/clinical cohort support, overt hypothyroidism rare in OSA)",
    "grade_tier": "weak-moderate",
    "verdict_anchor": "borderline",
    "framing_note": "WEAK-MODERATE (Mendelian-randomization supports a causal DIRECTION hypothyroid→OSA, OR 1.734; thin bedside/clinical cohort support, overt hypothyroidism rare in OSA)",
    "pmids": [
      "39719972",
      "21820299"
    ],
    "upstream_variants": [
      "hypothyroidism",
      "graves",
      "hashimoto",
      "hypothyroid",
      "levothyrox",
      "low thyroid",
      "low tsh",
      "thyroid disorder",
      "thyroidectomy",
      "underactive thyroid"
    ],
    "downstream_variants": [
      "osa",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "hypothyroidism"
    ],
    "downstream_topics": [
      "sleep_apnea",
      "osa"
    ]
  },
  {
    "upstream": "OBESITY",
    "downstream": "OSA",
    "grade_raw": "STRONG (dose-response; obesity = 3.310(a) / Walsh intermediate step when the SC condition drove documented weight gain)",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG (dose-response; obesity = 3.310(a) / Walsh intermediate step when the SC condition drove documented weight gain)",
    "pmids": [
      "11122588"
    ],
    "upstream_variants": [
      "obesity",
      "weight gain from sc condition",
      "morbid obesity",
      "overweight",
      "weight gain"
    ],
    "downstream_variants": [
      "osa",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "obesity"
    ],
    "downstream_topics": [
      "sleep_apnea",
      "osa"
    ]
  },
  {
    "upstream": "PTSD",
    "downstream": "OSA",
    "grade_raw": "MODERATE-STRONG (dual-prong: causation 3.310(a) + aggravation 3.310(b))",
    "grade_tier": "moderate-strong",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE-STRONG (dual-prong: causation 3.310(a) + aggravation 3.310(b))",
    "pmids": [
      "38913378",
      "36163136",
      "35054110",
      "28735910",
      "25665698",
      "38196691",
      "34270410",
      "22016096",
      "11122588"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "osa",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "sleep_apnea",
      "osa"
    ]
  },
  {
    "upstream": "RHINITIS",
    "downstream": "OSA",
    "grade_raw": "MODERATE — real mechanism + longitudinal cohort, but relieving nasal obstruction does NOT reliably lower objective AHI; frame AGGRAVATION/contribution 3.310(b), not sole causation",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE — real mechanism + longitudinal cohort, but relieving nasal obstruction does NOT reliably lower objective AHI; frame AGGRAVATION/contribution 3.310(b), not sole causation",
    "pmids": [
      "14665515",
      "11427099",
      "9042068",
      "34606442",
      "39361293",
      "16904855",
      "32713164",
      "30572534"
    ],
    "upstream_variants": [
      "rhinitis",
      "sinusitis",
      "nasal obstruction",
      "allergic rhinitis",
      "hay fever",
      "vasomotor rhinitis",
      "chronic rhinosinusitis",
      "chronic sinus",
      "crs",
      "nasal polyp",
      "rhinosinusitis",
      "sinus infection"
    ],
    "downstream_variants": [
      "osa",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "allergic_rhinitis",
      "rhinosinusitis"
    ],
    "downstream_topics": [
      "sleep_apnea",
      "osa"
    ]
  },
  {
    "upstream": "TBI",
    "downstream": "OSA",
    "grade_raw": "STRONG — best-in-class veteran cohort (Leng 2021, ~197k veterans, adjusted incident HR 1.28)",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG — best-in-class veteran cohort (Leng 2021, ~197k veterans, adjusted incident HR 1.28)",
    "pmids": [
      "33658328"
    ],
    "upstream_variants": [
      "tbi",
      "blast injury",
      "concussion",
      "mtbi",
      "pcs",
      "post concussion",
      "postconcussion",
      "traumatic brain injury"
    ],
    "downstream_variants": [
      "osa",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "tbi"
    ],
    "downstream_topics": [
      "sleep_apnea",
      "osa"
    ]
  },
  {
    "upstream": "ADT",
    "downstream": "osteoporosis",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "15647578",
      "11575286",
      "34421586",
      "15714259"
    ],
    "upstream_variants": [
      "adt"
    ],
    "downstream_variants": [
      "osteoporosis",
      "fragility fracture",
      "androgen deprivation",
      "bone loss",
      "bone mineral density",
      "glucocorticoid induced bone",
      "osteopenia",
      "steroid induced bone"
    ],
    "upstream_topics": [],
    "downstream_topics": [
      "osteoporosis"
    ]
  },
  {
    "upstream": "DIABETES",
    "downstream": "peripheral neuropathy",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "37536473",
      "33143626",
      "22696371",
      "33284680"
    ],
    "upstream_variants": [
      "diabetes",
      "a1c",
      "diabetes mellitus",
      "diabetic",
      "dm",
      "dm2",
      "hyperglycem",
      "insulin resist",
      "prediabetes",
      "t2d",
      "t2dm",
      "type 2 diabetes"
    ],
    "downstream_variants": [
      "peripheral neuropathy",
      "diabetic neuropathy",
      "diabetic peripheral neuropathy",
      "distal symmetric polyneuropathy",
      "dsp",
      "peripheral nerve damage",
      "polyneuropathy",
      "stocking glove"
    ],
    "upstream_topics": [
      "t2d"
    ],
    "downstream_topics": [
      "peripheral_neuropathy"
    ]
  },
  {
    "upstream": "TBI",
    "downstream": "post-traumatic epilepsy",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "9414327",
      "19233461",
      "24695268",
      "3929158",
      "28086980",
      "28076834"
    ],
    "upstream_variants": [
      "tbi",
      "blast injury",
      "concussion",
      "mtbi",
      "pcs",
      "post concussion",
      "postconcussion",
      "traumatic brain injury"
    ],
    "downstream_variants": [
      "post traumatic epilepsy",
      "seizure disorder",
      "convulsion",
      "convulsions",
      "convulsive disorder",
      "epilepsy",
      "post traumatic seizure",
      "posttraumatic epilepsy",
      "recurrent seizures",
      "seizure",
      "seizures"
    ],
    "upstream_topics": [
      "tbi"
    ],
    "downstream_topics": [
      "epilepsy"
    ]
  },
  {
    "upstream": "OBSTRUCTIVE SLEEP APNEA",
    "downstream": "pulmonary hypertension",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "16497687",
      "27000753",
      "19249442",
      "26064448"
    ],
    "upstream_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "downstream_variants": [
      "pulmonary hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn",
      "hypertension",
      "cor pulmonale",
      "elevated pulmonary artery pressure",
      "pulmonary arterial hypertension",
      "pulmonary htn"
    ],
    "upstream_topics": [
      "sleep_apnea"
    ],
    "downstream_topics": [
      "hypertension",
      "pulmonary_hypertension"
    ]
  },
  {
    "upstream": "CHRONIC KIDNEY DISEASE",
    "downstream": "secondary hyperparathyroidism",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "21454719",
      "17091124",
      "34603697",
      "28646995"
    ],
    "upstream_variants": [
      "chronic kidney disease",
      "ckd",
      "kidney disease",
      "nephropath",
      "renal insufficiency"
    ],
    "downstream_variants": [
      "secondary hyperparathyroidism",
      "ckd mbd",
      "ckd mineral bone",
      "elevated pth",
      "hyperparathyroidism",
      "renal bone disease",
      "renal osteodystrophy",
      "chronic kidney disease",
      "ckd",
      "kidney disease",
      "nephropath",
      "renal insufficiency"
    ],
    "upstream_topics": [
      "ckd"
    ],
    "downstream_topics": [
      "hyperparathyroidism",
      "ckd"
    ]
  },
  {
    "upstream": "PTSD",
    "downstream": "sleep bruxism",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "37300526",
      "40346730",
      "17313939",
      "22480810",
      "34064229"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "sleep bruxism",
      "temporomandibular disorder",
      "bruxism",
      "jaw pain",
      "myofascial jaw",
      "teeth grinding",
      "temporomandibular",
      "tmd",
      "tmj"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "tmd"
    ]
  },
  {
    "upstream": "Chronic OPIOID therapy for SC pain",
    "downstream": "sleep-disordered breathing",
    "grade_raw": "MODERATE (opioid-induced sleep-disordered breathing, dose-dependent; central-predominant / ataxic breathing — NOT classic obstructive OSA)",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE (opioid-induced sleep-disordered breathing, dose-dependent; central-predominant / ataxic breathing — NOT classic obstructive OSA)",
    "pmids": [
      "17803007"
    ],
    "upstream_variants": [
      "chronic opioid therapy for sc pain"
    ],
    "downstream_variants": [
      "sleep disordered breathing",
      "ahi",
      "cpap",
      "obstructive sleep apnea",
      "osa",
      "polysomnogr",
      "sleep apnea"
    ],
    "upstream_topics": [],
    "downstream_topics": [
      "sleep_apnea"
    ]
  },
  {
    "upstream": "HYPERTENSION",
    "downstream": "stroke",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "12493255",
      "27431356",
      "18522829",
      "31097385",
      "26724178"
    ],
    "upstream_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "downstream_variants": [
      "stroke",
      "brain infarct",
      "cerebral infarction",
      "cerebrovascular accident",
      "cva",
      "ischemic stroke"
    ],
    "upstream_topics": [
      "hypertension"
    ],
    "downstream_topics": [
      "stroke"
    ]
  },
  {
    "upstream": "OBSTRUCTIVE SLEEP APNEA",
    "downstream": "stroke",
    "grade_raw": "STRONG",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG",
    "pmids": [
      "16282178",
      "20339144",
      "23684511",
      "27188535"
    ],
    "upstream_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "downstream_variants": [
      "stroke",
      "brain infarct",
      "cerebral infarction",
      "cerebrovascular accident",
      "cva",
      "ischemic stroke"
    ],
    "upstream_topics": [
      "sleep_apnea"
    ],
    "downstream_topics": [
      "stroke"
    ]
  },
  {
    "upstream": "OBSTRUCTIVE SLEEP APNEA",
    "downstream": "type 2 diabetes",
    "grade_raw": "MODERATE",
    "grade_tier": "moderate",
    "verdict_anchor": "viable",
    "framing_note": "MODERATE",
    "pmids": [
      "19958890",
      "22988888",
      "19265062",
      "25766697",
      "21112030",
      "27914881"
    ],
    "upstream_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "downstream_variants": [
      "type 2 diabetes",
      "a1c",
      "diabetes",
      "diabetes mellitus",
      "diabetic",
      "dm",
      "dm2",
      "hyperglycem",
      "insulin resist",
      "prediabetes",
      "t2d",
      "t2dm"
    ],
    "upstream_topics": [
      "sleep_apnea"
    ],
    "downstream_topics": [
      "t2d"
    ]
  },
  {
    "upstream": "weight gain",
    "downstream": "type 2 diabetes",
    "grade_raw": "STRONG mechanism",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG mechanism",
    "pmids": [
      "20493574",
      "27402723",
      "17167471",
      "29558518"
    ],
    "upstream_variants": [
      "weight gain",
      "obesity",
      "morbid obesity",
      "overweight"
    ],
    "downstream_variants": [
      "type 2 diabetes",
      "a1c",
      "diabetes",
      "diabetes mellitus",
      "diabetic",
      "dm",
      "dm2",
      "hyperglycem",
      "insulin resist",
      "prediabetes",
      "t2d",
      "t2dm"
    ],
    "upstream_topics": [
      "obesity"
    ],
    "downstream_topics": [
      "t2d"
    ]
  },
  {
    "upstream": "MIGRAINE",
    "downstream": "vestibular migraine",
    "grade_raw": "STRONG for vestibular migraine; MODERATE for undifferentiated vertigo",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG for vestibular migraine; MODERATE for undifferentiated vertigo",
    "pmids": [
      "23142830",
      "25705201",
      "23769597",
      "11222783",
      "17000973",
      "26141381"
    ],
    "upstream_variants": [
      "migraine",
      "post traumatic headache",
      "posttraumatic headache"
    ],
    "downstream_variants": [
      "vestibular migraine",
      "vertigo",
      "migraine",
      "post traumatic headache",
      "posttraumatic headache",
      "dizziness",
      "dizzy",
      "meniere",
      "meniere's",
      "migrainous vertigo",
      "room spinning",
      "spinning sensation",
      "vestibular"
    ],
    "upstream_topics": [
      "migraine"
    ],
    "downstream_topics": [
      "migraine",
      "vertigo"
    ]
  },
  {
    "upstream": "PTSD",
    "downstream": "weight gain",
    "grade_raw": "STRONG (association)",
    "grade_tier": "strong",
    "verdict_anchor": "viable",
    "framing_note": "STRONG (association)",
    "pmids": [
      "24258147",
      "39302721",
      "29793997",
      "42006341",
      "24918858"
    ],
    "upstream_variants": [
      "ptsd",
      "combat stress",
      "post traumatic stress",
      "posttraumatic stress",
      "stress disorder",
      "suicidal ideation",
      "suicidality",
      "suicide attempt"
    ],
    "downstream_variants": [
      "weight gain",
      "obesity",
      "morbid obesity",
      "overweight"
    ],
    "upstream_topics": [
      "ptsd"
    ],
    "downstream_topics": [
      "obesity"
    ]
  }
];
