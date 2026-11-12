// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
// POST [base]/$graphql, ported from Medplum 5.2.14 packages/fhir-router/src/graphql/graphql.ts: the handler and the root schema
// (read by id, search, the Connection API, create, update, patch and delete) and the depth and cost rules. Changes: synchronous (executeSync; resolvers return
// values), every read and search goes through the `fhir` callback (the store's own request path), the schema covers the resource
// types passed in (built on first use, one per type list), introspection is an option, and the depth (12) and cost (10,000)
// rules refuse a query with Medplum's commented-out error texts, where 5.2.14 only logs (resolvers block the event loop, so a
// fan-out must be refused before it runs). A write goes through the `fhir` callback too, so it is validated as REST validates it,
// and primes (or, for a delete, clears) the per-request read of its Type/id.
import { badRequest, deepClone, DEFAULT_MAX_SEARCH_COUNT, forbidden, OperationOutcomeError } from '@medplum/core';
import type { OperationOutcome, Resource, ResourceType } from '@medplum/fhirtypes';
import type { ArgumentNode, ASTNode, ASTVisitor, DocumentNode, ExecutionResult, FieldNode, GraphQLFieldConfigArgumentMap, GraphQLFieldConfigMap, GraphQLResolveInfo, OperationDefinitionNode, ValidationContext } from 'graphql';
import { executeSync, GraphQLError, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, Kind, parse, validate } from 'graphql';
import type { Fhir, GraphQLContext } from './graphql-types.ts';
import {
  buildGraphQLOutputType,
  buildSearchArgs,
  getConnectionType,
  getGraphQLInputType,
  getGraphQLOutputType,
  getPatchOperationInputType,
  invalidRequest,
  outputTypes,
  readCached,
  resolveByConnectionApi,
  resolveBySearch,
} from './graphql-types.ts';

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
    document = parse(query, { maxTokens: 1000 }); // graphql-js's overlapping-fields rule is quadratic in same-name fields
  } catch (_err) {
    return answer(400, badRequest('GraphQL syntax error.'));
  }

  const schema = getRootSchema(opts.types);
  // the depth and cost rules follow fragment spreads, so they run only once the standard rules (NoFragmentCycles) pass
  let validationErrors = validate(schema, document);
  if (validationErrors.length === 0) {
    validationErrors = validate(schema, document, [MaxDepthRule(), QueryCostRule(variables)]);
  }
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
  const mutationFields: GraphQLFieldConfigMap<any, GraphQLContext> = {};

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

    // FHIR GraphQL Connection API
    fields[resourceType + 'Connection'] = {
      type: getConnectionType(t, resourceType, graphQLOutputType),
      args: buildSearchArgs(resourceType),
      resolve: resolveByConnectionApi,
    };

    // Mutation API
    mutationFields[resourceType + 'Create'] = {
      type: graphQLOutputType,
      args: buildCreateArgs(resourceType),
      resolve: resolveByCreate,
    };

    mutationFields[resourceType + 'Update'] = {
      type: graphQLOutputType,
      args: buildUpdateArgs(resourceType),
      resolve: resolveByUpdate,
    };

    mutationFields[resourceType + 'Patch'] = {
      type: graphQLOutputType,
      args: buildPatchArgs(resourceType),
      resolve: resolveByPatch,
    };

    mutationFields[resourceType + 'Delete'] = {
      type: graphQLOutputType,
      args: {
        id: {
          type: new GraphQLNonNull(GraphQLID),
          description: resourceType + ' ID',
        },
      },
      resolve: resolveByDelete,
    };
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'QueryType',
      fields,
    }),
    mutation: new GraphQLObjectType({
      name: 'MutationType',
      fields: mutationFields,
    }),
  });
}

function buildCreateArgs(resourceType: string): GraphQLFieldConfigArgumentMap {
  const args: GraphQLFieldConfigArgumentMap = {
    res: {
      type: new GraphQLNonNull(getGraphQLInputType(resourceType, 'Create')),
      description: resourceType + ' Create',
    },
  };
  return args;
}

function buildUpdateArgs(resourceType: string): GraphQLFieldConfigArgumentMap {
  const args: GraphQLFieldConfigArgumentMap = {
    id: {
      type: new GraphQLNonNull(GraphQLID),
      description: resourceType + ' ID',
    },
    res: {
      type: new GraphQLNonNull(getGraphQLInputType(resourceType, 'Update')),
      description: resourceType + ' Update',
    },
  };
  return args;
}

