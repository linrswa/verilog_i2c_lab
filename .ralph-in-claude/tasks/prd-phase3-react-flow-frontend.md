# PRD: Phase 3 — React Flow Frontend

## 1. Introduction/Overview

Build a React Flow-based frontend for the I2C Demo Platform that allows users to visually construct I2C test sequences by dragging and connecting nodes on a canvas. The frontend communicates with the existing FastAPI backend (`POST /api/run`, `GET /api/templates`, `GET /api/waveform/:id`) to execute simulations and display results. Users can compose test flows from node types (Reset, Write, Read, Scan, Delay), run them against the cocotb simulation, and view per-step pass/fail results along with register dumps.

## 2. Goals

- Provide a drag-and-drop visual interface for constructing I2C test sequences
- Serialize React Flow graphs into the backend's JSON step format and execute simulations
- Display per-step execution results with clear pass/fail indicators
- Allow VCD waveform file download for external viewing
- Support loading pre-built test templates from the backend
- Persist user-created flows in localStorage for convenience

## 3. User Stories

### Phase 1: Project Scaffolding & Layout

#### US-001: Project Setup with Bun + Vite + React + TypeScript
**Description:** As a developer, I want a properly configured frontend project so that I can start building components.

**Acceptance Criteria:**
- [ ] `frontend/` directory created with `bun create vite` using React + TypeScript template
- [ ] Tailwind CSS v4 installed and configured
- [ ] React Flow (`@xyflow/react`) installed as dependency
- [ ] `bun dev` starts the dev server without errors
- [ ] `bun run build` produces a production build without errors
- [ ] TypeScript strict mode enabled in `tsconfig.json`

#### US-002: Application Shell & Layout
**Description:** As a user, I want a structured layout with distinct panels so that I can see all parts of the interface at once.

**Acceptance Criteria:**
- [ ] Three-panel layout: left sidebar (node palette), center (React Flow canvas), bottom (result panel)
- [ ] Sidebar displays the 5 node types (Reset, Write, Read, Scan, Delay) as draggable items
- [ ] Result panel is collapsible and starts collapsed
- [ ] A top toolbar area with a "Run" button (disabled state initially)
- [ ] Layout is responsive and fills the viewport
- [ ] Verify in browser: all panels render correctly at 1280x800 minimum

### Phase 2: Custom Nodes & Canvas Interaction

#### US-003: Custom Node Components
**Description:** As a user, I want distinct visual nodes for each I2C operation so that I can identify them on the canvas.

**Acceptance Criteria:**
- [ ] `ResetNode` — displays "Reset" label, no editable parameters, one output handle
- [ ] `WriteNode` — displays fields for address (hex), register (hex), data (comma-separated hex bytes); one input handle, one output handle
- [ ] `ReadNode` — displays fields for address (hex), register (hex), byte count (n), optional expected data; one input handle, one output handle
- [ ] `ScanNode` — displays field for address (hex), optional expected result (true/false); one input handle, one output handle
- [ ] `DelayNode` — displays field for cycle count (integer); one input handle, one output handle
- [ ] Each node type has a distinct color/accent for quick visual identification
- [ ] Node parameters are editable directly on the node (inline forms)
- [ ] Verify in browser: all 5 node types render with correct fields

#### US-004: Drag-and-Drop from Sidebar to Canvas
**Description:** As a user, I want to drag node types from the sidebar onto the canvas so that I can build test sequences visually.

**Acceptance Criteria:**
- [ ] Dragging a node type from the sidebar and dropping it on the canvas creates a new node instance
- [ ] The new node appears at the drop position with default parameter values
- [ ] Default values: address=`0x50`, register=`0x00`, data=`[]`, n=`1`, cycles=`100`
- [ ] Multiple instances of the same node type can be added
- [ ] Nodes can be repositioned on the canvas after placement
- [ ] Verify in browser: drag-and-drop works smoothly

#### US-005: Node Connection & Edge Management
**Description:** As a user, I want to connect nodes with edges to define execution order so that I can create sequential test flows.

