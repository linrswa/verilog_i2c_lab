# PRD: Waveform Viewer with Time-Aligned Canvas

## 1. Introduction/Overview

Add a waveform viewer to the I2C Demo web application that displays VCD simulation waveforms aligned with the React Flow canvas. The canvas is redesigned from free-form drag-and-drop to a horizontal linear pipeline layout, where each protocol step node's x-position corresponds to its simulation time range. A collapsible WaveformPanel below the canvas renders SDA, SCL, and other signals using SVG, sharing the same coordinate system so nodes and waveforms are naturally aligned without extra synchronization logic.

## 2. Goals

- Redesign the React Flow canvas to a horizontal linear pipeline layout
- Parse VCD files on the backend and serve signal data as JSON
- Record per-step simulation timing (start/end) in the cocotb driver
- Render digital waveforms (SVG) in a collapsible panel below the canvas
- Align node positions with waveform time ranges after simulation
- Provide a signal selector to toggle visibility of any VCD signal
- Support hover/click synchronization between nodes and waveform regions

## 3. User Stories

### Phase 1: Horizontal Linear Layout

#### US-001: Horizontal Auto-Layout for Nodes
**Description:** As a user, I want protocol step nodes to be arranged horizontally in a linear pipeline so that the sequence is visually clear and ready for waveform alignment.

**Acceptance Criteria:**
- [ ] All nodes are positioned at the same y-coordinate
- [ ] Nodes are spaced evenly: `x = i * (NODE_WIDTH + GAP)`
- [ ] Adding a new node places it at the end of the sequence with correct position
- [ ] Deleting a node re-indexes and re-positions all remaining nodes
- [ ] Edges are auto-generated between consecutive nodes (smoothstep type)
- [ ] `nodesConnectable={false}` prevents manual edge creation
- [ ] Typecheck/lint passes
- [ ] Verify in browser: nodes appear in a horizontal row

#### US-002: Click-to-Append Sidebar
**Description:** As a user, I want to click buttons in the sidebar to append protocol steps to the sequence, replacing the drag-and-drop interaction.

**Acceptance Criteria:**
- [ ] Sidebar shows buttons for each node type (START, SEND_BYTE, RECV_BYTE, STOP)
- [ ] Clicking a button appends the node to the end of the sequence
- [ ] New node automatically gets an edge from the previous node
- [ ] Drag-and-drop from sidebar is removed
- [ ] START/STOP auto-management still works (sequence must start with START, end with STOP)
- [ ] Typecheck/lint passes
- [ ] Verify in browser: clicking sidebar buttons appends nodes correctly

#### US-003: Drag-to-Reorder Nodes
**Description:** As a user, I want to drag nodes horizontally to reorder them in the sequence so I can rearrange steps without deleting and re-adding.

**Acceptance Criteria:**
- [ ] Nodes can be dragged horizontally only (y-axis locked)
- [ ] Dropping a node between two others inserts it at that position
- [ ] After reorder, all nodes snap to their correct evenly-spaced positions
- [ ] Edges are regenerated to reflect the new order
- [ ] START must remain first, STOP must remain last (cannot be reordered past boundaries)
- [ ] Typecheck/lint passes
- [ ] Verify in browser: dragging a node reorders the sequence

### Phase 2: VCD Parse API

#### US-004: VCD Parser Service
**Description:** As a developer, I want a backend service that parses VCD files and extracts signal change data so the frontend can render waveforms.

**Acceptance Criteria:**
- [ ] New file `backend/app/services/vcd_parser.py` with a `parse_vcd()` function
- [ ] Uses the `vcdvcd` Python package to parse VCD files
- [ ] Extracts signal changes as `[time_ps, value]` arrays
- [ ] Handles VCD signal hierarchy (e.g., `i2c_system_wrapper.dut.scl` maps to `scl`)
- [ ] Returns timescale, end_time, and per-signal metadata (width, changes)
- [ ] Returns all available signal names when no filter is specified
- [ ] `vcdvcd` is added to project dependencies
- [ ] Typecheck/lint passes

#### US-005: Waveform Signals API Endpoint
**Description:** As a frontend developer, I want a REST endpoint that returns parsed VCD signal data as JSON so I can render waveforms in the browser.

