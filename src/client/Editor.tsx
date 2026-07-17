import CodeMirror from '@uiw/react-codemirror';
import { SQLDialect, sql } from '@codemirror/lang-sql';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Collaborator, Project, Revision } from '../shared/types';
import { api, ApiError } from './api';
import { arrangeTables, exportPostgres, parseDbml, positionsFor, updateTableSettings, type ArrangeAlgorithm, type DiagramLayout, type SchemaModel, type SchemaTable } from './dbml';
import { clampSplit, editorReducer, initialEditorState } from './editor-state';

type TableNode = Node<{ table: SchemaTable }, 'table'>;
type SchemaEdge = Edge<{ sourceLabel: string; targetLabel: string }, 'cardinality'>;
type ProjectDetail = { project: Project };
type CollaboratorList = { collaborators: Array<Collaborator | (Omit<Collaborator, 'displayName'> & { display_name: string })> };
type RevisionList = { revisions: Revision[] };
const diagramNodeWidth = 250;
const diagramHeaderHeight = 36;
const diagramRowHeight = 26;
const diagramNodeMinHeight = 96;
const diagramPadding = 80;
const pngScale = 3;
const pngMaxSide = 12_000;

function SchemaTableNode({ data }: NodeProps<TableNode>) {
  return <article className="table-node">
    <Handle type="target" position={Position.Left} />
    <header style={data.table.headerColor ? { backgroundColor: data.table.headerColor } : undefined}><small>{data.table.schema}</small><strong>{data.table.name}</strong></header>
    <div>{data.table.columns.map((column) => <div className="column-row" key={column.id}>
      <span className={`column-name${column.primaryKey ? ' key-column' : ''}${column.foreignKey ? ' foreign-column' : ''}`}>
        <span>{column.name}</span>
        <span className="column-flags">
          {column.primaryKey && <span className="column-flag pk-flag">PK</span>}
          {column.foreignKey && <span className="column-flag fk-flag">FK</span>}
        </span>
      </span>
      <code>{column.type}</code>
    </div>)}</div>
    <Handle type="source" position={Position.Right} />
  </article>;
}

function CardinalityEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, label, markerEnd, style, selected, data }: EdgeProps<SchemaEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const labelClass = `edge-end-label${selected ? ' selected-edge-end-label' : ''}`;
  const sourceLabelPosition = cardinalityLabelPosition(sourceX, sourceY, sourcePosition);
  const targetLabelPosition = cardinalityLabelPosition(targetX, targetY, targetPosition);
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} label={label} labelX={labelX} labelY={labelY} labelBgPadding={[4, 2]} labelBgBorderRadius={4} />
    <EdgeLabelRenderer>
      <span className={labelClass} style={{ transform: `translate(-50%, -50%) translate(${sourceLabelPosition.x}px,${sourceLabelPosition.y}px)` }}>{data?.sourceLabel}</span>
      <span className={labelClass} style={{ transform: `translate(-50%, -50%) translate(${targetLabelPosition.x}px,${targetLabelPosition.y}px)` }}>{data?.targetLabel}</span>
    </EdgeLabelRenderer>
  </>;
}

function cardinalityLabelPosition(x: number, y: number, position: Position) {
  const gap = 18;
  const lift = -13;
  switch (position) {
    case Position.Left:
      return { x: x - gap, y: y + lift };
    case Position.Right:
      return { x: x + gap, y: y + lift };
    case Position.Top:
      return { x, y: y - gap };
    case Position.Bottom:
      return { x, y: y + gap };
    default:
      return { x, y: y + lift };
  }
}

export function diagramNodes(model: SchemaModel, layout: DiagramLayout, writable: boolean, selectedEdgeId?: string): TableNode[] {
  const selectedRelation = model.relations.find((relation) => relation.id === selectedEdgeId);
  const related = selectedRelation ? new Set([selectedRelation.fromTable, selectedRelation.toTable]) : new Set<string>();
  return model.tables.map((table) => ({
    id: table.id,
    type: 'table',
    position: layout[table.id] ?? { x: 0, y: 0 },
    data: { table },
    draggable: writable,
    className: related.has(table.id) ? 'related-table-node' : '',
  }));
}

