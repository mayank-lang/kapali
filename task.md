# Tasks - AstroForge Stage 12 & 13

## Stage 12: Final Star Correction
- `[x]` Implement `executeFinalStarCorrection` in `src/utils/filters.ts`
- `[x]` Register 'StarCorrect' in `ActiveTool` and state in `src/components/PostProcessor.tsx`
- `[x]` Add UI parameters and execute handlers for Final Star Correction in `src/components/PostProcessor.tsx`
- `[x]` Add 'starcorrect' operations, defaults, and parameters editing in `src/components/WorkflowBuilder.tsx`
- `[x]` Add 'starcorrect' executors inside the pipeline run loop in `src/components/WorkflowBuilder.tsx`
- `[x]` Verify everything builds successfully with `npm run build`

## Stage 13: Reality & Artifact Inspector
- `[x]` Add `originalFloatData` storage to `SharedFile` workspace models in `src/App.tsx`
- `[x]` Build the `RealityInspector` sidebar interface panel component
- `[x]` Implement A/B Blink, Interactive Wipe Swipe, and Difference Map rendering in `AstroPreviewer.tsx`
- `[x]` Implement 1D Vector Line Profile sampling and plot it as an SVG graph
- `[x]` Integrate CDS Simbad Sesame resolver and Aladin Hips2Fits DSS reference fetching
- `[x]` Add full mathematical undo/redo buffer inside `PostProcessor.tsx`
- `[x]` Confirm zero TypeScript strict warnings and verify production build compiles cleanly
