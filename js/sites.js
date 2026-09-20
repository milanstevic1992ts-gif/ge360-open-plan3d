export const SITE_STATUSES=Object.freeze([
  {code:'lead',label:'DA VALUTARE'},
  {code:'survey',label:'RILIEVO'},
  {code:'quote',label:'PREVENTIVO'},
  {code:'active',label:'IN CORSO'},
  {code:'paused',label:'SOSPESO'},
  {code:'done',label:'COMPLETATO'}
]);

export function createSite(input={}, idFactory) {
  const now=new Date().toISOString();
  const id=typeof idFactory==='function' ? idFactory() : 'site-'+Date.now().toString(36);
  return normalizeSite({
    id,
    clientName:input.clientName || '',
    address:input.address || '',
    title:input.title || '',
    status:input.status || 'survey',
    phone:input.phone || '',
    email:input.email || '',
    notes:input.notes || '',
    createdAt:input.createdAt || now,
    updatedAt:input.updatedAt || now
  });
}

export function normalizeSite(site) {
  const status=SITE_STATUSES.some(s=>s.code===site.status) ? site.status : 'survey';
  const clientName=String(site.clientName || '').trim();
  const address=String(site.address || '').trim();
  const title=String(site.title || '').trim() || [clientName,address].filter(Boolean).join(' · ') || 'Cantiere';
  return {
    id:String(site.id),
    title,
    clientName,
    address,
    phone:String(site.phone || '').trim(),
    email:String(site.email || '').trim(),
    status,
    notes:String(site.notes || '').trim(),
    createdAt:site.createdAt || new Date().toISOString(),
    updatedAt:site.updatedAt || new Date().toISOString()
  };
}

export function siteLabel(site) {
  if (!site) return 'Senza cantiere';
  return site.title || site.clientName || site.address || 'Cantiere';
}

export function statusLabel(code) {
  const found=SITE_STATUSES.find(s=>s.code===code);
  return found ? found.label : String(code || 'RILIEVO').toUpperCase();
}

export function siteStats(site, plans=[]) {
  const related=(plans || []).filter(p=>p && String(p.siteId || '')===String(site.id));
  const photos=related.reduce((sum,p)=>sum+(Array.isArray(p.photos)?p.photos.length:0),0);
  const takeoffRows=related.reduce((sum,p)=>sum+(p.takeoff && Array.isArray(p.takeoff.rows)?p.takeoff.rows.length:0),0);
  const updatedAt=related.reduce((latest,p)=>{
    const value=String(p.updatedAt || '');
    return value>latest ? value : latest;
  },String(site.updatedAt || ''));
  return {
    plans:related.length,
    photos,
    takeoffRows,
    updatedAt
  };
}

export function plansForSite(plans, siteId) {
  if (siteId===null || siteId===undefined || siteId==='all') return (plans || []).slice();
  if (siteId==='none') return (plans || []).filter(p=>!p.siteId);
  return (plans || []).filter(p=>String(p.siteId || '')===String(siteId));
}
