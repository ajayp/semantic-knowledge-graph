import * as readline from "readline";
import { traverse, TraversalFacet, ValueNode } from "./skg";

const COLLECTION = "stackexchange";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on("close", () => { closed = true; });

async function traversePath(path: string[]): Promise<Map<string, ValueNode> | undefined> {
  const hopNodes = path.map((term, i) => ({
    field: "title body",
    values: [term],
    ...(i > 0 ? { defaultOperator: "OR" as const } : {}),
  }));

  const traversal = await traverse(
    COLLECTION,
    ...hopNodes,
    { field: "body", minOccurrences: 2, limit: 10 }
  );

  let facets: TraversalFacet[] = traversal.graph;
  for (const term of path) {
    const node = facets[0]?.values.get(term);
    if (!node?.traversals) return undefined;
    facets = node.traversals;
  }
  return facets[0]?.values;
}

function printResults(values: Map<string, ValueNode>, path: string[]) {
  const skip = new Set(path);
  console.log(`\nTerm                 Relatedness`);
  console.log("-".repeat(35));
  for (const [related, data] of values) {
    if (skip.has(related)) continue;
    console.log(`  ${related.padEnd(20)} ${data.relatedness.toFixed(5)}`);
  }
  console.log();
}

async function run() {
  console.log("=".repeat(72));
  console.log("  SOLR SEMANTIC KNOWLEDGE GRAPH");
  console.log("=".repeat(72));
  console.log(`  Collection: ${COLLECTION}`);
  console.log("  Enter a term to see what the corpus finds related to it.");
  console.log(`  Then enter another term to drill down a hop (relationship filter).`);
  console.log(`  Commands: "back" (undo last hop), "reset" (start over), "exit".\n`);

  let path: string[] = [];

  const ask = () => {
    if (closed) return;
    const prompt = path.length ? `[${COLLECTION}] ${path.join(" > ")} > ` : `[${COLLECTION}] Query (or "exit"): `;
    rl.question(prompt, async (input) => {
      const term = input.trim();

      if (!term || term.toLowerCase() === "exit") { rl.close(); return; }

      if (term.toLowerCase() === "reset") {
        path = [];
        ask();
        return;
      }

      if (term.toLowerCase() === "back") {
        if (path.length === 0) {
          console.log("(already at the top)\n");
          ask();
          return;
        }
        path = path.slice(0, -1);
        if (path.length > 0) {
          try {
            const values = await traversePath(path);
            if (values) printResults(values, path);
          } catch (err: any) {
            console.error(`Error: ${err.message}\n`);
          }
        }
        ask();
        return;
      }

      const nextPath = [...path, term];
      try {
        const values = await traversePath(nextPath);
        if (!values) {
          console.log("(no results)\n");
          ask();
          return;
        }
        printResults(values, nextPath);
        path = nextPath;
      } catch (err: any) {
        console.error(`Error: ${err.message}\n`);
      }

      ask();
    });
  };

  ask();
}

run().catch(console.error);
