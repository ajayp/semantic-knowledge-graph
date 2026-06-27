import { createReadStream, existsSync } from "fs";
import { randomUUID } from "crypto";
import { parse } from "csv-parse";
import { solrPost, solrPostForm } from "./solr-client";

const SCHEMA_FIELDS: Record<string, string[]> = {
  jobs: ["company_country", "job_description", "company_description"],
};

const STACK_COLLECTIONS = new Set([
  "health", "cooking", "scifi", "travel", "devops", "stackexchange",
]);

function fieldsFor(name: string): string[] {
  return SCHEMA_FIELDS[name] ?? (STACK_COLLECTIONS.has(name) ? ["title", "body"] : ["title", "body"]);
}

export async function createCollection(name: string): Promise<void> {
  // Standalone Solr uses the Core Admin API (not the SolrCloud Collections API)
  await solrPostForm("/admin/cores", [
    ["action", "UNLOAD"],
    ["core", name],
    ["deleteIndex", "true"],
    ["deleteDataDir", "true"],
    ["deleteInstanceDir", "true"],
  ]).catch(() => {});

  await solrPostForm("/admin/cores", [
    ["action", "CREATE"],
    ["name", name],
    ["configSet", "_default"],
  ]);

  await applySchema(name);
}

export async function applySchema(name: string): Promise<void> {
  // Disable automatic field type guessing — only our explicit fields get indexed
  await solrPost(`/${name}/config`, {
    "set-user-property": { "update.autoCreateFields": "false" },
  });

  // Set /select handler to use edismax by default
  await solrPost(`/${name}/config`, {
    "update-requesthandler": {
      name: "/select",
      class: "solr.SearchHandler",
      defaults: { defType: "edismax", indent: true },
    },
  });

  for (const field of fieldsFor(name)) {
    await solrPost(`/${name}/schema`, { "delete-field": { name: field } }).catch(() => {});
    await solrPost(`/${name}/schema`, {
      "add-field": {
        name: field,
        type: "text_general",
        stored: true,
        indexed: true,
        multiValued: false,
        uninvertible: true,  // Solr 9 changed this default to false; SKG terms facets need it
      },
    });
  }
}

export async function indexCsv(
  collectionName: string,
  csvPath: string,
  options: { append?: boolean } = {}
): Promise<void> {
  if (!existsSync(csvPath)) {
    const gz = csvPath + ".gz";
    const hint = existsSync(gz) ? ` (found ${gz} — run: gunzip "${gz}")` : "";
    throw new Error(`CSV not found: ${csvPath}${hint}`);
  }

  if (!options.append) {
    await solrPost(`/${collectionName}/update?commit=true`, { delete: { query: "*:*" } });
  }

  const parser = createReadStream(csvPath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    })
  );

  let batch: Record<string, unknown>[] = [];
  let total = 0;
  let rowNum = 0;

  const allowedFields = new Set(fieldsFor(collectionName));

  for await (const record of parser as AsyncIterable<Record<string, unknown>>) {
    rowNum++;
    const filtered: Record<string, unknown> = { id: randomUUID() };
    for (const [k, v] of Object.entries(record)) {
      if (allowedFields.has(k)) filtered[k] = v;
    }
    batch.push(filtered);

    if (batch.length >= 500) {
      // No commit=true per batch — one commit at the end avoids 60+ flushes
      await solrPost(`/${collectionName}/update`, batch);
      total += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await solrPost(`/${collectionName}/update`, batch);
    total += batch.length;
  }

  // Single commit after all docs are uploaded
  await solrPost(`/${collectionName}/update?commit=true`, {});

  console.log(`${collectionName}: ${total} documents indexed`);
}
