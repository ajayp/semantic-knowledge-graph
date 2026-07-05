import { traverse, buildExpandedQuery, TraversalFacet } from "./skg";
import { solrPost } from "./solr-client";

function section(title: string) {
  console.log("\n" + "=".repeat(72));
  console.log(title);
  console.log("=".repeat(72));
}

function printRelatedTerms(graph: TraversalFacet[], query: string, exclude: string[] = []) {
  const queryNode = graph[0]?.values.get(query);
  if (!queryNode?.traversals) {
    console.log("(no results)");
    return;
  }
  const skip = new Set([query, ...exclude]);
  for (const [term, data] of queryNode.traversals[0].values) {
    if (skip.has(term)) continue;
    console.log(`  ${term.padEnd(20)} ${data.relatedness.toFixed(5)}`);
  }
}

async function example1() {
  section("Example 1 — Related Terms (health collection)");
  console.log(`
Query: "ibuprofen" on the health StackExchange collection.

The SKG scans every term that co-occurs with "ibuprofen" posts and asks: does this
term appear *more* in ibuprofen posts than in all posts generally? If yes, it gets
a high relatedness score. Score guide:
  1.0  = perfectly correlated with the query — appears only in these docs
  0.0  = unrelated — appears at the same rate everywhere (like "the", "a")
  < 0  = anti-correlated — less common in these docs than in the collection
`);

  const traversal = await traverse(
    "health",
    { field: "title body", values: ["ibuprofen"] },
    // minOccurrences > 1: a term appearing in just 1 doc can still score near-1.0
    // relatedness by coincidence — requiring 2+ filters out that single-doc noise.
    { field: "body", minOccurrences: 2, limit: 8 }
  );

  console.log("Term                 Relatedness");
  console.log("-".repeat(35));
  printRelatedTerms(traversal.graph, "ibuprofen");
  console.log(`
advil, motrin, acetaminophen, naproxen — the SKG found every OTC pain-relief
synonym and generic/brand pairing purely from word distribution across 12,000+ posts.
No medical dictionary. No hand-coded synonyms.`);
}

async function example2() {
  section("Example 2 — Domain Switch (stackexchange — sci-fi)");
  console.log(`
Same technique, completely different domain. Query: "kryptonite" on the combined
StackExchange collection (health + cooking + scifi + travel + devops posts).

The SKG has no idea what kryptonite is. It just notices that certain other words
appear disproportionately often in posts that mention kryptonite. Those happen
to be other DC Universe terms — the corpus "knows" the domain.
`);

  const traversal = await traverse(
    "stackexchange",
    { field: "title body", values: ["kryptonite"] },
    { field: "body", minOccurrences: 2, limit: 8 }
  );

  console.log("Term                 Relatedness");
  console.log("-".repeat(35));
  printRelatedTerms(traversal.graph, "kryptonite");
  console.log(`
superman, kryptonians, krypton, metallo, smallville — all DC Universe terms,
surfaced without any comic book ontology. The corpus knew the domain; the code didn't.`);
}

async function countResults(query: string, params: Record<string, unknown>): Promise<number> {
  const res = await solrPost("/stackexchange/select", {
    query,
    limit: 0,
    params: { defType: "edismax", qf: "title body", ...params },
  }) as { response: { numFound: number } };
  return res.response.numFound;
}

async function example3() {
  section("Example 3 — Query Expansion (stackexchange)");

  const traversal = await traverse(
    "stackexchange",
    { field: "title body", values: ["kryptonite"] },
    { field: "body", minOccurrences: 2, limit: 8 }
  );

  const query = "kryptonite";
  const expanded = buildExpandedQuery(traversal, query);
  const expansionOnly = expanded.replace(/^kryptonite\^5\s*/, "");

  const termList = expansionOnly
    .split(" ")
    .map(t => { const [term, score] = t.split("^"); return `    ${term.padEnd(14)} ${parseFloat(score).toFixed(2)}  (highly correlated with ${query} posts)`; })
    .join("\n");

  const baseline = await countResults(query, {});
  const s1 = await countResults(`${query} ${expansionOnly}`, { mm: "1" });
  const s2 = await countResults(`${query} ${expansionOnly}`, { mm: "2" });
  const s3 = await countResults(`${query} ${expansionOnly}`, { mm: "30%" });
  const s4 = await countResults(`${query} AND (${expansionOnly})`, { mm: "2" });
  const s5 = await countResults(query, { bq: expansionOnly });

  const pct = (n: number) => {
    if (n === baseline) return "(same)";
    const p = Math.round((n / baseline - 1) * 100);
    return p > 0 ? `(+${p}%)` : `(${p}%)`;
  };

  console.log(`"${query}" alone finds ${baseline} posts. The SKG found ${expansionOnly.split(" ").length} related terms:\n`);
  console.log(termList);
  console.log(`\nWe can use those terms to cast a wider or narrower net:\n`);

  console.log(`  Baseline: search "${query}" only`);
  console.log(`  → ${baseline} posts\n`);

  console.log(`  Strategy 1: search for ${query} OR superman OR krypton OR any related term`);
  console.log(`  → ${s1} posts  ${pct(s1)}  Most are Superman posts that never say "${query}"\n`);

  console.log(`  Strategy 2: post must contain at least 2 of the 8 terms`);
  console.log(`  → ${s2} posts   ${pct(s2)}  Cuts noise — accidental single-word matches drop out\n`);

  console.log(`  Strategy 3: post must contain at least 30% of the 8 terms (≥3 words)`);
  console.log(`  → ${s3} posts   ${pct(s3)}  Same here — these terms cluster so tightly that matching 2 implies 3+\n`);

  console.log(`  Strategy 4: "${query}" is required, plus at least one related term`);
  console.log(`  → ${s4} posts   ${pct(s4)}  Stricter than baseline — some ${query} posts mention none of the related terms\n`);

  console.log(`  Strategy 5: only "${query}" posts, but rank by how many related terms they also mention`);
  console.log(`  → ${s5} posts   ${pct(s5)}  Same docs as baseline, most conceptually rich ones rise to the top`);
}

