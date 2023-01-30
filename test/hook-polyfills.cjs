'use strict';

// Always install WebStreams polyfill

import('web-streams-polyfill/dist/polyfill.es2018.mjs');

globalThis.__usesWebstreamPolyfill = true;
