/** Initial Canadian institution selector. Listing a school is not an affiliation, SSO integration, or access guarantee. */
export const INSTITUTIONS = [
 {id:'western',name:'Western University',city:'London',aliases:'UWO Western',logo:'/institutions/western.svg',login:true},
 {id:'toronto',name:'University of Toronto',city:'Toronto',aliases:'UofT U of T',logo:'/institutions/toronto.svg',login:false},
 {id:'waterloo',name:'University of Waterloo',city:'Waterloo',aliases:'UW',logo:'/institutions/waterloo.svg',login:false},
 {id:'mcmaster',name:'McMaster University',city:'Hamilton',aliases:'Mac',logo:'/institutions/mcmaster.png',login:false},
 {id:'queens',name:"Queen’s University",city:'Kingston',aliases:'Queens Queen\'s',logo:'/institutions/queens.svg',login:false},
 {id:'ottawa',name:'University of Ottawa',city:'Ottawa',aliases:'uOttawa Université Ottawa',logo:'/institutions/ottawa.png',login:false},
 {id:'york',name:'York University',city:'Toronto',aliases:'YorkU',logo:'/institutions/york.jpg',login:false},
 {id:'tmu',name:'Toronto Metropolitan University',city:'Toronto',aliases:'TMU Ryerson',logo:'/institutions/tmu.svg',login:false},
] as const;
export function institution(id:unknown){return INSTITUTIONS.find(s=>s.id===id);}

// Canonical names come from config; only the manual option accepts a supplied name.
export function waitlistInstitution(id: unknown, rawName: unknown): string | null {
  const selected = institution(id);
  if (selected) return selected.name;
  if (id !== 'other' || typeof rawName !== 'string') return null;
  const name = rawName.trim().replace(/ +/g, ' ');
  if (name.length < 2 || name.length > 120 || /[\p{Cc}\p{Cf}<>]/u.test(name) || !/\p{L}/u.test(name)) return null;
  const known = INSTITUTIONS.find((s) => s.name.toLowerCase() === name.toLowerCase());
  return known?.name ?? name;
}
