// MSCD v2.4 mockup: sample data + derivation helpers (fictional organisation)
// Static interface content (translations, Tera guidance, integrity labels, storage visuals, role labels) lives in
// static.js and the date helpers in dates.js; both are re-exported here, so existing imports keep working.
import { LOC_VISUALS, ROLE_LABELS } from './static.js';
import { makeDates } from './dates.js';
export { T, TERA, INTEG } from './static.js';

export const TODAY_S = '2026-09-29';
export const { P, dd, iso, addD, fmt } = makeDates(TODAY_S);

export const PEOPLE = {
  rina:['Rina Kusuma','ISMS Manager'], bagus:['Bagus Prasetyo','IT Infrastructure Lead'], dewi:['Dewi Anggraini','HR Manager'], fajar:['Fajar Nugroho','Facilities Manager'], sari:['Sari Wulandari','Head of Quality'], hendra:['Hendra Wijaya','CISO'], maya:['Maya Putri','Internal Auditor'], andi:['Andi Saputra','Procurement Lead'], tono:['Tono Hartono','BCM Coordinator'], yusuf:['Yusuf Rahman','Application Development Lead'], lina:['Lina Marlina','Legal & Compliance Officer'], none:['Unassigned','-']
};

export const ROLES = {
  manager:{ who:'rina', label:ROLE_LABELS.manager },
  owner:{ who:'bagus', label:ROLE_LABELS.owner },
  auditor:{ who:'maya', label:ROLE_LABELS.auditor },
  top:{ who:'hendra', label:ROLE_LABELS.top },
};

// Repository locations: [name, kind, short label, colour, icon]; the colour and icon come from LOC_VISUALS by kind.
const loc = (name, kind, short) => [name, kind, short, LOC_VISUALS[kind].color, LOC_VISUALS[kind].icon];
export const LOC = { sp:loc('SharePoint Online','sp','SharePoint'), od:loc('OneDrive (personal)','od','OneDrive'), gd:loc('Google Shared Drive','gd','Google Drive'), vault:loc('Managed Vault','vault','Vault'), smb:loc('File share (SMB)','smb','File share') };
export const FREQ = { daily:['Daily','Harian',1], weekly:['Weekly','Mingguan',7], monthly:['Monthly','Bulanan',30], quarterly:['Quarterly','Kuartalan',91], semi:['Semi-annual','Semesteran',182], annual:['Annual','Tahunan',365], event:['Per event','Per kejadian',0] };
export const FREQ_ORDER = ['daily','weekly','monthly','quarterly','semi','annual','event'];

export const MS = [
  { id:'isms', code:'ISO/IEC 27001', ed:'2022', short:'ISMS', name:['Information security management system','Sistem manajemen keamanan informasi'], mgr:'rina', mgrRole:'ISMS Manager', color:'#e8731a',
    scope:'Data centre & managed services operations: Jakarta and Surabaya', certifier:'PT Sertifikasi Nusantara', lead:'Ir. Dwi Hartanto, IRCA LA', cert:['Certified 14 Mar 2025, cycle 2025–2028','Tersertifikasi 14 Mar 2025, siklus 2025–2028'], stage:['Surveillance 1, year 2','Surveilans 1, tahun ke-2'],
    audit:{ name:['Surveillance audit 1','Audit surveilans 1'], date:'2026-11-12', days:2, prepWindowDays:60 }, clauses:[100,100,88,72,94,81,67], findings:{open:3,major:1}, loc:'sp', locMode:'Customer Repository, Link', pack:'ISO27001-2022 v1.2.0', phase:['Operate & maintain','Operasi & pemeliharaan'], unit:'ctrl', theme:{5:'Organizational',6:'People',7:'Physical',8:'Technological'},
    gateName:['Risk & SoA','Risiko & SoA'], gtSuggestions:['A.8.13','PRC-07','A.5.23'], approver:'hendra' },
  { id:'qms', code:'ISO 9001', ed:'2015 to 2026', short:'QMS', name:['Quality management system','Sistem manajemen mutu'], mgr:'sari', mgrRole:'QMS Manager', color:'#3a6fd8',
    scope:'Software product development and support', certifier:'Lembaga Sertifikasi Garuda Mutu', lead:'Ir. Bambang Sutrisno', cert:['Certified 22 Jun 2023, cycle 2023–2026','Tersertifikasi 22 Jun 2023, siklus 2023–2026'], stage:['Recertification + transition audit','Resertifikasi + audit transisi'],
    audit:{ name:['Recertification & ISO 9001:2026 transition audit','Audit resertifikasi & transisi ISO 9001:2026'], date:'2026-12-03', days:3, prepWindowDays:60 }, clauses:[100,96,90,85,88,74,80], findings:{open:2,major:0}, loc:'vault', locMode:'Managed Vault', pack:'ISO9001-2026 v0.9 + ISO9001-2015 v1.4', phase:['Operate & maintain','Operasi & pemeliharaan'], unit:'req',
    banner:{ tone:'info', text:['ISO 9001:2026 transition: 14 tasks open, 3 new requirements without relations.','Transisi ISO 9001:2026: 14 tugas terbuka, 3 persyaratan baru tanpa relasi.'], kind:'transition' },
    gateName:['Risk & Opportunity + Process Map','Risiko & Peluang + Peta Proses'], gtSuggestions:['Cl. 8.4','PRC-Q04'], approver:'sari' },
  { id:'bcms', code:'ISO 22301', ed:'2019', short:'BCMS', name:['Business continuity management system','Sistem manajemen keberlangsungan usaha'], mgr:'tono', mgrRole:'BCMS Manager', color:'#1f8a8a',
    scope:'Data centre operations: Jakarta', certifier:'PT Sertifikasi Nusantara', lead:['To be assigned','Belum ditentukan'], cert:['Not yet certified, Stage 1 planned','Belum tersertifikasi, Tahap 1 direncanakan'], stage:['Implementation, phase 4 of 8','Implementasi, fase 4 dari 8'],
    audit:{ name:['Stage 1 audit','Audit Tahap 1'], date:'2027-02-10', days:1, prepWindowDays:60 }, clauses:[100,90,60,55,40,20,10], findings:{open:0,major:0}, loc:'gd', locMode:'Customer Repository, Zero-transit', pack:'ISO22301-2019 v1.0.0', phase:['BIA & risk assessment','BIA & penilaian risiko'], unit:'req',
    banner:{ tone:'bad', text:['Google Shared Drive token expired 27 Sep 2026. Integrity checks paused for 11 files.','Token Google Shared Drive kedaluwarsa 27 Sep 2026. Pemeriksaan integritas 11 berkas tertunda.'], kind:'connector' },
    gateName:['BIA & Risk Assessment','BIA & Penilaian Risiko'], gtSuggestions:['BIA-03','PLN-B02'], approver:'hendra' },
  { id:'abms', code:'ISO 37001', ed:'2025', short:'ABMS', name:['Anti-bribery management system','Sistem manajemen anti-penyuapan'], mgr:'lina', mgrRole:'Anti-Bribery Compliance Function', color:'#7a4fd3',
    scope:'Procurement, sales and partner management: all sites', certifier:'PT Integritas Sertifikasi Indonesia', lead:'-', cert:['Not yet certified, no audit event','Belum tersertifikasi, belum ada event audit'], stage:['Implementation, phase 1 of 8','Implementasi, fase 1 dari 8'],
    audit:null, clauses:[20,0,0,0,0,0,0], findings:{open:0,major:0}, loc:'vault', locMode:'Managed Vault', pack:'ISO37001-2025 v0.6 (beta)', phase:['Initiate: context & bribery risk','Inisiasi: konteks & risiko penyuapan'], unit:'req',
    banner:{ tone:'warn', text:['Beta framework pack ISO37001-2025 v0.6: 41 of 88 activities available.','Framework pack beta ISO37001-2025 v0.6: 41 dari 88 aktivitas tersedia.'], kind:'beta' },
    gateName:['Bribery Risk Assessment','Penilaian Risiko Penyuapan'], gtSuggestions:['Cl. 4.5'], approver:'lina' },
];

