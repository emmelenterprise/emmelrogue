/**
 * Extracts ALL Pokemon data from the game source files.
 * Reads species-id.ts (enum), starters.ts (base costs), and German locale
 * to produce pokemon-data.json with ALL Pokemon including evolutions.
 *
 * For Pokemon without explicit starter cost, cost is estimated based on
 * evolution depth and base species cost.
 *
 * Run once: node server/scripts/extract-pokemon-data.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SPECIES_FILE = path.join(ROOT, 'src', 'enums', 'species-id.ts');
const STARTERS_FILE = path.join(ROOT, 'src', 'data', 'balance', 'starters.ts');
const LOCALE_DE_FILE = path.join(ROOT, 'locales', 'de', 'pokemon.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'pokemon-data.json');

// --- Step 1: Parse SpeciesId enum ---
function parseSpeciesEnum() {
  const content = fs.readFileSync(SPECIES_FILE, 'utf-8');
  const enumMap = {}; // name -> numericId
  const idToName = {}; // numericId -> name

  const enumBodyMatch = content.match(/export\s+enum\s+SpeciesId\s*\{([\s\S]*?)\n\}/);
  if (!enumBodyMatch) throw new Error('Could not find SpeciesId enum');

  const body = enumBodyMatch[1];
  let currentValue = 0;

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;

    const match = trimmed.match(/^([A-Z_0-9]+)\s*(?:=\s*(-?\d+))?\s*[,}]?/);
    if (!match) continue;

    const name = match[1];
    if (match[2] !== undefined) {
      currentValue = parseInt(match[2], 10);
    }

    enumMap[name] = currentValue;
    idToName[currentValue] = name;
    currentValue++;
  }

  console.log(`Parsed ${Object.keys(enumMap).length} species from enum`);
  return { enumMap, idToName };
}

// --- Step 2: Parse speciesStarterCosts ---
function parseStarterCosts() {
  const content = fs.readFileSync(STARTERS_FILE, 'utf-8');
  const costs = {}; // enum name -> cost

  const regex = /\[SpeciesId\.([A-Z_0-9]+)\]\s*:\s*(\d+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    costs[match[1]] = parseInt(match[2], 10);
  }

  console.log(`Parsed ${Object.keys(costs).length} starter costs`);
  return costs;
}

// --- Step 3: Convert enum name to display name ---
function enumToName(enumName) {
  const specials = {
    'NIDORAN_F': 'Nidoran♀',
    'NIDORAN_M': 'Nidoran♂',
    'FARFETCHD': "Farfetch'd",
    'MR_MIME': 'Mr. Mime',
    'MR_RIME': 'Mr. Rime',
    'MIME_JR': 'Mime Jr.',
    'TYPE_NULL': 'Type: Null',
    'JANGMO_O': 'Jangmo-o',
    'HAKAMO_O': 'Hakamo-o',
    'KOMMO_O': 'Kommo-o',
    'TAPU_KOKO': 'Tapu Koko',
    'TAPU_LELE': 'Tapu Lele',
    'TAPU_BULU': 'Tapu Bulu',
    'TAPU_FINI': 'Tapu Fini',
    'HO_OH': 'Ho-Oh',
    'PORYGON_Z': 'Porygon-Z',
    'PORYGON2': 'Porygon2',
    'WO_CHIEN': 'Wo-Chien',
    'CHIEN_PAO': 'Chien-Pao',
    'TING_LU': 'Ting-Lu',
    'CHI_YU': 'Chi-Yu',
    'IRON_TREADS': 'Iron Treads',
    'IRON_BUNDLE': 'Iron Bundle',
    'IRON_HANDS': 'Iron Hands',
    'IRON_JUGULIS': 'Iron Jugulis',
    'IRON_MOTH': 'Iron Moth',
    'IRON_THORNS': 'Iron Thorns',
    'IRON_VALIANT': 'Iron Valiant',
    'IRON_LEAVES': 'Iron Leaves',
    'IRON_BOULDER': 'Iron Boulder',
    'IRON_CROWN': 'Iron Crown',
    'GREAT_TUSK': 'Great Tusk',
    'SCREAM_TAIL': 'Scream Tail',
    'BRUTE_BONNET': 'Brute Bonnet',
    'FLUTTER_MANE': 'Flutter Mane',
    'SLITHER_WING': 'Slither Wing',
    'SANDY_SHOCKS': 'Sandy Shocks',
    'ROARING_MOON': 'Roaring Moon',
    'WALKING_WAKE': 'Walking Wake',
    'GOUGING_FIRE': 'Gouging Fire',
    'RAGING_BOLT': 'Raging Bolt',
    'BLOODMOON_URSALUNA': 'Bloodmoon Ursaluna',
  };

  if (specials[enumName]) return specials[enumName];

  // Handle prefixed regional variants
  const prefixes = ['ALOLA_', 'GALAR_', 'HISUI_', 'PALDEA_'];
  for (const prefix of prefixes) {
    if (enumName.startsWith(prefix)) {
      const baseName = enumName.substring(prefix.length);
      const region = prefix.replace('_', '');
      const regionName = region.charAt(0) + region.slice(1).toLowerCase();
      const base = specials[baseName] || baseName.charAt(0) + baseName.slice(1).toLowerCase().replace(/_/g, ' ');
      return `${regionName} ${base}`;
    }
  }

  return enumName.charAt(0) + enumName.slice(1).toLowerCase().replace(/_/g, ' ');
}

// --- Step 4: Convert enum name to locale key (camelCase) ---
function enumToLocaleKey(enumName) {
  const parts = enumName.toLowerCase().split('_');
  return parts[0] + parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

// --- Step 5: Build evolution chains to estimate costs ---
// Known evolution chains (base species ID -> [stage1, stage2])
// We map base IDs 1-905 (Gen 1-8 standard) to evolution families
function buildEvolutionMap(enumMap) {
  // Map: speciesId -> { baseId, stage } (0=base, 1=stage1, 2=stage2)
  const evoMap = {};

  // Parse the standard Pokemon (ID 1-1025) into evolution families
  // We use a simple heuristic: consecutive IDs that form evo lines
  // This is based on the National Pokedex ordering where evolutions follow their pre-evolutions
  const EVOLUTION_CHAINS = [
    // Gen 1
    [1,2,3],[4,5,6],[7,8,9],[10,11,12],[13,14,15],[16,17,18],[19,20],
    [21,22],[23,24],[25,26],[27,28],[29,30,31],[32,33,34],[35,36],
    [37,38],[39,40],[41,42],[43,44,45],[46,47],[48,49],[50,51],
    [52,53],[54,55],[56,57],[58,59],[60,61,62],[63,64,65],[66,67,68],
    [69,70,71],[72,73],[74,75,76],[77,78],[79,80],[81,82],[83],[84,85],
    [86,87],[88,89],[90,91],[92,93,94],[95],[96,97],[98,99],[100,101],
    [102,103],[104,105],[106],[107],[108],[109,110],[111,112],[113],
    [114],[115],[116,117],[118,119],[120,121],[122],[123],[124],[125],
    [126],[127],[128],[129,130],[131],[132],[133,134],[133,135],[133,136],
    [137],[138,139],[140,141],[142],[143],[144],[145],[146],[147,148,149],
    [150],[151],
    // Gen 2
    [152,153,154],[155,156,157],[158,159,160],[161,162],[163,164],[165,166],
    [167,168],[170,171],[172],[173],[174],[175,176],[177,178],[179,180,181],
    [183,184],[185],[186],[187,188,189],[190],[191,192],[193],[194,195],
    [196],[197],[198],[199],[200],[201],[202],[203],[204,205],[206],[207],
    [208],[209,210],[211],[212],[213],[214],[215],[216,217],[218,219],[220,221],
    [222],[223,224],[225],[226],[227],[228,229],[230],[231,232],[233],[234],
    [235],[236],[237],[238],[239],[240],[241],[242],[243],[244],[245],
    [246,247,248],[249],[250],[251],
    // Gen 3
    [252,253,254],[255,256,257],[258,259,260],[261,262],[263,264],[265,266,267],
    [265,268,269],[270,271,272],[273,274,275],[276,277],[278,279],[280,281,282],
    [283,284],[285,286],[287,288,289],[290,291],[290,292],[293,294,295],
    [296,297],[298],[299],[300,301],[302],[303],[304,305,306],[307,308],
    [309,310],[311],[312],[313],[314],[315],[316,317],[318,319],[320,321],
    [322,323],[324],[325,326],[327],[328,329,330],[331,332],[333,334],
    [335],[336],[337],[338],[339,340],[341,342],[343,344],[345,346],
    [347,348],[349,350],[351],[352],[353,354],[355,356],[357],[358],[359],
    [360],[361,362],[363,364,365],[366,367],[366,368],[369],[370],
    [371,372,373],[374,375,376],[377],[378],[379],[380],[381],[382],[383],
    [384],[385],[386],
    // Gen 4
    [387,388,389],[390,391,392],[393,394,395],[396,397,398],[399,400],
    [401,402],[403,404,405],[406],[407],[408,409],[410,411],[412,413],
    [412,414],[415,416],[417],[418,419],[420,421],[422,423],[424],[425,426],
    [427,428],[429],[430],[431,432],[433],[434,435],[436,437],[438],[439],
    [440],[441],[442],[443,444,445],[446],[447,448],[449,450],[451,452],
    [453,454],[455],[456,457],[458],[459,460],[461],[462],[463],[464],
    [465],[466],[467],[468],[469],[470],[471],[472],[473],[474],[475],
    [476],[477],[478],[479],[480],[481],[482],[483],[484],[485],[486],
    [487],[488],[489,490],[491],[492],[493],
    // Gen 5
    [494],[495,496,497],[498,499,500],[501,502,503],[504,505],[506,507,508],
    [509,510],[511,512],[513,514],[515,516],[517,518],[519,520,521],
    [522,523],[524,525,526],[527,528],[529,530],[531],[532,533,534],
    [535,536,537],[538],[539],[540,541,542],[543,544,545],[546,547],
    [548,549],[550],[551,552,553],[554,555],[556],[557,558],[559,560],
    [561],[562,563],[564,565],[566,567],[568,569],[570,571],[572,573],
    [574,575,576],[577,578,579],[580,581],[582,583,584],[585,586],
    [587],[588,589],[590,591],[592,593],[594],[595,596],[597,598],
    [599,600,601],[602,603,604],[605,606],[607,608,609],[610,611,612],
    [613,614],[615],[616,617],[618],[619,620],[621],[622,623],[624,625],
    [626],[627,628],[629,630],[631],[632],[633,634,635],[636,637],
    [638],[639],[640],[641],[642],[643],[644],[645],[646],[647],[648],[649],
    // Gen 6
    [650,651,652],[653,654,655],[656,657,658],[659,660],[661,662,663],
    [664,665,666],[667,668],[669,670,671],[672,673],[674,675],[676],
    [677,678],[679,680,681],[682,683],[684,685],[686,687],[688,689],
    [690,691],[692,693],[694,695],[696,697],[698,699],[700],[701],
    [702],[703],[704,705,706],[707],[708,709],[710,711],[712,713],
    [714,715],[716],[717],[718],[719],[720],[721],
    // Gen 7
    [722,723,724],[725,726,727],[728,729,730],[731,732,733],[734,735],
    [736,737,738],[739,740],[741],[742,743],[744,745],[746],[747,748],
    [749,750],[751,752],[753,754],[755,756],[757,758],[759,760],
    [761,762,763],[764],[765],[766],[767,768],[769,770],[771],[772,773],
    [774],[775],[776],[777],[778],[779],[780],[781],[782,783,784],
    [785],[786],[787],[788],[789,790,791],[789,790,792],[793],[794],
    [795],[796],[797],[798],[799],[800],[801],[802],[803,804],[805],
    [806],[807],[808,809],
    // Gen 8
    [810,811,812],[813,814,815],[816,817,818],[819,820],[821,822,823],
    [824,825,826],[827,828],[829,830],[831,832],[833,834],[835,836],
    [837,838,839],[840,841],[840,842],[843,844],[845],[846,847],
    [848,849],[850,851],[852,853],[854,855],[856,857,858],[859,860,861],
    [862],[863],[864],[865],[866],[867],[868,869],[870],[871],[872,873],
    [874],[875],[876],[877],[878,879],[880],[881],[882],[883],[884],
    [885,886,887],[888],[889],[890],[891,892],[893],[894],[895],[896],
    [897],[898],
    // Gen 9
    [906,907,908],[909,910,911],[912,913,914],[915,916],[917,918,919],
    [920,921],[922,923],[924,925],[926,927],[928,929,930],[931],[932,933,934],
    [935,936],[937,938],[939,940],[941],[942,943],[944,945],[946,947],
    [948,949,950],[951,952],[953,954],[955,956],[957,958],[959,960],
    [961,962],[963,964],[965,966],[967,968],[969,970],[971,972],[973],
    [974,975],[976,977],[978],[979,980],[981],[982,983],[984],[985],
    [986],[987],[988],[989],[990],[991],[992],[993],[994],[995],[996,997,998],
    [999],[1000],[1001],[1002],[1003],[1004],[1005],[1006],[1007],[1008],
    [1009],[1010],[1011],[1012],[1013],[1014],[1015],[1016],[1017],[1018],
    [1019],[1020],[1021],[1022],[1023],[1024],[1025],
  ];

  for (const chain of EVOLUTION_CHAINS) {
    const baseId = chain[0];
    for (let stage = 0; stage < chain.length; stage++) {
      const id = chain[stage];
      evoMap[id] = { baseId, stage };
    }
  }

  return evoMap;
}

// --- Main ---
const { enumMap, idToName } = parseSpeciesEnum();
const starterCosts = parseStarterCosts();

// Load German locale
let localeDe = {};
try {
  localeDe = JSON.parse(fs.readFileSync(LOCALE_DE_FILE, 'utf-8'));
  console.log(`Loaded ${Object.keys(localeDe).length} German pokemon names`);
} catch (e) {
  console.warn('Warning: Could not load German locale, using English names only');
}

// Build evolution map for cost estimation
const evoMap = buildEvolutionMap(enumMap);

// Build output with ALL Pokemon
const output = {};
let deFound = 0;
let costEstimated = 0;

for (const [enumName, id] of Object.entries(enumMap)) {
  if (id < 0) continue; // Skip invalid IDs

  const localeKey = enumToLocaleKey(enumName);
  let nameDe = localeDe[localeKey] || null;
  const nameEn = enumToName(enumName);

  // For regional forms: prefix the German name with region if it's the same as the base
  const prefixes = ['ALOLA_', 'GALAR_', 'HISUI_', 'PALDEA_'];
  const regionLabels = { 'ALOLA_': 'Alola', 'GALAR_': 'Galar', 'HISUI_': 'Hisui', 'PALDEA_': 'Paldea' };
  for (const prefix of prefixes) {
    if (enumName.startsWith(prefix)) {
      const baseName = enumName.substring(prefix.length);
      const baseLocaleKey = enumToLocaleKey(baseName);
      const baseNameDe = localeDe[baseLocaleKey] || null;
      // If regional form has same German name as base, prefix with region
      if (nameDe && baseNameDe && nameDe === baseNameDe) {
        nameDe = `${regionLabels[prefix]}-${nameDe}`;
      } else if (!nameDe && baseNameDe) {
        nameDe = `${regionLabels[prefix]}-${baseNameDe}`;
      }
      break;
    }
  }

  if (nameDe) deFound++;

  // Determine cost
  let cost;
  if (starterCosts[enumName] !== undefined) {
    cost = starterCosts[enumName];
  } else {
    // Estimate cost based on evolution stage
    const evo = evoMap[id];
    if (evo && evo.stage > 0) {
      // Look up base species cost
      const baseEnumName = idToName[evo.baseId];
      const baseCost = baseEnumName ? (starterCosts[baseEnumName] || 3) : 3;
      // +2 per evolution stage
      cost = Math.min(10, baseCost + evo.stage * 2);
    } else if (id >= 2000) {
      // Regional form: use base species cost + 1
      const baseId = id % 2000 < 1000 ? id % 2000 : id % 4000 < 2000 ? id % 4000 : id % 2000;
      const baseEnumName = idToName[baseId];
      const baseCost = baseEnumName ? (starterCosts[baseEnumName] || 5) : 5;
      cost = Math.min(10, baseCost + 1);
    } else {
      // Unknown Pokemon, default cost based on ID range (later = stronger)
      if (id <= 151) cost = 5;
      else if (id <= 251) cost = 5;
      else if (id <= 386) cost = 6;
      else if (id <= 493) cost = 6;
      else if (id <= 649) cost = 6;
      else if (id <= 721) cost = 7;
      else if (id <= 809) cost = 7;
      else if (id <= 905) cost = 7;
      else cost = 7;
    }
    costEstimated++;
  }

  // Determine generation (for icon path)
  let generation;
  if (enumName.startsWith('ALOLA_')) generation = 7;
  else if (enumName.startsWith('GALAR_')) generation = 8;
  else if (enumName.startsWith('HISUI_')) generation = 8;
  else if (enumName.startsWith('PALDEA_')) generation = 9;
  else if (id <= 151) generation = 1;
  else if (id <= 251) generation = 2;
  else if (id <= 386) generation = 3;
  else if (id <= 493) generation = 4;
  else if (id <= 649) generation = 5;
  else if (id <= 721) generation = 6;
  else if (id <= 809) generation = 7;
  else if (id <= 905) generation = 8;
  else generation = 9;

  const entry = {
    name: nameEn,
    name_de: nameDe || nameEn,
    cost,
    generation,
  };
  // Mark species with explicit starter costs (used by starter-generator)
  if (starterCosts[enumName] !== undefined) {
    entry.starter = true;
  }
  output[id] = entry;
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
console.log(`Written ${Object.keys(output).length} entries to ${OUTPUT_FILE}`);
console.log(`  ${deFound} with German names, ${costEstimated} with estimated costs`);
console.log(`  ${Object.keys(starterCosts).length} with explicit starter costs`);
