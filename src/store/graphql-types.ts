// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
// Ported from Medplum 5.2.14 packages/fhir-router/src/graphql/utils.ts and output-types.ts: the GraphQL output types of FHIR
// types, the search arguments, the search, Connection and reference resolvers, reverse lookups and list-field arguments; also
// getConnectionType and resolveByConnectionApi from graphql.ts (here, so the two files import one way). Changes: resolvers are
// synchronous and go through the request's `fhir` callback (no repository, no DataLoader: a per-request map reads each
// reference once); the type cache belongs to one schema, whose resource types are passed in (a store may hold only some types:
// reverse lookups and `resource` cover only those; reverse lookups leave out every-type targets, see targetsEveryType); Medplum's batched reverse lookups and search counter (project settings)
// are dropped. Not yet here: input types (mutations), plan 3 Task 4.
import type { Filter, InternalSchemaElement, SearchRequest } from '@medplum/core';
import {
  DEFAULT_MAX_SEARCH_COUNT,
  DEFAULT_SEARCH_COUNT,
  OperationOutcomeError,
  Operator,
  badRequest,
  capitalize,
  evalFhirPathTyped,
  formatSearchQuery,
  getDataType,
  getReferenceString,
  getSearchParameters,
  isLowerCase,
  isReference,
  isResourceTypeSchema,
  isString,
  normalizeOperationOutcome,
  notFound,
  parseReference,
  parseSearchRequest,
  toJsBoolean,
  toTypedValue,
  tryGetDataType,
  validationRegexes,
} from '@medplum/core';
import type { Bundle, ElementDefinitionType, OperationOutcome, Reference, Resource, ResourceType } from '@medplum/fhirtypes';
import type {
  GraphQLEnumValueConfigMap,
  GraphQLError,
  GraphQLFieldConfig,
  GraphQLFieldConfigArgumentMap,
  GraphQLFieldConfigMap,
  GraphQLNullableOutputType,
  GraphQLOutputType,
  GraphQLResolveInfo,
  GraphQLScalarType,
} from 'graphql';
import { GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, GraphQLUnionType, Kind } from 'graphql';

// A FHIR request on the store, path relative to the base; the parsed JSON body. An answer ≥ 400 throws its OperationOutcome.
export type Fhir = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => unknown;

export interface GraphQLContext {
  fhir: Fhir;
  resources: Map<string, Resource | Error>; // replaces Medplum's DataLoader: Type/id read once per query, a failed read too
}

// Reads Type/id once per query (Medplum's DataLoader): a failed read is kept and thrown again, as DataLoader keeps a rejection.
export function readCached(ctx: GraphQLContext, resourceType: string, id: string): Resource {
  const key = `${resourceType}/${id}`;
  let result = ctx.resources.get(key);
  if (!result) {
    try {
      result = ctx.fhir('GET', `${resourceType}/${encodeURIComponent(id)}`) as Resource;
    } catch (err) {
      result = new OperationOutcomeError(normalizeOperationOutcome(err), { cause: err });
    }
    ctx.resources.set(key, result);
  }
  if (result instanceof Error) {
    throw result;
  }
  return result;
}

export const typeCache: Record<string, GraphQLScalarType | undefined> = {
  base64Binary: GraphQLString,
  boolean: GraphQLBoolean,
  canonical: GraphQLString,
  code: GraphQLString,
  date: GraphQLString,
  dateTime: GraphQLString,
  decimal: GraphQLFloat,
  id: GraphQLID,
  instant: GraphQLString,
  integer: GraphQLFloat,
  markdown: GraphQLString,
  number: GraphQLFloat,
  oid: GraphQLString,
  positiveInt: GraphQLFloat,
  string: GraphQLString,
  time: GraphQLString,
  unsignedInt: GraphQLFloat,
  uri: GraphQLString,
  url: GraphQLString,
  uuid: GraphQLString,
  xhtml: GraphQLString,
  'http://hl7.org/fhirpath/System.Boolean': GraphQLBoolean,
  'http://hl7.org/fhirpath/System.Date': GraphQLString,
  'http://hl7.org/fhirpath/System.DateTime': GraphQLString,
  'http://hl7.org/fhirpath/System.Decimal': GraphQLFloat,
  'http://hl7.org/fhirpath/System.Integer': GraphQLFloat,
  'http://hl7.org/fhirpath/System.String': GraphQLString,
  'http://hl7.org/fhirpath/System.Time': GraphQLString,
};