// ---------- ISO/IEC 27001 Annex A ----------
const A = {
  5:'Policies for information security|Information security roles and responsibilities|Segregation of duties|Management responsibilities|Contact with authorities|Contact with special interest groups|Threat intelligence|Information security in project management|Inventory of information and other associated assets|Acceptable use of information and other associated assets|Return of assets|Classification of information|Labelling of information|Information transfer|Access control|Identity management|Authentication information|Access rights|Information security in supplier relationships|Addressing information security within supplier agreements|Managing information security in the ICT supply chain|Monitoring, review and change management of supplier services|Information security for use of cloud services|Information security incident management planning and preparation|Assessment and decision on information security events|Response to information security incidents|Learning from information security incidents|Collection of evidence|Information security during disruption|ICT readiness for business continuity|Legal, statutory, regulatory and contractual requirements|Intellectual property rights|Protection of records|Privacy and protection of PII|Independent review of information security|Compliance with policies, rules and standards for information security|Documented operating procedures',
  6:'Screening|Terms and conditions of employment|Information security awareness, education and training|Disciplinary process|Responsibilities after termination or change of employment|Confidentiality or non-disclosure agreements|Remote working|Information security event reporting',
  7:'Physical security perimeters|Physical entry|Securing offices, rooms and facilities|Physical security monitoring|Protecting against physical and environmental threats|Working in secure areas|Clear desk and clear screen|Equipment siting and protection|Security of assets off-premises|Storage media|Supporting utilities|Cabling security|Equipment maintenance|Secure disposal or re-use of equipment',
  8:'User endpoint devices|Privileged access rights|Information access restriction|Access to source code|Secure authentication|Capacity management|Protection against malware|Management of technical vulnerabilities|Configuration management|Information deletion|Data masking|Data leakage prevention|Information backup|Redundancy of information processing facilities|Logging|Monitoring activities|Clock synchronization|Use of privileged utility programs|Installation of software on operational systems|Networks security|Security of network services|Segregation of networks|Web filtering|Use of cryptography|Secure development life cycle|Application security requirements|Secure system architecture and engineering principles|Secure coding|Security testing in development and acceptance|Outsourced development|Separation of development, test and production environments|Change management|Test information|Protection of information systems during audit testing'
};
const ST27 = {
  '5.23':'blocked','8.12':'blocked', '8.30':'na','8.34':'na','7.9':'na','8.11':'na',
  '5.7':'planned','8.16':'planned','8.28':'planned','8.29':'planned','8.33':'planned','7.4':'planned', '5.35':'ns','8.27':'ns',
  '5.9':'partial','5.12':'partial','5.13':'partial','5.19':'partial','5.21':'partial','5.22':'partial','6.3':'partial','6.7':'partial','7.7':'partial','7.13':'partial','8.6':'partial','8.8':'partial','8.9':'partial','8.13':'partial','8.15':'partial','8.19':'partial','8.24':'partial','8.32':'partial'
};
const OWN27 = id => { const [t,n] = id.split('.').map(Number);
  if (t===6) return 'dewi'; if (t===7) return 'fajar';
  if (t===5) { if (n===2||n===3) return 'hendra'; if (n===4||n===6) return 'dewi'; if (n===5||n===31||n===34) return 'lina'; if (n===7) return 'yusuf'; if (n>=9&&n<=14) return (n%2?'bagus':'rina'); if (n>=15&&n<=18) return 'bagus'; if (n>=19&&n<=23) return 'andi'; if (n>=24&&n<=28) return 'hendra'; if (n>=31&&n<=34) return 'lina'; return 'rina'; }
  if (n===4||n>=25) return 'yusuf'; return 'bagus'; };
const DOC27 = id => { const [t,n] = id.split('.').map(Number);
  if (t===6) return 'PRC-12'; if (t===7) return 'PRC-15';
  if (t===5) { if (n===2||n===3||n===4) return 'IMS-01'; if (n===5||n===6) return 'PRC-13'; if (n===8) return 'PRC-09'; if (n<=8) return 'POL-01'; if (n===9||n===10) return 'PRC-05'; if (n<=14) return 'STD-06'; if (n<=18) return 'PRC-07'; if (n<=23) return 'PRC-08'; if (n<=28) return 'PRC-13'; if (n<=30) return 'PLN-02'; return 'IMS-01'; }
  if ([2,3,5,18].includes(n)) return 'PRC-07'; if ([1,9,19,20,21,22,23].includes(n)) return 'STD-04'; if ([6,14].includes(n)) return 'PLN-02'; if ([7,8].includes(n)) return 'PRC-10'; if ([10,11,12,24].includes(n)) return 'STD-06'; if (n===13) return 'PRC-11'; if ([15,16,17].includes(n)) return 'STD-05'; if (n===32) return 'PRC-09'; return 'PRC-16'; };
const FREQ27 = id => { const [t,n] = id.split('.').map(Number);
  const m = { '8.7':'daily','8.15':'daily','8.16':'daily','8.13':'monthly','8.8':'monthly','8.6':'monthly','5.7':'monthly','7.4':'monthly','5.18':'quarterly','8.2':'quarterly','5.22':'quarterly','8.9':'quarterly','8.17':'quarterly','5.9':'quarterly','6.7':'quarterly','7.13':'semi','5.35':'semi','8.14':'semi','7.2':'monthly','7.7':'quarterly' }[id];
  if (m) return m; if (t===5 && n>=24 && n<=28) return 'event'; if (['5.8','5.11','6.1','6.2','6.5','7.14','8.10','8.19','8.32','8.28','8.29'].includes(id)) return 'event'; return { 5:'annual',6:'event',7:'annual',8:'quarterly' }[t]; };
const NOTE27 = {
  '5.23':{ note:'Applicable: no risk-based justification linked', gate:true, just:'' },
  '8.12':{ note:'Applicable: no risk-based justification linked', gate:true, just:'' },
  '5.9':{ note:'Asset register export changed after being pinned as evidence', prod:'2026-06-20', integ:'changed' },
  '8.13':{ note:'Q3 backup log not found at pinned location', prod:'2026-04-14', integ:'missing' },
  '7.13':{ note:'Maintenance log lives in a departed employee\u2019s OneDrive', prod:'2026-02-10', integ:'revoked', loc:'od' },
  '8.8':{ note:'Monthly scan report missing for Aug and Sep', prod:'2026-07-31' },
  '6.3':{ note:'2026 awareness campaign not yet run', prod:'2025-06-20' },
  '8.15':{ note:'Log review record present; retention config evidence expired', prod:'2026-05-02' },
  '5.19':{ note:'Two critical suppliers without current security review', prod:'2025-08-15' },
  '8.32':{ note:'CAB minutes missing for two emergency changes', prod:'2026-06-30' },
  '8.24':{ note:'Key rotation evidence older than policy interval', prod:'2025-09-01' },
  '7.7':{ note:'Spot-check record for Surabaya missing' },
  '8.9':{ note:'Baseline drift report not produced since Jun' , prod:'2026-06-10' },
  '8.30':{ just:'No development is outsourced; all software is developed in-house.' }, '8.34':{ just:'Audit testing is performed on non-production copies only.' }, '7.9':{ just:'No equipment is used off-premises; laptops are covered under A.8.1.' }, '8.11':{ just:'No production data is used outside production; covered by A.8.33 test information.' },
  '8.7':{ prod:'2026-09-29' }, '8.16':{ prod:'2026-09-28' },
};
const RISK27 = id => { const [t,n] = id.split('.').map(Number); const base = { 5:[3,14,22], 6:[9,27], 7:[19,8], 8:[14,31,35,3] }[t]; return base.slice(0, 1 + (n % 2)).map(x => 'R-' + String(x).padStart(3,'0')); };