**Acceptance Criteria:**
- [ ] Dragging from an output handle to an input handle creates a directed edge
- [ ] Edges render as smooth step curves with arrow indicators
- [ ] Each output handle allows only one outgoing edge (linear sequence)
- [ ] Each input handle allows only one incoming edge (no merge)
- [ ] Edges can be deleted by selecting and pressing Delete/Backspace
- [ ] Nodes can be deleted by selecting and pressing Delete/Backspace
- [ ] Verify in browser: connections form correctly and deletions work

### Phase 3: Serialization & API Integration

#### US-006: Flow-to-JSON Serialization
**Description:** As a developer, I want to convert the React Flow graph into the backend's JSON step format so that I can submit it for simulation.

**Acceptance Criteria:**
- [ ] `serialize.ts` exports a function `serializeFlow(nodes, edges) => StepPayload[]`
- [ ] Performs topological sort on the directed graph to determine execution order
- [ ] Disconnected nodes are excluded (only the connected chain from the root is included)
- [ ] Each node maps to its corresponding step format: `{op, addr, reg, data, n, expect, cycles}`
- [ ] Hex string values are formatted correctly (e.g., `"0x50"`, `"0xA5"`)
- [ ] Unit tests pass for: linear chain, single node, branching (error), empty canvas
- [ ] Typecheck passes

#### US-007: API Client & Run Execution
**Description:** As a user, I want to click "Run" to execute my test flow and see results so that I can validate my I2C sequences.

**Acceptance Criteria:**
- [ ] `api.ts` exports functions: `runSimulation(steps)`, `fetchTemplates()`, `getWaveformUrl(id)`
- [ ] API base URL is configurable via environment variable (`VITE_API_URL`, defaults to `http://localhost:8000/api`)
- [ ] "Run" button is enabled only when canvas has at least one connected chain
- [ ] Clicking "Run" shows a loading spinner/state on the button
- [ ] On success, result panel expands and displays results (handled by US-008)
- [ ] On error (422/500/503), a toast or inline error message is shown
- [ ] Typecheck passes

### Phase 4: Results Display & Templates

#### US-008: Result Panel — Step Results & Register Dump
**Description:** As a user, I want to see detailed execution results so that I can verify my I2C test passed or failed.

**Acceptance Criteria:**
- [ ] Result panel shows overall pass/fail status with color indicator (green/red)
- [ ] Each step is listed with: operation name, status (ok/fail), and relevant details
- [ ] For `read_bytes` steps: shows returned data and match result against expected
- [ ] For `scan` steps: shows found status and match result
- [ ] Failed steps are highlighted in red
- [ ] Register dump section shows a formatted hex table of the 256-byte register file
- [ ] A "Download VCD" button appears that triggers waveform file download via `GET /api/waveform/{id}`
- [ ] Verify in browser: results display correctly for a sample simulation response

#### US-009: Node Status Overlay
**Description:** As a user, I want to see pass/fail status on each node after execution so that I can quickly identify which step failed.

**Acceptance Criteria:**
- [ ] After simulation, each node in the executed chain shows a status badge (green check / red X)
- [ ] Status is mapped by step index to the corresponding node in topological order
- [ ] Status clears when the flow is modified (node added/removed/edited, edge changed)
- [ ] Verify in browser: status badges appear on nodes after running a simulation

#### US-010: Template Loading
**Description:** As a user, I want to load pre-built test templates so that I can quickly start with common test patterns.

**Acceptance Criteria:**
- [ ] A "Templates" dropdown or modal in the toolbar lists templates from `GET /api/templates`
- [ ] Selecting a template populates the canvas with the corresponding nodes and edges
- [ ] Template steps are laid out in a vertical or horizontal chain with auto-positioning
- [ ] Loading a template prompts confirmation if the canvas is not empty ("Replace current flow?")
- [ ] Verify in browser: templates load and display correctly

### Phase 5: Persistence & Polish

#### US-011: localStorage Flow Persistence
**Description:** As a user, I want my flow to persist across page refreshes so that I don't lose my work.

