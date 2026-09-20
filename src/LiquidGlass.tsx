// Original, static displacement map: neutral in the center, curved at the rim.
// Only the backdrop is refracted. No text snapshots, pointer loop or raster asset.
const displacementMap = 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="x"><stop stop-color="#ff0080"/><stop offset=".035" stop-color="#800080"/><stop offset=".965" stop-color="#800080"/><stop offset="1" stop-color="#000080"/></linearGradient>
    <linearGradient id="y" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#00ff00"/><stop offset=".035" stop-color="#008000"/><stop offset=".965" stop-color="#008000"/><stop offset="1" stop-color="#000000"/></linearGradient>
  </defs>
  <rect width="128" height="128" fill="url(#x)"/><rect width="128" height="128" fill="url(#y)" style="mix-blend-mode:screen"/>
</svg>`);

export function LiquidGlass() {
  return <svg className="liquid-glass-definitions" width="0" height="0" aria-hidden="true" focusable="false">
    <defs><filter id="project-grid-refraction" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
      <feImage href={displacementMap} x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="rim" />
      <feDisplacementMap in="SourceGraphic" in2="rim" scale="14" xChannelSelector="R" yChannelSelector="G" />
    </filter></defs>
  </svg>;
}
