// Why retrieval missed: for each case whose expected passages were not all retrieved, search the
// top 30 and show where each expected passage really ranks and how similar it is. Dev cases only by
// default, so retrieval changes are not designed around the held-out cases.
import { retrieveRelevantChunks } from "../../src/retrieve/search.js";
import { loadRetrieval } from "./answer.js";
import { CASES, matches, sourceGroups } from "./data.js";
import { sleep } from "./models.js";
import { SIMILARITY_FLOOR, TOP_K } from "./rem.js";
import { retrievalOf } from "./report.js";

export async function misses(split: string): Promise<void> {
  const retrieval = loadRetrieval();
  const list = CASES.filter((c) => (split === "all" || c.split === split) && retrievalOf(c) && !retrievalOf(c)!.full);
  console.log(`${list.length} ${split} cases with an expected passage missing from the top ${TOP_K} (floor ${SIMILARITY_FLOOR}).\n`);
  for (const c of list) {
    const r = retrieval.cases[c.id];
    const deep = await retrieveRelevantChunks(r.standalone, 30);
    console.log(`${c.id} (${c.category}): ${r.standalone}`);
    for (const g of sourceGroups(c)) {
      const rank = deep.findIndex((p) => g.some((alt) => matches(alt, p)));
      const hit = rank >= 0 ? deep[rank] : null;
      const where = !hit ? "not in the top 30" : rank < TOP_K ? (Number(hit.similarity) < SIMILARITY_FLOOR ? `rank ${rank + 1}, under the floor` : `rank ${rank + 1}, ok`) : `rank ${rank + 1}`;
      console.log(`  ${g[0]}: ${where}${hit ? `, similarity ${Number(hit.similarity).toFixed(3)}` : ""}`);
    }
    const top = deep.slice(0, 3).map((p) => `${p.source}#${p.headingPath.split(" > ").pop()} ${Number(p.similarity).toFixed(3)}`);
    console.log(`  ranked above it: ${top.join("; ")}\n`);
    await sleep(900);
  }
}
