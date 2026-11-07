import { z } from 'zod';

/**
 * Converts a task's Zod output schema into the JSON schema sent to OpenAI as a
 * strict `json_schema` response format, and maps the model's wire output back to
 * the shape the Zod schema expects.
 *
 * OpenAI strict mode requires every object property to be listed in `required`,
 * `additionalProperties: false` on every object, and no `propertyNames`. So:
 * - an optional property (`.optional()` or `.default(...)`) is sent as required
 *   but nullable, and a `null` from the model is removed again before parsing;
 * - a record keyed by an enum (`z.partialRecord(z.enum([...]), value)`) is sent as
 *   an object with one required, nullable property per enum key, and `null`
 *   entries are removed again before parsing;
 * - annotations OpenAI does not need (`$schema`, `default`) are dropped.
 *
 * Validation keywords such as `minLength` or `maxItems` are kept. The Zod schema
 * stays the final gate: `outputSchema.parse` runs on the decoded value, so
 * trimming and every bound are still enforced in application code.
 *
 * Anything this converter cannot represent faithfully (free-form records,
 * `oneOf`/`allOf`, conditionals, ...) throws, so a new schema fails in unit tests
 * instead of at request time.
 */

export type JsonSchema = { [keyword: string]: unknown };

export type StrictOutputSchema = {
  /** Schema sent as `response_format.json_schema.schema` with `strict: true`. */
  wireSchema: JsonSchema;
  /** Maps the parsed wire JSON back to the Zod input shape (drops nulls for optional fields). */
  decode: (wireValue: unknown) => unknown;
};

const droppedKeywords = new Set(['$schema', 'default']);
const unsupportedKeywords = new Set([
  '$ref',
  '$defs',
  'definitions',
  'allOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'unevaluatedItems',
  'unevaluatedProperties',
  'prefixItems',
  'contains',
  'minProperties',
  'maxProperties',
  'uniqueItems',
]);

const isRecord = (value: unknown): value is JsonSchema =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });

const enumKeys = (propertyNames: unknown, path: string): string[] => {
  if (!isRecord(propertyNames) || !Array.isArray(propertyNames.enum)
    || propertyNames.enum.some(key => typeof key !== 'string')) {
    throw new Error(`Strict output schema at ${path}: records must be keyed by a string enum.`);
  }
  return propertyNames.enum as string[];
};

const toWire = (schema: unknown, path: string): JsonSchema => {
  if (!isRecord(schema)) throw new Error(`Strict output schema at ${path}: expected a schema object.`);

  const wire: JsonSchema = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (droppedKeywords.has(keyword)) continue;
    if (unsupportedKeywords.has(keyword)) {
      throw new Error(`Strict output schema at ${path}: unsupported keyword "${keyword}".`);
    }
    wire[keyword] = value;
  }

  if (wire.type === 'object' || 'properties' in wire || 'propertyNames' in wire) {
    const properties: JsonSchema = {};
    if ('propertyNames' in wire) {
      const keys = enumKeys(wire.propertyNames, path);
      const valueSchema = toWire(wire.additionalProperties, `${path}/additionalProperties`);
      for (const key of keys) properties[key] = nullable(valueSchema);
      delete wire.propertyNames;
    } else {
      if (wire.additionalProperties !== undefined && wire.additionalProperties !== false) {
        throw new Error(`Strict output schema at ${path}: free-form additionalProperties are not supported.`);
      }
      const required = new Set(Array.isArray(wire.required) ? wire.required as string[] : []);
      for (const [key, propertySchema] of Object.entries(isRecord(wire.properties) ? wire.properties : {})) {
        const converted = toWire(propertySchema, `${path}/properties/${key}`);
        properties[key] = required.has(key) ? converted : nullable(converted);
      }
    }
    wire.type = 'object';
    wire.properties = properties;
    wire.required = Object.keys(properties);
    wire.additionalProperties = false;
    return wire;
  }

  if (wire.type === 'array') {
    if (!isRecord(wire.items)) throw new Error(`Strict output schema at ${path}: arrays need a single items schema.`);
    wire.items = toWire(wire.items, `${path}/items`);
    return wire;
  }

  if (Array.isArray(wire.anyOf)) {
    wire.anyOf = wire.anyOf.map((branch, index) => toWire(branch, `${path}/anyOf/${index}`));
  }
  return wire;
};

/** Removes the nulls `toWire` introduced, guided by the original (non-strict) JSON schema. */
const fromWire = (schema: unknown, value: unknown): unknown => {
  if (!isRecord(schema)) return value;

  if (Array.isArray(value)) {
    return schema.type === 'array' ? value.map(item => fromWire(schema.items, item)) : value;
  }
  if (!isRecord(value)) return value;

  if ('propertyNames' in schema) {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== null)
      .map(([key, entry]) => [key, fromWire(schema.additionalProperties, entry)]);
    return Object.fromEntries(entries);
  }
  if (isRecord(schema.properties)) {
    const properties = schema.properties;
    const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
    const entries = Object.entries(value)
      .filter(([key, entry]) => !(entry === null && key in properties && !required.has(key)))
      .map(([key, entry]) => [key, fromWire(properties[key], entry)]);
    return Object.fromEntries(entries);
  }
  return value;
};

const cache = new WeakMap<z.ZodType, StrictOutputSchema>();

export const toStrictOutputSchema = (outputSchema: z.ZodType): StrictOutputSchema => {
  const cached = cache.get(outputSchema);
  if (cached) return cached;

  // io: 'input' describes what the model must produce (before Zod transforms/defaults).
  const source = z.toJSONSchema(outputSchema, { target: 'draft-7', io: 'input', unrepresentable: 'throw' }) as JsonSchema;
  const wireSchema = toWire(source, '#');
  if (wireSchema.type !== 'object') throw new Error('Strict output schema root must be an object.');

  const strict: StrictOutputSchema = { wireSchema, decode: wireValue => fromWire(source, wireValue) };
  cache.set(outputSchema, strict);
  return strict;
};
