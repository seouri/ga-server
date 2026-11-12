// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
// Ported from Medplum 5.2.14 packages/fhir-router/src/graphql/utils.ts and output-types.ts: the GraphQL output types of FHIR
// types, the search arguments and the search resolver. Changes: resolvers are synchronous and go through the request's `fhir`
// callback (no repository, no DataLoader); the type cache belongs to one schema, whose resource types are passed in (a store
// may hold only some types). Not yet here: reverse lookups, the Connection API, `resource` on Reference and list-field
// arguments (with Medplum's resolveField) come in plan 3 Task 3; input types (mutations) in Task 4.
import type { InternalSchemaElement, SearchRequest } from '@medplum/core';
import {
  DEFAULT_MAX_SEARCH_COUNT,
  DEFAULT_SEARCH_COUNT,
  capitalize,
  formatSearchQuery,
  getDataType,
  getSearchParameters,
  isResourceTypeSchema,
  parseSearchRequest,
} from '@medplum/core';
import type { Bundle, ElementDefinitionType, OperationOutcome, Resource, ResourceType } from '@medplum/fhirtypes';
import type { GraphQLError, GraphQLFieldConfigArgumentMap, GraphQLFieldConfigMap, GraphQLNullableOutputType, GraphQLOutputType, GraphQLResolveInfo, GraphQLScalarType } from 'graphql';
import { GraphQLBoolean, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, GraphQLUnionType } from 'graphql';

// A FHIR request on the store, path relative to the base; the parsed JSON body. An answer ≥ 400 throws its OperationOutcome.
export type Fhir = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => unknown;

export interface GraphQLContext {
  fhir: Fhir;
  resources: Map<string, Resource>; // replaces Medplum's DataLoader: Type/id read once per query
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

export function parseSearchArgs(resourceType: ResourceType, _source: any, args: Record<string, string>): SearchRequest {
  // Reverse the transform of dashes to underscores, back to dashes
  args = Object.fromEntries(Object.entries(args).map(([key, value]) => [graphQLFieldToFhirParam(key), value]));
  return parseSearchRequest(resourceType, args);
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
  const bundle = ctx.fhir('GET', resourceType + formatSearchQuery(searchRequest)) as Bundle;
  return (bundle.entry ?? []).map((e) => e.resource as Resource); // Medplum's search Bundle always has entry; the store's omits an empty one
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

  // Medplum's resolveField only applies list-field arguments (Task 3); the default resolver reads the property.
  const propertyName = (key.split('.').pop() as string).replace('[x]', capitalize(elementDefinitionType.code as string));
  fields[propertyName] = {
    description: elementDefinition.description, // TODO: elementDefinition.short
    type: getOutputPropertyType(t, elementDefinition, typeName, key),
  };
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
 * GraphQL type resolver for resources.
 * When loading a resource via reference, GraphQL needs to know the type of the resource.
 * @param resource - The loaded resource.
 * @returns The GraphQL type name of the resource.
 */
function resolveTypeByReference(resource: Resource | undefined): string | undefined {
  return resource?.resourceType || undefined;
}
