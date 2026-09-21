export const WORK_CATALOG_VERSION = "2026.09.22.2";
export const BUNDLED_WORK_CATALOG = [
  {
    "id": "paint.walls",
    "label": "Pitturazione pareti",
    "category": "Pittura",
    "quantityRule": "ROOM_NET_WALLS",
    "unit": "m²",
    "basePriority": 150,
    "synonyms": [
      "pitturare muri",
      "pittura muri",
      "tinteggiare",
      "imbiancare pareti"
    ]
  },
  {
    "id": "paint.ceiling",
    "label": "Pitturazione soffitto",
    "category": "Pittura",
    "quantityRule": "ROOM_CEILING",
    "unit": "m²",
    "basePriority": 145,
    "synonyms": [
      "pitturare soffitto",
      "imbiancare soffitto"
    ]
  },
  {
    "id": "paint.walls_ceiling",
    "label": "Pitturazione pareti + soffitto",
    "category": "Pittura",
    "quantityRule": "ROOM_WALLS_CEILING",
    "unit": "m²",
    "basePriority": 155,
    "synonyms": [
      "pitturare tutto",
      "pittura completa",
      "pareti soffitto"
    ]
  },
  {
    "id": "skim.walls",
    "label": "Rasatura pareti",
    "category": "Rasature",
    "quantityRule": "ROOM_NET_WALLS",
    "unit": "m²",
    "basePriority": 150,
    "synonyms": [
      "rasare muri",
      "rasatura muri"
    ]
  },
  {
    "id": "skim.ceiling",
    "label": "Rasatura soffitto",
    "category": "Rasature",
    "quantityRule": "ROOM_CEILING",
    "unit": "m²",
    "basePriority": 125,
    "synonyms": [
      "rasare soffitto"
    ]
  },
  {
    "id": "skim.walls_ceiling",
    "label": "Rasatura pareti + soffitto",
    "category": "Rasature",
    "quantityRule": "ROOM_WALLS_CEILING",
    "unit": "m²",
    "basePriority": 145,
    "synonyms": [
      "rasare tutto"
    ]
  },
  {
    "id": "skim.reinforced",
    "label": "Rasatura armata con rete",
    "category": "Rasature",
    "quantityRule": "ROOM_NET_WALLS",
    "unit": "m²",
    "basePriority": 140,
    "synonyms": [
      "rasatura rete",
      "rete rasatura"
    ]
  },
  {
    "id": "tiles.remove.wall",
    "label": "Rimozione piastrelle pareti",
    "category": "Demolizioni",
    "quantityRule": "ROOM_TILING_OR_NET_WALLS",
    "unit": "m²",
    "basePriority": 150,
    "synonyms": [
      "togliere piastrelle muri",
      "levare piastrelle pareti",
      "demolizione rivestimento"
    ]
  },
  {
    "id": "tiles.remove.floor",
    "label": "Rimozione piastrelle pavimento",
    "category": "Demolizioni",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 145,
    "synonyms": [
      "togliere piastrelle pavimento",
      "demolizione piastrelle"
    ]
  },
  {
    "id": "tiles.install.wall",
    "label": "Posa piastrelle pareti",
    "category": "Rivestimenti",
    "quantityRule": "ROOM_TILING_OR_NET_WALLS",
    "unit": "m²",
    "basePriority": 150,
    "synonyms": [
      "piastrellare muri",
      "rivestimento pareti"
    ]
  },
  {
    "id": "tiles.install.floor",
    "label": "Posa piastrelle pavimento",
    "category": "Pavimenti",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 155,
    "synonyms": [
      "piastrellare pavimento",
      "posa gres"
    ]
  },
  {
    "id": "tiles.over.floor",
    "label": "Posa su posa pavimento",
    "category": "Pavimenti",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 145,
    "synonyms": [
      "posa sopra piastrelle",
      "piastrelle su piastrelle"
    ]
  },
  {
    "id": "floor.demolish",
    "label": "Demolizione pavimento",
    "category": "Demolizioni",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 145,
    "synonyms": [
      "demolire pavimento",
      "rimuovere pavimento"
    ]
  },
  {
    "id": "floor.leveling",
    "label": "Autolivellante",
    "category": "Pavimenti",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 145,
    "synonyms": [
      "livellante",
      "autolivellante pavimento"
    ]
  },
  {
    "id": "floor.screed",
    "label": "Massetto",
    "category": "Pavimenti",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 140,
    "synonyms": [
      "nuovo massetto",
      "rifare massetto"
    ]
  },
  {
    "id": "floor.spc",
    "label": "Posa pavimento SPC",
    "category": "Pavimenti",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 150,
    "synonyms": [
      "spc",
      "posa spc",
      "vinilico spc"
    ]
  },
  {
    "id": "floor.lvt",
    "label": "Posa pavimento LVT",
    "category": "Pavimenti",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 125,
    "synonyms": [
      "lvt",
      "posa lvt"
    ]
  },
  {
    "id": "floor.laminate",
    "label": "Posa laminato",
    "category": "Pavimenti",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 135,
    "synonyms": [
      "laminato",
      "posa laminato"
    ]
  },
  {
    "id": "floor.parquet",
    "label": "Posa parquet flottante",
    "category": "Pavimenti",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 95,
    "synonyms": [
      "parquet",
      "posa parquet"
    ]
  },
  {
    "id": "skirting.install",
    "label": "Posa battiscopa",
    "category": "Pavimenti",
    "quantityRule": "ROOM_SKIRTING",
    "unit": "m",
    "basePriority": 145,
    "synonyms": [
      "battiscopa",
      "zoccolino"
    ]
  },
  {
    "id": "wall.demolish",
    "label": "Demolizione parete",
    "category": "Demolizioni",
    "quantityRule": "WALL_GROSS_AREA",
    "unit": "m²",
    "basePriority": 140,
    "synonyms": [
      "demolire muro",
      "abbattere parete",
      "demolizione muro"
    ]
  },
  {
    "id": "wall.partition",
    "label": "Nuova parete in laterizio",
    "category": "Muratura",
    "quantityRule": "WALL_GROSS_AREA",
    "unit": "m²",
    "basePriority": 110,
    "synonyms": [
      "nuovo muro",
      "tramezzo laterizio"
    ]
  },
  {
    "id": "wall.restore",
    "label": "Ripristino muratura",
    "category": "Muratura",
    "quantityRule": "WALL_GROSS_AREA",
    "unit": "m²",
    "basePriority": 100,
    "synonyms": [
      "ripristino muro",
      "riparare muro"
    ]
  },
  {
    "id": "plaster.restore",
    "label": "Ripristino intonaco",
    "category": "Muratura",
    "quantityRule": "ROOM_NET_WALLS",
    "unit": "m²",
    "basePriority": 135,
    "synonyms": [
      "intonaco",
      "rifare intonaco"
    ]
  },
  {
    "id": "traces.open",
    "label": "Apertura tracce",
    "category": "Impianti",
    "quantityRule": "MANUAL",
    "unit": "m",
    "basePriority": 95,
    "synonyms": [
      "fare tracce",
      "tracce muro"
    ]
  },
  {
    "id": "traces.close",
    "label": "Chiusura tracce",
    "category": "Muratura",
    "quantityRule": "MANUAL",
    "unit": "m",
    "basePriority": 140,
    "synonyms": [
      "chiudere tracce",
      "ripristino tracce"
    ]
  },
  {
    "id": "drywall.ceiling",
    "label": "Controsoffitto cartongesso",
    "category": "Cartongesso",
    "quantityRule": "ROOM_CEILING",
    "unit": "m²",
    "basePriority": 145,
    "synonyms": [
      "controsoffitto",
      "abbassamento cartongesso"
    ]
  },
  {
    "id": "drywall.wall",
    "label": "Controparete cartongesso",
    "category": "Cartongesso",
    "quantityRule": "WALL_GROSS_AREA",
    "unit": "m²",
    "basePriority": 110,
    "synonyms": [
      "controparete",
      "parete cartongesso"
    ]
  },
  {
    "id": "drywall.partition",
    "label": "Parete divisoria cartongesso",
    "category": "Cartongesso",
    "quantityRule": "WALL_GROSS_AREA",
    "unit": "m²",
    "basePriority": 105,
    "synonyms": [
      "tramezzo cartongesso",
      "divisorio cartongesso"
    ]
  },
  {
    "id": "drywall.valance",
    "label": "Veletta cartongesso",
    "category": "Cartongesso",
    "quantityRule": "MANUAL",
    "unit": "m",
    "basePriority": 115,
    "synonyms": [
      "veletta",
      "velette"
    ]
  },
  {
    "id": "drywall.box",
    "label": "Cassonetto cartongesso",
    "category": "Cartongesso",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 85,
    "synonyms": [
      "cassonetto cartongesso",
      "chiusura tubi"
    ]
  },
  {
    "id": "waterproof.floor",
    "label": "Impermeabilizzazione pavimento",
    "category": "Impermeabilizzazioni",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 105,
    "synonyms": [
      "guaina pavimento",
      "impermeabilizzare pavimento"
    ]
  },
  {
    "id": "waterproof.shower",
    "label": "Impermeabilizzazione doccia",
    "category": "Bagno",
    "quantityRule": "MANUAL",
    "unit": "m²",
    "basePriority": 115,
    "synonyms": [
      "guaina doccia",
      "impermeabilizzare doccia"
    ]
  },
  {
    "id": "bath.complete",
    "label": "Rifacimento bagno completo",
    "category": "Bagno",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 130,
    "synonyms": [
      "bagno completo",
      "rifare bagno"
    ]
  },
  {
    "id": "bath.tub_to_shower",
    "label": "Conversione vasca in doccia",
    "category": "Bagno",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 125,
    "synonyms": [
      "vasca doccia",
      "togliere vasca mettere doccia"
    ]
  },
  {
    "id": "bath.shower.tray",
    "label": "Installazione piatto doccia",
    "category": "Bagno",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 95,
    "synonyms": [
      "piatto doccia"
    ]
  },
  {
    "id": "bath.wc",
    "label": "Installazione WC",
    "category": "Bagno",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 75,
    "synonyms": [
      "montaggio wc",
      "water"
    ]
  },
  {
    "id": "bath.bidet",
    "label": "Installazione bidet",
    "category": "Bagno",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 65,
    "synonyms": [
      "montaggio bidet"
    ]
  },
  {
    "id": "bath.sink",
    "label": "Installazione lavabo",
    "category": "Bagno",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 70,
    "synonyms": [
      "lavabo",
      "montaggio lavabo"
    ]
  },
  {
    "id": "bath.niche",
    "label": "Realizzazione nicchia doccia",
    "category": "Bagno",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 100,
    "synonyms": [
      "nicchia doccia",
      "nicchie doccia"
    ]
  },
  {
    "id": "door.install",
    "label": "Installazione porta battente",
    "category": "Aperture",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 95,
    "synonyms": [
      "porta battente",
      "montaggio porta"
    ]
  },
  {
    "id": "door.sliding",
    "label": "Installazione porta scorrevole",
    "category": "Aperture",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 125,
    "synonyms": [
      "porta scorrevole",
      "scorrevole"
    ]
  },
  {
    "id": "door.pocket",
    "label": "Installazione porta scorrevole a scomparsa",
    "category": "Aperture",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 115,
    "synonyms": [
      "scrigno",
      "porta a scomparsa",
      "controtelaio scorrevole"
    ]
  },
  {
    "id": "door.close",
    "label": "Chiusura vano porta",
    "category": "Muratura",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 110,
    "synonyms": [
      "chiudere porta",
      "murare porta",
      "chiusura porta"
    ]
  },
  {
    "id": "door.open",
    "label": "Creazione nuovo vano porta",
    "category": "Muratura",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 105,
    "synonyms": [
      "aprire porta",
      "nuovo foro porta",
      "nuovo vano"
    ]
  },
  {
    "id": "door.move",
    "label": "Spostamento porta",
    "category": "Muratura",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 90,
    "synonyms": [
      "spostare porta"
    ]
  },
  {
    "id": "window.reveal",
    "label": "Ripristino spallette finestra",
    "category": "Muratura",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 100,
    "synonyms": [
      "spallette finestra",
      "ripristino finestra"
    ]
  },
  {
    "id": "box.shutter",
    "label": "Nuovo cassonetto tapparella",
    "category": "Finiture",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 75,
    "synonyms": [
      "cassonetto tapparella",
      "cassone finestra"
    ]
  },
  {
    "id": "electric.socket",
    "label": "Nuovo punto presa",
    "category": "Elettrico",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 100,
    "synonyms": [
      "presa elettrica",
      "nuova presa"
    ]
  },
  {
    "id": "electric.move_socket",
    "label": "Spostamento presa",
    "category": "Elettrico",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 95,
    "synonyms": [
      "spostare presa"
    ]
  },
  {
    "id": "electric.light",
    "label": "Nuovo punto luce",
    "category": "Elettrico",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 95,
    "synonyms": [
      "punto luce",
      "nuova luce"
    ]
  },
  {
    "id": "electric.spotlights",
    "label": "Faretti controsoffitto",
    "category": "Elettrico",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 90,
    "synonyms": [
      "faretti",
      "spot"
    ]
  },
  {
    "id": "electric.led",
    "label": "Striscia LED",
    "category": "Elettrico",
    "quantityRule": "MANUAL",
    "unit": "m",
    "basePriority": 75,
    "synonyms": [
      "led",
      "strip led"
    ]
  },
  {
    "id": "plumbing.water",
    "label": "Nuovo punto acqua",
    "category": "Idraulico",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 100,
    "synonyms": [
      "punto acqua",
      "attacco acqua"
    ]
  },
  {
    "id": "plumbing.drain",
    "label": "Nuovo scarico",
    "category": "Idraulico",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 100,
    "synonyms": [
      "scarico",
      "nuovo scarico"
    ]
  },
  {
    "id": "plumbing.move",
    "label": "Spostamento punto acqua/scarico",
    "category": "Idraulico",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 90,
    "synonyms": [
      "spostare scarico",
      "spostare acqua"
    ]
  },
  {
    "id": "kitchen.remove",
    "label": "Rimozione cucina",
    "category": "Cucina",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 95,
    "synonyms": [
      "smontare cucina",
      "togliere cucina"
    ]
  },
  {
    "id": "kitchen.splash",
    "label": "Rivestimento paraschizzi cucina",
    "category": "Cucina",
    "quantityRule": "MANUAL",
    "unit": "m²",
    "basePriority": 105,
    "synonyms": [
      "paraschizzi",
      "schienale cucina"
    ]
  },
  {
    "id": "kitchen.connections",
    "label": "Predisposizione attacchi cucina",
    "category": "Cucina",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 85,
    "synonyms": [
      "attacchi cucina",
      "predisposizione cucina"
    ]
  },
  {
    "id": "ceiling.cracks",
    "label": "Ripristino crepe soffitto",
    "category": "Finiture",
    "quantityRule": "ROOM_CEILING",
    "unit": "m²",
    "basePriority": 80,
    "synonyms": [
      "crepe soffitto",
      "riparare soffitto"
    ]
  },
  {
    "id": "wall.cracks",
    "label": "Ripristino crepe pareti",
    "category": "Finiture",
    "quantityRule": "ROOM_NET_WALLS",
    "unit": "m²",
    "basePriority": 95,
    "synonyms": [
      "crepe muri",
      "riparare crepe"
    ]
  },
  {
    "id": "mould.treat",
    "label": "Trattamento antimuffa",
    "category": "Pittura",
    "quantityRule": "ROOM_NET_WALLS",
    "unit": "m²",
    "basePriority": 90,
    "synonyms": [
      "muffa",
      "antimuffa"
    ]
  },
  {
    "id": "primer",
    "label": "Fissativo / primer pareti",
    "category": "Pittura",
    "quantityRule": "ROOM_NET_WALLS",
    "unit": "m²",
    "basePriority": 90,
    "synonyms": [
      "fissativo",
      "primer muri"
    ]
  },
  {
    "id": "floor.primer",
    "label": "Primer / aggrappante pavimento",
    "category": "Pavimenti",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 100,
    "synonyms": [
      "aggrappante",
      "primer pavimento"
    ]
  },
  {
    "id": "terrace.demolish",
    "label": "Demolizione pavimento terrazza",
    "category": "Esterni",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 75,
    "synonyms": [
      "togliere pavimento terrazza"
    ]
  },
  {
    "id": "terrace.waterproof",
    "label": "Impermeabilizzazione terrazza",
    "category": "Esterni",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 85,
    "synonyms": [
      "guaina terrazza",
      "impermeabilizzare terrazzo"
    ]
  },
  {
    "id": "terrace.tile",
    "label": "Posa pavimento terrazza",
    "category": "Esterni",
    "quantityRule": "ROOM_FLOOR",
    "unit": "m²",
    "basePriority": 80,
    "synonyms": [
      "piastrelle terrazza",
      "pavimento terrazzo"
    ]
  },
  {
    "id": "clean.final",
    "label": "Pulizia finale cantiere",
    "category": "Generale",
    "quantityRule": "PLAN_FLOOR",
    "unit": "m²",
    "basePriority": 100,
    "synonyms": [
      "pulizia finale",
      "pulizia cantiere"
    ]
  },
  {
    "id": "protect.floor",
    "label": "Protezione pavimenti",
    "category": "Generale",
    "quantityRule": "PLAN_FLOOR",
    "unit": "m²",
    "basePriority": 85,
    "synonyms": [
      "coprire pavimenti",
      "protezione pavimento"
    ]
  },
  {
    "id": "waste.remove",
    "label": "Carico e smaltimento macerie",
    "category": "Demolizioni",
    "quantityRule": "MANUAL",
    "unit": "m³",
    "basePriority": 90,
    "synonyms": [
      "smaltimento macerie",
      "portare via macerie"
    ]
  },
  {
    "id": "furniture.move",
    "label": "Spostamento mobili",
    "category": "Generale",
    "quantityRule": "COUNT",
    "unit": "cad.",
    "basePriority": 60,
    "synonyms": [
      "spostare mobili",
      "mobili"
    ]
  },
  {
    "id": "custom",
    "label": "Lavorazione personalizzata",
    "category": "Altro",
    "quantityRule": "MANUAL",
    "unit": "",
    "basePriority": 10,
    "synonyms": [
      "altro",
      "personalizzata"
    ]
  }
];

