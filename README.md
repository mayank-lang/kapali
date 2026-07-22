
Kapali is an astrophotography suite designed to keep things in mind with the limitation of image parsing and redundant file storages. Kapali provides sub-second 32-bit floating-point image manipulation pipelines, native parsing of raw FITS headers and SER video streams, SIMBAD target resolution, and DSS catalog sky comparison.

---

## Key Features

### 1. Astronomical Previewer & Stretching
- Non-Linear Stretch Engines: Histogram Transformation, Asinh, Midtone Transfer Function (MTF), and ArcSinh curve stretching.
- Channel Inspector: Separate viewing of R, G, B channels and luminance planes.
- Interactive Analysis Tools: 1D Line Profile intensity sampler, A/B Blink previewer, Split-Screen Wipe Swipe, and Difference Mapping.

###  2. FITS, SER & Metadata Inspection
- Native binary parsing of 8-bit, 16-bit, 32-bit int, and 32-bit float FITS images.
- SER video file stream decoder for planetary imaging.
- Full FITS Header Card reader and metadata inspector with keyword search and modification capabilities.
- EXIF data extraction for DSLR/Mirrorless astrophotography inputs.

###  3. Subframe Selector & Quality Culling
- Automated frame metric grading: FWHM, Star Eccentricity, SNR, Star Count, and Sky Background Noise.
- Interactive scatter plots and quality score filters to cull sub-par exposures before stacking.

###  4. Post-Processor & Image Correction
- Gradient & Background Extraction: Polynomial surface modeling for complex light pollution gradients.
- Colour Calibration & Neutralization: Background neutralization and photometric white balancing.
- Star Operations: Unsharp masking, star reduction, and final star halo correction.
- Noise Reduction: Wavelet, Bilateral, and Gaussian smoothing filters.
- Wavelet Decomposition: Multiscale Median Transform (MMT) for high-frequency detail enhancement.
- Non-Destructive History: Complete undo/redo mathematical buffer.

### 5. Reality Inspector & Astronomical Catalog Resolver
- CDS SIMBAD / Sesame Resolver: Look up target celestial coordinates (RA/Dec) by object identifier (e.g., M31, NGC 7000).
- DSS Reference Sky Comparison: Fetch Aladin HiPS2Fits Digitized Sky Survey (DSS) reference images for live overlay and target alignment checks.

### 6. Workflow Pipeline & Batch Processing
- Node Pipeline Builder: Visual step-by-step workflow pipeline builder for non-destructive multi-operation execution.
- Batch Converter & Exporter: Bulk format conversion between FITS, TIFF, PNG, and JPEG.

### 7. Astronomical Physics Lab & Planner
- Physics Calculations: Signal-to-Noise Ratio (SNR) calculators, Photon Transfer Curves (PTC), atmospheric extinction modeling, and optical filter spectrum analysis.
- 2D Fourier Transform: Fast Fourier Transform (FFT) analysis for frequency domain inspection.
- Observation Planner: Target altitude/airmass tracking, moon phase impact, and target visibility charts.

### 8. Script Console
- Embedded JavaScript execution environment for authoring custom automation scripts and macro transformations.

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- `npm` or `yarn`

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/mayank-lang/kapali.git
   cd kapali
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

---

##  Running the Application

### Web Development Server
Run the Vite development server in browser mode:
```bash
npm run dev
```
Open `http://localhost:5173` in your web browser.

### Desktop App (Electron)
Launch Kapali as a native desktop application with live reload:
```bash
npm run electron:dev
```

---

## Building for Production

### Web Bundle
Build optimized production web assets:
```bash
npm run build
```

### Desktop Application Builds

- Windows Build (NSIS Installer & Portable executable):
  ```bash
  npm run electron:build:win
  ```

- Linux Build (AppImage, Debian `.deb`, `.zip`, `.tar.gz`):
  ```bash
  npm run electron:build:linux
  ```

Outputs will be saved in the `dist_electron/` folder.

---

## Project Architecture

```
kapali/
├── electron/              # Electron main process and preload scripts
│   ├── main.js
│   └── preload.js
├── public/                # Static public assets and SVG icons
├── src/
│   ├── assets/            # Project images and application icons
│   ├── components/        # React UI components
│   │   ├── AstroPreviewer.tsx
│   │   ├── BatchManager.tsx
│   │   ├── Converter.tsx
│   │   ├── MetadataExplorer.tsx
│   │   ├── PhysicsLab.tsx
│   │   ├── PlannerPanel.tsx
│   │   ├── PostProcessor.tsx
│   │   ├── RealityInspector.tsx
│   │   ├── ScriptConsole.tsx
│   │   ├── SubframeSelector.tsx
│   │   └── WorkflowBuilder.tsx
│   ├── styles/            # CSS Design Tokens & Global Styles
│   ├── utils/             # FITS/SER parsers, physics & math engines
│   │   ├── atmosphericPhysics.ts
│   │   ├── filters.ts
│   │   ├── fourierAnalysis.ts
│   │   ├── opticalAnalysis.ts
│   │   ├── parsers.ts
│   │   ├── photometry.ts
│   │   ├── photonTransfer.ts
│   │   ├── snrCalculator.ts
│   │   ├── spectralAnalysis.ts
│   │   └── stretch.ts
│   ├── App.tsx            # Main Application entry & Workspace state
│   └── main.tsx           # React DOM root render
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  Developed by <a href="https://github.com/mayank-lang">mayank-lang</a>
</p>
