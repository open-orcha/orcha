// Generate portal types and validation schemas from FastAPI's generated slice.
// Usage: node tools/generate-workflow-contract.mjs /path/to/workflows-openapi.json
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const source = readFileSync(process.argv[2]);
const spec = JSON.parse(source);
const schemas = spec.components.schemas;
const evidenceSource = process.argv[3] ? readFileSync(process.argv[3]) : null;
if (evidenceSource) {
  const evidenceSpec = JSON.parse(evidenceSource);
  const path = '/api/workflows/{wid}/tasks/{tid}/evidence';
  const operation = evidenceSpec.paths[path]?.get;
  if (!operation) throw new Error('Generated evidence GET contract missing');
  const refs = new Set();
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) refs.add(value.$ref.split('/').at(-1));
    Object.values(value).forEach(collect);
  }
  collect(operation);
  for (const ref of refs) collect(evidenceSpec.components.schemas[ref]);
  for (const ref of refs) {
    const next = evidenceSpec.components.schemas[ref];
    if (!next || schemas[ref] && JSON.stringify(schemas[ref]) !== JSON.stringify(next)) throw new Error(`Conflicting generated schema: ${ref}`);
    schemas[ref] = next;
  }
  spec.paths[path] = { ...spec.paths[path], get: operation };
  writeFileSync('docs/design/workflows/workflow-evidence-openapi.json', evidenceSource);
}
function type(s) {
  if (s.$ref) return s.$ref.split('/').at(-1);
  if (s.anyOf) return s.anyOf.map(type).join(' | ');
  if (s.enum) return s.enum.map(v => JSON.stringify(v)).join(' | ');
  if ('const' in s) return JSON.stringify(s.const);
  if (s.type === 'array') return `Array<${type(s.items)}>`;
  if (s.type === 'object') {
    if (!s.properties) return `Record<string, ${typeof s.additionalProperties === 'object' ? type(s.additionalProperties) : 'unknown'}>`;
    return `{\n${Object.entries(s.properties).map(([k,v]) => `  ${JSON.stringify(k)}${s.required?.includes(k) ? '' : '?'}: ${type(v)};`).join('\n')}\n}`;
  }
  if (s.type === 'integer' || s.type === 'number') return 'number';
  if (['string','boolean','null'].includes(s.type)) return s.type;
  return 'unknown';
}
function clean(s, propertyMap = false) {
  if (Array.isArray(s)) return s.map(value => clean(value));
  if (!s || typeof s !== 'object') return s;
  return Object.fromEntries(Object.entries(s).filter(([k])=>propertyMap || !['title','description','default','examples'].includes(k)).map(([k,v])=>[k,clean(v, !propertyMap && k === 'properties')]));
}
const routes = Object.entries(spec.paths).flatMap(([path,ops]) => Object.entries(ops).map(([method,op])=>({path,method,operation:op['x-workflow-operation'],body:op.requestBody?.content?.['application/json']?.schema?.$ref?.split('/').at(-1)})));
const sha = createHash('sha256').update(source).digest('hex');
const out = `// Generated from FastAPI OpenAPI slices. DO NOT EDIT.\n// Workflow source SHA-256: ${sha}\n// Evidence GET source SHA-256: ${evidenceSource ? createHash('sha256').update(evidenceSource).digest('hex') : 'not included'}\n// Regenerate with tools/generate-workflow-contract.mjs and both source files.\n\n${Object.entries(schemas).map(([k,v])=>`export type ${k} = ${type(v)};`).join('\n\n')}\n\nexport type WorkflowModels = {\n${Object.keys(schemas).map(k=>`  ${k}: ${k};`).join('\n')}\n};\nexport const workflowSchemas = ${JSON.stringify(clean(schemas),null,2)};\nexport const workflowRoutes = ${JSON.stringify(routes,null,2)} as const;\n`;
writeFileSync('orcha-cli/orcha_cli/templates/portal/frontend/src/pages/workflows/workflowContract.generated.ts',out);
writeFileSync('docs/design/workflows/workflows-openapi.json',source);
console.log(`Generated ${Object.keys(schemas).length} models and ${routes.length} operations; ${sha}`);