// --- utils.ts ---

function parseSearchArgsWithReference(
  resourceType: ResourceType,
  source: any,
  args: Record<string, string>
): { searchRequest: SearchRequest; referenceFilter: Filter | undefined } {
  let referenceFilter: Filter | undefined = undefined;
  if (source) {
    // Sanity check: nested resources (contained, Bundle entries) can have arbitrary ids
    if (!isString(source.id) || !validationRegexes.id.test(source.id)) {
      throw new OperationOutcomeError(badRequest('Invalid reference'));
    }

    // _reference is a required field for reverse lookup searches
    // The GraphQL parser will validate that it is there.
    const reference = args['_reference'];
    delete args['_reference'];
    referenceFilter = {
      code: reference,
      operator: Operator.EQUALS,
      value: getReferenceString(source),
    };
  }

  // Reverse the transform of dashes to underscores, back to dashes
  args = Object.fromEntries(Object.entries(args).map(([key, value]) => [graphQLFieldToFhirParam(key), value]));

  // Parse the search request
  const searchRequest = parseSearchRequest(resourceType, args);
  return { searchRequest, referenceFilter };
}

function addFilter(searchRequest: SearchRequest, filter: Filter): void {
  const existingFilters = searchRequest.filters || [];
  searchRequest.filters = [filter, ...existingFilters];
}

export function parseSearchArgs(resourceType: ResourceType, source: any, args: Record<string, string>): SearchRequest {
  const { searchRequest, referenceFilter } = parseSearchArgsWithReference(resourceType, source, args);

  if (referenceFilter) {
    addFilter(searchRequest, referenceFilter);
  }

  return searchRequest;
}

export function applyMaxCount(searchRequest: SearchRequest, maxCount: number | undefined): void {
  searchRequest.count = Math.min(searchRequest.count ?? DEFAULT_SEARCH_COUNT, maxCount ?? DEFAULT_MAX_SEARCH_COUNT);
}

export function graphQLFieldToFhirParam(code: string): string {
  return code.startsWith('_') ? code : code.replaceAll('_', '-');
}

export function fhirParamToGraphQLField(code: string): string {
  return code.replaceAll('-', '_');
}

/**
 * GraphQL resolver for search requests.
 * The field name should always end with "List" (i.e., "Patient" search uses "PatientList").
 * The search args should be FHIR search parameters.
 * @param source - The source/root.  This should always be null for our top level readers.
 * @param args - The GraphQL search arguments.
 * @param ctx - The GraphQL context.
 * @param info - The GraphQL resolve info.  This includes the schema, and additional field details.
 * @returns The resources for the query.
 */
export function resolveBySearch(source: any, args: Record<string, string>, ctx: GraphQLContext, info: GraphQLResolveInfo): Resource[] {
  const fieldName = info.fieldName;
  const resourceType = fieldName.substring(0, fieldName.length - 'List'.length) as ResourceType;
  const searchRequest = parseSearchArgs(resourceType, source, args);
  applyMaxCount(searchRequest, undefined);
  const bundle = search(ctx, searchRequest);
  return (bundle.entry ?? []).map((e) => e.resource as Resource); // Medplum's search Bundle always has entry; the store's omits an empty one
}

const search = (ctx: GraphQLContext, searchRequest: SearchRequest): Bundle =>
  ctx.fhir('GET', searchRequest.resourceType + formatSearchQuery(searchRequest)) as Bundle;

interface ConnectionResponse {
  count?: number;
  offset?: number;
  pageSize?: number;
  edges?: ConnectionEdge[];
  first?: string;
  previous?: string;
  next?: string;
  last?: string;
}

interface ConnectionEdge {
  mode?: string;
  score?: number;
  resource?: Resource;
}

export function getConnectionType(t: OutputTypes, resourceType: string, resourceGraphQLType: GraphQLOutputType): GraphQLOutputType {
  const cacheKey = resourceType + 'Connection';
  let result = t.cache[cacheKey];
  if (!result) {
    result = buildConnectionType(resourceType, resourceGraphQLType);
    t.cache[cacheKey] = result;
  }
  return result;
}

