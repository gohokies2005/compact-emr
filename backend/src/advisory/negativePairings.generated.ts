// AUTO-VENDORED from flatratenexus-project/references/medical_literature/curated/negative_pairings.json
// by backend/scripts/vendor-negative-pairings.cjs. DO NOT hand-edit — re-run the script on any source change.
// Source of truth is FRN's negative_pairings.md (built to .json via `npm run negatives:build`).
// INTERNAL physician strategy: reason / counterargument / PMIDs are advisory to the RN/physician and are
// NEVER quoted in a letter (CLAUDE.md #17).
import type { NegativePairing } from './negativePairingLookup.js';

export const NEGATIVE_PAIRINGS_SOURCE_VERSION = "1.0";

export const NEGATIVE_PAIRINGS: readonly NegativePairing[] = [
  {
    "upstream": "migraine",
    "claimed": "obstructive sleep apnea",
    "verdict": "not_supportable",
    "caution": false,
    "reason": "No physiologic pathway by which a migraine/headache disorder increases upper-airway collapsibility or destabilizes ventilatory control (the determinants of obstructive apnea). Migraine is a neurovascular trigeminovascular pain disorder; OSA is an anatomic/upper-airway + ventilatory-control disorder. Where a causal arrow exists in the evidence it runs the REVERSE direction (OSA→migraine), and the best population data show no association in either direction.",
    "counterargument": "(a) genetic causal (Mendelian randomization) evidence runs OSA→migraine, not migraine→OSA; (b) the largest cohort found no association (OR 0.98); (c) the only sleep disorder migraine tracks with is insomnia, not sleep-disordered breathing; (d) any co-occurrence is confounded by shared risk factors (obesity, depression/anxiety, TMD).",
    "pmids": [
      "39881850",
      "40105250",
      "38056382"
    ],
    "upstream_variants": [
      "migraine",
      "chronic headache disorder",
      "post traumatic headache",
      "posttraumatic headache"
    ],
    "claimed_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "migraine"
    ],
    "claimed_topics": [
      "sleep_apnea"
    ]
  },
  {
    "upstream": "tinnitus",
    "claimed": "obstructive sleep apnea",
    "verdict": "not_supportable",
    "caution": false,
    "reason": "Tinnitus is a subjective auditory perception generated in the cochlea/auditory pathway; it has no efferent route to pharyngeal muscle tone, upper-airway caliber, or central respiratory drive. The entire literature runs the other way (OSA→tinnitus, via nocturnal hypoxia / cochlear vascular injury and acoustic energy from snoring).",
    "counterargument": "(a) no biological plausibility for perceiving ear-ringing to narrow/collapse the airway; (b) the supporting evidence shows OSA causing tinnitus, or a non-causal association driven by shared risk factors (age, obesity, noise). Asserting tinnitus aggravated the veteran's OSA inverts the established causal arrow.",
    "pmids": [
      "38321723",
      "39841314",
      "36292063"
    ],
    "upstream_variants": [
      "tinnitus",
      "ear ringing",
      "ears ringing",
      "head noise",
      "ringing in",
      "ringing in ears"
    ],
    "claimed_variants": [
      "obstructive sleep apnea",
      "ahi",
      "cpap",
      "osa",
      "polysomnogr",
      "sleep apnea",
      "sleep disordered breathing"
    ],
    "upstream_topics": [
      "tinnitus"
    ],
    "claimed_topics": [
      "sleep_apnea"
    ]
  },
  {
    "upstream": "tinnitus",
    "claimed": "migraine",
    "verdict": "not_supportable",
    "caution": false,
    "reason": "No abstract states tinnitus causes or aggravates migraine. Where a direction is asserted, migraine is the driver producing auditory phenotypes including tinnitus (migraine→tinnitus); otherwise the relationship is a shared central/trigeminal mechanism and simple comorbidity. A shared upstream substrate does not establish that one symptom causes the other.",
    "counterargument": "tinnitus and migraine are co-travelers of a common neurological substrate (trigeminal/auditory central sensitization), not cause-and-effect; if any arrow exists it points migraine→tinnitus, so the service-connected tinnitus cannot be the medical cause of a later-claimed migraine. Comorbidity/shared-etiology fails the \"caused or aggravated by\" standard.",
    "pmids": [
      "42249307",
      "41612541",
      "42168216"
    ],
    "upstream_variants": [
      "tinnitus",
      "ear ringing",
      "ears ringing",
      "head noise",
      "ringing in",
      "ringing in ears"
    ],
    "claimed_variants": [
      "migraine",
      "headache",
      "post traumatic headache",
      "posttraumatic headache"
    ],
    "upstream_topics": [
      "tinnitus"
    ],
    "claimed_topics": [
      "migraine"
    ]
  },
  {
    "upstream": "ischemic heart disease",
    "claimed": "hypertension",
    "verdict": "not_supportable",
    "caution": false,
    "reason": "The established causal arrow is the REVERSE — hypertension → IHD. Chronic pressure load drives endothelial injury and accelerated coronary atherosclerosis, so HTN is a leading cause of IHD, not its consequence. No credible literature supports IHD causing/aggravating essential hypertension; physiologically, IHD/post-MI states (pump failure, reduced cardiac output) more often LOWER systemic BP.",
    "counterargument": "rating IHD as upstream and HTN as secondary inverts accepted pathophysiology — the far more likely picture is that pre-existing HTN drove the coronary disease. (A narrow renovascular/cardiorenal argument is a different pairing and would need specific renal-artery/kidney evidence.)",
    "pmids": [
      "41886200"
    ],
    "upstream_variants": [
      "ischemic heart disease",
      "ihd",
      "coronary artery disease",
      "angina",
      "cad",
      "cardiovascular",
      "coronary",
      "heart disease",
      "ischemic heart",
      "myocardial infarct",
      "nstemi",
      "stemi"
    ],
    "claimed_variants": [
      "hypertension",
      "elevated blood pressure",
      "hbp",
      "high blood pressure",
      "htn"
    ],
    "upstream_topics": [
      "cardiovascular"
    ],
    "claimed_topics": [
      "hypertension"
    ]
  },
  {
    "upstream": "obstructive sleep apnea",
    "claimed": "GERD",
    "verdict": "not_supportable",
    "caution": true,
    "reason": "The intuitive theory (apneic negative intrathoracic pressure → trans-LES gradient → reflux) is DIRECTLY REFUTED by manometry: during apneic negative-pressure swings, compensatory rises in upper-esophageal-sphincter and gastroesophageal-junction pressure actually PREVENT reflux, and the sleep-reflux that does occur in OSA is driven by arousal-related transient LES relaxations (TLESR), not pressure. The broader association is real but obesity-confounded and bidirectional.",
    "counterargument": "obesity (not OSA per se) drives the reflux (AHI shows no independent association with GER severity); the mechanism a nexus would invoke is disproven; directionality is contestable (reflux can provoke airway events). IF argued at all, a letter must lead with arousal-TLESR + the BMI-adjusted association + CPAP treatment-response — NEVER the pressure-gradient claim.",
    "pmids": [
      "20236246",
      "26446244",
      "38531547"
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
    "claimed_variants": [
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
      "sleep_apnea"
    ],
    "claimed_topics": [
      "gerd"
    ]
  }
];
