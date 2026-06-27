import { solrPost } from "./solr-client";

export type SKGNode = {
  field: string;
  values?: string[];
  name?: string;
  limit?: number;
  minOccurrences?: number;
  minPopularity?: number;
  defaultOperator?: "AND" | "OR";
};

export type ValueNode = {
  relatedness: number;
  traversals?: TraversalFacet[];
};

export type TraversalFacet = {
  name: string;
  values: Record<string, ValueNode>;
};

export type TraversalResult = {
  graph: TraversalFacet[];
};

function defaultNodeName(i: number, j: number): string {
  return "f" + i + (j ? `_${j}` : "");
}

function generateFacets(node: SKGNode & { name: string }): object[] {
  const { field, values, name, limit, minOccurrences, minPopularity, defaultOperator = "AND" } = node;

  const relatednessFunc = minPopularity !== undefined
    ? `relatedness($fore,$back,min_popular=${minPopularity})`
    : "relatedness($fore,$back)";

  const baseFacet: Record<string, unknown> = {
    type: values ? "query" : "terms",
    limit: limit ?? 10,
    sort: { relatedness: "desc" },
    facet: {
      relatedness: { type: "func", func: relatednessFunc },
    },
  };

  if (minOccurrences) baseFacet.mincount = minOccurrences;
  if (field) baseFacet.field = field;

  if (values) {
    // Query facets: one per value; no mincount or default limit on these
    if (minOccurrences) delete baseFacet.mincount;
    if (!limit) delete baseFacet.limit;

    return values.map((_, i) => ({
      ...baseFacet,
      facet: { ...(baseFacet.facet as object) }, // each gets its own facet copy
      query: `{!edismax q.op=${defaultOperator} qf=${field} v=$${name}_${i}_query}`,
    }));
  }

  return [baseFacet];
}

export function buildRequest(...nodes: SKGNode[]): object {
  const request: {
    limit: number;
    params: Record<string, unknown>;
    facet: Record<string, unknown>;
  } = {
    limit: 0,
    params: {
      q: "*:*",
      fore: "{!${defType} v=$q}",
      back: "*:*",
      defType: "edismax",
    },
    facet: {},
  };

  let parentNodes: Array<{ facet: Record<string, unknown> }> = [request];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const namedNode = { ...node, name: node.name ?? defaultNodeName(i, 0) };
    const facets = generateFacets(namedNode) as Array<{ facet: Record<string, unknown> }>;

    for (const parentNode of parentNodes) {
      for (let j = 0; j < facets.length; j++) {
        parentNode.facet[`${namedNode.name}_${j}`] = facets[j];
      }
    }

    if (node.values) {
      for (let k = 0; k < node.values.length; k++) {
        request.params[`${namedNode.name}_${k}_query`] = node.values[k];
      }
    }

    parentNodes = facets;
  }

  return request;
}

function sortByRelatednessDesc(values: Record<string, ValueNode>): Record<string, ValueNode> {
  return Object.fromEntries(
    Object.entries(values).sort(([, a], [, b]) => b.relatedness - a.relatedness)
  );
}

function transformNode(node: Record<string, unknown>, responseParams: Record<string, unknown>): ValueNode {
  const relatednessData = node.relatedness as { relatedness: number } | undefined;
  const count = node.count as number;
  const relatedness = count > 0 && relatednessData ? relatednessData.relatedness : 0.0;

  const valueNode: ValueNode = { relatedness };
  const subTraversals = transformResponseFacet(node, responseParams);
  if (subTraversals.length > 0) valueNode.traversals = subTraversals;

  return valueNode;
}

function transformResponseFacet(
  node: Record<string, unknown>,
  responseParams: Record<string, unknown>
): TraversalFacet[] {
  const ignoredKeys = new Set(["count", "relatedness", "val"]);
  const traversals: Record<string, TraversalFacet> = {};

  for (const [fullName, data] of Object.entries(node)) {
    if (ignoredKeys.has(fullName)) continue;

    // Strip the trailing _N index to get the base node name
    const parts = fullName.split("_");
    const baseName = parts.slice(0, -1).join("_");

    if (!traversals[baseName]) {
      traversals[baseName] = { name: baseName, values: {} };
    }

    const facetData = data as Record<string, unknown>;

    if (Array.isArray(facetData.buckets)) {
      // Terms facet: each bucket is a discovered term
      const valuesNode: Record<string, ValueNode> = {};
      for (const bucket of facetData.buckets as Record<string, unknown>[]) {
        valuesNode[String(bucket.val)] = transformNode(bucket, responseParams);
      }
      traversals[baseName].values = valuesNode;
    } else {
      // Query facet: look up the original query string from params
      const valueName = String(responseParams[`${fullName}_query`]);
      traversals[baseName].values[valueName] = transformNode(facetData, responseParams);
    }
  }

  for (const t of Object.values(traversals)) {
    t.values = sortByRelatednessDesc(t.values);
  }

  return Object.values(traversals);
}

export async function traverse(collectionName: string, ...nodes: SKGNode[]): Promise<TraversalResult> {
  const request = buildRequest(...nodes);
  const response = (await solrPost(`/${collectionName}/select`, request)) as {
    facets: Record<string, unknown>;
    params?: Record<string, unknown>;
  };

  // The request params are needed to reverse-map query facet names back to their query strings
  const requestParams = (request as { params: Record<string, unknown> }).params;
  const graph = transformResponseFacet(response.facets, requestParams);

  return { graph };
}

export function buildExpandedQuery(
  traversal: TraversalResult,
  query: string,
  threshold = 0.0
): string {
  const queryNode = traversal.graph[0]?.values[query];
  if (!queryNode?.traversals) return `${query}^5`;

  const relatedTerms = queryNode.traversals[0].values;
  const expansion = Object.entries(relatedTerms)
    .filter(([term, node]) => term !== query && node.relatedness > threshold)
    .map(([term, node]) => `${term}^${node.relatedness.toFixed(5)}`)
    .join(" ");

  return `${query}^5 ${expansion}`.trim();
}