// ---------- Harmonized Structure requirement lists ----------
const HS = [['4.1','Understanding the organization and its context'],['4.2','Needs and expectations of interested parties'],['4.3','Scope of the management system'],['4.4','Management system and its processes'],['5.1','Leadership and commitment'],['5.2','Policy'],['5.3','Roles, responsibilities and authorities'],['6.1','Actions to address risks and opportunities'],['6.2','Objectives and planning to achieve them'],['6.3','Planning of changes'],['7.1','Resources'],['7.2','Competence'],['7.3','Awareness'],['7.4','Communication'],['7.5','Documented information']];
const HS9 = [['9.1','Monitoring, measurement, analysis and evaluation'],['9.2','Internal audit'],['9.3','Management review'],['10.1','Improvement: general'],['10.2','Nonconformity and corrective action'],['10.3','Continual improvement']];
const C8 = {
  qms:[['8.1','Operational planning and control'],['8.2','Requirements for products and services'],['8.3','Design and development of products and services'],['8.4','Control of externally provided processes, products and services'],['8.5','Production and service provision'],['8.6','Release of products and services'],['8.7','Control of nonconforming outputs']],
  bcms:[['8.1','Operational planning and control'],['8.2','Business impact analysis and risk assessment'],['8.3','Business continuity strategies and solutions'],['8.4','Business continuity plans and procedures'],['8.5','Exercise programme'],['8.6','Evaluation of business continuity documentation and capabilities']],
  abms:[['4.5','Bribery risk assessment'],['8.1','Operational planning and control'],['8.2','Due diligence'],['8.3','Financial controls'],['8.4','Non-financial controls'],['8.5','Anti-bribery controls by controlled organizations and business associates'],['8.6','Anti-bribery commitments'],['8.7','Gifts, hospitality, donations and similar benefits'],['8.8','Managing inadequacy of anti-bribery controls'],['8.9','Raising concerns'],['8.10','Investigating and dealing with bribery']],
};
const REQCFG = {
  qms:{ st:{ '8.4':'partial','9.1':'partial','6.3':'partial','7.2':'partial','10.3':'planned','8.7':'complete' }, own:{ '8.3':'yusuf','8.4':'andi','7.2':'dewi','9.2':'maya','8.5':'yusuf' }, def:'sari', doc:{ '7.5':'IMS-01','9.2':'IMS-02','10.2':'IMS-03','9.3':'IMS-04','8.3':'PRC-Q02','8.4':'PRC-Q03','8.7':'PRC-Q04','8.2':'REG-Q01','9.1':'REG-Q01' }, ddoc:'QM-01', freq:{ '9.1':'monthly','8.4':'annual','8.7':'event','8.6':'event','9.2':'annual','9.3':'annual','7.2':'annual','8.2':'event','8.3':'event','8.5':'monthly','10.2':'event' }, dfreq:'annual', note:{ '8.4':'External provider evaluations 2026 done for 6 of 9 critical suppliers', '9.1':'Customer satisfaction survey Q3 not analysed', '6.3':'Transition change plan (ISO 9001:2026) not approved', '7.2':'Competence matrix missing 4 new hires', '8.7':'Marked complete by process owner: awaiting verification' } },
  bcms:{ st:{ '6.3':'partial','7.1':'partial','7.2':'partial','7.3':'partial','7.4':'partial','7.5':'implemented','8.1':'implemented','8.2':'blocked','8.3':'planned','8.4':'planned','8.5':'ns','8.6':'ns','9.1':'ns','9.2':'ns','9.3':'ns','10.1':'ns','10.2':'ns','10.3':'ns' }, own:{ '8.2':'tono','8.3':'bagus','8.4':'bagus','8.5':'tono','8.6':'tono','7.2':'dewi','9.2':'maya' }, def:'tono', doc:{ '7.5':'IMS-01','9.2':'IMS-02','10.2':'IMS-03','9.3':'IMS-04','8.2':'PLN-B01','8.3':'PLN-B02','8.4':'PLN-B02','4.4':'REG-B01' }, ddoc:'POL-B01', freq:{ '8.2':'annual','8.5':'annual','9.1':'quarterly' }, dfreq:'annual', note:{ '8.2':'BIA-03: RTO 8h exceeds MTPD 4h; BIA-06 not started', '8.3':'Waiting for the BIA checkpoint', '8.4':'Waiting for the BIA checkpoint', '7.4':'Emergency communication tree not tested' } },
  abms:{ st:{ '4.1':'partial','4.2':'partial','4.5':'blocked' }, own:{ '4.5':'lina','8.2':'andi','8.3':'andi','8.7':'andi' }, def:'lina', doc:{}, ddoc:'POL-A01', freq:{}, dfreq:'annual', note:{ '4.5':'Bribery risk assessment not started', '4.1':'Context workshop held 18 Sep; issues not yet recorded' } },
};

export const DOCS = {
  isms:[
    ['POL-01','Information Security Policy','Policy','4.0','approved','2026-02-10','2027-02-10','hendra'],
    ['PRC-05','Asset & Information Handling Procedure','Procedure','2.1','approved','2026-05-04','2027-05-04','rina'],
    ['REG-03','Information Asset Register','Register','7','expired','2025-09-06','2026-09-06','bagus'],
    ['PRC-07','Access Control Procedure','Procedure','3.2','expired','2025-09-24','2026-09-24','bagus'],
    ['PRC-08','Supplier Security Procedure','Procedure','1.3','approved','2026-01-15','2027-01-15','andi'],
    ['PRC-13','Incident Management Procedure','Procedure','2.0','approved','2026-03-20','2027-03-20','hendra'],
    ['PLN-02','ICT Continuity Plan','Plan','1.1','review','2025-10-30','2026-10-30','bagus'],
    ['PRC-12','HR Security Procedure','Procedure','1.4','approved','2026-04-12','2027-04-12','dewi'],
    ['PRC-15','Physical Security Procedure','Procedure','2.2','expired','2025-09-17','2026-09-17','fajar'],
    ['STD-04','Secure Configuration Standard','Standard','1.0','expired','2025-07-23','2026-07-23','bagus'],
    ['PRC-10','Vulnerability & Malware Management Procedure','Procedure','2.3','approved','2026-06-01','2027-06-01','bagus'],
    ['STD-06','Cryptography & Data Protection Standard','Standard','1.2','approved','2026-08-19','2027-08-19','yusuf'],
    ['PRC-11','Backup & Restore Procedure','Procedure','1.5','expired','2025-08-19','2026-08-19','bagus'],
    ['STD-05','Logging & Monitoring Standard','Standard','1.1','approved','2025-10-14','2026-10-14','bagus'],
    ['PRC-16','Secure Development Procedure','Procedure','0.9','draft','','2026-10-20','yusuf'],
    ['PRC-09','Change Management Procedure','Procedure','2.0','approved','2026-01-28','2027-01-28','bagus'],
    ['SOA-01','Statement of Applicability v3.0','Register','3.0','draft','','2026-10-15','hendra'],
    ['POL-14','Cloud Services Security Policy','Policy','1.0','approved','2026-07-07','2027-07-07','andi'],
  ],
  qms:[
    ['QM-01','Quality Manual','Policy','5.0','approved','2026-01-12','2027-01-12','sari'],
    ['PRC-Q02','Design & Development Procedure','Procedure','3.1','approved','2026-03-03','2027-03-03','yusuf'],
    ['PRC-Q03','External Provider Evaluation Procedure','Procedure','2.0','review','2025-10-06','2026-10-06','andi'],
    ['PRC-Q04','Nonconforming Output Procedure','Procedure','1.2','expired','2025-09-20','2026-09-20','sari'],
    ['REG-Q01','Customer Feedback & Complaint Register','Register','-','approved','2026-09-01','2026-10-25','sari'],
    ['PLN-Q05','ISO 9001:2026 Transition Plan','Plan','0.3','draft','','2026-10-31','sari'],
  ],
  bcms:[
    ['POL-B01','Business Continuity Policy','Policy','1.0','approved','2026-04-02','2027-04-02','tono'],
    ['REG-B01','Prioritised Activities Register','Register','1.0','approved','2026-06-15','2027-06-15','tono'],
    ['PLN-B01','Business Impact Analysis Report','Plan','0.8','draft','','2026-10-01','tono'],
    ['PLN-B02','BC Plan: Data Centre Jakarta','Plan','0.2','draft','','2026-12-15','bagus'],
  ],
  abms:[ ['POL-A01','Anti-Bribery Policy','Policy','0.5','draft','','2026-10-30','lina'] ],
};
export const SHARED = [
  ['IMS-01','Document Control Procedure','Procedure','3.0','approved','2026-02-02','2027-02-02','rina'],
  ['IMS-02','Internal Audit Procedure','Procedure','2.4','approved','2025-10-20','2026-10-20','maya'],
  ['IMS-03','Corrective Action Procedure','Procedure','2.1','approved','2026-05-11','2027-05-11','rina'],
  ['IMS-04','Management Review Procedure','Procedure','1.6','approved','2025-10-08','2026-10-08','hendra'],
];

