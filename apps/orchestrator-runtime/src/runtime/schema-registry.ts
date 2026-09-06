export interface SchemaSpec {
  id: string;
  file?: string;
  isArrayEnvelope?: boolean;
  arrayItemFile?: string;
}

export function resolveSchema(schemaName: string): SchemaSpec {
  return { id: schemaName };
}

export function loadSchemaText(_spec: SchemaSpec): null {
  return null;
}