function buildConnectionType(resourceType: string, resourceGraphQLType: GraphQLOutputType): GraphQLOutputType {
  return new GraphQLObjectType({
    name: resourceType + 'Connection',
    fields: {
      count: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      pageSize: { type: GraphQLInt },
      first: { type: GraphQLString },
      previous: { type: GraphQLString },
      next: { type: GraphQLString },
      last: { type: GraphQLString },
      edges: {
        type: new GraphQLList(
          new GraphQLObjectType({
            name: resourceType + 'ConnectionEdge',
            fields: {
              mode: { type: GraphQLString },
              score: { type: GraphQLFloat },
              resource: { type: resourceGraphQLType },
            },
          })
        ),
      },
    },
  });
}

/**
 * GraphQL resolver for Connection API requests.
 * The field name should always end with "Connection" (i.e., "Patient" search uses "PatientConnection").
 * The search args should be FHIR search parameters.
 * @param source - The source/root.  This should always be null for our top level readers.
 * @param args - The GraphQL search arguments.
 * @param ctx - The GraphQL context.
 * @param info - The GraphQL resolve info.  This includes the schema, and additional field details.
 * @returns The Connection for the query.
 */
export function resolveByConnectionApi(source: any, args: Record<string, string>, ctx: GraphQLContext, info: GraphQLResolveInfo): ConnectionResponse | undefined {
  const fieldName = info.fieldName;
  const resourceType = fieldName.substring(0, fieldName.length - 'Connection'.length) as ResourceType;
  const searchRequest = parseSearchArgs(resourceType, source, args);
  if (isFieldRequested(info, 'count')) {
    searchRequest.total = 'accurate';
  }
  if (!isFieldRequested(info, 'edges')) {
    searchRequest.count = 0;
  }
  applyMaxCount(searchRequest, undefined);
  const bundle = search(ctx, searchRequest);
  return {
    count: bundle.total,
    offset: searchRequest.offset ?? 0,
    pageSize: searchRequest.count ?? DEFAULT_SEARCH_COUNT,
    edges: bundle.entry?.map((e) => ({
      mode: e.search?.mode,
      score: e.search?.score,
      resource: e.resource as Resource,
    })),
    next: getNextCursor(bundle),
  };
}

function getNextCursor(bundle: Bundle): string | undefined {
  const link = bundle.link?.find((l) => l.relation === 'next')?.url;
  if (!link) {
    return undefined;
  }
  return new URL(link).searchParams.get('_cursor') || undefined;
}

/**
 * Returns true if the field is requested in the GraphQL query.
 * @param info - The GraphQL resolve info.  This includes the field name.
 * @param fieldName - The field name to check.
 * @returns True if the field is requested in the GraphQL query.
 */
export function isFieldRequested(info: GraphQLResolveInfo, fieldName: string): boolean {
  return info.fieldNodes.some((fieldNode) =>
    fieldNode.selectionSet?.selections.some((selection) => {
      return selection.kind === Kind.FIELD && selection.name.value === fieldName;
    })
  );
}

export function buildSearchArgs(resourceType: string): GraphQLFieldConfigArgumentMap {
  const args: GraphQLFieldConfigArgumentMap = {
    _count: {
      type: GraphQLInt,
      description: 'Specify how many elements to return from a repeating list.',
    },
    _offset: {
      type: GraphQLInt,
      description: 'Specify the offset to start at for a repeating element.',
    },
    _sort: {
      type: GraphQLString,
      description: 'Specify the sort order by comma-separated list of sort rules in priority order.',
    },
    _id: {
      type: GraphQLString,
      description: 'Select resources based on the logical id of the resource.',
    },
    _lastUpdated: {
      type: GraphQLString,
      description: 'Select resources based on the last time they were changed.',
    },
    _filter: {
      type: GraphQLString,
      description:
        ' The _filter parameter provides a syntax for expressing a set of query expressions on the underlying resources.',
    },
    _cursor: {
      type: GraphQLString,
      description: 'The _cursor parameter is used to retrieve the next page of results from a previous search.',
    },
  };
  const searchParams = getSearchParameters(resourceType);
  if (searchParams) {
    for (const [code, searchParam] of Object.entries(searchParams)) {
      // GraphQL does not support dashes in argument names
      // So convert dashes to underscores
      args[fhirParamToGraphQLField(code)] = {
        type: GraphQLString,
        description: searchParam.description,
      };
    }
  }
  return args;
}

