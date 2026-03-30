import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import pxToRem from './postcss-px-to-rem.js';

export default {
  plugins: [
    tailwindcss,
    autoprefixer,
    pxToRem({
      rootValue: 16,
      unitPrecision: 5,
      minPixelValue: 2,
    }),
  ],
};
