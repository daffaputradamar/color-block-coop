// Proves every handcrafted level is solvable and checks doors sit on open edge cells.
import { LEVELS } from '../shared/levels.js';
import { parseLevel, buildOcc, findExit } from '../shared/logic.js';
import { solve } from '../shared/solver.js';

let failed = 0;
LEVELS.forEach((def, i) => {
  const problems = [];
  let level, blocks;
  try {
    ({ level, blocks } = parseLevel(def, i));
  } catch (e) {
    console.log(`#${i + 1} ${def.name}: ${e.message}`);
    failed++;
    return;
  }
  if (def.grid.some((row) => row.length !== level.w)) problems.push('ragged grid');
  for (const d of level.doors) {
    const sideLen = d.side === 'top' || d.side === 'bottom' ? level.w : level.h;
    if (d.at < 0 || d.at + d.len > sideLen) problems.push(`door ${d.side}@${d.at} out of range`);
    for (let k = d.at; k < d.at + d.len; k++) {
      const [x, y] = d.side === 'top' ? [k, 0] : d.side === 'bottom' ? [k, level.h - 1] : d.side === 'left' ? [0, k] : [level.w - 1, k];
      if (level.walls[y * level.w + x]) problems.push(`door ${d.side}@${d.at} touches a wall`);
    }
  }
  const usedColors = new Set(blocks.flatMap((b) => [b.color, ...b.layers]));
  for (const c of usedColors) if (!level.doors.some((d) => d.color === c)) problems.push(`no door for ${c}`);
  const occ = buildOcc(level, blocks);
  for (const b of blocks) if (findExit(level, occ, b) >= 0) problems.push(`block ${b.tag} starts at its exit`);

  const t = Date.now();
  const r = solve(level, blocks, { maxStates: 2_000_000 });
  const ms = Date.now() - t;
  const status = r.solvable ? `OK   moves=${r.moves}` : r.complete ? 'UNSOLVABLE' : 'GAVE UP';
  if (!r.solvable) failed++;
  if (problems.length) failed++;
  console.log(`#${String(i + 1).padStart(2)} ${def.name.padEnd(14)} ${status.padEnd(16)} states=${r.states} ${ms}ms ${problems.join('; ')}`);
});
process.exit(failed ? 1 : 0);