/**
 * Returns an OperationOutcome for GraphQL errors.
 * @param errors - Array of GraphQL errors.
 * @returns OperationOutcome with the GraphQL errors as OperationOutcome issues.
 */
export function invalidRequest(errors: readonly GraphQLError[]): OperationOutcome {
  return {
    resourceType: 'OperationOutcome',
    issue: errors.map((error) => ({
      severity: 'error',
      code: 'invalid',
      details: { text: error.message },
    })),
  };
}

// --- output-types.ts ---

// One schema's output types: Medplum's module-level outputTypeCache, per resource type list.
export type OutputTypes = { types: readonly string[]; cache: Record<string, GraphQLOutputType | undefined> };
export const outputTypes = (types: readonly string[]): OutputTypes => ({ types, cache: { ...typeCache } });

export function getGraphQLOutputType(t: OutputTypes, inputType: string): GraphQLOutputType {
  let result = t.cache[inputType];
  if (!result) {
    result = buildGraphQLOutputType(t, inputType);
    t.cache[inputType] = result;
  }
  return result;
}

export function buildGraphQLOutputType(t: OutputTypes, resourceType: string): GraphQLOutputType {
  if (resourceType === 'ResourceList') {
    return new GraphQLUnionType({
      name: 'ResourceList',
      types: () => t.types.map((rt) => getGraphQLOutputType(t, rt)).filter((x) => !!x) as GraphQLObjectType[],
      resolveType: resolveTypeByReference,
    });
  }

  const schema = getDataType(resourceType);
  return new GraphQLObjectType({
    name: resourceType,
    description: schema.description,
    fields: () => buildGraphQLOutputFields(t, resourceType as ResourceType),
  });
}

function buildGraphQLOutputFields(t: OutputTypes, resourceType: ResourceType): GraphQLFieldConfigMap<any, any> {
  const fields: GraphQLFieldConfigMap<any, any> = {};
  buildOutputPropertyFields(t, resourceType, fields);
  buildReverseLookupFields(t, resourceType, fields);
  return fields;
}

function buildOutputPropertyFields(t: OutputTypes, resourceType: string, fields: GraphQLFieldConfigMap<any, any>): void {
  const schema = getDataType(resourceType);

  if (isResourceTypeSchema(schema)) {
    fields.resourceType = {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Resource Type',
    };
  }

  if (resourceType === 'Reference') {
    fields.resource = {
      description: 'Reference',
      type: getGraphQLOutputType(t, 'ResourceList'),
      resolve: (source, args, ctx) => resolveByReference(t, source, args, ctx),
    };
  }

  for (const [key, elementDefinition] of Object.entries(schema.elements)) {
    for (const type of elementDefinition.type as ElementDefinitionType[]) {
      buildOutputPropertyField(t, fields, key, elementDefinition, type);
    }
  }
}

function buildOutputPropertyField(
  t: OutputTypes,
  fields: GraphQLFieldConfigMap<any, any>,
  key: string,
  elementDefinition: InternalSchemaElement,
  elementDefinitionType: ElementDefinitionType
): void {
  let typeName = elementDefinitionType.code as string;
  if (typeName === 'Element' || typeName === 'BackboneElement') {
    typeName = elementDefinition.type[0].code;
  }
  if (typeName === 'Resource') {
    typeName = 'ResourceList';
  }

  const fieldConfig: GraphQLFieldConfig<any, any> = {
    description: elementDefinition.description, // TODO: elementDefinition.short
    type: getOutputPropertyType(t, elementDefinition, typeName, key),
    resolve: resolveField,
  };

  if (elementDefinition.max > 1) {
    fieldConfig.args = buildListPropertyFieldArgs(typeName);
  }

  const propertyName = (key.split('.').pop() as string).replace('[x]', capitalize(elementDefinitionType.code as string));
  fields[propertyName] = fieldConfig;
}

