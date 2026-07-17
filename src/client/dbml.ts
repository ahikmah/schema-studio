import { ModelExporter, Parser, renameTable } from '@dbml/core';

export type SchemaColumn = {
  id: string;
  name: string;
  type: string;
  primaryKey: boolean;
  foreignKey: boolean;
  required: boolean;
  unique: boolean;
};

export type SchemaTable = {
  id: string;
  name: string;
  schema: string;
  headerColor?: string;
  columns: SchemaColumn[];
};

export type SchemaRelation = {
  id: string;
  fromTable: string;
  fromColumn: string;
  fromCardinality: '1' | 'N';
  toTable: string;
  toColumn: string;
  toCardinality: '1' | 'N';
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:N';
};

export type SchemaModel = { tables: SchemaTable[]; relations: SchemaRelation[] };
export type ParseResult = { ok: true; model: SchemaModel } | { ok: false; message: string; line?: number };
export type DiagramLayout = Record<string, { x: number; y: number }>;
export type ArrangeAlgorithm = 'left-right' | 'snowflake' | 'compact';

const tableId = (schema: string, table: string) => `${schema}.${table}`;

const typeName = (type: { type_name?: string; args?: string | null } | string) => {
  if (typeof type === 'string') return type;
  const name = type.type_name ?? 'unknown';
  return `${name}${type.args && !name.includes('(') ? `(${type.args})` : ''}`;
};

const errorDetails = (error: unknown) => {
  const value = error as { message?: string; diagnostics?: Array<{ message?: string; location?: { start?: { line?: number } } }> };
  const diagnostic = value.diagnostics?.[0];
  return {
    message: diagnostic?.message ?? value.message ?? 'Invalid DBML',
    line: diagnostic?.location?.start?.line,
  };
};

const relationCardinality = (value: string | undefined): SchemaRelation['fromCardinality'] => value === '*' ? 'N' : '1';

const isPrimaryEndpoint = (
  endpoint: { schemaName?: string; tableName: string; fieldNames: string[] },
  primaryKeys: Map<string, Set<string>>,
  fallbackSchema: string,
) => {
  const keys = primaryKeys.get(tableId(endpoint.schemaName || fallbackSchema, endpoint.tableName));
  return Boolean(keys?.size) && endpoint.fieldNames.every((field) => keys?.has(field));
};

const dependentEndpoint = (
  endpoints: Array<{ relation?: string; schemaName?: string; tableName: string; fieldNames: string[] }>,
  primaryKeys: Map<string, Set<string>>,
  fallbackSchema: string,
) => {
  const many = endpoints.find((endpoint) => endpoint.relation === '*');
  if (many) return many;
  const [left, right] = endpoints;
  const leftPk = isPrimaryEndpoint(left, primaryKeys, fallbackSchema);
  const rightPk = isPrimaryEndpoint(right, primaryKeys, fallbackSchema);
  if (leftPk !== rightPk) return leftPk ? right : left;
  return endpoints[0];
};

export function parseDbml(source: string): ParseResult {
  try {
    const database = Parser.parse(source, 'dbml');
    const primaryKeys = new Map(database.schemas.flatMap((schema) => schema.tables.map((table) => [
      tableId(schema.name, table.name),
      new Set(table.fields.filter((field) => field.pk).map((field) => field.name)),
    ])));
    const foreignKeys = new Set<string>();
    const relations = database.schemas.flatMap((schema) => schema.refs.map((ref) => {
      const from = dependentEndpoint(ref.endpoints, primaryKeys, schema.name);
      const to = ref.endpoints.find((endpoint) => endpoint !== from) ?? ref.endpoints[1];
      const fromTable = tableId(from.schemaName || schema.name, from.tableName);
      const toTable = tableId(to.schemaName || schema.name, to.tableName);
      const fromColumn = from.fieldNames.join(',');
      const toColumn = to.fieldNames.join(',');
      from.fieldNames.forEach((field) => foreignKeys.add(`${fromTable}.${field}`));
      const fromCardinality = relationCardinality(from.relation);
      const toCardinality = relationCardinality(to.relation);
      return {
        id: `ref-${ref.id}`,
        fromTable,
        fromColumn,
        fromCardinality,
        toTable,
        toColumn,
        toCardinality,
        cardinality: `${fromCardinality}:${toCardinality}` as SchemaRelation['cardinality'],
      };
    }));
    const tables = database.schemas.flatMap((schema) => schema.tables.map((table) => ({
      id: tableId(schema.name, table.name),
      name: table.name,
      schema: schema.name,
      headerColor: table.headerColor === 'none' ? undefined : table.headerColor,
      columns: table.fields.map((field) => ({
        id: `${tableId(schema.name, table.name)}.${field.name}`,
        name: field.name,
        type: typeName(field.type),
        primaryKey: field.pk,
        foreignKey: foreignKeys.has(`${tableId(schema.name, table.name)}.${field.name}`),
        required: field.not_null,
        unique: field.unique,
      })),
    })));
    return { ok: true, model: { tables, relations } };
  } catch (error) {
    return { ok: false, ...errorDetails(error) };
  }
}