export function buildReqs(ms) {
  if (ms.id === 'isms') {
    const out = [];
    [5,6,7,8].forEach(t => A[t].split('|').forEach((title, i) => {
      const id = t + '.' + (i+1); const n = NOTE27[id] || {};
      out.push({ id:'A.'+id, key:id, title, theme:'A.'+t+' '+ms.theme[t], st: ST27[id] || 'implemented', owner:OWN27(id), doc:DOC27(id), freq:FREQ27(id), note:n.note||'', gate:!!n.gate, just: n.just !== undefined ? n.just : (ST27[id]==='na' ? '' : 'Required by risk treatment; see linked risks.'), risks: ST27[id]==='na' ? [] : RISK27(id), prod:n.prod, integ:n.integ||'ok', loc:n.loc||ms.loc });
    }));
    return out;
  }
  const cfg = REQCFG[ms.id]; const list = [...HS, ...C8[ms.id], ...HS9].sort((a,b)=>parseFloat(a[0])-parseFloat(b[0]) || a[0].localeCompare(b[0]));
  const seen = new Set();
  return list.filter(([id]) => !seen.has(id) && seen.add(id)).map(([id,title],i) => {
    let st = cfg.st[id]; if (!st) st = ms.id==='abms' ? 'ns' : 'implemented';
    const cl = id.split('.')[0];
    return { id:'Cl. '+id, key:id, title, theme:'Clause '+cl, st, owner: cfg.own[id] || cfg.def, doc: cfg.doc[id] || cfg.ddoc, freq: cfg.freq[id] || cfg.dfreq, note: cfg.note[id] || '', gate: st==='blocked', just: 'Requirement within scope', risks: [], prod: undefined, integ: ms.id==='bcms' ? 'pending' : 'ok', loc: ms.loc };
  });
}

export function buildDocs(ms) {
  const mk = (r, shared) => ({ id:r[0], title:r[1], tier:r[2], ver:r[3], st:r[4], appr:r[5], rev:r[6], owner:r[7], shared, ms:ms.id });
  return [...(DOCS[ms.id]||[]).map(r=>mk(r,false)), ...SHARED.map(r=>mk(r,true))];
}

export function freshOf(prod, p) {
  if (!p) return 'fresh'; const age = -dd(prod);
  if (age <= p + 1) return 'fresh'; if (age <= p * 1.25 + 1) return 'aging'; if (age <= p * 2) return 'expired'; return 'critical';
}
const EVT = { '8.8':'Vulnerability scan report','8.13':'Backup job log & restore test','8.7':'EDR daily detection summary','8.15':'SIEM log review record','8.16':'SOC monitoring shift report','5.18':'Quarterly access rights review','8.2':'Privileged account review','6.3':'Awareness training attendance','5.9':'Asset register export','7.13':'Equipment maintenance log','5.7':'Threat intelligence digest','7.2':'Visitor & badge access log','8.32':'CAB minutes','8.24':'Key rotation record','5.19':'Supplier security review','9.1':'Performance measurement report','8.4':'External provider evaluation','8.2q':'Contract review record' };
export function buildEvidence(ms, reqs) {
  const pre = { isms:'EV-', qms:'EQ-', bcms:'EB-', abms:'EA-' }[ms.id]; const out = [];
  reqs.forEach((c, i) => {
    if (['na','ns','planned','blocked'].includes(c.st)) return;
    if (ms.id === 'bcms' && !['4.1','4.2','4.3','4.4','5.1','5.2','5.3','6.1','6.2','7.5','8.1'].includes(c.key)) return;
    const p = FREQ[c.freq][2]; let prod = c.prod;
    if (!prod) { let back; if (c.st === 'implemented' || c.st === 'complete') back = p ? (i*13) % Math.max(1, Math.round(p*0.9)) : (i*13) % 120; else back = p ? Math.round(p*1.3) + (i*7) % Math.min(60, Math.max(1,p)) : 200 + (i*7) % 100; prod = addD(TODAY_S, -back); }
    if (p && dd(addD(prod, p)) < -120) prod = addD(TODAY_S, -(p + 30 + (i*11) % 90));
    out.push({ code: pre + String(100 + i*3).padStart(4,'0'), ctrl:c.id, ctrlKey:c.key, title: (EVT[c.key] || (c.title + ': operating record')), freq:c.freq, p, prod, next: p ? addD(prod, p) : null, fresh: freshOf(prod, p), integ:c.integ, loc:c.loc, owner:c.owner, ver: ms.loc==='vault' ? 'v'+(1+i%3) : (ms.loc==='gd' ? 'rev '+(3+i%5) : 'v'+(2+i%4)+'.0'), hashAlg: ms.loc==='vault' ? 'SHA-256' : (ms.loc==='gd' ? (i%6===0 ? 'none' : 'SHA-256 (provider)') : 'quickXorHash'), path: ms.loc==='vault' ? '/vault/'+ms.short+'/'+c.id.replace(/[ .]/g,'') : (ms.loc==='gd' ? 'Compliance BCMS / Evidence / 2026' : (c.loc==='od' ? 'Personal / Documents / DC' : 'Compliance / ISMS / Evidence / 2026 / Q3')) });
  });
  out.forEach(e => { if (e.hashAlg === 'none' && e.integ === 'ok') e.integ = 'nohash'; });
  return out;
}

