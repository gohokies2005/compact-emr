import { assessMechanismViability } from '../src/services/mechanism-viability.js';
const OSA_UPPER = 'OSA results from repetitive collapse of the pharyngeal (UPPER) airway; risk factors are obesity, craniofacial anatomy, ventilatory-control instability. (PMID:30000002)';
const cases = [
  { claimed: 'obstructive sleep apnea', upstream: 'burn pit / airborne hazard exposure', chunks: ['Airborne hazards / open burn pits cause deployment-related LOWER-airway disease: chronic bronchitis, constrictive bronchiolitis, asthma, restrictive lung disease. (PMID:30000001)', OSA_UPPER], want: ['not_viable','borderline'] },
  { claimed: 'obstructive sleep apnea', upstream: 'PTSD', chunks: ['PTSD is associated with worse OSA severity and lower CPAP adherence; hyperarousal and fragmented sleep are proposed aggravation mechanisms. (PMID:31000001)', OSA_UPPER], want: ['viable','borderline'] },
  { claimed: 'obstructive sleep apnea', upstream: 'obesity', chunks: ['Obesity increases parapharyngeal fat and reduces lung volume, directly promoting upper-airway collapse; dominant modifiable OSA risk factor. (PMID:31000002)', OSA_UPPER], want: ['viable'] },
  { claimed: 'obstructive sleep apnea', upstream: 'migraine', chunks: ['Cross-sectional studies report an association between migraine and OSA; a direct causal anatomic mechanism is not established. (PMID:31000003)', OSA_UPPER], want: ['viable','borderline'] },
  { claimed: 'lumbar radiculopathy', upstream: 'lumbar degenerative disc disease', chunks: ['Lumbar disc degeneration/herniation mechanically compresses exiting nerve roots, producing radiculopathy. (PMID:31000004)'], want: ['viable'] },
];
let pass=0;
for (const c of cases){
  const v = await assessMechanismViability(c.claimed, c.upstream, c.chunks);
  const ok = !!v && c.want.includes(v.verdict); if(ok)pass++;
  console.log(`\n=== ${c.upstream} -> ${c.claimed} ===`);
  console.log(`  verdict: ${v?v.verdict:'NULL'} (want ${c.want.join('/')})  ${ok?'PASS':'FAIL'}`);
  if(v){console.log('  headline: '+v.headline); console.log('  reason: '+v.reason.slice(0,300));}
}
console.log(`\n${pass}/${cases.length} passed`);
