// Local PostCSS plugin to convert px -> rem for our source styles.
// We avoid an external dependency so the repo stays self-contained.
//
// Notes:
// - Only runs on our app source, skips node_modules/vendor CSS.
// - Keeps hairlines like 1px borders as-is (configurable via minPixelValue).
// - Converts values inside calc()/box-shadow/etc in declaration values.
//
// Base: 16px = 1rem
const DEFAULTS = {
  rootValue: 16,
  unitPrecision: 5,
  minPixelValue: 2,
  // Convert only SFC styles in our source tree.
  // This avoids touching Tailwind's generated CSS (expanded from src/index.css),
  // which would break pixel-based assumptions (e.g. the /screen big board).
  include: /[\\/](src)[\\/].*\\.vue\\b/i,
  exclude: /node_modules|element-plus|[\\/]src[\\/]index\\.css\\b|ScreenHomePage\\.vue\\b/i,
};

function toFixed(v, precision) {
  const pow = Math.pow(10, precision);
  return Math.round(v * pow) / pow;
}

export default function pxToRemPlugin(userOptions = {}) {
  const opts = { ...DEFAULTS, ...userOptions };

  return {
    postcssPlugin: 'local-px-to-rem',
    Once(root, { result }) {
      const from = (result && result.opts && result.opts.from) || '';
      if (opts.exclude && opts.exclude.test(from)) return;
      if (opts.include && !opts.include.test(from)) return;

      root.walkDecls((decl) => {
        if (!decl.value || decl.value.indexOf('px') === -1) return;

        // Keep the root font-size in px to avoid circular rem on <html>.
        const parent = decl.parent;
        const selector = parent && parent.type === 'rule' ? parent.selector : '';
        if (decl.prop === 'font-size' && (selector === 'html' || selector === ':root')) return;

        // Avoid converting in CSS variables like: --foo: 12px; (still fine to convert),
        // but keep it consistent and convert anyway.
        const next = decl.value.replace(/(-?\\d*\\.?\\d+)px\\b/g, (m, numStr) => {
          const px = Number(numStr);
          if (!Number.isFinite(px)) return m;
          if (px === 0) return '0';
          if (Math.abs(px) < opts.minPixelValue) return m;

          const rem = toFixed(px / opts.rootValue, opts.unitPrecision);
          return `${rem}rem`;
        });

        decl.value = next;
      });
    },
  };
}

pxToRemPlugin.postcss = true;
