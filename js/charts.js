/*
 * Charts — small hand-made SVG bar charts (no libraries, works offline).
 * One y-axis, thin bars with rounded data-ends, hairline grid, hover tooltip.
 */
const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function niceStep(raw) {
    if (raw <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }

  /** A bar from the baseline y0 to y1, with the data-end (away from baseline) rounded. */
  function barPath(x, w, y0, y1, r) {
    const h = Math.abs(y1 - y0);
    if (h < 0.5) return '';
    r = Math.min(r, h, w / 2);
    if (y1 < y0) {
      return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
    }
    return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
  }

  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Grouped bar chart.
   * opts: { labels, fullLabels, series: [{name, color, values}], height, format, axisFormat, tooltipExtra(i) }
   */
  function bars(container, opts) {
    const { labels, series, height = 240, format = String, axisFormat = String } = opts;
    const fullLabels = opts.fullLabels || labels;
    container.innerHTML = '';
    container.classList.add('chart');

    if (series.length > 1) {
      const legend = document.createElement('div');
      legend.className = 'legend';
      legend.innerHTML = series
        .map(s => `<span class="legend-item"><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.name)}</span>`)
        .join('');
      container.appendChild(legend);
    }

    const plot = document.createElement('div');
    plot.className = 'chart-plot';
    container.appendChild(plot);

    const width = Math.max(280, container.clientWidth);
    const m = { top: 10, right: 6, bottom: 26, left: 54 };
    const pw = width - m.left - m.right;
    const ph = height - m.top - m.bottom;

    const all = series.flatMap(s => s.values);
    let max = Math.max(0, ...all);
    const min = Math.min(0, ...all);
    if (max === min) max = 1;
    const step = niceStep((max - min) / 4);
    const top = Math.ceil(max / step) * step;
    const bottom = Math.floor(min / step) * step;
    const y = v => m.top + ((top - v) / (top - bottom)) * ph;

    const svg = svgEl('svg', {
      width, height, viewBox: `0 0 ${width} ${height}`, role: 'img',
      'aria-label': `${series.map(s => s.name).join(' and ')} per month`,
    }, plot);

    // grid + y ticks
    for (let v = bottom; v <= top + step / 1000; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      const isZero = Math.abs(v) < step / 1000;
      svgEl('line', { x1: m.left, x2: width - m.right, y1: yy, y2: yy, class: isZero ? 'axis-line' : 'grid-line' }, svg);
      const t = svgEl('text', { x: m.left - 8, y: yy + 4, 'text-anchor': 'end', class: 'tick' }, svg);
      t.textContent = axisFormat(isZero ? 0 : v);
    }

    const n = labels.length;
    const gw = pw / n;
    const gap = 2;
    const s = series.length;
    const bw = Math.max(3, Math.min(26, (gw * 0.66 - (s - 1) * gap) / s));
    const inner = bw * s + gap * (s - 1);
    const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 46))));

    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    plot.appendChild(tip);

    const groups = [];
    labels.forEach((lab, i) => {
      const gx = m.left + gw * i + (gw - inner) / 2;
      const g = svgEl('g', { class: 'bar-group' }, svg);
      series.forEach((se, j) => {
        const d = barPath(gx + j * (bw + gap), bw, y(0), y(se.values[i]), 4);
        if (d) {
          const p = svgEl('path', { d }, g);
          p.style.fill = se.color;
        }
      });
      groups.push(g);

      if ((n - 1 - i) % labelEvery === 0) {
        const t = svgEl('text', { x: m.left + gw * i + gw / 2, y: height - 8, 'text-anchor': 'middle', class: 'tick' }, svg);
        t.textContent = lab;
      }
    });

    // hit targets go on top so they're bigger than the bars
    labels.forEach((lab, i) => {
      const hit = svgEl('rect', {
        x: m.left + gw * i, y: m.top, width: gw, height: ph, class: 'hit', tabindex: 0,
        'aria-label': `${fullLabels[i]}: ${series.map(se => `${se.name} ${format(se.values[i])}`).join(', ')}`,
      }, svg);
      const show = () => {
        groups.forEach((g, k) => { g.style.opacity = k === i ? 1 : 0.35; });
        const rows = series.map(se =>
          `<div class="tip-row"><span class="swatch" style="background:${se.color}"></span><span>${escapeHtml(se.name)}</span><b>${escapeHtml(format(se.values[i]))}</b></div>`
        ).join('');
        const extra = opts.tooltipExtra ? `<div class="tip-extra">${escapeHtml(opts.tooltipExtra(i))}</div>` : '';
        tip.innerHTML = `<div class="tip-title">${escapeHtml(fullLabels[i])}</div>${rows}${extra}`;
        tip.hidden = false;
        const cx = m.left + gw * i + gw / 2;
        const tw = tip.offsetWidth;
        const left = Math.min(Math.max(4, cx - tw / 2), width - tw - 4);
        tip.style.left = `${left}px`;
        tip.style.top = `${m.top}px`;
      };
      const hide = () => {
        groups.forEach(g => { g.style.opacity = 1; });
        tip.hidden = true;
      };
      hit.addEventListener('mouseenter', show);
      hit.addEventListener('mouseleave', hide);
      hit.addEventListener('focus', show);
      hit.addEventListener('blur', hide);
      hit.addEventListener('click', show);
    });
  }

  return { bars };
})();
