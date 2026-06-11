// app/services/conditionCanon.js
//
// PURE condition-canonicalization module (KEYSTONE extraction, 2026-06-10, task f).
//
// The CANONICAL_CONDITIONS regex table + canonicalizeCondition + canonicalizeConditionMulti
// + isCanonicalLabel were EXTRACTED VERBATIM out of framingGate.js into this dependency-free
// module so anchorMechanism.js (and the Ask-Aegis / Lambda viability path) can canonicalize
// WITHOUT pulling framingGate's heavy require-graph (better-sqlite3, llm/client, anthropicGate,
// routingResolver, the DB). framingGate.js now require()s this module and RE-EXPORTS the same
// names, so its public API is byte-identical and every existing consumer (claude.js, the linter,
// the gate itself) keeps working unchanged.
//
// NO better-sqlite3, NO llm/client, NO fs/DB. Pure regex + arrays. Keep it that way.
//
// The table below is the SINGLE SOURCE OF TRUTH for FRN condition canonicalization. Mirrors the
// regex map in app/scripts/build-pair-level-atlas-v2.py. Any edit here is an edit to every
// canonicalization consumer at once.

'use strict';

const CANONICAL_CONDITIONS = [
  ['PTSD',                              [/\bPTSD\b/i, /post.?traumatic stress/i]],
  ['MDD / Depression',                  [/\bMDD\b/i, /major depressive disorder/i, /\bmajor depression\b/i, /depressive disorder/i, /\bdepressive\b/i, /\bdepression\b/i, /\bdysthymia\b/i, /persistent depressive/i]],
  ['Anxiety / GAD',                     [/\bGAD\b/i, /generalized anxiety/i, /\banxiety disorder\b/i, /\banxiety\b/i, /panic disorder/i]],
  ['Acquired psychiatric (unspecified)',[/acquired psychiatric/i]],
  ['Insomnia',                          [/insomnia/i]],
  ['Alcohol use disorder',              [/alcohol use disorder/i, /alcohol (?:abuse|dependence)/i, /\bAUD\b/i, /alcoholism/i]],
  ['Substance use disorder',            [/substance use disorder/i, /substance (?:abuse|dependence)/i, /\bSUD\b/i, /opioid (?:use disorder|abuse|dependence)/i]],
  ['Diabetes type 2',                   [/diabetes mellitus(?:,? )?type (?:2|II)/i, /\btype 2 diabetes\b/i, /\btype II diabetes\b/i, /\bdiabetes,? type (?:2|II)\b/i, /\bT2DM\b/i, /\bDMII\b/i, /\bDM2\b/i, /\bT2D\b/i, /\b(?:adult.onset|non.insulin.dependent) diabetes\b/i]],
  // ⚠ DATA-CORRUPTION TRAP GUARD (2026-06-10): the bare "sleep apnea" alias must NOT
  // swallow "central sleep apnea" / "mixed sleep apnea" — CSA is a DISTINCT phenotype
  // (opioid→CSA must never merge with PTSD→OSA). Negative lookbehinds keep the OSA
  // catch-all from grabbing the central/mixed variants even via canonicalizeConditionMulti
  // (which returns ALL matches, so ordering alone is not enough). The distinct
  // 'Central sleep apnea' label is declared ABOVE this row so it wins the single-match too.
  ['Obstructive sleep apnea',           [/obstructive sleep apnea/i, /\bOSA\b/i, /(?<!central\s)(?<!mixed\s)\bsleep apnea\b/i]],
  ['Tinnitus',                          [/tinnitus/i]],
  ['Hearing loss',                      [/hearing loss/i, /\bSNHL\b/i, /sensorineural hearing/i]],
  ['Vertigo / Meniere',                 [/meniere/i, /vertigo/i]],
  // ⚠ DATA-CORRUPTION TRAP GUARD (2026-06-10): systemic "hypertension" must NOT swallow
  // "pulmonary hypertension" (distinct circulation; the must-lose HTN→pulmonary-HTN
  // exclusion inverts if merged), nor "portal hypertension" (a cirrhosis sequela),
  // nor "intracranial/ocular hypertension". Negative lookbehinds + the distinct
  // 'Pulmonary hypertension' label declared ABOVE keep them separate even through
  // canonicalizeConditionMulti. \bHTN\b alone is ambiguous but in practice the
  // pulmonary variant is written "pulmonary HTN" / "PAH" (handled by its own row above).
  ['Hypertension',                      [/(?<!pulmonary\s)(?<!portal\s)(?<!intracranial\s)(?<!ocular\s)(?<!venous\s)\bhypertension\b/i, /(?<!pulmonary\s)\bHTN\b/i, /high blood pressure/i, /\bHBP\b/i]],
  ['Ischemic heart disease',            [/ischemic heart disease/i, /\bIHD\b/i, /coronary artery disease/i, /\bCAD\b/i, /myocardial infarction/i]],
  ['Atrial fibrillation',               [/atrial fibrillation/i, /\bA[\s-]?fib\b/i]],
  ['Stroke / CVA',                      [/\bstroke\b/i, /\bCVA\b/i, /cerebrovascular accident/i]],
  ['GERD',                              [/\bGERD\b/i, /gastroesophageal reflux/i, /acid reflux/i]],
  ['Gastritis / ulcer',                 [/\bgastritis\b/i, /peptic ulcer/i, /\bPUD\b/i, /duodenitis/i, /\bulcer\b/i]],
  ['IBS',                               [/\bIBS\b/i, /irritable bowel/i]],
  ['Barrett esophagus',                 [/barrett/i]],
  ['Hypothyroidism',                    [/hypothyroid/i]],
  // /\bobesity\b/ guarded with neg-lookahead so "obesity hypoventilation syndrome"
  // routes to its own distinct label (OHS) rather than collapsing to Obesity.
  ['Obesity',                           [/\bobesity\b(?! hypoventilation)/i, /\bobese\b/i, /morbid(?:ly)? obese/i]],
  // ── Headache phenotype-split (2026-06-10 neuro tables §17/§3.5) ──────────────
  // TBI→post-traumatic-headache (M4), cervical→cervicogenic-headache (M3),
  // analgesic-overuse→MOH (M3) are DISTINCT diagnostic entities from migraine.
  // Declared BEFORE 'Migraines / headaches' so the phenotype wins the single-match;
  // the migraine catch-all's bare /\bheadache/ is guarded so multi-match doesn't
  // also tag these as generic migraine/headache.
  ['Post-traumatic headache',           [/post.?traumatic headache/i, /\bPTH\b/i]],
  ['Cervicogenic headache',             [/cervicogenic headache/i]],
  ['Tension headache',                  [/tension.?type headache/i, /tension headache/i]],
  ['Medication-overuse headache',       [/medication.?overuse headache/i, /\bMOH\b/i, /rebound headache/i, /analgesic.?overuse headache/i]],
  ['Migraines / headaches',             [/migraine/i, /(?<!post.?traumatic )(?<!cervicogenic )(?<!tension )(?<!tension.?type )(?<!medication.?overuse )(?<!rebound )(?<!analgesic.?overuse )\bheadache/i]],
  ['TBI',                               [/\bTBI\b/i, /traumatic brain injur/i]],
  // /\bneuropathy\b/ catch-all guarded (2026-06-10) so the distinct rated entities
  // optic-neuropathy and autonomic-neuropathy are not swallowed. "diabetic
  // neuropathy" / "diabetic PN" INTENTIONALLY still maps here (diabetes→diabetic-PN
  // downstream IS peripheral neuropathy).
  ['Peripheral neuropathy',             [/peripheral neuropathy/i, /(?<!optic )(?<!autonomic )\bneuropathy\b/i]],
  ['Fibromyalgia',                      [/fibromyalgia/i]],
  ['Chronic pain syndrome',             [/chronic pain syndrome/i, /\bchronic pain\b/i]],
  ['Lumbar / back',                     [/lumbar (?:spine|strain|disc|degenerative)/i, /\blow.?back\b/i, /\bback (?:pain|strain|disability|condition|injury)\b/i, /lumbosacral/i]],
  ['Cervical / neck',                   [/cervical (?:spine|strain|disc|degenerative)/i, /\bneck (?:pain|strain|disability|condition|injury)\b/i]],
  ['Knee',                              [/\bknee\b/i]],
  ['Shoulder',                          [/\bshoulder\b/i, /rotator cuff/i]],
  ['Hip',                               [/\bhip\b/i]],
  ['Ankle',                             [/\bankle\b/i]],
  ['Wrist',                             [/\bwrist\b/i]],
  ['Radiculopathy',                     [/radiculopath/i]],
  ['Carpal tunnel',                     [/carpal tunnel/i]],
  ['TMJ',                               [/\bTMJ\b/i, /temporomandibular/i]],
  ['Plantar fasciitis / foot',          [/plantar fasciit/i, /pes planus/i, /flat ?feet/i]],
  // ── Psoriasis / psoriatic-arthritis split (2026-06-10 rheum §5 + derm §3) ────
  // 'Psoriatic arthritis' (SC-psoriasis→PsA M4, psoriasis→psoriatic-spondylitis)
  // and 'Psoriasis' (a distinct upstream for PsA + a downstream of PTSD-flare/AS)
  // are declared BEFORE the coarse 'Skin (...)' so they are not swallowed. The
  // skin catch-all's /psoriasis/ is guarded so "psoriatic arthritis" / bare
  // "psoriasis" route to their own labels via multi-match.
  ['Psoriatic arthritis',               [/psoriatic arthritis/i, /psoriatic spondylitis/i, /\bPsA\b/i]],
  ['Psoriasis',                         [/(?<!psoriatic )\bpsoriasis\b/i, /plaque psoriasis/i]],
  // /\bdermatitis\b/ catch-all guarded so 'Stasis dermatitis' (a distinct rated
  // entity: CVI→stasis-dermatitis M4/blessed) is not swallowed by coarse Skin.
  ['Skin (eczema/psoriasis/dermatitis)',[/eczema/i, /atopic dermatitis/i, /seborrheic dermatitis/i, /(?<!stasis )\bdermatitis\b/i]],
  // ── Rhinitis/sinus phenotype-split (2026-06-10 ENT §7 + allergy §11A) ───────
  // allergic-rhinitis is a DISTINCT upstream anchor (AR→asthma united-airway,
  // AR→CRS, AR→OSA) — declared BEFORE the coarse 'Sinusitis / rhinitis' so it
  // wins. Chronic rhinosinusitis (CRS) likewise (asthma→CRS, AR→CRS, burn-pit→CRS).
  ['Allergic rhinitis',                 [/allergic rhinitis/i, /vasomotor rhinitis/i, /hay fever/i]],
  ['Chronic rhinosinusitis',            [/chronic rhinosinusitis/i, /\bCRS\b/i, /chronic sinusitis/i, /nasal polyp/i]],
  ['Sinusitis / rhinitis',              [/\bsinusitis\b/i, /(?<!allergic )(?<!vasomotor )\brhinitis\b/i, /chronic sinus/i]],
  ['Asthma',                            [/\basthma\b/i]],
  ['COPD',                              [/\bCOPD\b/i, /chronic obstructive pulmonary/i, /emphysema/i]],
  ['Erectile dysfunction',              [/erectile dysfunction/i, /\bimpotence\b/i]],

  // ════════════════════════════════════════════════════════════════════════════
  // 2026-06-10 CANON EXPANSION — 18-domain anchor-map coverage (KEYSTONE UNBLOCK).
  // Adds the downstream/intermediate/upstream conditions the specialist-authored
  // anchor tables (docs/ANCHOR_MAP_AUTHORED_TABLES_2026-06-10.md, ~865 rows) need
  // so they can author into references/anchor_mechanism_authored.json. ADDITIVE:
  // the prior 43 labels above are unchanged in behavior (the OSA/HTN/headache/
  // rhinitis/psoriasis guards above are the only edits to existing rows, and they
  // only REMOVE a wrong swallow). Within this block, SPECIFIC phenotypes precede
  // their generic parent and use guarded patterns so distinct rated entities never
  // merge (the central-sleep-apnea / pulmonary-hypertension class of corruption).
  // The two distinct-phenotype TRAP labels (Central sleep apnea, Pulmonary
  // hypertension) are order-independent here because the OSA/HTN rows above already
  // carry negative-lookbehind guards.
  // ════════════════════════════════════════════════════════════════════════════

  // ── 1. NEPHROLOGY ───────────────────────────────────────────────────────────
  ['Diabetic nephropathy',              [/diabetic nephropathy/i, /diabetic kidney disease/i]],
  ['Hypertensive nephrosclerosis',      [/hypertensive nephrosclerosis/i, /hypertensive kidney/i, /nephrosclerosis/i]],
  ['Lupus nephritis',                   [/lupus nephritis/i]],
  ['Nephrotic syndrome',                [/nephrotic syndrome/i, /nephrotic/i]],
  ['Glomerulonephritis',                [/glomerulonephritis/i, /\bGN\b/i, /\bMPGN\b/i, /\bIgA nephropathy\b/i]],
  ['Nephrolithiasis',                   [/nephrolithiasis/i, /kidney stone/i, /renal stone/i, /urolithiasis/i, /struvite stone/i, /uric.?acid stone/i]],
  ['Renal tubular acidosis',            [/renal tubular acidosis/i, /\bRTA\b/i]],
  ['Renal anemia',                      [/renal anemia/i, /anemia of (?:chronic )?(?:kidney|renal)/i, /anemia of CKD/i]],
  ['Secondary hyperparathyroidism',     [/secondary hyperparathyroidism/i, /secondary hyperPTH/i, /renal osteodystrophy/i, /CKD.?MBD/i]],
  ['Proteinuria',                       [/proteinuria/i, /albuminuria/i]],
  ['ESRD',                              [/\bESRD\b/i, /end.?stage renal/i, /end.?stage kidney/i, /dialysis.?dependent/i]],
  // CKD declared AFTER its specific variants so "diabetic nephropathy" etc. win.
  ['CKD / chronic kidney disease',      [/chronic kidney disease/i, /\bCKD\b/i, /chronic renal (?:failure|insufficiency|disease)/i, /\bnephropathy\b/i]],

  // ── 2. ONCOLOGY (most are presumptive-preempt; canon needed for routing) ─────
  ['Esophageal cancer',                 [/esophageal (?:cancer|carcinoma|adenocarcinoma)/i, /cancer of the esophagus/i]],
  ['Gastric cancer',                    [/gastric (?:cancer|carcinoma|adenocarcinoma)/i, /stomach cancer/i, /\bMALT lymphoma\b/i]],
  ['Colorectal cancer',                 [/colorectal cancer/i, /colon cancer/i, /rectal cancer/i, /colorectal carcinoma/i]],
  ['Hepatocellular carcinoma',          [/hepatocellular carcinoma/i, /\bHCC\b/i, /liver cancer/i]],
  ['Lung cancer',                       [/lung cancer/i, /bronchogenic carcinoma/i, /lung (?:adeno)?carcinoma/i, /non.?small cell lung/i, /small cell lung/i]],
  ['Bladder cancer',                    [/bladder cancer/i, /urothelial carcinoma/i, /transitional cell carcinoma/i]],
  ['Kidney cancer',                     [/kidney cancer/i, /renal cell carcinoma/i, /\bRCC\b/i]],
  ['Prostate cancer',                   [/prostate cancer/i, /prostatic (?:adeno)?carcinoma/i]],
  ['Lymphoma',                          [/\blymphoma\b/i, /non.?hodgkin/i, /hodgkin/i]],
  ['Leukemia',                          [/leukemia/i, /\bCLL\b/i, /hairy.?cell/i]],
  ['Multiple myeloma',                  [/multiple myeloma/i, /\bMGUS\b/i]],
  ['Melanoma',                          [/melanoma/i]],
  ['Squamous cell carcinoma (skin)',    [/squamous cell carcinoma/i, /\bSCC\b/i, /marjolin/i, /cutaneous SCC/i]],
  ['Mesothelioma',                      [/mesothelioma/i]],
  ['Thyroid cancer',                    [/thyroid cancer/i, /thyroid carcinoma/i]],

  // ── 3. DERMATOLOGY (specific rated dermatoses; coarse Skin label still above) ─
  ['Stasis dermatitis',                 [/stasis dermatitis/i, /venous (?:stasis )?dermatitis/i]],
  ['Chronic urticaria',                 [/chronic urticaria/i, /\burticaria\b/i, /angioedema/i, /hives/i]],
  ['Vitiligo',                          [/vitiligo/i]],
  ['Alopecia areata',                   [/alopecia areata/i, /\balopecia\b/i]],
  ['Hidradenitis suppurativa',          [/hidradenitis/i, /\bHS\b(?=.*suppurativa)/i]],
  ['Rosacea',                           [/rosacea/i]],
  ['Lichen planus',                     [/lichen planus/i]],
  ['Keloid / hypertrophic scar',        [/keloid/i, /hypertrophic scar/i]],
  ['Cellulitis',                        [/cellulitis/i, /erysipelas/i]],
  ['Lymphedema',                        [/lymphedema/i, /lymphostatic/i]],

  // ── 4. OPHTHALMOLOGY ────────────────────────────────────────────────────────
  ['Diabetic retinopathy',              [/diabetic retinopathy/i, /\bDR\b(?=.*retinopath)/i, /proliferative (?:diabetic )?retinopathy/i, /\bPDR\b/i]],
  ['Hypertensive retinopathy',          [/hypertensive retinopathy/i]],
  ['Glaucoma',                          [/glaucoma/i, /\bPOAG\b/i, /\bNTG\b/i, /angle.?recession/i, /neovascular glaucoma/i]],
  ['Cataract',                          [/cataract/i]],
  ['NAION',                             [/\bNAION\b/i, /non.?arteritic.*optic neuropathy/i, /anterior ischemic optic neuropathy/i, /\bAION\b/i]],
  ['Dry eye disease',                   [/dry eye/i, /\bDED\b/i, /keratoconjunctivitis sicca/i, /aqueous.?deficient/i]],
  ['Uveitis',                           [/uveitis/i, /\biritis\b/i]],
  ['Retinal vascular occlusion',        [/retinal vein occlusion/i, /\bRVO\b/i, /retinal artery occlusion/i, /\bRAO\b/i]],
  ['Optic neuritis',                    [/optic neuritis/i]],
  ['Central serous retinopathy',        [/central serous (?:retinopathy|chorioretinopathy)/i, /\bCSCR\b/i, /\bCSR\b(?=.*retinopath)/i]],
  ['Traumatic optic neuropathy',        [/traumatic optic neuropathy/i]],
  ['Macular degeneration',              [/macular degeneration/i, /\bAMD\b/i]],

  // ── 5. RHEUMATOLOGY ─────────────────────────────────────────────────────────
  ['Gout',                              [/\bgout\b/i, /gouty arthritis/i, /urate nephropathy/i, /tophaceous/i]],
  ['Rheumatoid arthritis',              [/rheumatoid arthritis/i, /\bRA\b(?=.*(?:arthritis|rheumatoid))/i]],
  ['SLE / lupus',                       [/systemic lupus/i, /\bSLE\b/i, /\blupus\b(?! nephritis)/i, /discoid lupus/i, /drug.?induced lupus/i, /\bDILE\b/i]],
  ['Ankylosing spondylitis',            [/ankylosing spondylitis/i, /axial spondyloarthritis/i, /\baxSpA\b/i, /\bAS\b(?=.*spond)/i, /psoriatic spondylitis/i]],
  // ('Fibromyalgia' already exists in the original 43 labels above — not duplicated.)
  ['Chronic fatigue syndrome',          [/chronic fatigue syndrome/i, /\bCFS\b/i, /\bME\/CFS\b/i, /myalgic encephalomyelitis/i]],
  ['Sjogren syndrome',                  [/sj(?:o|ö)gren/i]],
  ['Sarcoidosis',                       [/sarcoidosis/i, /sarcoid/i]],
  ['Scleroderma',                       [/scleroderma/i, /systemic sclerosis/i]],
  ['Avascular necrosis',                [/avascular necrosis/i, /osteonecrosis/i, /\bAVN\b/i]],
  ['Vasculitis',                        [/vasculitis/i, /cryoglobulinemic/i, /\bGPA\b/i, /\bPAN\b(?=.*vasculit)/i]],
  ['Raynaud phenomenon',                [/raynaud/i, /\bHAVS\b/i, /hand.?arm vibration/i]],
  ['Reactive arthritis',               [/reactive arthritis/i, /\bReA\b/i, /reactive arthropathy/i]],
  ['CPPD',                              [/\bCPPD\b/i, /pseudogout/i, /calcium pyrophosphate/i]],
  ['Polymyalgia rheumatica',            [/polymyalgia rheumatica/i, /\bPMR\b/i]],
  ['Inflammatory myopathy',             [/inflammatory myopathy/i, /\bIMNM\b/i, /polymyositis/i, /dermatomyositis/i]],
  ['Bursitis / tendinitis',             [/bursitis/i, /tendinitis/i, /tendinopathy/i, /epicondylitis/i, /tendonitis/i]],

  // ── 6. UROLOGY / GU ─────────────────────────────────────────────────────────
  ['BPH / LUTS',                        [/benign prostatic hyperplasia/i, /\bBPH\b/i, /\bLUTS\b/i, /lower urinary tract symptom/i, /prostatic hypertrophy/i]],
  ['Neurogenic bladder',                [/neurogenic bladder/i, /detrusor (?:hyperreflexia|areflexia)/i]],
  ['Overactive bladder',                [/overactive bladder/i, /\bOAB\b/i, /\bnocturia\b/i]],
  ['Urinary incontinence',              [/urinary incontinence/i, /stress incontinence/i, /urge incontinence/i]],
  ['Chronic prostatitis / CPPS',        [/chronic prostatitis/i, /\bCPPS\b/i, /chronic pelvic pain syndrome/i]],
  ['Interstitial cystitis',             [/interstitial cystitis/i, /bladder pain syndrome/i]],
  ['Recurrent UTI',                     [/recurrent (?:UTI|urinary tract infection)/i, /recurrent cystitis/i]],
  ['Peyronie disease',                  [/peyronie/i]],
  ['Urethral stricture',               [/urethral stricture/i]],
  ['Retrograde ejaculation',            [/retrograde ejaculation/i]],
  ['Male infertility',                  [/male infertility/i, /\boligospermia\b/i, /\bazoospermia\b/i]],
  ['Hypogonadism',                      [/hypogonadism/i, /\bOPIAD\b/i, /low testosterone/i, /testosterone deficiency/i, /\bTRT\b(?=.*deficien)/i]],
  ['Female sexual dysfunction',         [/female sexual dysfunction/i, /\bFSD\b/i, /dyspareunia/i, /vaginismus/i]],
  ['Chronic pelvic pain',               [/chronic pelvic pain/i, /\bCPP\b/i]],

  // ── 7. ENT / OTOLARYNGOLOGY ─────────────────────────────────────────────────
  ['Chronic otitis media',              [/chronic otitis media/i, /serous otitis/i, /chronic otitis/i]],
  ['Eustachian tube dysfunction',       [/eustachian tube dysfunction/i, /\bETD\b/i, /aural fullness/i, /barotrauma/i]],
  ['BPPV',                              [/\bBPPV\b/i, /benign paroxysmal positional/i]],
  ['Vestibular dysfunction',            [/vestibular (?:dysfunction|migraine|disorder)/i, /peripheral vertigo/i, /labyrinthine/i]],
  ['Dysphagia',                         [/dysphagia/i, /swallowing (?:difficulty|disorder)/i]],
  ['LPR / chronic laryngitis',          [/laryngopharyngeal reflux/i, /\bLPR\b/i, /chronic laryngitis/i]],
  ['Vocal cord dysfunction',            [/vocal cord dysfunction/i, /\bVCD\b/i]],
  ['Hyperacusis',                       [/hyperacusis/i]],
  ['Anosmia',                           [/anosmia/i, /parosmia/i, /\bsmell loss\b/i]],
  ['Chronic cough',                     [/chronic cough/i]],
  ['Epistaxis',                         [/epistaxis/i, /recurrent nosebleed/i]],

  // ── 8. PULMONOLOGY ──────────────────────────────────────────────────────────
  // Pulmonary hypertension is the TRAP label — distinct from systemic HTN above.
  ['Pulmonary hypertension',            [/pulmonary hypertension/i, /pulmonary htn/i, /\bPAH\b/i, /\bPH\b(?=.*pulmonary)/i]],
  ['Chronic bronchitis',                [/chronic bronchitis/i]],
  ['Bronchiectasis',                    [/bronchiectasis/i]],
  ['Constrictive bronchiolitis',        [/constrictive bronchiolitis/i, /obliterative bronchiolitis/i, /bronchiolitis obliterans/i]],
  ['Interstitial lung disease',         [/interstitial lung disease/i, /\bILD\b/i, /pulmonary fibrosis/i, /\bIPF\b/i, /hypersensitivity pneumonitis/i]],
  ['Obesity hypoventilation syndrome',  [/obesity hypoventilation/i, /\bOHS\b/i]],
  ['Restrictive lung disease',          [/restrictive lung disease/i, /restrictive (?:lung )?(?:defect|physiology)/i]],
  ['Aspiration pneumonia',              [/aspiration pneumonia/i]],
  ['Chronic respiratory failure',       [/chronic respiratory failure/i, /respiratory failure/i]],

  // ── 9. HEMATOLOGY ───────────────────────────────────────────────────────────
  ['DVT / VTE',                         [/deep vein thrombosis/i, /\bDVT\b/i, /venous thromboembolism/i, /\bVTE\b/i, /paget.?schroetter/i]],
  ['Pulmonary embolism',                [/pulmonary embolism/i, /\bPE\b(?=.*pulmonary)/i]],
  ['Iron deficiency anemia',            [/iron.?deficiency anemia/i, /\bIDA\b/i]],
  ['Anemia of chronic disease',         [/anemia of chronic disease/i, /\bACD\b(?=.*anemia)/i]],
  ['B12 deficiency anemia',             [/b12 (?:deficiency )?anemia/i, /megaloblastic anemia/i, /pernicious anemia/i]],
  ['Thrombocytopenia',                  [/thrombocytopenia/i, /\bITP\b/i, /\bHIT\b/i]],
  ['Leukopenia / neutropenia',          [/leukopenia/i, /neutropenia/i, /agranulocytosis/i]],
  ['Pancytopenia',                      [/pancytopenia/i, /aplastic anemia/i]],
  ['Polycythemia',                      [/polycythemia/i, /erythrocytosis/i]],
  ['Iron overload',                     [/iron overload/i, /hemochromatosis/i, /\bHFE\b/i]],
  // Generic 'Anemia' last so specific phenotypes win.
  ['Anemia',                            [/\banemia\b/i]],

  // ── 10. HEPATOLOGY / lower-GI ───────────────────────────────────────────────
  ['NAFLD / NASH',                      [/\bNAFLD\b/i, /\bNASH\b/i, /non.?alcoholic (?:fatty liver|steatohepatitis)/i, /fatty liver/i, /hepatic steatosis/i]],
  ['Cirrhosis',                         [/cirrhosis/i, /alcoholic liver disease/i, /\bALD\b(?=.*liver)/i]],
  ['Portal hypertension',               [/portal hypertension/i, /esophageal varices/i, /\bascites\b/i]],
  ['Hepatic encephalopathy',            [/hepatic encephalopathy/i]],
  ['Chronic pancreatitis',              [/chronic pancreatitis/i, /pancreatitis/i]],
  ['Exocrine pancreatic insufficiency', [/exocrine pancreatic insufficiency/i, /\bEPI\b(?=.*pancrea)/i, /pancreatic insufficiency/i]],
  ['Cholelithiasis',                    [/cholelithiasis/i, /gallstone/i, /cholecystitis/i, /biliary/i]],
  ['IBD / Crohn / UC',                  [/inflammatory bowel disease/i, /\bIBD\b/i, /crohn/i, /ulcerative colitis/i, /\bUC\b(?=.*colitis)/i, /microscopic colitis/i]],
  ['Diverticular disease',              [/diverticular disease/i, /diverticulosis/i, /diverticulitis/i]],
  ['Hemorrhoids',                       [/hemorrhoid/i]],
  ['Anal fissure',                      [/anal fissure/i]],
  ['Fecal incontinence',                [/fecal incontinence/i, /neurogenic bowel/i]],
  ['Constipation / OIC',                [/opioid.?induced constipation/i, /\bOIC\b/i, /chronic constipation/i, /\bconstipation\b/i]],
  ['Gastroparesis',                     [/gastroparesis/i]],

  // ── 11. ENDOCRINE ───────────────────────────────────────────────────────────
  ['Hyperlipidemia',                    [/hyperlipidemia/i, /dyslipidemia/i, /hypercholesterolemia/i, /\bhigh cholesterol\b/i]],
  ['Metabolic syndrome',                [/metabolic syndrome/i]],
  ['Hyperthyroidism',                   [/hyperthyroid/i, /thyrotoxicosis/i, /graves/i]],
  ['Osteoporosis',                      [/osteoporosis/i, /\bGIOP\b/i, /osteopenia/i, /fragility fracture/i]],
  ['Adrenal insufficiency',             [/adrenal insufficiency/i, /addison/i]],
  ['Cushing syndrome',                  [/cushing/i]],
  ['Hyperprolactinemia',                [/hyperprolactinemia/i, /prolactinoma/i]],
  ['Hypopituitarism',                   [/hypopituitarism/i, /pituitary insufficiency/i, /panhypopituitar/i]],
  ['Gynecomastia',                      [/gynecomastia/i]],
  ['Pre-diabetes',                      [/pre.?diabetes/i, /impaired (?:glucose|fasting)/i, /prediabetes/i]],
  ['Type 3c diabetes',                  [/type 3c diabetes/i, /pancreatogenic diabetes/i, /\bT3cDM\b/i]],
  ['Steroid-induced diabetes',          [/steroid.?induced diabetes/i, /glucocorticoid.?induced diabetes/i, /steroid diabetes/i]],

  // ── 12. NEUROLOGY (headache phenotypes handled above) ───────────────────────
  ['Seizure / epilepsy',                [/\bseizure\b/i, /epilepsy/i, /post.?traumatic epilepsy/i, /\bPTE\b/i]],
  ['Cognitive disorder / NCD',          [/neurocognitive disorder/i, /\bNCD\b/i, /cognitive (?:impairment|disorder)/i, /\bdementia\b/i]],
  ['Cubital tunnel',                    [/cubital tunnel/i, /ulnar (?:neuropathy|entrapment)/i]],
  ['Tarsal tunnel',                     [/tarsal tunnel/i]],
  ['Multiple sclerosis',                [/multiple sclerosis/i, /\bMS\b(?=.*sclerosis)/i]],
  ['CRPS',                              [/\bCRPS\b/i, /complex regional pain/i, /reflex sympathetic dystrophy/i, /\bRSD\b/i, /causalgia/i]],
  ['Bell palsy',                        [/bell'?s? palsy/i, /facial (?:nerve )?palsy/i]],
  ['Trigeminal neuralgia',              [/trigeminal neuralgia/i]],
  ['Autonomic neuropathy',              [/autonomic neuropathy/i, /dysautonomia/i]],

  // ── 13. SLEEP (Central sleep apnea is the TRAP label — distinct from OSA) ────
  ['Central sleep apnea',               [/central sleep apnea/i, /\bCSA\b/i, /cheyne.?stokes/i, /mixed sleep apnea/i]],
  ['Circadian rhythm disorder',         [/circadian rhythm disorder/i, /circadian disruption/i, /shift work disorder/i]],
  ['Hypersomnia',                       [/hypersomnia/i, /\bEDS\b(?=.*sleep)/i]],
  ['Narcolepsy',                        [/narcolepsy/i]],
  ['REM behavior disorder',             [/rem (?:sleep )?behavior disorder/i, /\bRBD\b/i]],
  ['Nightmare disorder',                [/nightmare disorder/i, /\bTASD\b/i, /trauma.?associated sleep/i, /\bnightmares\b/i]],
  ['Restless legs syndrome',            [/restless legs?/i, /\bRLS\b/i, /periodic limb movement/i, /\bPLMD\b/i]],

  // ── 14. CARDIOLOGY (HTN/IHD/AFib/Stroke exist above) ────────────────────────
  ['Heart failure',                     [/heart failure/i, /\bCHF\b/i, /\bHFpEF\b/i, /\bHFrEF\b/i, /cardiomyopathy/i, /congestive heart/i]],
  ['Peripheral artery disease',         [/peripheral artery disease/i, /peripheral arterial disease/i, /\bPAD\b/i, /claudication/i]],
  ['Left ventricular hypertrophy',      [/left ventricular hypertrophy/i, /\bLVH\b/i, /hypertensive heart disease/i]],
  ['Aortic aneurysm',                   [/aortic aneurysm/i, /\bAAA\b/i]],
  ['Carotid artery disease',            [/carotid (?:artery )?(?:disease|stenosis)/i, /carotid atherosclerosis/i]],

  // ── 15. ALLERGY / GYN / PAIN / DENTAL ───────────────────────────────────────
  ['Food allergy',                      [/food allergy/i, /\banaphylaxis\b/i]],
  ['Allergic conjunctivitis',           [/allergic conjunctivitis/i]],
  ['Eosinophilic esophagitis',          [/eosinophilic esophagitis/i, /\bEoE\b/i]],
  ['CVID',                              [/\bCVID\b/i, /common variable immunodeficiency/i]],
  ['Endometriosis',                     [/endometriosis/i]],
  ['PCOS',                              [/\bPCOS\b/i, /polycystic ovar/i]],
  ['Uterine fibroids',                  [/uterine fibroid/i, /\bleiomyoma\b/i, /\bmyoma\b/i]],
  ['Dysmenorrhea',                      [/dysmenorrhea/i, /menstrual dysregulation/i, /menorrhagia/i]],
  // NOTE: OUD is NOT a separate canonical here — "opioid use disorder" already
  // canonicalizes to 'Substance use disorder' (declared above, the rated VA entity
  // SUD collapses opioid/substance use). Authored OUD rows use 'Substance use disorder'.
  ['Xerostomia',                        [/xerostomia/i, /dry mouth/i]],
  ['Dental erosion / caries',           [/dental erosion/i, /dental caries/i, /periodontal/i, /periodontitis/i, /tooth (?:decay|erosion)/i]],
  ['Bruxism',                           [/bruxism/i, /teeth grinding/i]],
  ['Sialadenitis',                      [/sialadenitis/i, /salivary gland/i]],
];
function canonicalizeCondition(text) {
  if (!text || typeof text !== 'string') return null;
  for (const [name, patterns] of CANONICAL_CONDITIONS) {
    for (const re of patterns) {
      if (re.test(text)) return name;
    }
  }
  return null;
}

// Multi-match variant — returns ALL canonical names that match the text.
function canonicalizeConditionMulti(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = [];
  for (const [name, patterns] of CANONICAL_CONDITIONS) {
    for (const re of patterns) {
      if (re.test(text)) {
        if (!matches.includes(name)) matches.push(name);
        break; // one pattern per canonical is enough
      }
    }
  }
  return matches;
}

// The canonical label set (the output strings of canonicalizeCondition). Several labels
// (e.g. "Lumbar / back", "Cervical / neck", "Diabetes type 2") are valid outputs that do NOT
// match their own regex patterns, so canonicalizeCondition(label) returns null for them. Use
// isCanonicalLabel() to test membership without a round-trip.
const CANONICAL_CONDITION_LABELS = CANONICAL_CONDITIONS.map(([name]) => name);
function isCanonicalLabel(s) { return CANONICAL_CONDITIONS.some(([name]) => name === s); }

module.exports = {
  CANONICAL_CONDITIONS,
  canonicalizeCondition,
  canonicalizeConditionMulti,
  CANONICAL_CONDITION_LABELS,
  isCanonicalLabel,
};