**Acceptance Criteria:**
- [ ] New endpoint: `GET /api/waveform/{waveform_id}/signals`
- [ ] Accepts optional `signals` query parameter (comma-separated signal names)
- [ ] When `signals` is omitted, returns all available signals
- [ ] Response format: `{ timescale, end_time, signals: { [name]: { width, changes } } }`
- [ ] Returns 404 if waveform_id not found
- [ ] Returns 400 if requested signal name doesn't exist in the VCD
- [ ] Typecheck/lint passes

### Phase 3: Step Timing

#### US-006: Record Per-Step Simulation Timing
**Description:** As a developer, I want each protocol step result to include `start_time_ps` and `end_time_ps` so the frontend can align nodes with waveform time ranges.

**Acceptance Criteria:**
- [ ] `I2CDriver` methods (`_run_segment`, `_run_write_txn`, `_run_read_txn`) record sim time before and after execution using `cocotb.utils.get_sim_time(units='ps')`
- [ ] Non-protocol ops (`reset`, `delay`) also record timing
- [ ] `_map_protocol_results()` distributes timing to individual steps
- [ ] Each step in the API response includes `time_range_ps: [start, end]`
- [ ] `RunResponse` includes `sim_time_total_ps`
- [ ] Timing values are accurate (verified by comparing with VCD waveform)
- [ ] Typecheck/lint passes

### Phase 4: Waveform Panel

#### US-007: SVG Waveform Renderer
**Description:** As a user, I want to see digital waveforms rendered below the canvas so I can visualize the I2C bus activity.

**Acceptance Criteria:**
- [ ] New component `WaveformPanel.tsx` renders below the React Flow canvas
- [ ] Renders digital square-wave SVG paths from signal change data
- [ ] Each signal is drawn in its own row with a label on the left
- [ ] SDA and SCL are shown by default
- [ ] Panel is collapsible with a toggle button
- [ ] Panel only appears when simulation results exist
- [ ] Typecheck/lint passes
- [ ] Verify in browser: waveforms render correctly after simulation

#### US-008: Signal Selector
**Description:** As a user, I want to select which signals to display in the waveform panel so I can focus on relevant signals or add debug signals.

**Acceptance Criteria:**
- [ ] A signal selector UI lists all available signals from the VCD
- [ ] Users can toggle individual signals on/off
- [ ] SDA and SCL are enabled by default
- [ ] Additional signals (busy, done, ack_error, state, etc.) can be toggled on
- [ ] Signal order in the panel matches the selection order
- [ ] Typecheck/lint passes
- [ ] Verify in browser: toggling signals adds/removes waveform rows

#### US-009: Step Region Overlays
**Description:** As a user, I want to see semi-transparent colored regions on the waveform that correspond to each protocol step so I can correlate bus activity with steps.

**Acceptance Criteria:**
- [ ] Semi-transparent colored rectangles overlay the waveform for each step's time range
- [ ] Each step type has a distinct color (matching the node color scheme)
- [ ] Step labels are shown within or above the overlay regions
- [ ] Overlays span the full height of the waveform area
- [ ] Typecheck/lint passes
- [ ] Verify in browser: colored regions appear aligned with step time ranges

### Phase 5: Integration & Alignment

#### US-010: Post-Simulation Node Realignment
**Description:** As a user, I want nodes to resize and reposition after simulation to match their actual time ranges so that nodes and waveforms are visually aligned.

**Acceptance Criteria:**
- [ ] After simulation, each node's x-position is set to `timeToX(step.start_time_ps)`
- [ ] Each node's width is set proportional to its time range duration
- [ ] Strict linear scaling is used (no minimum width clamp)
- [ ] Narrow nodes (short time steps like START/STOP) show full details on hover via tooltip
- [ ] `timeToX()` function is shared between node layout and waveform rendering
- [ ] Before simulation, nodes revert to evenly-spaced default layout
- [ ] Typecheck/lint passes
- [ ] Verify in browser: nodes align with waveform regions after simulation

#### US-011: Viewport Synchronization
**Description:** As a user, I want the waveform panel to stay aligned with the canvas when I pan or zoom so that the correspondence between nodes and waveforms is maintained.

**Acceptance Criteria:**
- [ ] WaveformPanel listens to React Flow's `onViewportChange` event
- [ ] Pan and zoom transforms are applied to the waveform SVG viewport
- [ ] Horizontal scrolling keeps nodes and waveform regions aligned
- [ ] Zoom level changes scale the waveform proportionally
- [ ] Typecheck/lint passes
- [ ] Verify in browser: panning/zooming canvas keeps waveform aligned

#### US-012: Hover/Click Cross-Highlighting
**Description:** As a user, I want hovering over a node to highlight the corresponding waveform region (and vice versa) so I can quickly correlate steps with bus activity.

