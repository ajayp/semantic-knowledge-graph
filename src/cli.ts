import * as readline from "readline";
import { traverse } from "./skg";

const COLLECTION = "stackexchange";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on("close", () => { closed = true; });

async function run() {
  console.log("=".repeat(72));
  console.log("  SOLR SEMANTIC KNOWLEDGE GRAPH");
  console.log("=".repeat(72));
  console.log(`  Collection: ${COLLECTION}`);
  console.log("  Enter a term to see what the corpus finds related to it.\n");

  const ask = () => {
    if (closed) return;
    rl.question(`[${COLLECTION}] Query (or "exit"): `, async (input) => {
      const term = input.trim();
      if (!term || term.toLowerCase() === "exit") { rl.close(); return; }

      try {
        const traversal = await traverse(
          COLLECTION,
          { field: "title body", values: [term] },
          { field: "body", minOccurrences: 2, limit: 10 }
        );

        const queryNode = traversal.graph[0]?.values.get(term);
        if (!queryNode?.traversals) {
          console.log("(no results)\n");
          ask();
          return;
        }

        console.log(`\nTerm                 Relatedness`);
        console.log("-".repeat(35));
        for (const [related, data] of queryNode.traversals[0].values) {
          if (related === term) continue;
          console.log(`  ${related.padEnd(20)} ${data.relatedness.toFixed(5)}`);
        }
        console.log();
      } catch (err: any) {
        console.error(`Error: ${err.message}\n`);
      }

      ask();
    });
  };

  ask();
}

run().catch(console.error);