function buildPatchArgs(resourceType: string): GraphQLFieldConfigArgumentMap {
  return {
    id: {
      type: new GraphQLNonNull(GraphQLID),
      description: resourceType + ' ID',
    },
    patch: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(getPatchOperationInputType()))),
      description: 'Array of patch operations',
    },
  };
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
  return readCached(ctx, info.fieldName, args.id);
}

// The written record becomes this request's read of its Type/id (Medplum's repository writes through its cache the same way).
function written(ctx: GraphQLContext, resource: Resource): Resource {
  ctx.resources.set(`${resource.resourceType}/${resource.id}`, resource);
  return resource;
}

/**
 * GraphQL resolver function for create requests.
 * The field name should end with "Create" (i.e., "PatientCreate" for updating a Patient).
 * The args should include the data to be created for the specified resource type.
 * @param _source - The source/root object. In the case of creates, this is typically not used and is thus ignored.
 * @param args - The GraphQL arguments, containing the new data for the resource.
 * @param ctx - The GraphQL context. This includes the store's request path.
 * @param info - The GraphQL resolve info. This includes the schema, field details, and other query-specific information.
 * @returns The created resource.
 */
function resolveByCreate(_source: any, args: Record<string, any>, ctx: GraphQLContext, info: GraphQLResolveInfo): Resource {
  const fieldName = info.fieldName;
  const resourceType = fieldName.substring(0, fieldName.length - 'Create'.length) as ResourceType;
  const resourceArgs = args.res;
  if (resourceArgs.resourceType !== resourceType) {
    throw new OperationOutcomeError(badRequest('Invalid resourceType'));
  }
  // We have to deep clone the args before we try to make them into a resource, since the args are parsed from the request
  // as objects with a null prototype (via Object.create(null)), which means that tree of objects have no `valueOf` method which
  // we need for evalFhirPath to work properly
  return written(ctx, ctx.fhir('POST', resourceType, deepClone(resourceArgs)) as Resource);
}

/**
 * GraphQL resolver function for update requests.
 * The field name should end with "Update" (i.e., "PatientUpdate" for updating a Patient).
 * The args should include the data to be updated for the specified resource type.
 * @param _source - The source/root object. In the case of updates, this is typically not used and is thus ignored.
 * @param args - The GraphQL arguments, containing the new data for the resource.
 * @param ctx - The GraphQL context. This includes the store's request path.
 * @param info - The GraphQL resolve info. This includes the schema, field details, and other query-specific information.
 * @returns The updated resource.
 */
function resolveByUpdate(_source: any, args: Record<string, any>, ctx: GraphQLContext, info: GraphQLResolveInfo): Resource {
  const fieldName = info.fieldName;
  const resourceType = fieldName.substring(0, fieldName.length - 'Update'.length) as ResourceType;
  const resourceArgs = args.res;
  const resourceId = args.id;
  if (resourceArgs.resourceType !== resourceType) {
    throw new OperationOutcomeError(badRequest('Invalid resourceType'));
  }
  if (resourceId !== resourceArgs.id) {
    throw new OperationOutcomeError(badRequest('Invalid ID'));
  }
  // We have to deep clone the args before we try to make them into a resource, since the args are parsed from the request
  // as objects with a null prototype (via Object.create(null)), which means that tree of objects have no `valueOf` method which
  // we need for evalFhirPath to work properly
  return written(ctx, ctx.fhir('PUT', `${resourceType}/${encodeURIComponent(resourceId)}`, deepClone(resourceArgs)) as Resource);
}

/**
 * GraphQL resolver function for delete requests.
 * The field name should end with "Delete" (e.g., "PatientDelete" for deleting a Patient).
 * The args should include the ID of the resource to be deleted.
 * @param _source - The source/root object. In the case of deletions, this is typically not used and is thus ignored.
 * @param args - The GraphQL arguments, containing the ID of the resource to be deleted.
 * @param ctx - The GraphQL context. This includes the store's request path.
 * @param info - The GraphQL resolve info. This includes the schema, field details, and other query-specific information.
 */