export function diagramEdges(model: SchemaModel, selectedEdgeId?: string): SchemaEdge[] {
  return model.relations.map((relation) => {
    const selected = relation.id === selectedEdgeId;
    return {
      id: relation.id,
      source: relation.fromTable,
      target: relation.toTable,
      type: 'cardinality',
      label: selected ? `${relation.fromColumn} -> ${relation.toColumn}` : '',
      className: `schema-edge${selected ? ' selected-schema-edge' : ''}`,
      selected,
      markerEnd: { type: MarkerType.ArrowClosed, color: selected ? '#d9822b' : '#577a64' },
      data: { sourceLabel: relation.fromCardinality, targetLabel: relation.toCardinality },
    };
  });
}

const tableHeight = (table: SchemaTable) => Math.max(diagramNodeMinHeight, diagramHeaderHeight + table.columns.length * diagramRowHeight);

export function diagramExportBounds(model: SchemaModel, layout: DiagramLayout) {
  if (!model.tables.length) return { x: 0, y: 0, width: 1200, height: 800, scale: pngScale };
  const boxes = model.tables.map((table, index) => {
    const position = layout[table.id] ?? { x: (index % 4) * 320, y: Math.floor(index / 4) * 360 };
    return { ...position, width: diagramNodeWidth, height: tableHeight(table) };
  });
  const minX = Math.min(...boxes.map((box) => box.x)) - diagramPadding;
  const minY = Math.min(...boxes.map((box) => box.y)) - diagramPadding;
  const maxX = Math.max(...boxes.map((box) => box.x + box.width)) + diagramPadding;
  const maxY = Math.max(...boxes.map((box) => box.y + box.height)) + diagramPadding;
  const width = Math.ceil(maxX - minX);
  const height = Math.ceil(maxY - minY);
  return { x: minX, y: minY, width, height, scale: Math.min(pngScale, pngMaxSide / Math.max(width, height)) };
}

const nodeTypes = { table: SchemaTableNode } satisfies NodeTypes;
const edgeTypes = { cardinality: CardinalityEdge } satisfies EdgeTypes;
const dbmlDialect = SQLDialect.define({
  keywords: 'Project Table TableGroup Ref Enum Note indexes Indexes as inline headerColor primary key pk increment unique not null default ref delete update',
  types: 'uuid varchar text boolean integer bigint decimal numeric timestamp timestamptz date json jsonb vector serial bigserial float double',
  slashComments: true,
});
const dbmlLanguage = sql({ dialect: dbmlDialect });
const headerColors = ['#3498DB', '#E74C3C', '#2ECC71', '#FF9800', '#9B59B6', '#1ABC9C', '#34495E', '#E67E22', '#95A5A6', '#D35400', '#C0392B', '#16A085', '#2C3E50', '#F1C40F', '#27AE60', '#8E44AD', '#2980B9', '#E83E8C'];
const arrangementOptions: Array<{ id: ArrangeAlgorithm; name: string; description: string }> = [
  { id: 'left-right', name: 'Left-right', description: 'Arrange parent tables from left to right based on relationship direction.' },
  { id: 'snowflake', name: 'Snowflake', description: 'Place the most connected table in the center, with related tables around it.' },
  { id: 'compact', name: 'Compact', description: 'Pack tables into a compact grid for diagrams with fewer relationships.' },
];

