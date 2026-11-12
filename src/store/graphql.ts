// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
// POST [base]/$graphql, ported from Medplum 5.2.14 packages/fhir-router/src/graphql/graphql.ts: the handler and the root schema
// (read by id, search). Changes: synchronous (executeSync; resolvers return values), every read and search goes through the
// `fhir` callback (the store's own request path), the schema covers the resource types passed in (built on first use, one per
// type list), introspection is an option. Not yet here: the Connection API (plan 3 Task 3), mutations (Task 4), and Medplum's
// depth and cost rules, which in 5.2.14 only log (Task 3 makes the cost rule refuse).
import { badRequest, forbidden, normalizeOperationOutcome, OperationOutcomeError } from '@medplum/core';
import type { OperationOutcome, Resource } from '@medplum/fhirtypes';
import type { DocumentNode, ExecutionResult, GraphQLFieldConfigMap, GraphQLResolveInfo } from 'graphql';
import { executeSync, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, parse, specifiedRules, validate } from 'graphql';
import type { Fhir, GraphQLContext } from './graphql-types.ts';
import { buildGraphQLOutputType, buildSearchArgs, getGraphQLOutputType, invalidRequest, outputTypes, resolveBySearch } from './graphql-types.ts';

export type { Fhir } from './graphql-types.ts';

// Cached GraphQL schemas, by the sorted, comma-joined resource type list.
const rootSchemas = new Map<string, GraphQLSchema>();

const answer = (status: number, body: OperationOutcome | ExecutionResult) => ({ status, json: JSON.stringify(body) });

/**
 * Handles FHIR GraphQL requests.
 *
 * See: https://www.hl7.org/fhir/graphql.html
 * @param body - The request body: query, operationName, variables.
 * @param fhir - The store's request path, for reads and searches.
 * @param opts - introspection: allow schema queries; types: the store's resource types.
 * @returns The status and the JSON body: the GraphQL result (200), or an OperationOutcome.
 */
export function graphqlHandler(body: unknown, fhir: Fhir, opts: { introspection: boolean; types: readonly string[] }): { status: number; json: string } {
  const { query, operationName, variables } = (body ?? {}) as { query?: string; operationName?: string; variables?: Record<string, unknown> };
  if (!query) {
    return answer(400, badRequest('Must provide query.'));
  }

  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (_err) {
    return answer(400, badRequest('GraphQL syntax error.'));
  }

  const schema = getRootSchema(opts.types);
  const validationErrors = validate(schema, document, specifiedRules);
  if (validationErrors.length > 0) {
    return answer(400, invalidRequest(validationErrors));
  }

  const introspection = isIntrospectionQuery(query);
  if (introspection && !opts.introspection) {
    return answer(403, forbidden);
  }

  // shortcut: no introspection result cache; add one if introspection traffic matters
  const contextValue: GraphQLContext = { fhir, resources: new Map() };
  const result = executeSync({ schema, document, contextValue, operationName, variableValues: variables });
  return answer(200, result);
}

const introspectionRegex = /query IntrospectionQuery|__schema|__type(?!name)/;

/**
 * Returns true if the query is a GraphQL introspection query.
 *
 * Introspection queries ask for the schema, which is expensive.
 *
 * See: https://graphql.org/learn/introspection/
 * @param query - The GraphQL query.
 * @returns True if the query is an introspection query.
 */
function isIntrospectionQuery(query: string): boolean {
  return introspectionRegex.test(query);
}

export function getRootSchema(types: readonly string[]): GraphQLSchema {
  const key = [...types].sort().join();
  let rootSchema = rootSchemas.get(key);
  if (!rootSchema) {
    rootSchema = buildRootSchema(key.split(','));
    rootSchemas.set(key, rootSchema);
  }
  return rootSchema;
}

function buildRootSchema(types: readonly string[]): GraphQLSchema {
  const t = outputTypes(types);
  // First, create placeholder types
  // We need this first for circular dependencies
  for (const resourceType of types) {
    t.cache[resourceType] = buildGraphQLOutputType(t, resourceType);
  }

  // Next, fill in all of the type properties
  const fields: GraphQLFieldConfigMap<any, GraphQLContext> = {};

  for (const resourceType of types) {
    const graphQLOutputType = getGraphQLOutputType(t, resourceType);

    // Get resource by ID
    fields[resourceType] = {
      type: graphQLOutputType,
      args: {
        id: {
          type: new GraphQLNonNull(GraphQLID),
          description: resourceType + ' ID',
        },
      },
      resolve: resolveById,
    };

    // Search resource by search parameters
    fields[resourceType + 'List'] = {
      type: new GraphQLList(graphQLOutputType),
      args: buildSearchArgs(resourceType),
      resolve: resolveBySearch,
    };
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'QueryType',
      fields,
    }),
  });
}

/**
 * GraphQL resolver for ID requests.
 * The field name should always by the resource type.
 * There should always be exactly one argument "id".
 * @param _source - The source/root.  This should always be null for our top level readers.
 * @param args - The GraphQL search arguments.
 * @param ctx - The GraphQL context.
 * @param info - The GraphQL resolve info.  This includes the schema, and additional field details.
 * @returns The resource for the query.
 */
function resolveById(_source: any, args: any, ctx: GraphQLContext, info: GraphQLResolveInfo): Resource | undefined {
  const reference = `${info.fieldName}/${args.id}`;
  try {
    let resource = ctx.resources.get(reference);
    if (!resource) {
      resource = ctx.fhir('GET', `${info.fieldName}/${encodeURIComponent(args.id)}`) as Resource;
      ctx.resources.set(reference, resource);
    }
    return resource;
  } catch (err) {
    throw new OperationOutcomeError(normalizeOperationOutcome(err), { cause: err });
  }
}