**Acceptance Criteria:**
- [ ] Current flow (nodes + edges + viewport) is auto-saved to localStorage on every change
- [ ] On page load, saved flow is restored from localStorage if present
- [ ] A "Clear" button resets the canvas and clears localStorage
- [ ] Saved data is namespaced under a key like `i2c-demo-flow`
- [ ] Verify in browser: refresh preserves the flow; "Clear" removes it

#### US-012: Input Validation & UX Polish
**Description:** As a user, I want clear feedback when I enter invalid parameters so that I can fix issues before running.

**Acceptance Criteria:**
- [ ] Address fields validate hex format (0x00–0x7F for 7-bit I2C addresses)
- [ ] Register fields validate hex format (0x00–0xFF)
- [ ] Data fields validate comma-separated hex bytes (e.g., `0xA5, 0xB6`)
- [ ] Cycle count validates as positive integer
- [ ] Invalid fields show red border and inline error message
- [ ] "Run" button is disabled if any node in the chain has validation errors
- [ ] Verify in browser: validation errors display correctly

## 4. Functional Requirements

- FR-1: The frontend must be a Bun + Vite + React + TypeScript application with Tailwind CSS for styling
- FR-2: The canvas must use `@xyflow/react` (React Flow v12) for node-and-edge graph editing
- FR-3: Five custom node types must be supported: Reset, Write, Read, Scan, Delay
- FR-4: Nodes must be draggable from a sidebar palette onto the canvas
- FR-5: The system must serialize a connected node graph into the backend's `{steps: [...]}` JSON format using topological sort
- FR-6: The system must call `POST /api/run` with the serialized steps and display the response
- FR-7: The result panel must show per-step status, register dump, and a VCD download button
- FR-8: The system must load templates from `GET /api/templates` and populate the canvas accordingly
- FR-9: Flow state (nodes, edges, viewport) must auto-persist to localStorage
- FR-10: All hex input fields must validate format before submission
- FR-11: The API base URL must be configurable via `VITE_API_URL` environment variable

## 5. Non-Goals (Out of Scope)

- No in-browser waveform viewer — VCD download only (deferred to Phase 4)
- No multi-slave configuration UI — single slave target (Phase 4)
- No user authentication or multi-user support
- No backend persistence of flows — localStorage only
- No real-time simulation streaming / WebSocket updates
- No undo/redo functionality
- No mobile-responsive design (desktop-first, 1280px minimum)
- No dark mode (unless trivial with Tailwind)

## 6. Technical & Design Considerations

- **React Flow v12** (`@xyflow/react`): Use custom node types with `NodeProps`, handle connections via `onConnect`, and manage state with React Flow's built-in hooks (`useNodesState`, `useEdgesState`)
- **Topological Sort**: The serialization must handle detecting disconnected components and only serialize the connected chain. Use a simple DFS/BFS from nodes with no incoming edges.
- **Backend CORS**: The FastAPI backend must have CORS configured to allow requests from the Vite dev server (typically `http://localhost:5173`). Check if this is already configured; if not, add it as part of US-007.
- **Proxy Config**: Alternatively, configure Vite's dev server proxy to forward `/api` requests to the backend.
- **Node Parameter State**: Store node parameters in React Flow's `node.data` object. Use controlled form inputs within custom node components.
- **Existing Backend API Contract**:
  - `POST /api/run` — body: `{steps: [{op, addr?, reg?, data?, n?, expect?, cycles?}]}` — response: `{passed, steps, register_dump, waveform_id}`
  - `GET /api/templates` — response: list of template objects
  - `GET /api/waveform/{id}` — returns VCD file download

## 7. Success Metrics

- User can build a 5-step test flow (reset → write → delay → read → scan) entirely via drag-and-drop in under 2 minutes
- Simulation results display correctly with pass/fail indicators within 1 second of backend response
- Flow persists across browser refresh without data loss
- All 5 node types are visually distinct and parameters are editable inline

## 8. Open Questions

- Should the canvas support branching/parallel paths in the future, or will flows always be strictly linear chains?
- Should we add keyboard shortcuts for common actions (e.g., Ctrl+Enter to run)?
- Does the backend already have CORS configured, or does that need to be added?