async function example4() {
  section("Example 4 — Content-Based Recommendations (stackexchange)");
  console.log(`
Instead of a user query, we start from the terms in a document and ask: which
of these terms are semantically relevant to "star wars"? Terms that cluster with
Star Wars in the corpus score high. Terms from other franchises (batman, joker,
gotham) score negative — the SKG discriminates between them. The positive-scoring
terms then drive a recommendation query to fetch similar posts.
`);

  const classificationQuery = "star wars";
  const documentTerms = [
    "luke", "leia", "han", "vader", "chewbacca",
    "c-3po", "r2-d2", "batman", "joker", "gotham",
  ];

  const traversal = await traverse(
    "stackexchange",
    { field: "title body", values: [classificationQuery] },
    { field: "title body", values: documentTerms }
  );

  const starWarsNode = traversal.graph[0]?.values.get(classificationQuery);
  if (!starWarsNode?.traversals) {
    console.log("(no classification results)");
    return;
  }

  const termScores = starWarsNode.traversals[0].values;
  console.log("Term relatedness to 'star wars':");
  console.log("Term                 Relatedness  Note");
  console.log("-".repeat(55));
  for (const [term, data] of termScores) {
    const note = data.relatedness <= 0 ? "  ← wrong franchise" : "";
    console.log(`  ${term.padEnd(20)} ${data.relatedness.toFixed(5)}${note}`);
  }

  // Build recommendation query from terms scoring above 0.25
  const recQuery = Array.from(termScores)
    .filter(([, node]) => node.relatedness > 0.25)
    .map(([term, node]) => `"${term}"^${node.relatedness.toFixed(5)}`)
    .join(" ");

  const positiveCount = Array.from(termScores.values()).filter(n => n.relatedness > 0.25).length;
  console.log(`\nThe ${positiveCount} positive-scoring terms become a recommendation query. Top 5 matching posts:`);

  // Fetch top 5 matching documents
  const searchResponse = (await solrPost("/stackexchange/select", {
    query: recQuery,
    fields: ["title"],
    limit: 20,
    params: { qf: "title body", defType: "edismax" },
  })) as { response: { docs: Array<{ title?: string }> } };

  const titledDocs = searchResponse.response.docs
    .filter(doc => doc.title && doc.title.trim() !== "")
    .slice(0, 5);

  console.log("\nTop 5 recommended documents:");
  for (const [i, doc] of titledDocs.entries()) {
    console.log(`  ${i + 1}. ${doc.title}`);
  }
}

async function example5() {
  section("Example 5 — Arbitrary Relationships (scifi collection)");
  console.log(`
Three-level traversal: "data" → "daughter" → top related terms.

"daughter" is the relationship filter. We're not asking who co-occurs with Data
generally — we're asking: of all posts about Data that also discuss a daughter,
which characters appear disproportionately? The answer should be the specific
characters canonically tied to that relationship, discovered purely from corpus
statistics with no knowledge graph or ontology.
`);

  const traversal = await traverse(
    "scifi",
    { field: "title body", values: ["data"] },
    { field: "title body", values: ["daughter"], defaultOperator: "OR" },
    { field: "body", minOccurrences: 5, limit: 10 }
  );

  const dataNode = traversal.graph[0]?.values.get("data");
  const relationshipNode = dataNode?.traversals?.[0]?.values.get("daughter");
  if (!relationshipNode?.traversals) {
    console.log("(no results)");
    return;
  }

  const skip = new Set(["data", "data's", "daughter"]);
  console.log("Related to 'data' via 'daughter':");
  console.log("Term                 Relatedness");
  console.log("-".repeat(35));
  for (const [term, d] of relationshipNode.traversals[0].values) {
    if (skip.has(term)) continue;
    console.log(`  ${term.padEnd(20)} ${d.relatedness.toFixed(5)}`);
  }

  console.log(`
Lal is the android daughter Data builds in TNG "The Offspring." Dahj is his
daughter in Picard. Two characters from two different series, spanning decades
of Star Trek — surfaced by two strategic hops through an inverted index.`);
}

async function main() {
  await example1();
  await example2();
  await example3();
  await example4();
  await example5();
  console.log("\n" + "=".repeat(72) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