// explicit chain records per MS (stages that are not derived from controls / docs / evidence)
export const X = {
  isms:{
    context:[{ id:'CI-09', t:'Regulatory change: PDP Law implementing regulation', act:'Review relevance and link affected risks', h:'lina', due:'2026-10-20', down:['R-014','R-027'] }],
    risk:[
      { id:'R-031', t:'Unpatched hypervisor in Surabaya DC', act:'Select a treatment: no treatment linked', h:'rina', due:null, gate:true, up:['CI-03'], down:[] },
      { id:'R-014', t:'Privileged credential misuse', act:'Annual reassessment', h:'bagus', due:'2026-09-10', up:['CI-02'], down:['T-014','A.8.2'] },
      { id:'R-022', t:'Third-party cloud service outage', act:'Residual risk acceptance by Risk Owner', h:'hendra', due:'2026-10-30', up:['CI-05'], down:['T-022','A.5.23'] },
      { id:'R-027', t:'Insider data exfiltration', act:'Reassess after DLP rollout', h:'dewi', due:'2026-11-30', up:['CI-09'], down:['A.8.12'] },
      { id:'R-035', t:'Shadow SaaS usage by developers', act:'Complete initial assessment', h:'yusuf', due:'2026-10-12', up:['CI-07'], down:[] } ],
    treatment:[
      { id:'T-014', t:'Deploy PAM for hypervisor administrators', act:'Report implementation progress', h:'bagus', due:'2026-09-15', up:['R-014'], down:['A.8.2'] },
      { id:'T-019', t:'CCTV coverage for loading bay', act:'Confirm completion with photos', h:'fajar', due:'2026-10-24', up:['R-019'], down:['A.7.4'] },
      { id:'T-026', t:'Secrets scanning in CI pipeline', act:'Complete rollout to all repositories', h:'yusuf', due:'2026-12-05', up:['R-035'], down:['A.8.28'] },
      { id:'T-031', t:'Treatment for R-031', act:'Assign owner and plan treatment', h:'none', due:null, up:['R-031'], down:[] } ],
    soa:[{ id:'SOA-01', t:'Statement of Applicability v3.0', act:'Approve revised SoA (draft since 2 Sep)', h:'hendra', due:'2026-10-15', gate:true, up:['R-022','R-027'], down:['A.5.23','A.8.12'] }],
    metric:[
      { id:'M-07', t:'Patch SLA compliance (%)', act:'Enter Aug and Sep values', h:'bagus', due:'2026-09-05', up:['A.8.8'] },
      { id:'M-11', t:'Awareness training completion (%)', act:'Update after 2026 campaign', h:'dewi', due:'2026-10-31', up:['A.6.3'] },
      { id:'M-15', t:'Backup restore success rate', act:'Define data source and owner', h:'none', due:null, up:['A.8.13'] },
      { id:'M-19', t:'Mean time to contain incidents', act:'Enter Q3 value', h:'yusuf', due:'2026-11-20', up:['A.5.26'] } ],
  },
  qms:{
    context:[{ id:'CI-Q04', t:'Enterprise customer requires ISO 9001:2026 certificate by 2027', act:'Assess impact on quality objectives', h:'sari', due:'2026-10-10' }],
    risk:[{ id:'RO-11', t:'Loss of key developer knowledge', act:'Define action', h:'yusuf', due:'2026-10-20' }, { id:'RO-07', t:'Opportunity: automate release checks', act:'Decide go / no-go', h:'sari', due:'2026-12-15' }],
    action:[{ id:'ACT-09', t:'Knowledge transfer sessions', act:'Confirm completion', h:'yusuf', due:'2026-09-20' }],
    objective:[{ id:'QO-03', t:'Customer satisfaction ≥ 4.3 / 5', act:'Enter Q3 measurement', h:'sari', due:'2026-10-05' }],
    metric:[{ id:'MQ-02', t:'On-time release rate', act:'Enter Sep value', h:'yusuf', due:'2026-10-03' }],
  },
  bcms:{
    context:[{ id:'CI-B02', t:'Single utility feed at Jakarta DC', act:'Confirm relevance and link to BIA', h:'tono', due:'2026-10-08' }],
    product:[{ id:'PA-05', t:'Managed hosting: tier 2 customers', act:'Confirm prioritised activity list', h:'tono', due:'2026-10-15' }],
    bia:[{ id:'BIA-03', t:'BIA: colocation services', act:'Set RTO ≤ MTPD (currently RTO 8h > MTPD 4h)', h:'tono', due:'2026-10-01', gate:true }, { id:'BIA-06', t:'BIA: network operations centre', act:'Complete BIA', h:'bagus', due:null, gate:true }],
    drisk:[{ id:'DR-04', t:'Fibre cut on primary route', act:'Assess likelihood and impact', h:'bagus', due:'2026-10-22' }],
    exercise:[{ id:'EX-01', t:'Table-top exercise: DC power loss', act:'Schedule exercise', h:'tono', due:'2027-01-15' }, { id:'EX-02', t:'Failover test: Surabaya', act:'Assign owner and schedule', h:'none', due:null }],
  },
  abms:{},
};
export const STAGES = {
  isms:[ { id:'context', l:['Context issue','Isu konteks'], q:'How do you know which internal and external issues affect the ISMS?', rec:12 }, { id:'risk', l:['Risk','Risiko'], q:'Show me how this risk was identified and assessed.', rec:38 }, { id:'treatment', l:['Risk treatment','Perlakuan risiko'], q:'What was done about it, and is it complete?', rec:41 }, { id:'control', l:['Control','Kontrol'], q:'Which Annex A control implements the treatment?', src:'req' }, { id:'soa', l:['SoA','SoA'], q:'Why is this control applicable, and is the justification risk-based?', src:'soa', rec:93 }, { id:'document', l:['Document','Dokumen'], q:'Where is it written down, and is that version current?', src:'doc' }, { id:'evidence', l:['Evidence','Bukti'], q:'Prove it operated this cycle, not at implementation.', src:'ev' }, { id:'metric', l:['Metric','Metrik'], q:'How do you know it is effective?', rec:24 } ],
  qms:[ { id:'context', l:['Context issue','Isu konteks'], q:'Which issues and interested parties drive the QMS?', rec:9 }, { id:'risk', l:['Risk & opportunity','Risiko & peluang'], q:'How were risks and opportunities determined?', rec:21 }, { id:'action', l:['Action','Tindakan'], q:'What actions were planned and were they effective?', rec:24 }, { id:'process', l:['Process / requirement','Proses / persyaratan'], q:'Show the process and its operational controls.', src:'req' }, { id:'objective', l:['Quality objective','Sasaran mutu'], q:'Are objectives measurable and monitored?', rec:6 }, { id:'document', l:['Document','Dokumen'], q:'Is this the current controlled version?', src:'doc' }, { id:'evidence', l:['Evidence','Bukti'], q:'Show records from the current cycle.', src:'ev' }, { id:'metric', l:['Metric','Metrik'], q:'How is performance evaluated?', rec:12 } ],
  bcms:[ { id:'context', l:['Context issue','Isu konteks'], q:'Which issues affect continuity of prioritised activities?', rec:7 }, { id:'product', l:['Product / activity','Produk / aktivitas'], q:'Which products and activities are in scope and prioritised?', rec:8 }, { id:'bia', l:['BIA','BIA'], q:'Show MTPD, RTO and RPO for each prioritised activity.', rec:8 }, { id:'drisk', l:['Disruption risk','Risiko gangguan'], q:'How were disruption risks assessed?', rec:11 }, { id:'strategy', l:['Strategy / requirement','Strategi / persyaratan'], q:'Which strategies and solutions were selected?', src:'req' }, { id:'document', l:['BC plan / document','Rencana BC / dokumen'], q:'Are plans approved and current?', src:'doc' }, { id:'exercise', l:['Exercise','Latihan'], q:'When was this plan last exercised?', rec:3 }, { id:'evidence', l:['Evidence','Bukti'], q:'Show exercise and operating records.', src:'ev' } ],
  abms:[ { id:'context', l:['Context issue','Isu konteks'], q:'', rec:0 }, { id:'brisk', l:['Bribery risk','Risiko penyuapan'], q:'', rec:0 }, { id:'control', l:['Control / requirement','Kontrol / persyaratan'], q:'', src:'req' }, { id:'associate', l:['Position / associate','Posisi / mitra'], q:'', rec:0 }, { id:'document', l:['Document','Dokumen'], q:'', src:'doc' }, { id:'evidence', l:['Evidence','Bukti'], q:'', src:'ev' } ],
};


