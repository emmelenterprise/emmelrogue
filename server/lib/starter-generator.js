/**
 * Deterministic starter Pokemon generator using seedrandom.
 * Generates the same starters for the same seed — used for Race Menu.
 */

const seedrandom = require('seedrandom');
const path = require('path');
const pokemonData = require(path.join(__dirname, '..', 'data', 'pokemon-data.json'));

// Build cost buckets for efficient sampling
const costBuckets = {}; // cost -> [{ id, name, cost }]
const allStarters = [];

for (const [id, data] of Object.entries(pokemonData)) {
  if (!data.starter) continue; // Only use species from speciesStarterCosts (not evolutions/regional forms)
  const entry = { id: parseInt(id), name: data.name, cost: data.cost };
  allStarters.push(entry);
  if (!costBuckets[data.cost]) costBuckets[data.cost] = [];
  costBuckets[data.cost].push(entry);
}

/**
 * Generate random starters that sum to a scaled cost target.
 * Default: 3 starters, 10 cost points (mirrors getDailyRunStarters).
 * Cost scales proportionally: Math.round(10 * count / 3).
 *
 * @param {string} seed - The race seed
 * @param {number} count - Number of starters (1-6, default 3)
 * @returns {Array<{id: number, name: string, cost: number}>}
 */
function generateStarters(seed, count = 3) {
  count = Math.max(1, Math.min(6, count));
  const targetCost = Math.round(10 * count / 3);
  const rng = seedrandom(seed);

  // Try up to 100 times to get a valid combination
  for (let attempt = 0; attempt < 100; attempt++) {
    const picked = [];
    const usedIds = new Set();
    let totalCost = 0;
    let valid = true;

    for (let i = 0; i < count; i++) {
      const remaining = targetCost - totalCost;
      const slotsLeft = count - i;

      // Filter starters that could still fit
      // Each remaining slot needs at least cost 1, and at most remaining - (slotsLeft-1)
      const minCost = 1;
      const maxCost = remaining - (slotsLeft - 1);

      const candidates = allStarters.filter(
        s => s.cost >= minCost && s.cost <= maxCost && !usedIds.has(s.id)
      );

      if (candidates.length === 0) {
        valid = false;
        break;
      }

      const idx = Math.floor(rng() * candidates.length);
      const pick = candidates[idx];
      picked.push(pick);
      usedIds.add(pick.id);
      totalCost += pick.cost;
    }

    if (valid && totalCost === targetCost) {
      return picked;
    }
  }

  // Fallback: pick cost-3 starters (or whatever is available)
  const rng2 = seedrandom(seed + '-fallback');
  const cost3 = costBuckets[3] || costBuckets[4] || allStarters.slice(0, count);
  const result = [];
  const used = new Set();
  while (result.length < count && result.length < cost3.length) {
    const idx = Math.floor(rng2() * cost3.length);
    if (!used.has(cost3[idx].id)) {
      result.push(cost3[idx]);
      used.add(cost3[idx].id);
    }
  }
  return result;
}

/**
 * Generate a pool of 9 Pokemon for pick-from-pool mode.
 * Balanced across cost tiers so players have interesting choices.
 *
 * @param {string} seed - The race seed
 * @param {number} size - Pool size (default 9)
 * @returns {Array<{id: number, name: string, cost: number}>}
 */
function generatePool(seed, size = 9) {
  const rng = seedrandom(seed + '-pool');

  // Distribution: 2x low(1-2), 3x mid(3-4), 2x high(5-6), 2x elite(7-10)
  const tiers = [
    { costs: [1, 2], count: 2 },
    { costs: [3, 4], count: 3 },
    { costs: [5, 6], count: 2 },
    { costs: [7, 8, 9, 10], count: 2 },
  ];

  const pool = [];
  const usedIds = new Set();

  for (const tier of tiers) {
    const candidates = allStarters.filter(s => tier.costs.includes(s.cost) && !usedIds.has(s.id));
    const shuffled = candidates.sort(() => rng() - 0.5);

    for (let i = 0; i < tier.count && i < shuffled.length; i++) {
      pool.push(shuffled[i]);
      usedIds.add(shuffled[i].id);
    }
  }

  // If pool is still short, fill with random remaining
  while (pool.length < size) {
    const candidates = allStarters.filter(s => !usedIds.has(s.id));
    if (candidates.length === 0) break;
    const idx = Math.floor(rng() * candidates.length);
    pool.push(candidates[idx]);
    usedIds.add(candidates[idx].id);
  }

  // Shuffle final pool
  pool.sort(() => rng() - 0.5);

  return pool;
}

module.exports = { generateStarters, generatePool };
