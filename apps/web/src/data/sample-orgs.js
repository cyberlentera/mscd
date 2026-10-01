// The three sample organisations (UI 1.1), moved out of the controller's ORGS getter. All three reuse the same
// management system records of mscd-data.js; `ms` lists the systems each organisation runs, in display order.
export const ORGS = [
  { id:'ndt', name:'PT Nusantara Digital Teknologi', ms:['isms','qms','bcms','abms'], deploy:'saas', sites:2 },
  { id:'bsd', name:'PT Bank Sentosa Digital', ms:['isms','qms'], deploy:'onprem', sites:3 },
  { id:'rmn', name:'RS Medika Nusantara', ms:['isms'], deploy:'saas', sites:1 },
];