export const WORK_USAGE_KEY = 'ge360-work-usage-v1';
export const WORK_CATALOG_CACHE_KEY = 'ge360-work-catalog-cache-v1';

function norm(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fuzzyTokenScore(query, text) {
  if (!query) return 0;
  if (text === query) return 1000;
  if (text.startsWith(query)) return 800;
  if (text.includes(query)) return 620;
  const q = query.replace(/\s+/g, '');
  const t = text.replace(/\s+/g, '');
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) if (t[i] === q[qi]) qi++;
  return qi === q.length ? Math.max(80, 300 - (t.length - q.length) * 4) : 0;
}

export function loadWorkUsage(storage = localStorage) {
  try {
    const raw = JSON.parse(storage.getItem(WORK_USAGE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) { return {}; }
}

export function recordWorkUse(id, storage = localStorage) {
  const usage = loadWorkUsage(storage);
  const row = usage[id] || { count: 0, lastUsedAt: null, favorite: false };
  row.count = Number(row.count || 0) + 1;
  row.lastUsedAt = new Date().toISOString();
  usage[id] = row;
  storage.setItem(WORK_USAGE_KEY, JSON.stringify(usage));
  return usage;
}

export function setWorkFavorite(id, favorite, storage = localStorage) {
  const usage = loadWorkUsage(storage);
  const row = usage[id] || { count: 0, lastUsedAt: null, favorite: false };
  row.favorite = !!favorite;
  usage[id] = row;
  storage.setItem(WORK_USAGE_KEY, JSON.stringify(usage));
  return usage;
}

function roomBoost(item, roomType) {
  const cat = String(item.category || '').toLowerCase();
  const id = String(item.id || '');
  if (roomType === 'bagno') {
    if (cat === 'bagno' || cat === 'idraulico' || id.includes('waterproof')) return 120;
    if (cat === 'rivestimenti') return 80;
  }
  if (roomType === 'cucina') {
    if (cat === 'cucina') return 120;
    if (cat === 'rivestimenti' || cat === 'elettrico' || cat === 'idraulico') return 55;
  }
  if (roomType === 'esterno' && cat === 'esterni') return 120;
  if (['camera','soggiorno','disimpegno','studio','ripostiglio'].includes(roomType)) {
    if (['pittura','rasature','pavimenti','finiture'].includes(cat)) return 45;
  }
  return 0;
}

export function searchWorkCatalog(catalog, query, { roomType = 'altro', usage = {}, limit = 12 } = {}) {
  const q = norm(query);
  return (catalog || []).map(item => {
    const row = usage[item.id] || {};
    const hay = [item.label, item.category].concat(item.synonyms || []).map(norm);
    let match = q ? Math.max(...hay.map(text => fuzzyTokenScore(q, text))) : 1;
    if (!match) return null;
    const count = Number(row.count || 0);
    const recent = row.lastUsedAt ? Math.max(0, 40 - Math.floor((Date.now() - Date.parse(row.lastUsedAt)) / 86400000)) : 0;
    const usageScore = q ? Math.min(100, count * 5) : Math.min(1200, count * 120);
    const score =
      (q ? match * 10 : 0) +
      Number(item.basePriority || 0) +
      usageScore +
      recent +
      (row.favorite ? 1400 : 0) +
      roomBoost(item, roomType);
    return { item, score, usage: row };
  }).filter(Boolean)
    .sort((a,b) => b.score - a.score || a.item.label.localeCompare(b.item.label, 'it'))
    .slice(0, limit)
    .map(row => row.item);
}

export function loadCachedWorkCatalog(storage = localStorage) {
  try {
    const raw = JSON.parse(storage.getItem(WORK_CATALOG_CACHE_KEY) || 'null');
    if (raw && Array.isArray(raw.works) && raw.works.length) return raw;
  } catch (_) {}
  return { version: WORK_CATALOG_VERSION, works: BUNDLED_WORK_CATALOG };
}

export function saveCachedWorkCatalog(data, storage = localStorage) {
  if (!data || !Array.isArray(data.works) || !data.works.length) return false;
  storage.setItem(WORK_CATALOG_CACHE_KEY, JSON.stringify(data));
  return true;
}