**Acceptance Criteria:**
- [ ] Shared state (`hoveredStepIndex`, `selectedStepIndex`) is managed in App.tsx
- [ ] Hovering a node highlights the corresponding waveform step overlay
- [ ] Hovering a waveform step region highlights the corresponding node
- [ ] Clicking selects a step (persistent highlight until another is clicked)
- [ ] Highlight style is visually distinct (e.g., brighter overlay, node border glow)
- [ ] Typecheck/lint passes
- [ ] Verify in browser: hover/click cross-highlighting works bidirectionally

## 4. Functional Requirements

- FR-1: The canvas must arrange all protocol step nodes in a horizontal line at a fixed y-coordinate
- FR-2: New nodes must be appended to the end of the sequence via sidebar button clicks
- FR-3: Nodes must be reorderable by horizontal drag, with y-axis locked
- FR-4: Edges must be auto-generated between consecutive nodes; manual edge creation is disabled
- FR-5: The backend must parse VCD files using `vcdvcd` and return signal data as JSON via `GET /api/waveform/{id}/signals`
- FR-6: Signal change data must be returned as `[time_ps, value]` arrays sorted by time
- FR-7: The cocotb driver must record `start_time_ps` and `end_time_ps` for each protocol step
- FR-8: The simulation API response must include per-step `time_range_ps` and total `sim_time_total_ps`
- FR-9: The WaveformPanel must render digital square-wave SVG paths from signal change data
- FR-10: The WaveformPanel must be collapsible and only visible when simulation results exist
- FR-11: A signal selector must allow users to toggle visibility of any available VCD signal
- FR-12: After simulation, nodes must be repositioned and resized to match their step time ranges using linear scaling
- FR-13: The waveform viewport must synchronize with the React Flow canvas pan/zoom
- FR-14: Hovering a node or waveform region must highlight the corresponding counterpart

## 5. Non-Goals (Out of Scope)

- Analog waveform rendering
- Cursor / time measurement tools
- Waveform export (image/SVG export)
- Independent zoom/pan for the waveform panel (it shares the canvas viewport)
- Signal search/filtering beyond a simple toggle list
- Waveform comparison between multiple simulation runs
- Multi-bit bus visualization (bus values as hex/decimal)
- Undo/redo for node reordering
- Persisting signal selection preferences across sessions

## 6. Technical & Design Considerations

### Frontend
- **React Flow** canvas is reconfigured with `nodesConnectable={false}` and custom drag handling for reorder
- **SVG** is used for waveform rendering (not Canvas API) since signal count is small
- **Shared `timeToX()` function** in `frontend/src/lib/waveform.ts` is used by both node positioning and waveform rendering
- **State** is lifted to App.tsx (`hoveredStepIndex`, `selectedStepIndex`, `stepTimings`)
- Existing `DownloadVcdButton` component is preserved

### Backend
- **`vcdvcd`** package is added to dependencies for VCD parsing
- VCD files are small (KB range) so parsing performance is not a concern
- Signal hierarchy in VCD (e.g., `i2c_system_wrapper.dut.scl`) must be flattened or matched by leaf name
- `cocotb.utils.get_sim_time(units='ps')` is used for timing — must verify accuracy at await boundaries

### Layout Constants
- `NODE_WIDTH = 160`, `GAP = 40`, `Y = 200` (pre-simulation defaults)
- `LABEL_WIDTH` for signal name labels in waveform panel
- Post-simulation: strict linear scaling with tooltip for narrow nodes

## 7. Success Metrics

- After simulation, every node's horizontal span visually aligns with its corresponding waveform time region
- Users can identify which bus activity corresponds to which protocol step without cross-referencing
- Waveform panel renders within 500ms of receiving signal data
- All VCD signals are accessible via the signal selector

## 8. Open Questions

1. **Template compatibility**: Existing templates assume free-form or vertical layout. Do we need to migrate saved templates to the new horizontal format, or deprecate old templates?
2. **Insert-at-position**: Should users be able to insert nodes at arbitrary positions (not just append), e.g., by clicking between two existing nodes?
3. **Multi-bit signals**: If the VCD contains multi-bit signals (e.g., `state[3:0]`), should they be rendered as binary, hex, or bus-style? (Currently out of scope but may come up.)
4. **Viewport sync performance**: React Flow's viewport change events fire frequently during pan/zoom. Need to verify SVG re-render performance or add throttling.