/**
 * Builds field arguments for a list property.
 *
 * The FHIR GraphQL specification defines the following arguments for list properties:
 *   1. _count: Specify how many elements to return from a repeating list.
 *   2. _offset: Specify the offset to start at for a repeating element.
 *   3. fhirpath: A FHIRPath statement selecting which of the subnodes is to be included.
 *   4. All properties of the list element type.
 *
 * See: https://hl7.org/fhir/R4/graphql.html#list
 * @param fieldTypeName - The type name of the field.
 * @returns The arguments for the field.
 */
function buildListPropertyFieldArgs(fieldTypeName: string): GraphQLFieldConfigArgumentMap {
  const fieldArgs: GraphQLFieldConfigArgumentMap = {
    _count: {
      type: GraphQLInt,
      description: 'Specify how many elements to return from a repeating list.',
    },
    _offset: {
      type: GraphQLInt,
      description: 'Specify the offset to start at for a repeating element.',
    },
  };

  if (!isLowerCase(fieldTypeName.charAt(0))) {
    // If this is a backbone element, add "fhirpath" and all properties as arguments
    fieldArgs.fhirpath = {
      type: GraphQLString,
      description: 'A FHIRPath statement selecting which of the subnodes is to be included',
    };

    // Add all "string" and "code" properties as arguments
    const fieldTypeSchema = tryGetDataType(fieldTypeName);
    if (fieldTypeSchema?.elements) {
      for (const [fieldKey, fieldElementDefinition] of Object.entries(fieldTypeSchema.elements)) {
        for (const type of fieldElementDefinition.type) {
          buildListPropertyFieldArg(fieldArgs, fieldKey, fieldElementDefinition, type);
        }
      }
    }
  }

  return fieldArgs;
}

/**
 * Builds a field argument for a list property.
 * @param fieldArgs - The output argument map.
 * @param fieldKey - The key of the field.
 * @param elementDefinition - The FHIR element definition of the field.
 * @param elementDefinitionType - The FHIR element definition type of the field.
 */
function buildListPropertyFieldArg(
  fieldArgs: GraphQLFieldConfigArgumentMap,
  fieldKey: string,
  elementDefinition: InternalSchemaElement,
  elementDefinitionType: ElementDefinitionType
): void {
  const baseType = elementDefinitionType.code as string;
  const fieldName = fieldKey.replace('[x]', capitalize(baseType));
  switch (baseType) {
    case 'canonical':
    case 'code':
    case 'id':
    case 'oid':
    case 'string':
    case 'uri':
    case 'url':
    case 'uuid':
    case 'http://hl7.org/fhirpath/System.String':
      fieldArgs[fieldName] = {
        type: GraphQLString,
        description: elementDefinition.description, // TODO: elementDefinition.short
      };
      break;
  }
}

/**
 * Builds a list of reverse lookup fields for a resource type.
 *
 * It's also possible to use search is a special mode, doing reverse lookups -
 * e.g. list all the resources that refer to this resource.
 *
 * There must be at least the argument "_reference" which identifies which of the search parameters
 * for the target resource is used to match the resource that has focus.
 * In addition, there may be other arguments as defined above in search
 * (except that the "id" argument is prohibited here as nonsensical).
 *
 * See: https://www.hl7.org/fhir/graphql.html#reverse
 * @param t - The schema's output types (its resource types are the children looked up).
 * @param resourceType - The resource type to build fields for.
 * @param fields - The fields object to add fields to.
 */
// Left out of reverse lookups (README, deliberate differences): `_compartment` and the R4 parameters whose target is every
// resource type (Provenance.target, List.item, Task.focus, ...) put every type pair in the schema, about 400 MiB on an all-types
// store; such a lookup is a search by that parameter (`ProvenanceList(target: "Patient/1")`).
const targetsEveryType = (code: string, target: readonly string[]): boolean => code === '_compartment' || target.length >= 145; // R4 lists all 145

