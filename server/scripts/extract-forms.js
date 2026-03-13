/**
 * Extract Pokemon form data from pokemon-species.ts and add to pokemon-data.json.
 *
 * Run: node server/scripts/extract-forms.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SPECIES_FILE = path.join(ROOT, 'src', 'data', 'balance', 'pokemon-species.ts');
const SPECIES_ENUM_FILE = path.join(ROOT, 'src', 'enums', 'species-id.ts');
const FORM_KEY_FILE = path.join(ROOT, 'src', 'enums', 'species-form-key.ts');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'pokemon-data.json');

// --- Parse SpeciesId enum to get name -> ID mapping ---
function parseSpeciesEnum() {
  const content = fs.readFileSync(SPECIES_ENUM_FILE, 'utf-8');
  const map = {};
  const bodyMatch = content.match(/export\s+enum\s+SpeciesId\s*\{([\s\S]*?)\n\}/);
  if (!bodyMatch) throw new Error('Could not find SpeciesId enum');
  let val = 0;
  for (const line of bodyMatch[1].split('\n')) {
    const m = line.trim().match(/^([A-Z_0-9]+)\s*(?:=\s*(-?\d+))?\s*[,}]?/);
    if (!m) continue;
    if (m[2] !== undefined) val = parseInt(m[2], 10);
    map[m[1]] = val;
    val++;
  }
  return map;
}

// --- Parse SpeciesFormKey enum ---
function parseFormKeys() {
  const content = fs.readFileSync(FORM_KEY_FILE, 'utf-8');
  const map = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const m = line.trim().match(/^([A-Z_0-9]+)\s*=\s*"([^"]*)"/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

// --- Parse PokemonType from string ---
function parseType(typeStr) {
  if (!typeStr || typeStr === 'null') return null;
  // PokemonType.FIRE -> FIRE
  const m = typeStr.match(/PokemonType\.(\w+)/);
  return m ? m[1].toLowerCase() : typeStr.toLowerCase();
}

// --- Parse form key from string ---
function parseFormKey(keyStr, formKeyMap) {
  if (!keyStr) return '';
  keyStr = keyStr.trim();
  if (keyStr === '""' || keyStr === "''") return '';
  // SpeciesFormKey.MEGA -> "mega"
  const m = keyStr.match(/SpeciesFormKey\.(\w+)/);
  if (m) return formKeyMap[m[1]] || m[1].toLowerCase();
  // Quoted string
  const q = keyStr.match(/^"([^"]*)"$/);
  if (q) return q[1];
  return keyStr;
}

// --- Main extraction ---
function extractForms() {
  const speciesEnum = parseSpeciesEnum();
  const formKeyMap = parseFormKeys();
  const content = fs.readFileSync(SPECIES_FILE, 'utf-8');

  // Find all PokemonSpecies blocks that contain PokemonForm
  const results = {}; // speciesId -> forms[]

  // Strategy: find each "new PokemonSpecies(SpeciesId.XXX, ..." that contains "new PokemonForm"
  // Use a regex to find species with forms
  const speciesRegex = /new PokemonSpecies\(SpeciesId\.([A-Z_0-9]+),/g;
  let speciesMatch;

  while ((speciesMatch = speciesRegex.exec(content)) !== null) {
    const enumName = speciesMatch[1];
    const speciesId = speciesEnum[enumName];
    if (speciesId === undefined) continue;

    // Find the end of this PokemonSpecies block by counting parentheses
    const startIdx = speciesMatch.index;
    let depth = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < content.length; i++) {
      if (content[i] === '(') depth++;
      if (content[i] === ')') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    const block = content.substring(startIdx, endIdx + 1);

    // Check if this block contains PokemonForm
    if (!block.includes('new PokemonForm(')) continue;

    // Extract all PokemonForm calls
    const formRegex = /new PokemonForm\(/g;
    const forms = [];
    let formMatch;

    while ((formMatch = formRegex.exec(block)) !== null) {
      // Find the matching closing paren
      const fStart = formMatch.index + formMatch[0].length;
      let fDepth = 1;
      let fEnd = fStart;
      for (let i = fStart; i < block.length; i++) {
        if (block[i] === '(') fDepth++;
        if (block[i] === ')') {
          fDepth--;
          if (fDepth === 0) {
            fEnd = i;
            break;
          }
        }
      }

      const formArgs = block.substring(fStart, fEnd);

      // Parse the form arguments
      // PokemonForm(formName, formKey, type1, type2, height, weight, ab1, ab2, ab3, baseTotal, hp, atk, def, spa, spd, spe, ...)
      // Split by comma, but respect nested parentheses
      const args = [];
      let argDepth = 0;
      let current = '';
      for (const ch of formArgs) {
        if (ch === '(' || ch === '[') argDepth++;
        if (ch === ')' || ch === ']') argDepth--;
        if (ch === ',' && argDepth === 0) {
          args.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      if (current.trim()) args.push(current.trim());

      if (args.length < 10) continue;

      const formName = args[0].replace(/^"/, '').replace(/"$/, '');
      const formKey = parseFormKey(args[1], formKeyMap);
      const type1 = parseType(args[2]);
      const type2 = parseType(args[3]);
      const baseTotal = parseInt(args[9]) || 0;

      forms.push({
        formIndex: forms.length,
        formName,
        formKey,
        type1,
        type2,
        baseTotal,
      });
    }

    // Only include species with 2+ forms (Normal form + at least one alternate)
    if (forms.length >= 2) {
      results[speciesId] = forms;
    }
  }

  return results;
}

// --- Merge with existing pokemon-data.json ---
const existingData = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8'));
const formData = extractForms();

let updatedCount = 0;
for (const [speciesId, forms] of Object.entries(formData)) {
  if (existingData[speciesId]) {
    // Only include non-Normal forms (skip formIndex 0 since it's the base form)
    const altForms = forms.filter(f => f.formKey !== '' && f.formKey !== 'Normal');
    if (altForms.length > 0) {
      existingData[speciesId].forms = altForms.map(f => ({
        formIndex: f.formIndex,
        formName: f.formName,
        formKey: f.formKey,
        type1: f.type1,
        type2: f.type2,
        baseTotal: f.baseTotal,
      }));
      updatedCount++;
    }
  }
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(existingData, null, 2));
console.log(`Updated ${updatedCount} species with form data`);
console.log(`Total form entries: ${Object.values(formData).reduce((s, f) => s + f.length, 0)}`);
