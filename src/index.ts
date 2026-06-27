import { createCollection, indexCsv } from "./indexer";

async function main() {
  // Standalone collections
  await createCollection("jobs");
  await indexCsv("jobs", "data/jobs/jobs.csv");

  await createCollection("health");
  await indexCsv("health", "data/health/posts.csv");

  await createCollection("cooking");
  await indexCsv("cooking", "data/cooking/posts.csv");

  await createCollection("scifi");
  await indexCsv("scifi", "data/scifi/posts.csv");

  await createCollection("travel");
  await indexCsv("travel", "data/travel/posts.csv");

  await createCollection("devops");
  await indexCsv("devops", "data/devops/posts.csv");

  // stackexchange: all five StackExchange datasets merged into one collection
  await createCollection("stackexchange");
  await indexCsv("stackexchange", "data/health/posts.csv", { append: false });
  await indexCsv("stackexchange", "data/cooking/posts.csv", { append: true });
  await indexCsv("stackexchange", "data/scifi/posts.csv", { append: true });
  await indexCsv("stackexchange", "data/travel/posts.csv", { append: true });
  await indexCsv("stackexchange", "data/devops/posts.csv", { append: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