// ---------- Phases & activities ----------
const GENP = (gate, ops) => [
  { n:'Initiation & mandate', acts:['Secure top management mandate','Appoint management system manager','Approve project charter and budget','Baseline gap assessment'] },
  { n:'Context & scope', acts:['Identify internal and external issues','Identify interested parties and requirements','Define scope and boundaries','Map processes and interfaces','Approve scope statement'] },
  { n:'Leadership & policy', acts:['Draft policy','Define roles, responsibilities and authorities','Set measurable objectives','Approve and communicate policy'] },
  gate, ops,
  { n:'Documentation', acts:['Establish document control','Write mandatory procedures','Define record retention','Publish document register','Approve controlled documents'] },
  { n:'Operation & awareness', acts:['Run awareness campaign','Role-based training','Operate controls and collect evidence','Handle nonconformities per procedure','Evidence freshness review'] },
  { n:'Performance evaluation & improvement', acts:['Define metrics and measurement plan','Collect metric values','Conduct internal audit','Hold management review','Implement corrective actions','Verify corrective action effectiveness'] },
];
export const PHASES = {
  isms:[
    { n:'Initiation & mandate', acts:['Secure top management mandate','Appoint ISMS Manager and steering committee','Define project charter and budget','Baseline gap assessment','Communicate programme kick-off'] },
    { n:'Context & scope', acts:['Identify internal and external issues','Identify interested parties and requirements','Define ISMS scope and boundaries','Inventory information assets','Map interfaces and dependencies','Approve scope statement'] },
    { n:'Leadership & policy', acts:['Draft information security policy','Define roles, responsibilities and authorities','Approve policy at management review','Set information security objectives','Communicate policy to all staff'] },
    { n:'Risk assessment & SoA', gate:true, acts:['Define risk assessment methodology','Identify information security risks','Analyse and evaluate risks','Select risk treatment options','Select Annex A controls','Justify inclusions and exclusions','Draft Statement of Applicability','Risk owner approval of residual risk','Approve risk treatment plan','Approve Statement of Applicability'] },
    { n:'Risk treatment & controls', acts:['Implement organisational controls (A.5)','Implement people controls (A.6)','Implement physical controls (A.7)','Implement technological controls (A.8)','Establish supplier security requirements','Deploy access control and identity management','Deploy logging and monitoring','Establish incident management process','Establish backup and continuity arrangements','Cryptography and key management','Secure development practices','Track treatment plan progress'] },
    { n:'Documentation', acts:['Establish document control procedure','Write mandatory procedures','Write operating standards','Define record retention','Publish document register','Train document owners','Approve tier 1–2 documents','Approve tier 3–4 documents'] },
    { n:'Operation & awareness', acts:['Run awareness campaign','Role-based security training','Operate controls and collect evidence','Supplier onboarding under new requirements','Handle incidents per procedure','Change management under control','Quarterly access reviews','Evidence freshness review'] },
    { n:'Performance evaluation', acts:['Define metrics and measurement plan','Collect metric values','Plan internal audit programme','Conduct internal audit','Record and classify findings','Prepare management review inputs','Hold management review','Record decisions and actions'] },
    { n:'Improvement & audit readiness', acts:['Root cause analysis for findings','Implement corrective actions','Verify corrective action effectiveness','Compile evidence pack','Surveillance readiness check','Brief auditees on sampling focus','Close-out of open actions'] } ],
  qms:[ ...GENP({ n:'Risk & opportunity + process map', gate:true, acts:['Determine risks and opportunities','Plan actions for risks and opportunities','Define process map and interactions','Assign process owners','Define process KPIs','Approve process map','Approve quality objectives'] }, { n:'Process controls & design', acts:['Customer requirements review','Design and development controls','External provider evaluation','Production and service provision controls','Release and nonconforming output controls','Customer feedback process','Complaint handling'] }),
    { n:'ISO 9001:2026 transition', acts:['Install ISO 9001:2026 framework pack','Run gap analysis 2015 to 2026','Map documents to new requirements','Map evidence to new requirements','Review three new requirements','Update quality manual','Update process map','Train process owners','Update quality objectives','Update supplier controls','Internal audit against 2026 edition','Management review on transition','Notify certification body','Confirm transition audit date'] } ],
  bcms: GENP({ n:'BIA & risk assessment', gate:true, acts:['Identify products and services','Determine prioritised activities','Set MTPD, RTO and RPO per activity','Complete BIA for all prioritised activities','Assess disruption risks','Approve BIA report','Approve risk assessment'] }, { n:'BC strategies & plans', acts:['Select continuity strategies','Define resource requirements','Write BC plans','Define incident response structure','Establish warning and communication','Exercise programme design','Approve plans'] }),
  abms: GENP({ n:'Bribery risk assessment', gate:true, acts:['Identify bribery risk positions and transactions','Identify business associates in scope','Assess bribery risks by position, partner, region','Determine proportionate controls','Approve bribery risk assessment','Set risk review triggers'] }, { n:'Anti-bribery controls', acts:['Establish anti-bribery compliance function','Due diligence procedure','Financial controls','Non-financial controls','Gifts, hospitality and donations register','Anti-bribery commitments from associates','Raising concerns channel','Investigation procedure'] }),
};
export const PHASE_STATE = {
  isms:{ verifiedUpTo:9, ov:{ '4:5':'blocked:A.8.12','4:6':'blocked:A.5.23','4:9':'blocked:R-031','4:10':'blocked:SOA-01','9:4':'progress','9:6':'progress','9:7':'ns' } },
  qms:{ verifiedUpTo:8, current:9, ov:{ '9:1':'verified','9:2':'verified','9:3':'verified','9:4':'complete','9:5':'complete','9:6':'progress','9:7':'progress','9:8':'progress','9:9':'progress','9:10':'complete','9:11':'ns','9:12':'ns','9:13':'verified','9:14':'complete' } },
  bcms:{ verifiedUpTo:3, current:4, lockedFrom:5, ov:{ '4:1':'verified','4:2':'complete','4:3':'blocked:BIA-03','4:4':'blocked:BIA-06','4:5':'progress','4:6':'ns','4:7':'ns' } },
  abms:{ verifiedUpTo:0, current:1, lockedFrom:2, ov:{ '1:1':'verified','1:2':'verified','1:3':'complete','1:4':'progress' } },
};
export const OUTPUT_MAP = [['Statement of Applicability','SOA-01'],['SoA','SOA-01'],['information security policy','POL-01'],['policy','POL-01'],['document control','IMS-01'],['internal audit','IMS-02'],['corrective action','IMS-03'],['management review','IMS-04'],['risk assessment methodology','PRC-05'],['backup','PRC-11'],['incident','PRC-13'],['access control','PRC-07'],['supplier','PRC-08'],['BIA','PLN-B01'],['BC plan','PLN-B02'],['quality manual','QM-01'],['process map','QM-01'],['transition','PLN-Q05'],['gap analysis','PLN-Q05']];

// ---------- Traceability chains ----------
export const CHAINS = {
  isms:[
    { id:'R-014', nodes:[['context','CI-02'],['risk','R-014'],['treatment','T-014'],['control','A.8.2'],['soa','A.8.2'],['document','PRC-07'],['evidence','ev:A.8.2'],['metric','M-07']] },
    { id:'R-022', nodes:[['context','CI-05'],['risk','R-022'],['treatment','T-022'],['control','A.5.23'],['soa','A.5.23'],['document','POL-14'],['evidence','ev:A.5.23'],['metric','M-03']] },
    { id:'R-031', nodes:[['context','CI-03'],['risk','R-031'],['treatment','T-031'],['control','A.8.8'],['soa','A.8.8'],['document','PRC-10'],['evidence','ev:A.8.8'],['metric','M-07']] },
    { id:'R-003', nodes:[['context','CI-01'],['risk','R-003'],['treatment','T-003'],['control','A.5.15'],['soa','A.5.15'],['document','PRC-07'],['evidence','ev:A.5.15'],['metric','M-02']] } ],
  qms:[
    { id:'RO-11', nodes:[['context','CI-Q04'],['risk','RO-11'],['action','ACT-09'],['process','Cl. 8.3'],['objective','QO-03'],['document','PRC-Q02'],['evidence','ev:Cl. 8.3'],['metric','MQ-02']] },
    { id:'RO-07', nodes:[['context','CI-Q01'],['risk','RO-07'],['action','ACT-04'],['process','Cl. 8.6'],['objective','QO-01'],['document','QM-01'],['evidence','ev:Cl. 8.6'],['metric','MQ-01']] } ],
  bcms:[ { id:'PA-05', nodes:[['context','CI-B02'],['product','PA-05'],['bia','BIA-03'],['drisk','DR-04'],['strategy','Cl. 8.3'],['document','PLN-B02'],['exercise','EX-01'],['evidence','ev:Cl. 8.3']] } ],
  abms:[],
};
export const TITLES = { 'CI-02':'Dependence on privileged administrators','CI-05':'Reliance on public cloud providers','CI-03':'Ageing virtualisation platform in Surabaya','CI-01':'Multi-tenant hosting for regulated customers','R-003':'Unauthorised access to customer environments','T-003':'Role-based access with quarterly review','T-022':'Cloud provider assurance programme','M-03':'Cloud provider SLA breaches','M-02':'Access review completion rate','CI-Q01':'Competitive pressure on release cadence','ACT-04':'Automated release gate pilot','QO-01':'On-time release ≥ 95%','MQ-01':'Release defect rate' };
export const CLAUSE_AT_RISK = { context:'4.1', risk:'6.1.2', treatment:'6.1.3', control:'6.1.3 d)', soa:'6.1.3 d)', document:'7.5', evidence:'8.1 / 9.1', metric:'9.1', action:'6.1', process:'4.4', objective:'6.2', product:'8.2.1', bia:'8.2.2', drisk:'8.2.3', strategy:'8.3', exercise:'8.5' };

