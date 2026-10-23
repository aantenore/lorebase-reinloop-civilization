/** Tiny pixel icons as inline SVG (crisp at any size). */
const svg = (w: number, h: number, body: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${body}</svg>`)}`;

const heartPath = 'M1 0h2v1h1V0h2v1h1v3H6v1H5v1H4v1H3V6H2V5H1V4H0V1h1z';
export const ICONS = {
  heartFull: svg(7, 7, `<path fill="#17111a" d="${heartPath}"/><path fill="#e0503a" d="M1 1h2v1h1V1h2v3H5v1H4v1H3V5H2V4H1z"/><path fill="#ff9a8a" d="M1 1h1v1H1z"/>`),
  heartHalf: svg(7, 7, `<path fill="#17111a" d="${heartPath}"/><path fill="#4b3650" d="M1 1h2v1h1V1h2v3H5v1H4v1H3V5H2V4H1z"/><path fill="#e0503a" d="M1 1h2v1h0.99v4H3V5H2V4H1z"/>`),
  heartEmpty: svg(7, 7, `<path fill="#17111a" d="${heartPath}"/><path fill="#4b3650" d="M1 1h2v1h1V1h2v3H5v1H4v1H3V5H2V4H1z"/>`),
  berry: svg(6, 6, `<path fill="#17111a" d="M2 0h2v1h1v1h1v3H5v1H1V5H0V2h1V1h1z"/><path fill="#d8344a" d="M2 1h2v1h1v3H1V2h1z"/><path fill="#ff7088" d="M2 2h1v1H2z"/><path fill="#4fa65a" d="M3 0h1v1H3z"/>`),
  wood: svg(7, 5, `<path fill="#17111a" d="M0 1h7v3H0z"/><path fill="#8b5a32" d="M1 1h5v2H1z"/><path fill="#d6a670" d="M0 1h2v2H0z"/><path fill="#6b4429" d="M2 3h5v1H2z"/>`),
};

export function icon(name: keyof typeof ICONS, cls = 'ico'): HTMLImageElement {
  const img = document.createElement('img');
  img.src = ICONS[name];
  img.className = cls;
  img.alt = '';
  return img;
}