function download(name: string, contents: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function safeName(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schema';
}

export function Editor({ initialProject, onBack, onProjectChange }: {
  initialProject: Project;
  onBack: () => void;
  onProjectChange: (project: Project) => void;
}) {
  const parsed = useMemo(() => parseDbml(initialProject.dbml), [initialProject.dbml]);
  const initialModel = parsed.ok ? parsed.model : { tables: [], relations: [] };
  const [state, dispatch] = useReducer(editorReducer, initialEditorState(initialProject.dbml, initialModel, initialProject.version));
  const [layout, setLayout] = useState<DiagramLayout>(() => positionsFor(initialModel, initialProject.layout));
  const [panel, setPanel] = useState<'code' | 'diagram'>('code');
  const [modal, setModal] = useState<'share' | 'revisions' | null>(null);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [notice, setNotice] = useState('');
  const [flow, setFlow] = useState<ReactFlowInstance<TableNode, Edge> | null>(null);
  const [split, setSplit] = useState(42);
  const [diagramOnly, setDiagramOnly] = useState(false);
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const draftRef = useRef(state.draft);
  const layoutRef = useRef(layout);
  const savingRef = useRef(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const diagramRef = useRef<HTMLDivElement>(null);
  const writable = initialProject.role !== 'viewer';
  const selectedTable = state.lastValidModel.tables.find((table) => table.id === selectedTableId);

  useEffect(() => { draftRef.current = state.draft; }, [state.draft]);
  useEffect(() => { layoutRef.current = layout; }, [layout]);

  const nodes = useMemo(() => diagramNodes(state.lastValidModel, layout, writable, selectedEdgeId), [layout, selectedEdgeId, state.lastValidModel, writable]);
  const edges = useMemo(() => diagramEdges(state.lastValidModel, selectedEdgeId), [selectedEdgeId, state.lastValidModel]);

  const saveNow = useCallback(async () => {
    if (!writable || state.saveState === 'conflict' || savingRef.current || state.saveState === 'saved') return state.saveState === 'saved';
    savingRef.current = true;
    const savedDraft = draftRef.current;
    const savedLayout = layoutRef.current;
    dispatch({ type: 'saveStarted' });
    try {
      const result = await api.patch<{ version: number; updatedAt: string }>(`/api/projects/${initialProject.id}`, {
        dbml: savedDraft,
        layout: savedLayout,
        version: state.version,
      });
      dispatch({ type: 'saveSucceeded', version: result.version });
      onProjectChange({ ...initialProject, dbml: savedDraft, layout: savedLayout, version: result.version, updatedAt: result.updatedAt });
      if (draftRef.current !== savedDraft || layoutRef.current !== savedLayout) dispatch({ type: 'layoutChanged' });
      return true;
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        dispatch({ type: 'conflict', serverVersion: typeof reason.body.currentVersion === 'number' ? reason.body.currentVersion : undefined });
      } else {
        dispatch({ type: 'saveFailed' });
        setNotice(reason instanceof ApiError ? reason.message : 'Could not save the project');
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [initialProject, onProjectChange, state.saveState, state.version, writable]);

  useEffect(() => {
    if (state.saveState !== 'dirty' || !writable) return;
    const timeout = window.setTimeout(() => { void saveNow(); }, 2000);
    return () => window.clearTimeout(timeout);
  }, [saveNow, state.saveState, writable]);

  function changeDraft(value: string) {
    if (!writable) return;
    const next = parseDbml(value);
    dispatch({ type: 'draftChanged', draft: value, parsed: next });
    if (next.ok) setLayout((current) => positionsFor(next.model, current));
  }

  function moveNode(_: unknown, node: TableNode) {
    setLayout((current) => ({ ...current, [node.id]: node.position }));
    dispatch({ type: 'layoutChanged' });
  }

  function applyArrangement(algorithm: ArrangeAlgorithm) {
    if (!writable) return;
    const next = arrangeTables(state.lastValidModel, algorithm);
    layoutRef.current = next;
    setLayout(next);
    dispatch({ type: 'layoutChanged' });
    setArrangeOpen(false);
    window.setTimeout(() => void flow?.fitView({ duration: 350, padding: .18 }), 0);
  }

  function applyTableSettings(name: string, color: string) {
    if (!writable || !selectedTable) return;
    try {
      const source = updateTableSettings(draftRef.current, selectedTable.schema, selectedTable.name, name, color);
      const parsedSource = parseDbml(source);
      if (!parsedSource.ok) throw new Error(parsedSource.message);
      const nextTable = parsedSource.model.tables.find((table) => table.schema === selectedTable.schema && table.name === name.trim());
      if (!nextTable) throw new Error('Updated table not found');
      const nextLayout = { ...layoutRef.current };
      if (nextTable.id !== selectedTable.id) {
        nextLayout[nextTable.id] = nextLayout[selectedTable.id] ?? { x: 0, y: 0 };
        delete nextLayout[selectedTable.id];
      }
      const positioned = positionsFor(parsedSource.model, nextLayout);
      draftRef.current = source;
      layoutRef.current = positioned;
      setLayout(positioned);
      dispatch({ type: 'draftChanged', draft: source, parsed: parsedSource });
      setSelectedTableId(nextTable.id);
      setNotice('');
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Could not update table');
    }
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    event.preventDefault();
    const resize = (clientX: number) => {
      const bounds = workspace.getBoundingClientRect();
      setSplit(clampSplit(((clientX - bounds.left) / bounds.width) * 100));
    };
    const move = (pointer: PointerEvent) => resize(pointer.clientX);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  }

  async function openFullscreen() {
    try { await diagramRef.current?.requestFullscreen(); }
    catch { setNotice('Fullscreen is not available in this browser'); }
  }

  function findTable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = String(new FormData(event.currentTarget).get('table') ?? '').toLowerCase();
    const node = nodes.find((item) => item.data.table.name.toLowerCase().includes(query));
    if (node) void flow?.fitView({ nodes: [node], duration: 350, padding: 1.2 });
  }

  async function reloadServer() {
    try {
      const response = await api.get<ProjectDetail>(`/api/projects/${initialProject.id}`);
      const next = parseDbml(response.project.dbml);
      if (!next.ok) throw new Error('Server draft is invalid');
      setLayout(positionsFor(next.model, response.project.layout));
      dispatch({ type: 'reset', draft: response.project.dbml, model: next.model, version: response.project.version });
      onProjectChange(response.project);
    } catch {
      setNotice('Could not reload the server copy');
    }
  }

  async function openShare() {
    setModal('share');
    try {
      const response = await api.get<CollaboratorList>(`/api/projects/${initialProject.id}/collaborators`);
      setCollaborators(response.collaborators.map((item) => ({
        ...item,
        displayName: 'displayName' in item ? item.displayName : item.display_name,
      })));
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : 'Could not load collaborators');
    }
  }

  async function addCollaborator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await api.post<{ collaborator: Collaborator }>(`/api/projects/${initialProject.id}/collaborators`, {
        email: data.get('email'), role: data.get('role'),
      });
      setCollaborators((items) => [...items.filter((item) => item.id !== result.collaborator.id), result.collaborator]);
      form.reset();
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : 'Could not add collaborator');
    }
  }

  async function removeCollaborator(userId: string) {
    await api.delete(`/api/projects/${initialProject.id}/collaborators/${userId}`);
    setCollaborators((items) => items.filter((item) => item.id !== userId));
  }

  async function openRevisions() {
    setModal('revisions');
    try {
      setRevisions((await api.get<RevisionList>(`/api/projects/${initialProject.id}/revisions`)).revisions);
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : 'Could not load revisions');
    }
  }

  async function createRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (state.parseError) return setNotice('Fix the DBML error before creating a revision');
    if (!await saveNow()) return;
    try {
      await api.post(`/api/projects/${initialProject.id}/revisions`, { name: data.get('name') });
      form.reset();
      await openRevisions();
    } catch (reason) {
      setNotice(reason instanceof ApiError ? reason.message : 'Could not create revision');
    }
  }

  function exportSql() {
    if (state.parseError) return setNotice('Fix the DBML error before exporting PostgreSQL');
    try { download(`${safeName(initialProject.name)}.sql`, exportPostgres(state.draft), 'application/sql'); }
    catch { setNotice('Could not export PostgreSQL from this DBML'); }
  }

  function exportPng() {
    if (state.parseError) return setNotice('Fix the DBML error before exporting PNG');
    const bounds = diagramExportBounds(state.lastValidModel, layoutRef.current);
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(bounds.width * bounds.scale);
    canvas.height = Math.ceil(bounds.height * bounds.scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return setNotice('PNG export is not available in this browser');
    ctx.scale(bounds.scale, bounds.scale);
    ctx.fillStyle = '#f3f0e8';
    ctx.fillRect(0, 0, bounds.width, bounds.height);
    ctx.strokeStyle = '#d7dbd2';
    ctx.lineWidth = 1;
    for (let x = 0; x < bounds.width; x += 22) for (let y = 0; y < bounds.height; y += 22) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.stroke();
    }
    const point = (tableId: string, side: 'left' | 'right') => {
      const table = state.lastValidModel.tables.find((item) => item.id === tableId);
      const position = layoutRef.current[tableId] ?? { x: 0, y: 0 };
      return { x: position.x - bounds.x + (side === 'right' ? diagramNodeWidth : 0), y: position.y - bounds.y + tableHeight(table ?? { id: '', name: '', schema: '', columns: [] }) / 2 };
    };
    ctx.strokeStyle = '#577a64';
    ctx.fillStyle = '#425347';
    ctx.lineWidth = 3;
    ctx.font = 'bold 16px monospace';
    for (const relation of state.lastValidModel.relations) {
      const source = point(relation.fromTable, 'right');
      const target = point(relation.toTable, 'left');
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.bezierCurveTo(source.x + 80, source.y, target.x - 80, target.y, target.x, target.y);
      ctx.stroke();
      ctx.fillText(relation.fromCardinality, source.x + 10, source.y - 8);
      ctx.fillText(relation.toCardinality, target.x - 22, target.y - 8);
    }
    for (const [index, table] of state.lastValidModel.tables.entries()) {
      const position = layoutRef.current[table.id] ?? { x: (index % 4) * 320, y: Math.floor(index / 4) * 360 };
      const x = position.x - bounds.x;
      const y = position.y - bounds.y;
      const height = tableHeight(table);
      ctx.fillStyle = '#fffef9';
      ctx.strokeStyle = '#334239';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x, y, diagramNodeWidth, height, 9);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = table.headerColor ?? '#dce9f2';
      ctx.fillRect(x + 1, y + 1, diagramNodeWidth - 2, diagramHeaderHeight);
      ctx.fillStyle = '#577189';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(table.schema.toUpperCase(), x + 12, y + 14);
      ctx.fillStyle = '#1f2923';
      ctx.font = 'bold 16px sans-serif';
      ctx.fillText(table.name, x + 12, y + 30);
      ctx.font = 'bold 12px monospace';
      table.columns.forEach((column, row) => {
        const rowY = y + diagramHeaderHeight + row * diagramRowHeight;
        ctx.strokeStyle = '#e1e4dd';
        ctx.beginPath();
        ctx.moveTo(x, rowY);
        ctx.lineTo(x + diagramNodeWidth, rowY);
        ctx.stroke();
        ctx.fillStyle = column.foreignKey ? '#2c5b4b' : column.primaryKey ? '#235778' : '#1f2923';
        ctx.fillText(`${column.name}${column.primaryKey ? '  PK' : ''}${column.foreignKey ? '  FK' : ''}`, x + 10, rowY + 17);
        ctx.fillStyle = '#6a756c';
        ctx.fillText(column.type, x + diagramNodeWidth - 92, rowY + 17);
      });
    }
    canvas.toBlob((blob) => blob ? downloadBlob(`${safeName(initialProject.name)}.png`, blob) : setNotice('Could not export PNG'), 'image/png');
  }

  async function deleteProject() {
    if (!window.confirm(`Delete “${initialProject.name}”? This cannot be undone.`)) return;
    await api.delete(`/api/projects/${initialProject.id}`);
    onBack();
  }

  const statusText = state.saveState === 'saved' ? `Saved · v${state.version}`
    : state.saveState === 'dirty' ? 'Unsaved changes'
      : state.saveState === 'saving' ? 'Saving…'
        : state.saveState === 'error' ? 'Save failed'
          : 'Save conflict';

  return <main className="editor-shell">
    <header className="editor-header">
      <button className="back-button" onClick={onBack} aria-label="Back to projects">←</button>
      <div className="editor-title"><strong>{initialProject.name}</strong><span className={`save-status status-${state.saveState}`}>{statusText}</span></div>
      <div className="editor-actions">
        <button className="ghost" onClick={() => download(`${safeName(initialProject.name)}.dbml`, state.draft)}>DBML ↓</button>
        <button className="ghost" onClick={exportSql} disabled={Boolean(state.parseError)}>PostgreSQL ↓</button>
        <button className="ghost" onClick={exportPng} disabled={Boolean(state.parseError)}>PNG ↓</button>
        <button className="ghost" onClick={() => void openRevisions()}>Revisions</button>
        {initialProject.role === 'owner' && <button className="primary" onClick={() => void openShare()}>Share</button>}
      </div>
    </header>

    <div className="mobile-tabs" role="tablist"><button className={panel === 'code' ? 'active' : ''} onClick={() => setPanel('code')}>DBML</button><button className={panel === 'diagram' ? 'active' : ''} onClick={() => setPanel('diagram')}>Diagram</button></div>
    {notice && <div className="editor-notice" role="alert"><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}
    {initialProject.role === 'viewer' && <div className="viewer-banner">View-only project — you can inspect and export, but cannot save changes.</div>}
    <section
      ref={workspaceRef}
      className={`editor-workspace panel-${panel}${diagramOnly ? ' diagram-only' : ''}`}
      style={{ '--code-width': `${split}%` } as CSSProperties}
    >
      <div className="code-panel">
        <div className="panel-heading"><span>DBML source</span><small>{state.lastValidModel.tables.length} tables · {state.lastValidModel.relations.length} relations</small></div>
        <CodeMirror value={state.draft} onChange={changeDraft} editable={writable} height="100%" theme="light" extensions={[dbmlLanguage]} basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }} />
        {state.parseError && <div className="parse-error" role="alert"><strong>DBML issue</strong><span>{state.parseError}</span></div>}
      </div>
      <div
        className="panel-divider"
        role="separator"
        aria-label="Resize editor panels"
        aria-valuemin={25}
        aria-valuemax={75}
        aria-valuenow={Math.round(split)}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') setSplit((value) => clampSplit(value - 2));
          if (event.key === 'ArrowRight') setSplit((value) => clampSplit(value + 2));
        }}
      />
      <div className="diagram-panel" ref={diagramRef}>
        <div className="panel-heading diagram-heading"><div><span>Relationship map</span><small className="diagram-legend">PK/FK badges · cardinality labels at edge ends</small></div><form className="table-search" onSubmit={findTable}><input name="table" list="schema-tables" placeholder="Find table…" aria-label="Find table" /><datalist id="schema-tables">{state.lastValidModel.tables.map((table) => <option key={table.id} value={table.name} />)}</datalist></form></div>
        <div className="diagram-actions">
          {writable && <div className="arrange-control"><button type="button" onClick={() => { setSelectedTableId(undefined); setSelectedEdgeId(undefined); setArrangeOpen((value) => !value); }} aria-haspopup="menu" aria-expanded={arrangeOpen}>Arrange ▾</button>{arrangeOpen && <div className="arrange-menu" role="menu" aria-label="Choose auto arrange algorithm"><strong>Choose auto arrange algorithm</strong>{arrangementOptions.map((option, index) => <button type="button" role="menuitem" key={option.id} onClick={() => applyArrangement(option.id)}><span className="arrange-icon" aria-hidden="true">⌘</span><span><b>{option.name}</b><small>{option.description}</small></span><kbd>{index + 1}</kbd></button>)}</div>}</div>}
          <button type="button" onClick={exportPng} disabled={Boolean(state.parseError)}>PNG</button><button type="button" onClick={() => setDiagramOnly((value) => !value)}>{diagramOnly ? 'Split' : 'Wide'}</button><button type="button" onClick={() => void openFullscreen()}>Screen</button>
        </div>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setFlow} onNodeDragStop={moveNode} onEdgeClick={(_, edge) => { setArrangeOpen(false); setSelectedTableId(undefined); setSelectedEdgeId(edge.id); }} onNodeClick={(_, node) => { setArrangeOpen(false); setSelectedEdgeId(undefined); setSelectedTableId(node.id); }} onPaneClick={() => { setSelectedTableId(undefined); setSelectedEdgeId(undefined); setArrangeOpen(false); }} fitView minZoom={0.15} maxZoom={1.5} proOptions={{ hideAttribution: true }}>
          <Background color="#a9b2a9" gap={22} size={1} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {writable && selectedTable && <aside className="table-inspector" aria-label={`Edit ${selectedTable.name}`}>
          <header><strong>Table settings</strong><button type="button" onClick={() => setSelectedTableId(undefined)} aria-label="Close table settings">×</button></header>
          <form onSubmit={(event) => { event.preventDefault(); applyTableSettings(String(new FormData(event.currentTarget).get('tableName') ?? ''), selectedTable.headerColor ?? 'none'); }}>
            <label>Table name<input name="tableName" key={selectedTable.id} defaultValue={selectedTable.name} required maxLength={100} /></label>
            <button className="primary" type="submit">Apply name</button>
          </form>
          <div className="inspector-section"><strong>Header color</strong><div className="color-palette">{headerColors.map((color) => <button type="button" className="color-swatch" key={color} style={{ backgroundColor: color }} onClick={() => applyTableSettings(selectedTable.name, color)} aria-label={`Set header color ${color}`} aria-pressed={selectedTable.headerColor?.toUpperCase() === color} />)}</div></div>
          <div className="custom-color"><label>Custom<input type="color" value={selectedTable.headerColor ?? '#3498DB'} onChange={(event) => applyTableSettings(selectedTable.name, event.target.value)} /></label><code>{selectedTable.headerColor ?? 'Default'}</code><button type="button" className="ghost" onClick={() => applyTableSettings(selectedTable.name, 'none')}>Default</button></div>
        </aside>}
      </div>
    </section>

    {state.saveState === 'conflict' && <div className="modal-backdrop"><section className="conflict-card" role="alertdialog" aria-modal="true">
      <p className="section-label">Version conflict</p><h2>This project changed elsewhere.</h2>
      <p>Your local DBML is still here. Copy it before loading server version {state.serverVersion ?? 'latest'}.</p>
      <div className="modal-actions"><button className="ghost" onClick={() => void navigator.clipboard.writeText(state.draft)}>Copy local DBML</button><button className="primary" onClick={() => void reloadServer()}>Load server copy</button></div>
    </section></div>}

    {modal && <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setModal(null)}><section className="side-modal" role="dialog" aria-modal="true">
      <header><div><p className="section-label">{modal === 'share' ? 'Project access' : 'Saved milestones'}</p><h2>{modal === 'share' ? 'Share schema' : 'Revision history'}</h2></div><button className="close-button" onClick={() => setModal(null)} aria-label="Close">×</button></header>
      {modal === 'share' ? <>
        <form className="invite-form" onSubmit={addCollaborator}><label>Member email<input name="email" type="email" required placeholder="teammate@example.com" /></label><label>Access<select name="role" defaultValue="viewer"><option value="viewer">Viewer</option><option value="editor">Editor</option></select></label><button className="primary">Add or update</button></form>
        <div className="member-list">{collaborators.length ? collaborators.map((person) => <div key={person.id}><span><strong>{person.displayName}</strong><small>{person.email}</small></span><span className={`role-chip role-${person.role}`}>{person.role}</span><button className="text-danger" onClick={() => void removeCollaborator(person.id)}>Remove</button></div>) : <p className="modal-empty">Only you can access this project.</p>}</div>
        <button className="delete-project" onClick={() => void deleteProject()}>Delete project</button>
      </> : <>
        {writable && <form className="revision-form" onSubmit={createRevision}><label>Revision name<input name="name" required maxLength={100} placeholder="Architecture review v1" /></label><button className="primary" disabled={Boolean(state.parseError)}>Save milestone</button></form>}
        <div className="revision-list">{revisions.length ? revisions.map((revision) => <article key={revision.id}><span>#{revision.revision_number}</span><div><strong>{revision.name}</strong><small>{revision.created_by_name} · {new Date(revision.created_at).toLocaleString()}</small></div></article>) : <p className="modal-empty">No named revisions yet.</p>}</div>
      </>}
    </section></div>}
  </main>;
}
