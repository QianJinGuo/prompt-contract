#!/usr/bin/env node
import { serve } from '../src/server.js';

serve({ argv: process.argv.slice(2) }).catch((err) => {
  process.stderr.write(`[prompt-boost] fatal: ${err.message}\n`);
  process.exit(1);
});