function resolveByDelete(_source: any, args: Record<string, string>, ctx: GraphQLContext, info: GraphQLResolveInfo): void {
  const fieldName = info.fieldName;
  const resourceType = fieldName.substring(0, fieldName.length - 'Delete'.length) as ResourceType;
  ctx.fhir('DELETE', `${resourceType}/${encodeURIComponent(args.id)}`);
  ctx.resources.delete(`${resourceType}/${args.id}`); // a later read in this request reads it again: gone
}

/**
 * GraphQL resolver function for patch requests.
 * The field name should end with "Patch" (i.e., "PatientPatch" for patching a Patient).
 * The args should include the id and patch array for the specified resource type.
 * @param _source - The source/root object. In the case of patch, this is typically not used and is thus ignored.
 * @param args - The GraphQL arguments, containing the id and patch array.
 * @param ctx - The GraphQL context. This includes the store's request path.
 * @param info - The GraphQL resolve info. This includes the schema, field details, and other query-specific information.
 * @returns The patched resource.
 */
function resolveByPatch(_source: any, args: Record<string, any>, ctx: GraphQLContext, info: GraphQLResolveInfo): Resource {
  const fieldName = info.fieldName;
  const resourceType = fieldName.substring(0, fieldName.length - 'Patch'.length) as ResourceType;
  const resourceId = args.id;
  const patch = args.patch;
  if (!resourceType || !resourceId || !Array.isArray(patch)) {
    throw new OperationOutcomeError(badRequest('Invalid patch arguments'));
  }
  // Patch operation expects an array of operations (cloned: null-prototype objects, as for a create)
  return written(ctx, ctx.fhir('PATCH', `${resourceType}/${encodeURIComponent(resourceId)}`, deepClone(patch)) as Resource);
}

const DEFAULT_MAX_DEPTH = 12;

/**
 * Custom GraphQL rule that enforces max depth constraint.
 * @param maxDepth - The maximum allowed depth.
 * @returns A function that is an ASTVisitor that validates the maximum depth rule.
 */
const MaxDepthRule =
  (maxDepth: number = DEFAULT_MAX_DEPTH) =>
  (context: ValidationContext): ASTVisitor =>
    new MaxDepthVisitor(context, maxDepth);

type DepthRecord = { depth: number; node?: FieldNode };

class MaxDepthVisitor {
  private readonly context: ValidationContext;
  private readonly maxDepth: number;
  private readonly fragmentDepths: Record<string, DepthRecord>;

  constructor(context: ValidationContext, maxDepth: number) {
    this.context = context;
    this.fragmentDepths = Object.create(null);
    this.maxDepth = maxDepth;
  }

  OperationDefinition(node: OperationDefinitionNode): void {
    const result = this.getDepth(...node.selectionSet.selections);
    if (result.depth > this.maxDepth) {
      this.context.reportError(
        new GraphQLError(
          `Field "${result.node?.name.value}" exceeds max depth (depth=${result.depth}, max=${this.maxDepth})`,
          {
            nodes: result.node,
          }
        )
      );
    }
  }

  /**
   * Returns the depth of the GraphQL node in a query.
   * We use field depth as the representation of depth: the number of concrete fields (not counting fragment expansions)
   * @param nodes - The AST nodes.
   * @returns The maximum "depth" of the nodes.
   */
  private getDepth(...nodes: ASTNode[]): DepthRecord {
    let deepest: DepthRecord = { depth: -1 };
    for (const node of nodes) {
      let current: DepthRecord = { depth: 0 };
      if (node.kind === Kind.FIELD && node.name.value.startsWith('__')) {
        // Introspection (__schema, __type) reads the schema, not records: the standard IntrospectionQuery is 15 deep
      } else if (node.kind === Kind.FIELD) {
        if (node.selectionSet?.selections) {
          current = this.getDepth(...node.selectionSet.selections);
          current.depth += 1;
        } else {
          current = { depth: 0, node }; // Leaf field node
        }
      } else if (node.kind === Kind.FRAGMENT_SPREAD) {
        const fragmentName = node.name.value;
        const fragment = this.context.getFragment(fragmentName);
        const cachedDepth = this.fragmentDepths[fragmentName];

        if (cachedDepth) {
          current = cachedDepth;
        } else if (fragment) {
          current = this.getDepth(...fragment.selectionSet.selections);
          this.fragmentDepths[fragmentName] = current;
        }
      } else if (node.kind === Kind.INLINE_FRAGMENT) {
        current = this.getDepth(...node.selectionSet.selections);
      }

      if (current.depth > this.maxDepth) {
        return current; // Short circuit, no need to keep computing
      }
      if (current.depth > deepest.depth) {
        deepest = current;
      }
    }

    return deepest;
  }
}

