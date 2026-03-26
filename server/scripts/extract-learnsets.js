#!/usr/bin/env node
/**
 * Extract pokemon learnsets (level-up moves + egg moves) from TypeScript source
 * and generate a JSON file for the gym-admin moveset editor.
 *
 * Output: server/data/pokemon-learnsets.json
 * Format: { "speciesId": { "level": [[level, moveId], ...], "egg": [moveId, ...] } }
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src');

// --- Step 1: Parse MoveId enum ---
function parseEnum(filePath, enumName) {
  let src = fs.readFileSync(filePath, 'utf-8');
  // Strip all comments (block + line)
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

  const map = {};
  const reverseMap = {};
  let currentValue = 0;

  // Match enum body
  const enumMatch = src.match(new RegExp(`export\\s+enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\}`));
  if (!enumMatch) throw new Error(`Enum ${enumName} not found in ${filePath}`);

  const body = enumMatch[1];

  // Match all enum members: NAME = value or NAME
  const memberRegex = /([A-Z_][A-Z0-9_]*)\s*(?:=\s*(\d+))?\s*,/g;
  let match;
  while ((match = memberRegex.exec(body)) !== null) {
    const name = match[1];
    if (match[2] !== undefined) {
      currentValue = parseInt(match[2]);
    }
    map[name] = currentValue;
    reverseMap[currentValue] = name;
    currentValue++;
  }

  return { map, reverseMap };
}

// --- Step 2: Parse level moves ---
function parseLevelMoves(filePath, speciesEnum, moveEnum) {
  const src = fs.readFileSync(filePath, 'utf-8');
  const result = {};

  // Match each species entry: [SpeciesId.XXX]: [ ... ],
  const regex = /\[SpeciesId\.([A-Z_0-9]+)\]\s*:\s*\[([\s\S]*?)\](?=\s*,?\s*(?:\[SpeciesId|\}|$))/g;
  let match;

  while ((match = regex.exec(src)) !== null) {
    const speciesName = match[1];
    const speciesId = speciesEnum.map[speciesName];
    if (speciesId === undefined) continue;

    const movesBody = match[2];
    const moves = [];

    // Match [level, MoveId.XXX]
    const moveRegex = /\[\s*(\d+)\s*,\s*MoveId\.([A-Z_0-9]+)\s*\]/g;
    let moveMatch;
    while ((moveMatch = moveRegex.exec(movesBody)) !== null) {
      const level = parseInt(moveMatch[1]);
      const moveName = moveMatch[2];
      const moveId = moveEnum.map[moveName];
      if (moveId !== undefined) {
        moves.push([level, moveId]);
      }
    }

    if (moves.length > 0) {
      result[speciesId] = moves;
    }
  }

  return result;
}

// --- Step 3: Parse egg moves ---
function parseEggMoves(filePath, speciesEnum, moveEnum) {
  const src = fs.readFileSync(filePath, 'utf-8');
  const result = {};

  // Match: [SpeciesId.XXX]: [ MoveId.A, MoveId.B, ... ],
  const regex = /\[SpeciesId\.([A-Z_0-9]+)\]\s*:\s*\[\s*([\s\S]*?)\s*\]/g;
  let match;

  while ((match = regex.exec(src)) !== null) {
    const speciesName = match[1];
    const speciesId = speciesEnum.map[speciesName];
    if (speciesId === undefined) continue;

    const movesBody = match[2];
    const moves = [];

    const moveRegex = /MoveId\.([A-Z_0-9]+)/g;
    let moveMatch;
    while ((moveMatch = moveRegex.exec(movesBody)) !== null) {
      const moveId = moveEnum.map[moveMatch[1]];
      if (moveId !== undefined) {
        moves.push(moveId);
      }
    }

    if (moves.length > 0) {
      result[speciesId] = moves;
    }
  }

  return result;
}

// --- Step 4: Parse TM species map (transposed: move -> species[] => species -> moves[]) ---
function parseTmSpeciesMap(filePath, speciesEnum, moveEnum) {
  let src = fs.readFileSync(filePath, 'utf-8');
  // Strip comments
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

  const result = {}; // speciesId -> [moveId, ...]

  // Match: [MoveId.XXX]: [ ... ],
  const blockRegex = /\[MoveId\.([A-Z_0-9]+)\]\s*:\s*\[([\s\S]*?)\](?=\s*,?\s*(?:\[MoveId|\}|$))/g;
  let match;

  while ((match = blockRegex.exec(src)) !== null) {
    const moveName = match[1];
    const moveId = moveEnum.map[moveName];
    if (moveId === undefined) continue;

    const body = match[2];
    // Match SpeciesId.XXX (simple entries, not inside sub-arrays with form keys)
    const speciesRegex = /SpeciesId\.([A-Z_0-9]+)/g;
    let specMatch;
    while ((specMatch = speciesRegex.exec(body)) !== null) {
      const speciesId = speciesEnum.map[specMatch[1]];
      if (speciesId === undefined) continue;
      if (!result[speciesId]) result[speciesId] = [];
      if (!result[speciesId].includes(moveId)) {
        result[speciesId].push(moveId);
      }
    }
  }

  return result;
}

// --- Main ---
console.log('Parsing enums...');
const speciesEnum = parseEnum(path.join(SRC, 'enums', 'species-id.ts'), 'SpeciesId');
const moveEnum = parseEnum(path.join(SRC, 'enums', 'move-id.ts'), 'MoveId');
console.log(`  Species: ${Object.keys(speciesEnum.map).length}, Moves: ${Object.keys(moveEnum.map).length}`);

console.log('Parsing level moves...');
const levelMoves = parseLevelMoves(path.join(SRC, 'data', 'balance', 'pokemon-level-moves.ts'), speciesEnum, moveEnum);
console.log(`  ${Object.keys(levelMoves).length} species with level moves`);

console.log('Parsing egg moves...');
const eggMoves = parseEggMoves(path.join(SRC, 'data', 'balance', 'egg-moves.ts'), speciesEnum, moveEnum);
console.log(`  ${Object.keys(eggMoves).length} species with egg moves`);

console.log('Parsing TM species map...');
const tmMoves = parseTmSpeciesMap(path.join(SRC, 'data', 'balance', 'tm-species-map.ts'), speciesEnum, moveEnum);
console.log(`  ${Object.keys(tmMoves).length} species with TM moves`);

// --- Step 4: Parse evolutions to build prevolution chain ---
function parseEvolutions(filePath, speciesEnum) {
  let src = fs.readFileSync(filePath, 'utf-8');
  // Strip comments
  src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');

  const prevolutions = {}; // childId -> parentId

  // Match: [SpeciesId.PARENT]: [ ... new SpeciesEvolution(SpeciesId.CHILD, ...) ... ]
  const blockRegex = /\[SpeciesId\.([A-Z_0-9]+)\]\s*:\s*\[([\s\S]*?)\]/g;
  let match;
  while ((match = blockRegex.exec(src)) !== null) {
    const parentName = match[1];
    const parentId = speciesEnum.map[parentName];
    if (parentId === undefined) continue;

    const body = match[2];
    const evoRegex = /SpeciesEvolution\(\s*SpeciesId\.([A-Z_0-9]+)/g;
    let evoMatch;
    while ((evoMatch = evoRegex.exec(body)) !== null) {
      const childName = evoMatch[1];
      const childId = speciesEnum.map[childName];
      if (childId !== undefined) {
        prevolutions[childId] = parentId;
      }
    }
  }

  return prevolutions;
}

function getRootSpecies(speciesId, prevolutions) {
  let id = speciesId;
  const visited = new Set();
  while (prevolutions[id] !== undefined && !visited.has(id)) {
    visited.add(id);
    id = prevolutions[id];
  }
  return id;
}

console.log('Parsing evolutions...');
const prevolutions = parseEvolutions(path.join(SRC, 'data', 'balance', 'pokemon-evolutions.ts'), speciesEnum);
console.log(`  ${Object.keys(prevolutions).length} prevolution entries`);

// Combine — propagate egg moves from root species, include TMs
const learnsets = {};
const allSpeciesIds = new Set([...Object.keys(levelMoves), ...Object.keys(eggMoves), ...Object.keys(tmMoves)]);

for (const sid of allSpeciesIds) {
  learnsets[sid] = {};
  if (levelMoves[sid]) learnsets[sid].level = levelMoves[sid];

  // Egg moves: check this species first, then root species
  if (eggMoves[sid]) {
    learnsets[sid].egg = eggMoves[sid];
  } else {
    const rootId = getRootSpecies(parseInt(sid), prevolutions);
    if (rootId !== parseInt(sid) && eggMoves[rootId]) {
      learnsets[sid].egg = eggMoves[rootId];
    }
  }

  // TM moves
  if (tmMoves[sid]) learnsets[sid].tm = tmMoves[sid];
}

const outPath = path.join(__dirname, '..', 'data', 'pokemon-learnsets.json');
fs.writeFileSync(outPath, JSON.stringify(learnsets));
console.log(`Written ${Object.keys(learnsets).length} species to ${outPath}`);
console.log(`File size: ${(fs.statSync(outPath).size / 1024).toFixed(0)} KB`);