// ---------- Certification cycle ----------
export const EVENTS = {
  // `type` and `outcome` are the stored event type and recorded outcome (audit_event.event_type, outcome).
  isms:[ { t:['Stage 1','Tahap 1'], d:'2025-01-20', days:1, result:['Passed, 2 OFI','Lulus, 2 OFI'], type:'stage1', outcome:'recommended' }, { t:['Stage 2, certification','Tahap 2, sertifikasi'], d:'2025-03-10', days:3, result:['Certified, 2 Minor NC, 1 OFI','Tersertifikasi, 2 NC Minor, 1 OFI'], type:'stage2', outcome:'recommended' }, { t:['Surveillance 1','Surveilans 1'], d:'2026-11-12', days:2, next:true, type:'surveillance' }, { t:['Surveillance 2','Surveilans 2'], d:'2027-11-10', days:2, type:'surveillance' }, { t:['Recertification','Resertifikasi'], d:'2028-02-14', days:3, type:'recertification' } ],
  qms:[ { t:['Recertification (2015 ed.)','Resertifikasi (ed. 2015)'], short:['Recertification','Resertifikasi'], d:'2023-06-22', days:2, result:['Certified, 1 Minor','Tersertifikasi, 1 Minor'], type:'recertification', outcome:'recommended' }, { t:['Surveillance 1','Surveilans 1'], d:'2024-06-18', days:1, result:['Passed, 1 Minor','Lulus, 1 Minor'], type:'surveillance', outcome:'recommended' }, { t:['Surveillance 2','Surveilans 2'], d:'2025-06-24', days:1, result:['Passed, 0 NC, 2 OFI','Lulus, 0 NC, 2 OFI'], type:'surveillance', outcome:'recommended' }, { t:['Recertification + 2026 transition','Resertifikasi + transisi 2026'], short:['Recert + transition','Resert + transisi'], d:'2026-12-03', days:3, next:true, type:'recertification' }, { t:['Surveillance 1 (2026 ed.)','Surveilans 1 (ed. 2026)'], short:['Surveillance 1','Surveilans 1'], d:'2027-12-01', days:1, type:'surveillance' } ],
  bcms:[ { t:['Stage 1','Tahap 1'], d:'2027-02-10', days:1, next:true, type:'stage1' }, { t:['Stage 2, certification','Tahap 2, sertifikasi'], d:'2027-04-20', days:2, type:'stage2' }, { t:['Surveillance 1','Surveilans 1'], d:'2028-04-18', days:1, type:'surveillance' } ],
  abms:[],
};
export const FOCUS = { isms:'Vulnerability remediation (NC-2025-02), supplier and cloud controls (A.5.19–5.23), evidence of operation since Stage 2', qms:'Transition to ISO 9001:2026 structure, external provider control, customer satisfaction analysis', bcms:'Scope, BIA method and results, leadership, readiness for Stage 2', abms:'-' };
export const PREP = {
  isms:[ ['Confirm audit plan and auditee schedule with certifier','rina','2026-10-10','done'], ['Internal audit 2026 report issued','maya','2026-10-06','done'], ['Approve SoA v3.0','hendra','2026-10-15','open'], ['Close NC-2025-02 with effectiveness verification','bagus','2026-10-20','progress'], ['Management review 2026 held and recorded','hendra','2026-10-28','open'], ['Compile evidence pack: manifest in SharePoint','rina','2026-11-05','open'], ['Brief auditees on expected sampling focus','rina','2026-11-09','open'] ],
  qms:[ ['Install and validate ISO 9001:2026 pack','sari','2026-09-20','done'], ['Complete transition gap tasks (14)','sari','2026-11-10','progress'], ['Update quality manual to 2026 structure','sari','2026-11-01','open'], ['Internal audit against 2026 requirements','maya','2026-11-14','open'], ['Management review including transition','hendra','2026-11-20','open'] ],
  bcms:[ ['Approve BIA report','tono','2026-12-01','open'], ['Approve BC strategy','hendra','2026-12-15','open'], ['Approve BC plan: DC Jakarta','bagus','2027-01-10','open'], ['Run table-top exercise EX-01','tono','2027-01-15','open'], ['Internal audit of the BCMS','maya','2027-01-25','open'] ],
  abms:[],
};
export const PAST = {
  isms:[ ['NC-2025-01','Minor','7.5.3','Obsolete procedure version accessible on intranet','closed','Closed 12 Aug 2025, effectiveness verified'], ['NC-2025-02','Minor','8.8 / A.8.8','Remediation SLA missed for 3 critical vulnerabilities','open','Corrective action implemented, verification due 20 Oct 2026'], ['OFI-2025-01','OFI','9.1','Metric definitions lack target thresholds','closed','Addressed in measurement plan v2'] ],
  qms:[ ['NC-2025-03','Minor','8.4','Supplier re-evaluation overdue for 2 suppliers','open','Corrective action in progress'], ['OFI-2025-04','OFI','9.1.3','Trend analysis of customer complaints','closed','Quarterly trend report added'] ],
  bcms:[], abms:[],
};
export const CYCLE_ITEMS = {
  isms:[ ['6.1.2','Risk assessment reviewed this cycle','rina','2026-10-30','progress','32 of 38 risks reassessed; 6 older than 12 months'], ['9.2','Internal audit covering all requirements and controls','maya','2026-10-06','progress','Fieldwork complete, report in drafting'], ['9.3','Management review with all mandatory inputs','hendra','2026-10-28','open','2 of 7 inputs not yet prepared'], ['10.2','Corrective actions closed with verification','bagus','2026-10-20','progress','1 of 2 NC awaiting effectiveness verification'], ['9.1','Performance measured and analysed','rina','2026-10-15','open','3 metrics not updated since June'], ['7.5.2','Document reviews on time','rina','2026-10-31','open','5 documents past review date'] ],
  qms:[ ['6.1','Risks and opportunities reviewed','sari','2026-11-05','progress','2 items pending'], ['9.1.2','Customer satisfaction analysed','sari','2026-10-05','open','Q3 survey not analysed'], ['9.2','Internal audit against 2026 edition','maya','2026-11-14','open','Programme approved'], ['9.3','Management review incl. transition','hendra','2026-11-20','open',''], ['10.2','Corrective actions closed with verification','sari','2026-11-01','progress','NC-2025-03 in progress'], ['-','Edition transition tasks complete','sari','2026-11-10','progress','9 of 14 complete'] ],
  bcms:[ ['8.2.2','Business impact analysis approved','tono','2026-12-01','open','2 BIAs outstanding'], ['8.2.3','Disruption risk assessment approved','bagus','2026-12-10','open',''], ['8.5','Exercise programme executed','tono','2027-01-15','open','No exercise scheduled yet'], ['9.2','Internal audit of the BCMS','maya','2027-01-25','open',''], ['9.3','Management review','hendra','2027-01-30','open',''] ],
  abms:[ ['4.5','Bribery risk assessment approved','lina','2026-11-30','open','Not started'], ['5.1.1','Governing body oversight recorded','hendra','2026-12-15','open',''], ['8.2','Due diligence on business associates','andi','2027-01-31','open',''], ['9.4','Compliance function report to governing body','lina','2027-03-31','open',''] ],
};
export const DRIFT = {
  isms:[ { id:'risk12', l:['Risks not reassessed in 12 months','Risiko tidak dinilai ulang 12 bulan'], rows:[ ['R-005','Data centre power failure','bagus','2026-10-30'], ['R-009','Loss of key personnel','dewi','2026-10-30'], ['R-011','Ransomware on file servers','bagus','2026-10-30'], ['R-017','Physical intrusion Surabaya','fajar','2026-10-30'], ['R-020','Misconfigured cloud storage','yusuf','2026-10-30'], ['R-029','Regulatory penalty (PDP Law)','lina','2026-10-30'] ] }, { id:'unverif', l:['Evidence files that cannot be verified','Berkas bukti tak terverifikasi'], src:'unverif' }, { id:'metric', l:['Metrics no longer updated','Metrik berhenti diperbarui'], src:'metric' }, { id:'mr', l:['Management review inputs missing','Input tinjauan manajemen hilang'], rows:[ ['9.3.2 c)','Trends in nonconformities and corrective actions','rina','2026-10-21'], ['9.3.2 f)','Results of risk assessment and treatment plan status','rina','2026-10-21'] ] } ],
  qms:[ { id:'risk12', l:['Risks not reassessed in 12 months','Risiko tidak dinilai ulang 12 bulan'], rows:[ ['RO-03','Dependency on single hosting vendor','sari','2026-11-05'], ['RO-05','Skills gap in QA automation','yusuf','2026-11-05'] ] }, { id:'metric', l:['Metrics no longer updated','Metrik berhenti diperbarui'], src:'metric' }, { id:'csat', l:['Customer satisfaction not analysed this cycle','Kepuasan pelanggan belum dianalisis'], rows:[ ['QO-03','Customer satisfaction ≥ 4.3 / 5: Q3 survey','sari','2026-10-05'] ] } ],
  bcms:[ { id:'exercise', l:['BC plans without a scheduled exercise','Rencana BC tanpa latihan terjadwal'], src:'exercise' }, { id:'unverif', l:['Evidence files that cannot be verified','Berkas bukti tak terverifikasi'], src:'unverif' }, { id:'nohash', l:['Google-native evidence without content hash','Bukti Google native tanpa hash'], src:'nohash' } ],
  abms:[ { id:'dd', l:['Business associates without valid due diligence','Mitra tanpa due diligence berlaku'], rows:[] } ],
};
export const EXAMPLES = { '8.8':'Scanner PDF report showing scan date and remediation status', '8.13':'Backup job log export and restore test sign-off', '5.18':'Access review spreadsheet signed by the system owner', '6.3':'LMS attendance export or signed attendance sheet', '8.32':'CAB meeting minutes with approvals', '5.9':'Asset register export with date stamp', '7.13':'Vendor maintenance report or signed log', '8.15':'SIEM review record with reviewer and date', '5.19':'Completed supplier security questionnaire and review notes', '8.24':'Key rotation ticket or KMS audit log' };
export const REPOS = [
  { id:'sp', adapter:'m365', ownershipType:'organizational', actions:['test'], name:'SharePoint Online', type:'Microsoft 365', modes:'Link, Pass-through', status:'ok', tenant:'Compliance library, Sites.Selected', ms:['ISMS'], last:'29 Sep 2026 06:00' },
  { id:'gd', adapter:'google_drive', ownershipType:'organizational', actions:['test','reauthorise'], name:'Google Shared Drive', type:'Google Workspace', modes:'Zero-transit, Link', status:'bad', msg:['Delegated token expired 27 Sep 2026: checks paused for 11 references','Token delegasi kedaluwarsa 27 Sep 2026: pemeriksaan 11 rujukan tertunda'], tenant:'Compliance BCMS drive, drive.file', ms:['BCMS'], last:'27 Sep 2026 06:00' },
  { id:'vault', adapter:'managed_vault', ownershipType:'organizational', actions:['test'], name:'Managed Vault', type:'', modes:['Upload, versioned, SHA-256','Upload, berversi, SHA-256'], status:'ok', tenant:['Retention 6 years, encryption per tenant','Retensi 6 tahun, enkripsi per tenant'], ms:['QMS','ABMS'], last:'29 Sep 2026 06:00' },
  { id:'od', adapter:'m365', ownershipType:'personal', actions:['test','moveToLibrary'], name:'OneDrive personal', type:'Microsoft 365', modes:'Link', status:'warn', msg:['Personal repository, account disabled 15 Aug 2026, move evidence to the team library','Repositori pribadi, akun dinonaktifkan 15 Agu 2026, pindahkan bukti ke library tim'], tenant:['F. Nugroho, account disabled','F. Nugroho, akun dinonaktifkan'], ms:['ISMS'], last:'29 Sep 2026 06:00' },
];
export const ROUTING = [ ['ISMS','SharePoint Online','Link',['Restricted to Zero-transit','Terbatas ke Zero-transit']], ['QMS','Managed Vault','Upload','-'], ['BCMS','Google Shared Drive','Zero-transit',['Internal to Link','Internal ke Link']], ['ABMS','Managed Vault','Upload',['Concerns & investigations to restricted vault','Laporan & investigasi ke vault terbatas']] ];
export const LICENCE = { org:'PT Nusantara Digital Teknologi', to:'31 Mar 2027', fw:'4 of 4', ms:'4 of 10', users:'86 of 150', adapters:'Managed Vault, Microsoft 365, Google Workspace, SMB', features:[['Integrated Management System','Sistem Manajemen Terintegrasi'],['Edition Transition Assistant','Asisten Transisi Edisi'],['Link Health Monitor','Pemantau Kesehatan Tautan'],['Auditor guest access','Akses tamu auditor']], sig:['Ed25519, verified','Ed25519, terverifikasi'] };
export const PACKS = { isms:{ v:'1.2.0', installed:'02 Feb 2026', eds:'2022', update:null, status:'current' }, qms:{ v:'0.9.0 (2026), 1.4.2 (2015)', installed:'18 Sep 2026', eds:['2026 current, 2015 in transition','2026 berlaku, 2015 dalam transisi'], update:['1.0.0: subclause numbering verified against published text','1.0.0: penomoran subklausul diverifikasi terhadap teks terbitan'], status:'transition' }, bcms:{ v:'1.0.0', installed:'02 Apr 2026', eds:'2019', update:null, status:'current' }, abms:{ v:'0.6.0 (beta)', installed:'01 Sep 2026', eds:['2025 current, 2016 withdrawn','2025 berlaku, 2016 ditarik'], update:['0.7.0: 26 more activities, 80 finding conditions','0.7.0: tambahan 26 aktivitas, 80 kondisi temuan'], status:'beta' } };

