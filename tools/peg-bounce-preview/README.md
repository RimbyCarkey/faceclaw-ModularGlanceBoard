# Peg-Bounce browser preview

Run `npm ci` from the repository root, then run:

```sh
node tools/peg-bounce-preview/build.cjs
```

Open the generated Peg-Bounce Standalone HTML in a browser. It runs offline and displays the worker’s submitted 4-bit raster on a 640 × 480 canvas by default. It also accepts campaign JSON and a local UI font. Click the display for keyboard focus. Up and Down scroll, Left and Right swipe, Enter taps, and Esc double-taps.

Width and height set the viewport. Scale and offset controls adjust the board before rasterization. The browser supplies the worker’s settings, glyph rendering, and display interfaces. Native glyph caching, shell composition, audio, and Bluetooth timing are outside this preview.

For the editor, run `node tools/peg-bounce-editor/build.cjs`. Tutorial uses its practice target counts, and existing imported levels keep their authored counts.
