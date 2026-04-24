# Menubar and Actionbar Spec

This spec locks the editor chrome vocabulary before the next feature work wires behavior to each command.

## Menubar

### File
- New
- Open
- Save
- Save As
- Import YAML
- Export ZIP
- Recent

### Edit
- Undo
- Redo
- Copy
- Paste
- Duplicate
- Select All
- Find

### Asset
- Node Library
- Templates
- Import Asset

### View
- Fit to Content
- Zoom 100%
- Toggle Palette
- Toggle Inspector
- Toggle Dock
- Grid

### Graph
- Validate
- Auto-layout
- Detect Pattern
- Edge Filters

### Tools
- Compile
- Simulate
- Diff
- Generate Docs

### Help
- Shortcuts
- Docs
- About

## Actionbar

- Compile: run validation and refresh YAML preview.
- Save: create a local snapshot.
- Browse: open templates and node library browsing.
- Diff: compare current graph against a saved snapshot.
- Find: fuzzy-search nodes, edges, and generated resources.
- Blueprint Settings: edit stack-wide defaults.
- Cluster Defaults: edit per-cluster defaults once clusters exist.
- Simulate: animate traffic/failure behavior across graph edges.
- Play: open a read-only live preview of generated output with diff markers.

## Current Pass

This phase only updates labels, icons, and command intent text. Behavior wiring happens after the underlying systems exist.