export const PICKER_FILES = {
  sp:{ path:'Compliance / ISMS / Evidence / 2026 / Q3', files:[ ['Backup-Job-Log-Sep-2026.xlsx','28 Sep 2026','v3.0','quickXorHash','Bagus Prasetyo'], ['Restore-Test-2026-09-26.pdf','26 Sep 2026','v1.0','quickXorHash','Bagus Prasetyo'], ['Vuln-Scan-Report-2026-09.pdf','27 Sep 2026','v1.0','quickXorHash','Bagus Prasetyo'], ['Access-Review-Q3-2026.xlsx','22 Sep 2026','v2.0','quickXorHash','Rina Kusuma'], ['CAB-Minutes-2026-09-24.docx','24 Sep 2026','v4.0','quickXorHash','Bagus Prasetyo'] ] },
  gd:{ path:'Compliance BCMS / Evidence / 2026', files:[ ['BIA-Workshop-Notes-Sep.gdoc','25 Sep 2026','rev 7','none','Tono Hartono'], ['Prioritised-Activities-v1.xlsx','15 Sep 2026','rev 3','SHA-256','Tono Hartono'], ['Utility-Feed-Assessment.pdf','20 Sep 2026','rev 1','SHA-256','Bagus Prasetyo'] ] },
};

export const PLACEHOLDERS = {
  m1overview:{ prd:'§7.2', title:['Module 1, Overview','Modul 1, Ikhtisar'], bullets:['Aggregate readiness per clause for the active MS','Current phase, next gate and top three blockers','Five clickable summary cards (built: see Controls & requirements)'] },
  phases:{ prd:'§7.4', title:['Phase board & phase drill-down','Papan fase & rincian fase'], bullets:['Phase cards as tabs; counts computed from activity data','Gate banner: all activities must be Verified before the next phase opens','Activity table grouped by clause with Mark complete / Record blocker / Verify output'] },
  docs:{ prd:'§7.3', title:['Document register','Register dokumen'], bullets:['Grouped by tier: Policies, Standards, Procedures, Plans, Registers, Records, Forms','Shared IMS- documents show the other frameworks using them','Orphan Detector candidates flagged (built partially: see Documents tabs in Controls)'] },
  audit:{ prd:'§8.3 – 8.5', title:['Audit readiness & interactive traceability test','Kesiapan audit & uji keterlacakan interaktif'], bullets:['Chain picker (R-014, R-003, R-022 or random) rendering the pack-defined chain','Nodes coloured from record status; unready nodes show holder and due date','Readiness per chain stage table (three-colour bar, after-audit count, next due)'] },
  gt:{ prd:'§8.2', title:['Golden Thread Viewer','Golden Thread Viewer'], bullets:['Pick any node: risk, control, document, prioritised activity, business associate','Broken-chain markers with the clause violated','Shared markers with links to the same chain in other MS'] },
  timeline:{ prd:'§9.4 – 9.5', title:['Certification cycle timeline & event drill-down','Linimasa siklus sertifikasi & rincian event'], bullets:['Three-year timeline per MS; combined view to spot joint audits','Event detail: preparation checklist, previous findings to prove closed, expected focus','Cycle completeness: top four items on the main page, full list in drill-down'] },
  cal:{ prd:'§9.8', title:['Document review calendar','Kalender review dokumen'], bullets:['Overdue group first, then the next four months','Rows use the Module 1 register format: start review straight from the calendar'] },
  mytasks:{ prd:'§4, §7.1', title:['My Tasks: Domain Owner','Tugas Saya: Domain Owner'], bullets:['Cross-framework by default; small ignorable framework marker per task','Plain-language instruction and examples of accepted evidence','One submit button: file picker for Customer Repository, upload for Managed Vault'] },
  fw:{ prd:'§5.4, §12', title:['Framework library','Pustaka framework'], bullets:['Activate frameworks per licence; choose edition; set scope and certifier','Pack versions with signature status; offline bundle import for On-Premise','Edition Transition Assistant entry point (ISO 9001:2026, ISO 37001:2025)'] },
  storage:{ prd:'§11, §12', title:['Storage repositories & link health','Repositori penyimpanan & kesehatan tautan'], bullets:['Connect, test and monitor repositories; routing rules per MS and classification','Link Health Monitor: verified / changed / moved / missing / access revoked','Personal repositories (OneDrive, My Drive) flagged with move recommendation'] },
};
