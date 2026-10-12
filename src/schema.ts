export type JsonSchema = Record<string, any>;

export class Schema {
  schema: JsonSchema;
  isOptional = false;

  constructor(s: JsonSchema) {
    this.schema = { ...s };
  }

  describe(description: string): Schema {
    this.schema.description = description;
    return this;
  }

  optional(): Schema {
    this.isOptional = true;
    return this;
  }

  nullable(): Schema {
    this.schema.nullable = true;
    return this;
  }
}

function wrap(s: JsonSchema): Schema {
  return new Schema(s);
}

export const z = {
  string: (): Schema => wrap({ type: "string" }),
  number: (): Schema => wrap({ type: "number" }),
  boolean: (): Schema => wrap({ type: "boolean" }),
  any: (): Schema => wrap({}),
  array: (item?: Schema): Schema => wrap({ type: "array", items: item ? item.schema : {} }),
  record: (value?: Schema): Schema => wrap({ type: "object", additionalProperties: value ? value.schema : true }),
  object: (shape: Record<string, Schema>): Schema => wrap(objectSchema(shape)),
};

export function objectSchema(shape: Record<string, Schema>): JsonSchema {
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    properties[key] = field.schema;
    if (!field.isOptional) required.push(key);
  }
  const out: JsonSchema = { type: "object", properties };
  if (required.length) out.required = required;
  return out;
}

export function toJsonSchema(inputSchema: Record<string, Schema> | undefined): JsonSchema {
  if (!inputSchema || Object.keys(inputSchema).length === 0) {
    return { type: "object", properties: {} };
  }
  return objectSchema(inputSchema);
}