export function exportPostgres(source: string) {
  let index = 0;
  // ponytail: portable export maps pgvector to real[]; add native/portable modes if migration-grade output is needed.
  return ModelExporter.export(Parser.parse(source, 'dbml'), 'postgres')
    .replace(/^CREATE (UNIQUE )?INDEX ON /gm, (_, unique = '') => `CREATE ${unique}INDEX "schema_studio_auto_idx_${++index}" ON `)
    .replace(/DEFAULT \(([A-Za-z_][\w.]*\([^()]*\))\)/g, 'DEFAULT $1')
    .replace(/^(\s*)"([^"]+)" vector\((\d+)\)([^,\n]*)(,?)$/gim, '$1"$2" real[]$4$5 -- pgvector vector($3)');
}

export function updateTableSettings(source: string, schema: string, oldName: string, newName: string, headerColor: string) {
  const name = newName.trim();
  const color = headerColor === 'none' ? 'none' : headerColor.toUpperCase();
  if (!name || name.length > 100) throw new Error('Table name is required');
  if (color !== 'none' && !/^#[0-9A-F]{6}$/.test(color)) throw new Error('Use a six-digit hex color');

  const renamed = name === oldName ? source : renameTable({ schema, table: oldName }, { schema, table: name }, source);
  const database = Parser.parse(renamed, 'dbml');
  const table = database.schemas.find((item) => item.name === schema)?.tables.find((item) => item.name === name);
  if (!table) throw new Error('Table not found');

  const start = table.token.start.offset;
  const brace = renamed.indexOf('{', start);
  if (brace < start || brace > table.token.end.offset) throw new Error('Table declaration is invalid');

  let header = renamed.slice(start, brace);
  const setting = /headerColor\s*:\s*(?:#[0-9a-f]{6}|none)/i;
  if (setting.test(header)) {
    header = color === 'none' ? header
      .replace(/headerColor\s*:\s*(?:#[0-9a-f]{6}|none)\s*,\s*/i, '')
      .replace(/,\s*headerColor\s*:\s*(?:#[0-9a-f]{6}|none)/i, '')
      .replace(setting, '')
      : header.replace(setting, `headerColor: ${color}`);
  } else if (color !== 'none') {
    header = /\]\s*$/.test(header)
      ? header.replace(/\]\s*$/, `, headerColor: ${color}] `)
      : `${header.trimEnd()} [headerColor: ${color}] `;
  }
  header = header.replace(/\s*\[\s*\]\s*$/, ' ');
  return `${renamed.slice(0, start)}${header}${renamed.slice(brace)}`;
}

export function arrangeTables(model: SchemaModel, algorithm: ArrangeAlgorithm): DiagramLayout {
  const ids = model.tables.map((table) => table.id);
  if (algorithm === 'compact') {
    const columns = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
    return Object.fromEntries(ids.map((id, index) => [id, { x: (index % columns) * 300, y: Math.floor(index / columns) * 340 }]));
  }

  if (algorithm === 'snowflake') {
    const degree = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const relation of model.relations) {
      if (relation.fromTable in degree) degree[relation.fromTable] += 1;
      if (relation.toTable in degree) degree[relation.toTable] += 1;
    }
    const ordered = [...ids].sort((a, b) => degree[b] - degree[a] || a.localeCompare(b));
    const result: DiagramLayout = ordered[0] ? { [ordered[0]]: { x: 0, y: 0 } } : {};
    let offset = 1;
    for (let ring = 1; offset < ordered.length; ring += 1) {
      const count = Math.min(ring * 8, ordered.length - offset);
      const radius = ring * 440;
      for (let index = 0; index < count; index += 1) {
        const angle = (index / count) * Math.PI * 2;
        result[ordered[offset + index]] = { x: Math.round(Math.cos(angle) * radius), y: Math.round(Math.sin(angle) * radius) };
      }
      offset += count;
    }
    return result;
  }

  const children = new Map(ids.map((id) => [id, new Set<string>()]));
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const relation of model.relations) {
    if (!children.has(relation.toTable) || !children.has(relation.fromTable) || relation.toTable === relation.fromTable) continue;
    const dependents = children.get(relation.toTable)!;
    if (!dependents.has(relation.fromTable)) {
      dependents.add(relation.fromTable);
      incoming.set(relation.fromTable, incoming.get(relation.fromTable)! + 1);
    }
  }
  const levels = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => incoming.get(id) === 0).sort();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const parent = queue[cursor];
    for (const child of children.get(parent)!) {
      levels.set(child, Math.max(levels.get(child)!, levels.get(parent)! + 1));
      incoming.set(child, incoming.get(child)! - 1);
      if (incoming.get(child) === 0) queue.push(child);
    }
  }
  const grouped = new Map<number, string[]>();
  for (const id of ids) {
    const level = levels.get(id)!;
    grouped.set(level, [...(grouped.get(level) ?? []), id]);
  }
  return Object.fromEntries([...grouped].flatMap(([level, tables]) => tables.sort().map((id, index) => [id, { x: level * 340, y: index * 340 }])));
}

export function positionsFor(model: SchemaModel, saved: DiagramLayout): DiagramLayout {
  const compact = arrangeTables(model, 'compact');
  return Object.fromEntries(model.tables.map((table, index) => [
    table.id,
    saved[table.id] ?? compact[table.id] ?? { x: (index % 4) * 320, y: Math.floor(index / 4) * 360 },
  ]));
}