function buildReverseLookupFields(t: OutputTypes, resourceType: ResourceType, fields: GraphQLFieldConfigMap<any, any>): void {
  for (const childResourceType of t.types) {
    const childGraphQLType = getGraphQLOutputType(t, childResourceType);
    const childSearchParams = getSearchParameters(childResourceType);
    const enumValues: GraphQLEnumValueConfigMap = {};
    let count = 0;
    if (childSearchParams) {
      for (const [code, searchParam] of Object.entries(childSearchParams)) {
        if (searchParam.target?.includes(resourceType) && !targetsEveryType(code, searchParam.target)) {
          enumValues[fhirParamToGraphQLField(code)] = { value: code };
          count++;
        }
      }
    }

    if (count > 0) {
      const enumType = new GraphQLEnumType({
        name: resourceType + '_' + childResourceType + '_reference',
        values: enumValues,
      });
      const args = buildSearchArgs(childResourceType);
      args['_reference'] = {
        type: new GraphQLNonNull(enumType),
        description: `Specify which property to use for reverse lookup for ${childResourceType}`,
      };
      // Add List field for backward compatibility
      fields[childResourceType + 'List'] = {
        type: new GraphQLList(childGraphQLType),
        args,
        resolve: resolveBySearch,
      };
      // Add Connection field for count support
      fields[childResourceType + 'Connection'] = {
        type: getConnectionType(t, childResourceType, childGraphQLType),
        args,
        resolve: resolveByConnectionApi,
      };
    }
  }
}

function getOutputPropertyType(t: OutputTypes, elementDefinition: InternalSchemaElement, typeName: string, path: string): GraphQLOutputType {
  const baseType = getGraphQLOutputType(t, typeName) as GraphQLNullableOutputType;
  let graphqlType: GraphQLOutputType = elementDefinition.max > 1 ? new GraphQLList(new GraphQLNonNull(baseType)) : baseType;
  if (elementDefinition.min !== 0 && !path.endsWith('[x]')) {
    graphqlType = new GraphQLNonNull(graphqlType);
  }
  return graphqlType;
}

/**
 * GraphQL resolver for fields.
 * In the common case, this is just a matter of returning the field value from the source object.
 * If the field is a list and the user specifies list arguments, then we can apply those arguments here.
 * @param source - The source. This is the object that contains the field.
 * @param args - The GraphQL search arguments.
 * @param _ctx - The GraphQL context.
 * @param info - The GraphQL resolve info.  This includes the field name.
 * @returns The field value, with list arguments applied.
 */
function resolveField(source: any, args: any, _ctx: GraphQLContext, info: GraphQLResolveInfo): any {
  const fieldValue = source?.[info.fieldName];
  if (!args || !fieldValue) {
    return fieldValue;
  }

  const { _offset, _count, fhirpath, ...rest } = args;
  let array = fieldValue as any[];

  for (const [key, value] of Object.entries(rest)) {
    array = array.filter((item) => item[key] === value);
  }

  if (fhirpath) {
    array = array.filter((item) => toJsBoolean(evalFhirPathTyped(fhirpath, [toTypedValue(item)])));
  }

  if (_offset) {
    array = array.slice(_offset);
  }

  if (_count) {
    array = array.slice(0, _count);
  }

  return array;
}

/**
 * GraphQL resolver for Reference requests.
 * This is a special resolver for following Reference objects. As Medplum's server reads them: a reference that is not
 * local (`#x`, an absolute URL, a search) is not found; so is one to a type this store doesn't hold.
 * @param t - The schema's output types (its resource types).
 * @param source - The Reference.
 * @param _args - The GraphQL search arguments.
 * @param ctx - The GraphQL context.
 * @returns The resource the reference points to.
 */
function resolveByReference(t: OutputTypes, source: any, _args: any, ctx: GraphQLContext): Resource | undefined {
  if (!isReference(source)) {
    return undefined;
  }
  if (!source.reference.match(/^[A-Z][a-zA-Z]+\//)) {
    // Non-local references cannot be resolved
    throw new OperationOutcomeError(notFound);
  }
  let resourceType: string, id: string;
  try {
    [resourceType, id] = parseReference(source as Reference);
  } catch {
    throw new OperationOutcomeError(notFound);
  }
  if (!t.types.includes(resourceType)) {
    throw new OperationOutcomeError(notFound);
  }
  return readCached(ctx, resourceType, id);
}

/**
 * GraphQL type resolver for resources.
 * When loading a resource via reference, GraphQL needs to know the type of the resource.
 * @param resource - The loaded resource.
 * @returns The GraphQL type name of the resource.
 */
function resolveTypeByReference(resource: Resource | undefined): string | undefined {
  return resource?.resourceType || undefined;
}