const DEFAULT_MAX_COST = 10_000;

const QueryCostRule =
  (variables: Record<string, unknown> | undefined, maxCost: number = DEFAULT_MAX_COST) =>
  (context: ValidationContext): ASTVisitor =>
    new QueryCostVisitor(context, variables, maxCost);

class QueryCostVisitor {
  private readonly context: ValidationContext;
  private readonly maxCost: number;
  private fragmentCosts: Record<string, number>;
  private readonly variables: Record<string, unknown> | undefined;
  private operation: OperationDefinitionNode | undefined;

  constructor(context: ValidationContext, variables: Record<string, unknown> | undefined, maxCost: number) {
    this.context = context;
    this.variables = variables;
    this.maxCost = maxCost;
    this.fragmentCosts = Object.create(null);
  }

  OperationDefinition(node: OperationDefinitionNode): void {
    this.operation = node;
    this.fragmentCosts = Object.create(null); // a fragment's cost depends on this operation's variable defaults
    let cost = 0;
    for (const child of node.selectionSet.selections) {
      cost += this.calculateCost(child);
      if (cost > this.maxCost) {
        this.context.reportError(
          new GraphQLError('Query too complex', {
            extensions: { cost, limit: this.maxCost },
          })
        );
        break; // one error per operation (Medplum's commented-out report would repeat it for every later child)
      }
    }
  }

  private calculateCost(...nodes: ASTNode[]): number {
    let cost = 0;
    for (const node of nodes) {
      if (node.kind === Kind.FIELD && node.selectionSet) {
        let baseCost = 0;
        let branchingFactor = 1;
        if (isSearchField(node)) {
          baseCost = 8;
          // clamped: a negative count would buy a costly sibling; a search returns at most 1000 (applyMaxCount)
          branchingFactor = Math.min(Math.max(this.getCount(node.arguments) ?? 20, 0), DEFAULT_MAX_SEARCH_COUNT);
        } else if (isLinkedResource(node)) {
          baseCost = 1;
          branchingFactor = 2;
        }

        // shortcut: mutation fields cost 0 (as Medplum), so thousands of aliased creates pass the cost rule; cost them if write traffic matters
        cost += baseCost + branchingFactor * this.calculateCost(...node.selectionSet.selections);
      } else if (node.kind === Kind.FRAGMENT_SPREAD) {
        const fragmentName = node.name.value;
        const fragment = this.context.getFragment(fragmentName);
        const cachedCost = this.fragmentCosts[fragmentName];

        if (cachedCost !== undefined) {
          cost += cachedCost;
        } else if (fragment) {
          const fragmentCost = this.calculateCost(...fragment.selectionSet.selections);
          this.fragmentCosts[fragmentName] = fragmentCost;
          cost += fragmentCost;
        }
      } else if (node.kind === Kind.INLINE_FRAGMENT) {
        cost += this.calculateCost(...node.selectionSet.selections);
      }

      if (cost > this.maxCost) {
        return cost; // Short circuit return, no need to keep processing
      }
    }

    return cost;
  }

  getCount(args?: readonly ArgumentNode[]): number | undefined {
    const countArg = args?.find((arg) => arg.name.value === '_count');
    let value = countArg?.value;
    if (value?.kind === Kind.VARIABLE) {
      // Medplum counts only a literal; a `_count: $n` would otherwise cost 20 whatever $n is (sent, or its default)
      const name = value.name.value;
      if (this.variables && Object.hasOwn(this.variables, name)) {
        const n = this.variables[name];
        return typeof n === 'number' && Number.isInteger(n) ? n : undefined;
      }
      value = this.operation?.variableDefinitions?.find((d) => d.variable.name.value === name)?.defaultValue;
    }
    if (value?.kind === Kind.INT) {
      return Number.parseInt(value.value, 10);
    }
    return undefined;
  }
}

function isSearchField(node: FieldNode): boolean {
  return node.name.value.endsWith('List') || node.name.value.endsWith('Connection'); // Medplum: List only; a Connection searches too
}

function isLinkedResource(node: FieldNode): boolean {
  return node.name.value === 'resource';
}
