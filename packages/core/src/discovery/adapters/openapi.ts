/** OpenAPI 3 JSON/primitive-parameter subset. Unsupported operations remain visible. */
import { computeSchemaHash } from '../cbom.js';
import type { CreateCapabilityInput } from '../types.js';
import type { SoftwareTool, HttpExecutor } from '../../connectors/software-execution.js';

export interface OpenApiToolDraft extends SoftwareTool {toolName: string; method: string; path: string; summary: string; schemaHash: string; operationId?: string}
export interface OpenApiParseResult {capability: CreateCapabilityInput; tools: OpenApiToolDraft[]; unsupported: Array<{path: string; method: string; reason: string}>}
type OpenApiObject = Record<string, any>;
const object = (value: unknown): value is OpenApiObject => typeof value === 'object' && value !== null && !Array.isArray(value);

function resolveOpenApiValue(spec: OpenApiObject, value: any, seen: string[] = []): any {
  if (Array.isArray(value)) return value.map(item => resolveOpenApiValue(spec, item, seen));
  if (!object(value)) return value;
  if (value.$ref) {
    const reference = String(value.$ref);
    if (!reference.startsWith('#/')) throw new Error('unsupported remote reference');
    if (seen.includes(reference)) throw new Error('unsupported recursive reference');
    let referenced: any = spec;
    for (const segment of reference.slice(2).split('/')) referenced = referenced?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (referenced === undefined) throw new Error('unresolved local reference');
    return resolveOpenApiValue(spec, referenced, [...seen, reference]);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveOpenApiValue(spec, item, seen)]));
}
function validateParameter(parameter: OpenApiObject, properties: Record<string, unknown>): void {
  if (!['path', 'query', 'header'].includes(parameter.in) || !parameter.schema || !['string', 'number', 'integer', 'boolean'].includes(parameter.schema.type)) throw new Error('unsupported parameter serialization/type');
  const style = parameter.in === 'query' ? 'form' : 'simple';
  if (parameter.style && parameter.style !== style) throw new Error('unsupported parameter style');
  if (parameter.content || parameter.allowReserved) throw new Error('unsupported parameter encoding');
  if (properties[parameter.name]) throw new Error('unsupported duplicate parameter name');
}
function compileInput(operation: OpenApiObject, parent: OpenApiObject): {properties: Record<string, unknown>; required: string[]; parameters: NonNullable<HttpExecutor['parameters']>} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const parameters: NonNullable<HttpExecutor['parameters']> = [];
  for (const parameter of [...(parent.parameters ?? []), ...(operation.parameters ?? [])]) {
    validateParameter(parameter, properties);
    properties[parameter.name] = parameter.schema;
    const mandatory = parameter.required || parameter.in === 'path';
    if (mandatory) required.push(parameter.name);
    parameters.push({name: parameter.name, in: parameter.in, required: mandatory});
  }
  if (operation.requestBody) {
    const json = operation.requestBody.content?.['application/json'];
    if (!json) throw new Error('unsupported non-JSON body');
    properties.body = json.schema ?? {};
    if (operation.requestBody.required) required.push('body');
  }
  return {properties, required, parameters};
}
function validateResponses(operation: OpenApiObject): void {
  for (const response of Object.values(operation.responses ?? {}) as OpenApiObject[]) {
    if (response.content && Object.keys(response.content).some(type => type !== 'application/json')) throw new Error('unsupported non-JSON response');
  }
}
function compileAuthentication(spec: OpenApiObject, operation: OpenApiObject): HttpExecutor['auth'] {
  const security = operation.security ?? spec.security;
  if (!security?.length) return undefined;
  if (security.length !== 1 || Object.keys(security[0]).length !== 1) throw new Error('unsupported alternative/combined authentication');
  const name = Object.keys(security[0])[0]!;
  const scheme = resolveOpenApiValue(spec, spec.components?.securitySchemes?.[name]);
  if (scheme?.type === 'http' && scheme.scheme === 'bearer') return {kind: 'bearer'};
  if (scheme?.type === 'apiKey' && ['header', 'query'].includes(scheme.in)) return {kind: scheme.in, name: scheme.name};
  throw new Error('unsupported authentication');
}
function compileOperation(spec: OpenApiObject, path: string, method: string, pathRaw: OpenApiObject, endpoint: string, tools: OpenApiToolDraft[]): OpenApiToolDraft {
  const operation = resolveOpenApiValue(spec, pathRaw[method]);
  const parent = resolveOpenApiValue(spec, {parameters: pathRaw.parameters});
  if (operation.callbacks) throw new Error('unsupported callbacks');
  if (operation.servers || pathRaw.servers) throw new Error('unsupported server override');
  const {properties, required, parameters} = compileInput(operation, parent);
  validateResponses(operation);
  const auth = compileAuthentication(spec, operation);
  const name = operation.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,64}$/.test(name) || tools.some(tool => tool.name === name)) throw new Error('unsupported duplicate or invalid operation name');
  const summary = operation.summary ?? operation.description ?? `${method.toUpperCase()} ${path}`;
  const executor: HttpExecutor = {kind: 'http', url: endpoint.replace(/\/$/, '') + path, method: method.toUpperCase(), parameters};
  if (auth) executor.auth = auth;
  return {name, toolName: name, description: summary, inputSchema: {type: 'object', properties, required}, method: method.toUpperCase(), path, summary,
    schemaHash: computeSchemaHash({method, path, properties, required}), operationId: operation.operationId, executor};
}
function capabilityFor(spec: OpenApiObject, opts: {name?: string} | undefined, endpoint: string, tools: OpenApiToolDraft[], unsupported: OpenApiParseResult['unsupported']): CreateCapabilityInput {
  const title = String(spec.info?.title ?? opts?.name ?? 'openapi');
  const writes = tools.some(tool => !['GET', 'HEAD', 'OPTIONS'].includes(tool.method));
  return {kind: 'openapi', name: title, description: spec.info?.description, endpoint, transport: 'https', trust: 'untrusted', scope: writes ? ['read', 'write'] : ['read'],
    source: 'openapi-adapter', schemaHash: computeSchemaHash({title, tools}), metadata: {toolCount: tools.length, draftTools: tools, unsupported}};
}
export function parseOpenApiSpec(spec: unknown, opts?: {endpoint?: string; name?: string}): OpenApiParseResult {
  if (!object(spec)) throw new Error('OpenAPI spec must be an object');
  if (!/^3\.(0|1)\./.test(String(spec.openapi ?? ''))) throw new Error('unsupported OpenAPI version (3.0/3.1 required)');
  const endpoint = opts?.endpoint ?? spec.servers?.[0]?.url ?? 'https://example.invalid';
  const tools: OpenApiToolDraft[] = [];
  const unsupported: OpenApiParseResult['unsupported'] = [];
  for (const [path, raw] of Object.entries(spec.paths ?? {})) {
    const pathRaw = raw as OpenApiObject;
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      if (!pathRaw?.[method]) continue;
      try {tools.push(compileOperation(spec, path, method, pathRaw, endpoint, tools));}
      catch (error) {unsupported.push({path, method: method.toUpperCase(), reason: error instanceof Error ? error.message : String(error)});}
    }
  }
  return {capability: capabilityFor(spec, opts, endpoint, tools, unsupported), tools, unsupported};
}
